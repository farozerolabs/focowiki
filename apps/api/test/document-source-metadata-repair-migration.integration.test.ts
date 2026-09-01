import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATION_FILES, readMigrationSql } from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));
const REPAIR_MIGRATION = "021_source_metadata_persistence_repair.sql";
const migrationIndex = MIGRATION_FILES.indexOf(REPAIR_MIGRATION);

(enabled ? describe : describe.skip)("source metadata repair migration", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_metadata_migration_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 2 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    for (const file of MIGRATION_FILES.slice(0, migrationIndex)) {
      await sql.unsafe(readMigrationSql(file));
    }
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("adds resumable repair markers without processing source objects during migrate",
    async () => {
      await expect(sql<Array<{ generation: string }>>`
        SELECT generation FROM focowiki.runtime_generation WHERE singleton = true
      `).resolves.toEqual([{
        generation: "storage-vnext-v28-navigation-leaf-identity-recovery"
      }]);

      await sql.unsafe(readMigrationSql(REPAIR_MIGRATION));

      await expect(sql<Array<{
        metadata_parsed_at: boolean;
        metadata_repair_started_at: boolean;
        repair_index: boolean;
        generation: string;
      }>>`
        SELECT
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'focowiki'
              AND table_name = 'source_revision_presentations'
              AND column_name = 'metadata_parsed_at'
          ) AS metadata_parsed_at,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'focowiki'
              AND table_name = 'source_revision_presentations'
              AND column_name = 'metadata_repair_started_at'
          ) AS metadata_repair_started_at,
          to_regclass(
            'focowiki.source_revision_presentations_metadata_repair_idx'
          ) IS NOT NULL AS repair_index,
          generation
        FROM focowiki.runtime_generation
        WHERE singleton = true
      `).resolves.toEqual([{
        metadata_parsed_at: true,
        metadata_repair_started_at: true,
        repair_index: true,
        generation: "storage-vnext-v29-source-metadata-persistence-repair"
      }]);
    });
});

function withDatabase(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
