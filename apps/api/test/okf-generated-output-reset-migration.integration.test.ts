import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const runResetMigration = process.env.FOCOWIKI_RUN_OKF_RESET_MIGRATION === "1";
const describeMigration = databaseUrl && runResetMigration ? describe : describe.skip;

describeMigration("OKF generated output reset migration", () => {
  const sql = postgres(databaseUrl!, { max: 1 });

  beforeAll(async () => {
    const database = await sql<Array<{ name: string }>>`SELECT current_database() AS name`;
    if (database[0]?.name !== "focowiki_okf_migration_test") {
      throw new Error("OKF reset migration tests require the isolated focowiki_okf_migration_test database.");
    }

    await sql.unsafe("DROP SCHEMA IF EXISTS focowiki CASCADE");
    await sql.unsafe(await readMigration("001_production_admin_web.sql"));
    await sql.unsafe(await readFixture("okf-reset-legacy.sql"));
    await sql.begin(async (transaction) => {
      await transaction.unsafe(await readMigration("002_okf_google_v0_1_reset.sql"));
    });
  }, 60_000);

  afterAll(async () => {
    await sql.unsafe("DROP SCHEMA IF EXISTS focowiki CASCADE");
    await sql.end({ timeout: 5 });
  });

  it("retains source evidence while removing generated state and scheduling one rebuild", async () => {
    const retained = await sql<Array<{
      object_key: string;
      metadata_json: Record<string, unknown>;
      generated_output_status: string;
      generated_bundle_file_id: string | null;
      generated_bundle_file_path: string | null;
      revision_count: number;
      event_count: number;
    }>>`
      SELECT source.object_key,
             source.metadata_json,
             source.generated_output_status,
             source.generated_bundle_file_id,
             source.generated_bundle_file_path,
             (SELECT count(*)::int FROM focowiki.source_revisions revision
               WHERE revision.source_file_id = source.id) AS revision_count,
             (SELECT count(*)::int FROM focowiki.source_file_events event
               WHERE event.source_file_id = source.id) AS event_count
      FROM focowiki.source_files source
      WHERE source.id = 'source-reset-test'
    `;
    expect(retained).toEqual([{
      object_key: "sources/retained.md",
      metadata_json: { title: "Retained" },
      generated_output_status: "pending",
      generated_bundle_file_id: null,
      generated_bundle_file_path: null,
      revision_count: 1,
      event_count: 1
    }]);

    const generated = await sql<Array<{
      active_release_id: string | null;
      release_count: number;
      bundle_file_count: number;
      publication_status: string;
      publication_release_id: string | null;
    }>>`
      SELECT knowledge_base.active_release_id,
             (SELECT count(*)::int FROM focowiki.releases
               WHERE knowledge_base_id = knowledge_base.id) AS release_count,
             (SELECT count(*)::int FROM focowiki.bundle_files
               WHERE knowledge_base_id = knowledge_base.id) AS bundle_file_count,
             publication.status AS publication_status,
             publication.release_id AS publication_release_id
      FROM focowiki.knowledge_bases knowledge_base
      JOIN focowiki.publication_jobs publication
        ON publication.knowledge_base_id = knowledge_base.id
      WHERE knowledge_base.id = 'kb-reset-test'
    `;
    expect(generated).toEqual([{
      active_release_id: null,
      release_count: 0,
      bundle_file_count: 0,
      publication_status: "failed",
      publication_release_id: null
    }]);

    const reset = await sql<Array<{
      prefix: string;
      reset_job_count: number;
      cancelled_publication_job_count: number;
    }>>`
      SELECT prefix.prefix,
             (SELECT count(*)::int FROM focowiki.worker_jobs job
               WHERE job.knowledge_base_id = prefix.knowledge_base_id
                 AND job.kind = 'generated_output_reset'
                 AND job.status = 'queued') AS reset_job_count,
             (SELECT count(*)::int FROM focowiki.worker_jobs job
               WHERE job.knowledge_base_id = prefix.knowledge_base_id
                 AND job.kind = 'publication'
                 AND job.status = 'cancelled') AS cancelled_publication_job_count
      FROM focowiki.generated_output_reset_prefixes prefix
      WHERE prefix.knowledge_base_id = 'kb-reset-test'
    `;
    expect(reset).toEqual([{
      prefix: "generated/releases/reset/",
      reset_job_count: 1,
      cancelled_publication_job_count: 1
    }]);
  });
});

function readMigration(name: string): Promise<string> {
  return readFile(resolve(import.meta.dirname, "../migrations", name), "utf8");
}

function readFixture(name: string): Promise<string> {
  return readFile(resolve(import.meta.dirname, "fixtures", name), "utf8");
}
