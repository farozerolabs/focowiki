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
const bootstrap = readFileSync(
  resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
  "utf8"
);
const explicitIndexNames = [...bootstrap.matchAll(
  /CREATE (?:UNIQUE )?INDEX ([a-z0-9_]+) ON /gu
)].map((match) => match[1]!).sort();

describeOwnedDatabase("storage vNext PostgreSQL index plans", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_indexes_${ownerToken}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await sql.unsafe(bootstrap);
    await sql.unsafe("SET enable_seqscan = off");
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

  it("installs exactly the source-declared secondary indexes", async () => {
    const rows = await sql<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'focowiki'
        AND indexname = ANY(${explicitIndexNames})
      ORDER BY indexname
    `;

    expect(rows.map((row) => row.indexname)).toEqual(explicitIndexNames);
  });

  it.each([
    {
      name: "active directory path",
      expectedIndex: "source_directories_active_parent_path_idx",
      query: `
        SELECT public_id
        FROM focowiki.source_directories
        WHERE knowledge_base_id = 'kb-plan'
          AND parent_public_id IS NULL
          AND deleted_at IS NULL
        ORDER BY normalized_path, public_id
        LIMIT 20
      `
    },
    {
      name: "forward graph neighborhood",
      expectedIndex: "graph_edges_from_node_idx",
      query: `
        SELECT public_id
        FROM focowiki.graph_edges
        WHERE knowledge_base_id = 'kb-plan'
          AND from_node_public_id = 'node-plan'
        ORDER BY weight DESC, public_id
        LIMIT 20
      `
    },
    {
      name: "active root object owners",
      expectedIndex: "object_owners_release_root_idx",
      query: `
        SELECT object_id
        FROM focowiki.object_owners
        WHERE knowledge_base_id = 'kb-plan'
          AND release_root_public_id = 'root-plan'
        ORDER BY object_id
        LIMIT 20
      `
    },
    {
      name: "stale object reservation recovery",
      expectedIndex: "object_registrations_stale_reservation_idx",
      query: `
        SELECT object_id
        FROM focowiki.object_registrations
        WHERE state = 'reserved'
          AND created_at <= '2026-08-01T00:00:00.000Z'
        ORDER BY created_at, object_id
        LIMIT 20
      `
    },
    {
      name: "expired release event cleanup",
      expectedIndex: "release_event_summaries_expiry_idx",
      query: `
        SELECT public_id
        FROM focowiki.release_event_summaries
        WHERE expires_at <= '2026-08-01T00:00:00.000Z'
        ORDER BY expires_at, public_id
        LIMIT 20
        FOR UPDATE SKIP LOCKED
      `
    },
    {
      name: "live work claim",
      expectedIndex: "operation_work_items_claim_idx",
      query: `
        SELECT operation_public_id
        FROM focowiki.operation_work_items
        WHERE work_kind = 'source'
          AND state IN ('queued', 'retry')
        ORDER BY next_attempt_at, updated_at, operation_public_id
        LIMIT 20
      `
    },
    {
      name: "stale live work lease recovery",
      expectedIndex: "operation_work_items_lease_idx",
      query: `
        SELECT operation_public_id
        FROM focowiki.operation_work_items
        WHERE state = 'running'
          AND lease_expires_at <= '2026-08-01T00:00:00.000Z'
        ORDER BY lease_expires_at, operation_public_id
        LIMIT 20
        FOR UPDATE SKIP LOCKED
      `
    },
    {
      name: "cleanup action claim",
      expectedIndex: "cleanup_actions_claim_idx",
      query: `
        SELECT public_id
        FROM focowiki.cleanup_actions
        WHERE state IN ('queued', 'retry')
          AND not_before <= '2026-08-01T00:00:00.000Z'
        ORDER BY not_before, sequence_number, updated_at, public_id
        LIMIT 20
        FOR UPDATE SKIP LOCKED
      `
    },
    {
      name: "stale cleanup action lease recovery",
      expectedIndex: "cleanup_actions_lease_idx",
      query: `
        SELECT public_id
        FROM focowiki.cleanup_actions
        WHERE state = 'running'
          AND lease_expires_at <= '2026-08-01T00:00:00.000Z'
        ORDER BY lease_expires_at, public_id
        LIMIT 20
        FOR UPDATE SKIP LOCKED
      `
    },
    {
      name: "bounded operation result timeline",
      expectedIndex: "operation_results_scope_time_idx",
      query: `
        SELECT public_id
        FROM focowiki.operation_results
        WHERE knowledge_base_id = 'kb-plan'
        ORDER BY completed_at DESC, public_id DESC
        LIMIT 20
      `
    },
    {
      name: "knowledge-base audit timeline",
      expectedIndex: "security_audit_events_scope_time_idx",
      query: `
        SELECT public_id
        FROM focowiki.security_audit_events
        WHERE knowledge_base_id = 'kb-plan'
        ORDER BY created_at DESC, public_id
        LIMIT 20
      `
    }
  ])("uses the $name index", async ({ expectedIndex, query }) => {
    const attachedIndexes = await sql<Array<{ index_name: string }>>`
      SELECT child.relname AS index_name
      FROM pg_inherits AS inheritance
      JOIN pg_class AS parent ON parent.oid = inheritance.inhparent
      JOIN pg_namespace AS namespace ON namespace.oid = parent.relnamespace
      JOIN pg_class AS child ON child.oid = inheritance.inhrelid
      WHERE namespace.nspname = 'focowiki'
        AND parent.relname = ${expectedIndex}
      ORDER BY child.relname
    `;
    const plan = await sql.unsafe(`EXPLAIN (FORMAT JSON) ${query}`);
    const planText = JSON.stringify(plan);
    const planIndexes = [
      expectedIndex,
      ...attachedIndexes.map((row) => row.index_name)
    ];

    expect(planIndexes.some((indexName) => planText.includes(indexName))).toBe(true);
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
