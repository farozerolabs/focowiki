import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/db/migrations.js";
import {
  summarizeQueryPlan,
  type QueryPlanSummary
} from "../src/db/query-plan-validation.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase.sequential("indexed storage reconciliation query plans", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_reconciliation_plan_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), {
    max: 1,
    onnotice: () => {}
  });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), {
    max: 4,
    onnotice: () => {}
  });
  const prefix = "query-plan/storage/generated/";
  let fixtureSize = 0;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
    await sql.unsafe(`
      ALTER TABLE focowiki.immutable_objects
      DISABLE TRIGGER immutable_objects_storage_protection_trigger
    `);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await admin.end({ timeout: 5 });
  });

  it.each([
    { label: "10,000", size: 10_000 },
    { label: "100,000", size: 100_000 }
  ])(
    "keeps exact lookup, dirty claim, keyset backfill, and final authorization bounded at $label identities",
    async ({ size }) => {
      await growFixture(size);
      const plans = {
        exactLookup: await explainExactLookup(),
        dirtyClaim: await explainDirtyClaim(),
        keysetBackfill: await explainKeysetBackfill(size),
        finalAuthorization: await explainFinalAuthorization()
      };

      expectBounded(plans.exactLookup, [
        "storage_object_protection_index"
      ]);
      expectBounded(plans.dirtyClaim, [
        "storage_object_protection_dirty"
      ]);
      expectBounded(plans.keysetBackfill, [
        "immutable_objects"
      ]);
      expectBounded(plans.finalAuthorization, [
        "storage_object_protection_index",
        "immutable_objects"
      ]);

      for (const plan of Object.values(plans)) {
        expect(plan.actualRows).toBeLessThan(2_000);
        expect(plan.rowsRemovedByFilter).toBeLessThan(2_000);
        expect(plan.executionTimeMs ?? Number.POSITIVE_INFINITY).toBeLessThan(
          5_000
        );
      }
    },
    120_000
  );

  async function growFixture(targetSize: number): Promise<void> {
    if (fixtureSize >= targetSize) return;
    const start = fixtureSize;
    const end = targetSize - 1;
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key,
        content_type, size_bytes, lifecycle_state, verified_at
      )
      SELECT
        lpad(to_hex(value), 64, '0'),
        1,
        ${prefix} || 'v1/objects/' ||
          substring(lpad(to_hex(value), 64, '0'), 1, 2) || '/' ||
          lpad(to_hex(value), 64, '0'),
        'application/json',
        64,
        'active',
        now()
      FROM generate_series(${start}::bigint, ${end}::bigint) AS value
    `;
    await sql`
      INSERT INTO focowiki.storage_object_protection_index (
        object_key, checksum_sha256, format_version,
        protected, dirty, revision, protection_classes
      )
      SELECT
        ${prefix} || 'v1/objects/' ||
          substring(lpad(to_hex(value), 64, '0'), 1, 2) || '/' ||
          lpad(to_hex(value), 64, '0'),
        lpad(to_hex(value), 64, '0'),
        1,
        true,
        true,
        1,
        ARRAY['registered']::text[]
      FROM generate_series(${start}::bigint, ${end}::bigint) AS value
    `;
    await sql`
      INSERT INTO focowiki.storage_object_protection_dirty (
        object_key, checksum_sha256, format_version, reason
      )
      SELECT
        ${prefix} || 'v1/objects/' ||
          substring(lpad(to_hex(value), 64, '0'), 1, 2) || '/' ||
          lpad(to_hex(value), 64, '0'),
        lpad(to_hex(value), 64, '0'),
        1,
        'query_plan_fixture'
      FROM generate_series(${start}::bigint, ${end}::bigint) AS value
    `;
    await sql.unsafe("ANALYZE focowiki.immutable_objects");
    await sql.unsafe("ANALYZE focowiki.storage_object_protection_index");
    await sql.unsafe("ANALYZE focowiki.storage_object_protection_dirty");
    fixtureSize = targetSize;
  }

  async function explainExactLookup(): Promise<QueryPlanSummary> {
    const checksums = Array.from(
      { length: 100 },
      (_, index) => index.toString(16).padStart(64, "0")
    );
    const keys = checksums.map(
      (checksum) => `${prefix}v1/objects/${checksum.slice(0, 2)}/${checksum}`
    );
    return explain(sql`
      SELECT listed.object_key
      FROM unnest(
        ${keys}::text[],
        ${checksums}::text[],
        ${checksums.map(() => 1)}::int[]
      ) AS listed(object_key, checksum_sha256, format_version)
      CROSS JOIN LATERAL (
        SELECT indexed.protected, indexed.dirty
        FROM focowiki.storage_object_protection_index indexed
        WHERE indexed.object_key = listed.object_key
          AND indexed.checksum_sha256 = listed.checksum_sha256
          AND indexed.format_version = listed.format_version
        LIMIT 1
      ) protection
      WHERE protection.protected OR protection.dirty
    `);
  }

  async function explainDirtyClaim(): Promise<QueryPlanSummary> {
    return explain(sql`
      SELECT object_key, checksum_sha256, format_version, revision
      FROM focowiki.storage_object_protection_dirty
      WHERE state IN ('pending', 'retry')
        AND next_attempt_at <= now()
        AND (
          lease_expires_at IS NULL
          OR lease_expires_at <= now()
          OR lease_token = 'query-plan-owner'
        )
      ORDER BY object_key, checksum_sha256, format_version
      LIMIT 100
      FOR UPDATE SKIP LOCKED
    `);
  }

  async function explainKeysetBackfill(size: number): Promise<QueryPlanSummary> {
    const cursor = Math.floor(size / 2).toString(16).padStart(64, "0");
    return explain(sql`
      SELECT object_key, checksum_sha256, format_version
      FROM focowiki.immutable_objects
      WHERE object_key > ${
        `${prefix}v1/objects/${cursor.slice(0, 2)}/${cursor}`
      }
      ORDER BY object_key
      LIMIT 100
    `);
  }

  async function explainFinalAuthorization(): Promise<QueryPlanSummary> {
    const checksum = "ff".repeat(32);
    const objectKey = `${prefix}v1/objects/ff/${checksum}`;
    return explain(sql`
      SELECT
        EXISTS (
          SELECT 1
          FROM focowiki.storage_object_protection_index protection
          WHERE protection.object_key = ${objectKey}
            AND protection.checksum_sha256 = ${checksum}
            AND protection.format_version = 1
            AND (protection.protected OR protection.dirty)
        ) AS projection_conflict,
        EXISTS (
          SELECT 1
          FROM focowiki.immutable_objects object
          WHERE object.object_key = ${objectKey}
            AND object.checksum_sha256 = ${checksum}
            AND object.format_version = 1
        ) AS authoritative_conflict
    `);
  }

  async function explain(
    query: ReturnType<typeof sql>
  ): Promise<QueryPlanSummary> {
    const rows = await sql<Array<{ "QUERY PLAN": unknown }>>`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}
    `;
    return summarizeQueryPlan(rows[0]?.["QUERY PLAN"]);
  }
});

function expectBounded(
  plan: QueryPlanSummary,
  corpusRelations: string[]
): void {
  for (const relation of corpusRelations) {
    expect(plan.relationNames).toContain(relation);
    expect(plan.sequentialScanRelations).not.toContain(relation);
  }
}

function databaseConnectionUrl(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
