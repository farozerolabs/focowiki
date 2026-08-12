#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
  reconcileComprehensivePostgresRuntimeTables
} from "./lib/comprehensive-postgres-runtime-table-ledger.mjs";

const databaseUrl = requiredEnv("FOCOWIKI_COMPREHENSIVE_DATABASE_URL");
const inventory = readJson(requiredEnv("FOCOWIKI_COMPREHENSIVE_SOURCE_INVENTORY"));
const phase = requiredEnv("FOCOWIKI_COMPREHENSIVE_POSTGRES_PHASE");
const output = path.resolve(requiredEnv("FOCOWIKI_COMPREHENSIVE_POSTGRES_REPORT"));
const knowledgeBaseIds = requiredEnv("FOCOWIKI_COMPREHENSIVE_KNOWLEDGE_BASE_IDS")
  .split(",").map((value) => value.trim()).filter(Boolean);
if (knowledgeBaseIds.length !== 2 || new Set(knowledgeBaseIds).size !== 2) {
  throw new Error("PostgreSQL runtime ledger requires exactly two knowledge bases");
}
const expectedTableNames = inventory.inventory?.postgres
  ?.filter((item) => item.kind === "table")
  .map((item) => item.table) ?? [];
const apiRequire = createRequire(path.join(process.cwd(), "apps/api/package.json"));
const postgres = apiRequire("postgres");
const sql = postgres(databaseUrl, {
  max: 2,
  connect_timeout: 10,
  idle_timeout: 5,
  prepare: false
});

