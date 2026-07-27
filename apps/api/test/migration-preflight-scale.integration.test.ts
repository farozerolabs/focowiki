import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectMigrationWork } from "../src/db/migration-preflight.js";
import { applyMigrations } from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const runScaleTest = databaseUrl
  && process.env.FOCOWIKI_RUN_SCALE_QUERY_PLAN_TESTS === "true";
const describeScale = runScaleTest ? describe : describe.skip;

describeScale("migration preflight scale", () => {
  const connectionUrl =
    databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_migration_preflight_scale_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await applyMigrations(sql);
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      SELECT
        'kb-migration-scale-' || value::text,
        'Migration scale ' || value::text
      FROM generate_series(1, 10000) AS value
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_index_maintenance_requests (
        id, knowledge_base_id, trigger_kind, state, settings_revision,
        completed_at, next_attempt_at
      )
      SELECT
        'maintenance-completed-' || value::text,
        'kb-migration-scale-' || value::text,
        'automatic',
        'completed',
        1,
        now(),
        now()
      FROM generate_series(1, 10000) AS value
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_index_maintenance_requests (
        id, knowledge_base_id, trigger_kind, state, settings_revision,
        next_attempt_at
      ) VALUES (
        'maintenance-active-scale',
        'kb-migration-scale-1',
        'manual',
        'queued',
        1,
        now()
      )
    `;
    await sql`ANALYZE focowiki.knowledge_base_index_maintenance_requests`;
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  });

  it("reads only bounded active work through the partial maintenance index", async () => {
    await expect(inspectMigrationWork(sql)).resolves.toMatchObject({
      knowledgeBaseMaintenanceRequests: 1,
      total: 1,
      capped: false
    });

    const plan = await sql<Array<{ "QUERY PLAN": string }>>`
      EXPLAIN (FORMAT TEXT)
      SELECT count(*)
      FROM (
        SELECT 1
        FROM focowiki.knowledge_base_index_maintenance_requests
        WHERE state IN ('queued', 'planning', 'running', 'validating')
        LIMIT 1000001
      ) bounded_maintenance_requests
    `;
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");

    expect(text).toMatch(
      /knowledge_base_index_maintenance_(one_active|claim)_idx/u
    );
    expect(text).not.toContain("Seq Scan");
  });
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}
