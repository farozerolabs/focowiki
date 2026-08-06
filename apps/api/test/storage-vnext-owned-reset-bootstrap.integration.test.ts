import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStorageVnextOwnedScopeProof } from "../src/storage-vnext/bootstrap/owned-scope.js";
import { createStorageVnextPostgresPlane } from "../src/storage-vnext/bootstrap/postgres-plane.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;
const runId = createCanonicalRunId();
const proof = createStorageVnextOwnedScopeProof({
  runId,
  nonceHash: randomBytes(32).toString("hex"),
  createdAt: new Date().toISOString(),
  filesystemScope: join(tmpdir(), runId)
});

describeOwnedDatabase("storage vNext PostgreSQL owned reset/bootstrap", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, proof.postgresScope), { max: 2 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(proof.postgresScope)}`);
    databaseCreated = true;
    await sql.unsafe(`
      CREATE SCHEMA focowiki_validation;
      CREATE TABLE focowiki_validation.run_owner (
        singleton boolean PRIMARY KEY CHECK (singleton),
        run_id text NOT NULL,
        owner_marker text NOT NULL,
        proof_checksum text NOT NULL,
        target text NOT NULL,
        created_by_run boolean NOT NULL CHECK (created_by_run),
        existed_before_run boolean NOT NULL CHECK (NOT existed_before_run)
      );
    `);
    await sql`
      INSERT INTO focowiki_validation.run_owner (
        singleton,
        run_id,
        owner_marker,
        proof_checksum,
        target,
        created_by_run,
        existed_before_run
      ) VALUES (
        true,
        ${proof.runId},
        ${proof.ownerMarker},
        ${proof.proofChecksum},
        ${proof.postgresScope},
        true,
        false
      )
    `;
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(proof.postgresScope)} WITH (FORCE)`
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("runs on standard PostgreSQL 18", async () => {
    const rows = await sql<Array<{ version_number: number }>>`
      SELECT current_setting('server_version_num')::integer AS version_number
    `;
    expect(rows[0]?.version_number).toBeGreaterThanOrEqual(180_000);
    expect(rows[0]?.version_number).toBeLessThan(190_000);
  });

  it("performs clean, repeated, reset, interrupted, and recovered bootstrap deterministically", async () => {
    const plane = createStorageVnextPostgresPlane({ sql });

    expect((await plane.inspect(proof)).bootstrapState).toBe("empty");
    await plane.bootstrap(proof);
    expect(await plane.verifyBootstrap(proof)).toBe(true);
    const firstSignature = await catalogSignature(sql);

    await plane.bootstrap(proof);
    expect(await catalogSignature(sql)).toEqual(firstSignature);

    await plane.reset(proof);
    expect(await plane.verifyReset(proof)).toBe(true);
    expect(await sql<Array<{ marker_exists: boolean }>>`
      SELECT to_regclass('focowiki_validation.run_owner') IS NOT NULL AS marker_exists
    `).toEqual([{ marker_exists: true }]);

    const interrupted = createStorageVnextPostgresPlane({
      sql,
      bootstrapSql: `
        CREATE SCHEMA focowiki;
        CREATE TABLE focowiki.partial_bootstrap (public_id text PRIMARY KEY);
        SELECT 1 / 0;
      `
    });
    await expect(interrupted.bootstrap(proof)).rejects.toThrow();
    expect(await plane.verifyReset(proof)).toBe(true);

    await plane.bootstrap(proof);
    expect(await plane.verifyBootstrap(proof)).toBe(true);
    expect(await catalogSignature(sql)).toEqual(firstSignature);
  }, 120_000);
});

async function catalogSignature(sql: ReturnType<typeof postgres>) {
  const tables = await sql<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'focowiki'
    ORDER BY table_name
  `;
  const generation = await sql<Array<{ generation: string }>>`
    SELECT generation
    FROM focowiki.runtime_generation
    WHERE singleton = true
  `;
  return {
    tables: tables.map((row) => row.table_name),
    generation
  };
}

function createCanonicalRunId(): string {
  const compact = new Date().toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/u, "Z");
  return `svnext-${compact}-${randomBytes(6).toString("hex")}`;
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