try {
  const [relations, columns, constraints, indexes] = await Promise.all([
    sql`
      SELECT relation.relname AS table_name,
             CASE relation.relkind WHEN 'p' THEN 'table' ELSE 'table' END AS relation_kind,
             parent.relname AS parent_table_name,
             pg_total_relation_size(relation.oid)::bigint AS total_bytes,
             COALESCE(table_stats.seq_scan, 0)::bigint AS sequential_scan_count,
             COALESCE(table_stats.n_live_tup, 0)::bigint AS live_tuple_estimate,
             COALESCE(table_stats.n_dead_tup, 0)::bigint AS dead_tuple_estimate,
             COALESCE(index_stats.index_scan_count, 0)::bigint AS index_scan_count,
             COALESCE(lock_stats.lock_count, 0)::bigint AS lock_count
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      LEFT JOIN pg_inherits inheritance ON inheritance.inhrelid = relation.oid
      LEFT JOIN pg_class parent ON parent.oid = inheritance.inhparent
      LEFT JOIN pg_stat_user_tables table_stats ON table_stats.relid = relation.oid
      LEFT JOIN LATERAL (
        SELECT sum(index_scan.idx_scan)::bigint AS index_scan_count
        FROM pg_stat_user_indexes index_scan
        WHERE index_scan.relid = relation.oid
      ) index_stats ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::bigint AS lock_count
        FROM pg_locks lock
        WHERE lock.relation = relation.oid
      ) lock_stats ON true
      WHERE namespace.nspname = 'focowiki'
        AND relation.relkind IN ('r', 'p')
      ORDER BY relation.relname COLLATE "C"
    `,
    sql`
      SELECT table_name, column_name, ordinal_position, data_type, udt_name,
             is_nullable = 'YES' AS nullable,
             column_default IS NOT NULL AS default_present
      FROM information_schema.columns
      WHERE table_schema = 'focowiki'
      ORDER BY table_name COLLATE "C", ordinal_position
    `,
    sql`
      SELECT relation.relname AS table_name, constraint_record.conname AS name
      FROM pg_constraint constraint_record
      JOIN pg_class relation ON relation.oid = constraint_record.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'focowiki'
      ORDER BY relation.relname COLLATE "C", constraint_record.conname COLLATE "C"
    `,
    sql`
      SELECT tablename AS table_name, indexname AS name
      FROM pg_indexes
      WHERE schemaname = 'focowiki'
      ORDER BY tablename COLLATE "C", indexname COLLATE "C"
    `
  ]);
  const columnsByTable = groupBy(columns, "table_name");
  const constraintsByTable = groupBy(constraints, "table_name");
  const indexesByTable = groupBy(indexes, "table_name");
  const runtimeTables = [];
  for (const relation of relations) {
    const tableName = safeIdentifier(relation.table_name);
    const tableColumns = columnsByTable.get(tableName) ?? [];
    const exactRows = number((await sql.unsafe(
      `SELECT count(*)::bigint AS count FROM focowiki."${tableName}"`
    ))[0]?.count);
    const knowledgeBaseCounts = tableColumns.some((column) =>
      column.column_name === "knowledge_base_id")
      ? await readKnowledgeBaseCounts(sql, tableName, knowledgeBaseIds)
      : null;
    const stateColumn = ["state", "status", "root_role", "projection_role"]
      .find((name) => tableColumns.some((column) => column.column_name === name));
    const stateCounts = stateColumn
      ? await readStateCounts(sql, tableName, stateColumn)
      : [];
    runtimeTables.push({
      tableName,
      relationKind: relation.parent_table_name ? "partition" : "table",
      parentTableName: relation.parent_table_name ?? null,
      exactRows,
      totalBytes: number(relation.total_bytes),
      columns: tableColumns.map((column) => ({
        name: column.column_name,
        ordinal: number(column.ordinal_position),
        dataType: column.data_type,
        underlyingType: column.udt_name,
        nullable: column.nullable === true,
        defaultPresent: column.default_present === true
      })),
      columnCount: tableColumns.length,
      constraints: (constraintsByTable.get(tableName) ?? []).map((item) => item.name),
      constraintCount: (constraintsByTable.get(tableName) ?? []).length,
      indexes: (indexesByTable.get(tableName) ?? []).map((item) => item.name),
      indexCount: (indexesByTable.get(tableName) ?? []).length,
      indexScanCount: number(relation.index_scan_count),
      sequentialScanCount: number(relation.sequential_scan_count),
      liveTupleEstimate: number(relation.live_tuple_estimate),
      deadTupleEstimate: number(relation.dead_tuple_estimate),
      lockCount: number(relation.lock_count),
      knowledgeBaseCounts,
      stateCounts
    });
  }
  const report = {
    generatedAt: new Date().toISOString(),
    knowledgeBaseAliases: ["official", "legacy"],
    ...reconcileComprehensivePostgresRuntimeTables({
      phase,
      expectedTableNames,
      runtimeTables
    })
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(output, 0o600);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    output,
    phase,
    summary: report.summary
  })}\n`);
} finally {
  await sql.end({ timeout: 5 });
}

async function readKnowledgeBaseCounts(client, tableName, knowledgeBaseIds) {
  const rows = await client.unsafe(`
    SELECT
      count(*) FILTER (WHERE knowledge_base_id = $1)::bigint AS official,
      count(*) FILTER (WHERE knowledge_base_id = $2)::bigint AS legacy,
      count(*) FILTER (WHERE knowledge_base_id NOT IN ($1, $2))::bigint AS other
    FROM focowiki."${tableName}"
  `, knowledgeBaseIds);
  return {
    official: number(rows[0]?.official),
    legacy: number(rows[0]?.legacy),
    other: number(rows[0]?.other)
  };
}

async function readStateCounts(client, tableName, columnName) {
  const rows = await client.unsafe(`
    SELECT "${safeIdentifier(columnName)}"::text AS value, count(*)::bigint AS count
    FROM focowiki."${safeIdentifier(tableName)}"
    GROUP BY "${safeIdentifier(columnName)}"
    ORDER BY "${safeIdentifier(columnName)}"::text COLLATE "C"
  `);
  return rows.map((row) => ({ value: row.value, count: number(row.count) }));
}

function groupBy(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const values = result.get(row[key]) ?? [];
    values.push(row);
    result.set(row[key], values);
  }
  return result;
}

function safeIdentifier(value) {
  const text = String(value);
  if (!/^[a-z_][a-z0-9_]*$/u.test(text)) throw new Error("Unsafe PostgreSQL identifier");
  return text;
}

function number(value) {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("PostgreSQL runtime count is invalid");
  }
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
