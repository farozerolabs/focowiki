import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

const forbiddenTables = [
  "active_object_refs",
  "active_projection_records",
  "active_projection_segments",
  "generation_object_refs",
  "generation_projection_records",
  "generation_projection_segments",
  "generation_search_projection_refs",
  "knowledge_base_optimization_migrations",
  "publication_generations",
  "search_projection_documents",
  "search_projection_segments",
  "source_file_graph_term_documents",
  "source_file_graph_term_frequencies"
] as const;

const forbiddenColumns = [
  "active_generation_id",
  "candidate_generation_id",
  "generation_kind",
  "last_changed_generation_id",
  "predecessor_generation_id",
  "prior_active_generation_id",
  "optimized_active_generation_id",
  "normalized_text",
  "token_text",
  "lexical_vector",
  "entries_json",
  "record_json"
] as const;

describeOwnedDatabase("storage vNext run-owned clean bootstrap integration", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_${ownerToken}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    const bootstrap = readFileSync(
      resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
      "utf8"
    );
    await sql.unsafe(bootstrap);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("contains no legacy, PostgreSQL-search, or full-Generation tables", async () => {
    const rows = await sql<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'focowiki'
      ORDER BY table_name
    `;
    const tableNames = rows.map((row) => row.table_name);

    for (const tableName of forbiddenTables) {
      expect(tableNames, tableName).not.toContain(tableName);
    }
  });

  it("contains no legacy copy, search, or compatibility columns", async () => {
    const rows = await sql<Array<{ column_name: string }>>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'focowiki'
      ORDER BY table_name, ordinal_position
    `;
    const columnNames = rows.map((row) => row.column_name);

    for (const columnName of forbiddenColumns) {
      expect(columnNames, columnName).not.toContain(columnName);
    }
  });

  it("contains no legacy index or constraint families", async () => {
    const indexes = await sql<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'focowiki'
      ORDER BY indexname
    `;
    const constraints = await sql<Array<{ conname: string }>>`
      SELECT catalog_constraint.conname
      FROM pg_constraint catalog_constraint
      JOIN pg_namespace namespace ON namespace.oid = catalog_constraint.connamespace
      WHERE namespace.nspname = 'focowiki'
      ORDER BY catalog_constraint.conname
    `;
    const names = [
      ...indexes.map((row) => row.indexname),
      ...constraints.map((row) => row.conname)
    ];

    for (const prefix of [
      "active_projection_records_",
      "generation_projection_records_",
      "publication_generations_",
      "search_projection_documents_",
      "search_projection_segments_",
      "source_file_graph_term_documents_"
    ]) {
      expect(names.some((name) => name.startsWith(prefix)), prefix).toBe(false);
    }
  });

  it("marks only the storage-vNext generation in a clean database", async () => {
    const rows = await sql<Array<{ generation: string }>>`
      SELECT generation
      FROM focowiki.runtime_generation
      WHERE singleton = true
    `;

    expect(rows).toEqual([{ generation: "storage-vnext-v1" }]);
  });
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
