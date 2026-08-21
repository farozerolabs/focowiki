import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document indexing breaking boundary", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_breaking_boundary_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 1 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    for (const fileName of [
      "001_storage_vnext.sql",
      "002_document_queue_throughput.sql",
      "003_document_projection_throughput.sql",
      "004_projection_output_object_lifecycle.sql"
    ]) await sql.unsafe(await migration(fileName));
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("rejects persisted application data before mutating the schema", async () => {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('existing-knowledge-base', 'Existing knowledge base', 1)
    `;

    await expect(sql.unsafe(
      await migration("005_clean_document_indexing_boundary.sql")
    )).rejects.toMatchObject({ code: "55000" });

    await expect(sql<Array<{
      generation: string;
      processing_generation_exists: boolean;
    }>>`
      SELECT generation,
             EXISTS (
               SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'focowiki'
                 AND table_name = 'document_processing_jobs'
                 AND column_name = 'processing_generation'
             ) AS processing_generation_exists
      FROM focowiki.runtime_generation
      WHERE singleton = true
    `).resolves.toEqual([{
      generation: "storage-vnext-v12-projection-object-lifecycle",
      processing_generation_exists: false
    }]);
  });
});

async function migration(fileName: string): Promise<string> {
  return readFile(resolve(import.meta.dirname, "../migrations", fileName), "utf8");
}

function withDatabase(connectionUrl: string, database: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
