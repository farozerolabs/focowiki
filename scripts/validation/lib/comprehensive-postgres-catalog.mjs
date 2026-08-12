import crypto from "node:crypto";

const VALIDATION_DATABASE_PATTERN = /(?:^|[-_])clr(?:[-_]|$)|comprehensive[-_]release/iu;

export function assertValidationDatabaseTarget(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  if (!databaseName || !VALIDATION_DATABASE_PATTERN.test(databaseName)) {
    throw new Error("PostgreSQL catalog capture requires an explicitly validation-owned database name");
  }
  return { host: parsed.hostname, port: parsed.port, databaseName };
}

export async function capturePostgresCatalog(sql) {
  const [tables, columns, constraints, indexes, generation] = await Promise.all([
    sql`
      SELECT
        table_schema,
        table_name,
        table_type
      FROM information_schema.tables
      WHERE table_schema = 'focowiki'
      ORDER BY table_name
    `,
    sql`
      SELECT
        column_record.table_schema,
        column_record.table_name,
        column_record.column_name,
        column_record.ordinal_position,
        column_record.data_type,
        column_record.udt_name,
        column_record.is_nullable,
        column_record.column_default,
        column_record.character_maximum_length,
        column_record.numeric_precision,
        column_record.numeric_scale
      FROM information_schema.columns AS column_record
      WHERE column_record.table_schema = 'focowiki'
      ORDER BY column_record.table_name, column_record.ordinal_position
    `,
    sql`
      SELECT
        namespace.nspname AS table_schema,
        relation.relname AS table_name,
        constraint_record.conname AS constraint_name,
        constraint_record.contype AS constraint_type,
        pg_get_constraintdef(constraint_record.oid, true) AS definition
      FROM pg_constraint AS constraint_record
      JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'focowiki'
      ORDER BY relation.relname, constraint_record.conname
    `,
    sql`
      SELECT
        schemaname AS table_schema,
        tablename AS table_name,
        indexname AS index_name,
        indexdef AS definition
      FROM pg_indexes
      WHERE schemaname = 'focowiki'
      ORDER BY tablename, indexname
    `,
    sql`
      SELECT generation
      FROM focowiki.runtime_generation
      WHERE singleton = true
    `
  ]);

  const catalog = {
    schemaVersion: 1,
    schemaGeneration: generation[0]?.generation ?? null,
    ownershipBoundary: "schema:focowiki",
    lifecyclePhase: "clean-migrated",
    tables,
    columns,
    constraints,
    indexes
  };
  return {
    ...catalog,
    cardinality: {
      tables: tables.length,
      columns: columns.length,
      constraints: constraints.length,
      indexes: indexes.length
    },
    catalogHash: hashCatalog(catalog)
  };
}

export function assertPostgresCatalogComplete(catalog) {
  for (const collection of ["tables", "columns", "constraints", "indexes"]) {
    if (!Array.isArray(catalog[collection]) || catalog[collection].length === 0) {
      throw new Error(`PostgreSQL catalog is missing ${collection}`);
    }
  }
  if (catalog.schemaGeneration !== "storage-vnext-v3-semantic") {
    throw new Error(`Unexpected PostgreSQL schema generation: ${catalog.schemaGeneration}`);
  }
  const tableNames = new Set(catalog.tables.map((item) => item.table_name));
  for (const item of [...catalog.columns, ...catalog.constraints, ...catalog.indexes]) {
    if (!tableNames.has(item.table_name)) {
      throw new Error(`PostgreSQL catalog item has no owned table: ${item.table_name}`);
    }
  }
}

function hashCatalog(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
