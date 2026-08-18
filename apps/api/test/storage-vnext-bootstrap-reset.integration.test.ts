import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { assertRuntimeSchemaGeneration } from "../src/db/migrations.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

const requiredTables = [
  "knowledge_bases",
  "source_revisions",
  "source_file_active_revisions",
  "document_processing_jobs",
  "document_artifact_work",
  "document_artifact_receipts",
  "document_graphrag_chunks",
  "relation_candidate_pairs",
  "relation_directed_evidence",
  "canonical_file_relations",
  "search_family_receipts",
  "generated_page_bases",
  "projection_dirty_scopes",
  "projection_scope_storage_metrics",
  "document_projection_waiting_completions",
  "scoped_activation_owners",
  "knowledge_base_sequences",
  "cleanup_actions",
  "runtime_generation"
] as const;

const removedTables = [
  "knowledge_base_activation_revisions",
  "knowledge_base_activation_changes",
  "source_artifact_bundles",
  "processing_stage_work_items",
  "processing_stage_dependencies",
  "release_candidates",
  "release_roots",
  "active_snapshots"
] as const;

describeOwnedDatabase("storage vNext fixed-DAG clean bootstrap", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = "focowiki_vnext_" + ownerToken + "_"
    + randomUUID().replaceAll("-", "").slice(0, 10);
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe("CREATE DATABASE " + quoteIdentifier(databaseName));
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(
        "DROP DATABASE IF EXISTS " + quoteIdentifier(databaseName) + " WITH (FORCE)"
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("creates only the final fixed-DAG authorities from an absent database", async () => {
    const rows = await sql.unsafe<Array<{ table_name: string }>>(
      "SELECT table_name FROM information_schema.tables "
      + "WHERE table_schema = 'focowiki' ORDER BY table_name"
    );
    const names = rows.map((row) => row.table_name);
    for (const table of requiredTables) expect(names, table).toContain(table);
    for (const table of removedTables) expect(names, table).not.toContain(table);
  });

  it("contains no intermediate phase or generic bundle columns", async () => {
    const rows = await sql.unsafe<Array<{ table_name: string; column_name: string }>>(
      "SELECT table_name, column_name FROM information_schema.columns "
      + "WHERE table_schema = 'focowiki' AND ("
      + "(table_name = 'document_processing_jobs' "
      + "AND column_name IN ('phase', 'checkpoint', 'lease_owner', 'lease_expires_at')) "
      + "OR column_name = 'source_artifact_bundle_public_id')"
    );
    expect(rows).toEqual([]);
  });

  it("uses the closed work vocabulary without a dependency table", async () => {
    const rows = await sql.unsafe<Array<{ definition: string }>>(
      "SELECT pg_get_constraintdef(constraint_catalog.oid) AS definition "
      + "FROM pg_constraint constraint_catalog "
      + "JOIN pg_namespace namespace ON namespace.oid = constraint_catalog.connamespace "
      + "WHERE namespace.nspname = 'focowiki' "
      + "AND constraint_catalog.conname = 'document_artifact_work_kind_check'"
    );
    expect(rows).toHaveLength(1);
    for (const kind of [
      "prepare",
      "first_layer",
      "content_projection",
      "graphrag",
      "relation_reconcile",
      "knowledge_projection",
      "activate",
      "cleanup"
    ]) expect(rows[0]!.definition).toContain(kind);
    expect(await sql.unsafe<Array<{ relation: string | null }>>(
      "SELECT to_regclass('focowiki.document_work_dependencies')::text AS relation"
    )).toEqual([{ relation: null }]);
  });

  it("accepts the exact generation and rejects signature drift", async () => {
    const database = sql as unknown as DatabaseClient;
    await expect(assertRuntimeSchemaGeneration(database)).resolves.toBeUndefined();
    const rollback = new Error("rollback fixed-DAG signature fixture");

    await expect(sql.begin(async (transaction) => {
      await transaction.unsafe(
        "ALTER TABLE focowiki.document_artifact_work DROP COLUMN work_kind CASCADE"
      );
      await expect(assertRuntimeSchemaGeneration(
        transaction as unknown as DatabaseClient
      )).rejects.toMatchObject({ name: "RuntimeSchemaSignatureError" });
      throw rollback;
    })).rejects.toBe(rollback);

    await expect(assertRuntimeSchemaGeneration(database)).resolves.toBeUndefined();
  });

  it("records only the terminal runtime generation", async () => {
    await expect(sql.unsafe<Array<{ generation: string }>>(
      "SELECT generation FROM focowiki.runtime_generation WHERE singleton = true"
    )).resolves.toEqual([{ generation: "storage-vnext-v9-document-indexing-hybrid" }]);
  });
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = "/" + databaseName;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return "\"" + value.replaceAll("\"", "\"\"") + "\"";
}
