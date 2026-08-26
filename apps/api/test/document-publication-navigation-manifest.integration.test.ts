import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { fingerprintDocumentPublicationOutputs } from
  "../src/document-indexing/application/document-publication-manifest.js";
import { createPostgresDocumentPublicationJobRepository } from
  "../src/document-indexing/infrastructure/postgres-document-publication-job-repository.js";
import { activatePostgresDocumentPublicationPages } from
  "../src/document-indexing/infrastructure/postgres-document-publication-page-activation.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("publication navigation manifest", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_navigation_manifest_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 8 });
  const database = sql as unknown as DatabaseClient;
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await seed();
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("persists and activates navigation larger than 64 KiB", async () => {
    const repository = createPostgresDocumentPublicationJobRepository(database);
    await repository.createItem({
      publicId: "navigation-item",
      mutationPublicId: "navigation-mutation",
      knowledgeBaseId: "navigation-kb",
      documentJobPublicId: null,
      sourceFilePublicId: "navigation-source",
      sourceRevisionPublicId: "navigation-revision",
      operation: "delete",
      priorLogicalPath: "large/file.md",
      nextLogicalPath: null,
      affectedEvidence: {},
      readinessSequence: 1,
      createdAt: "2026-08-26T10:00:00.000Z"
    });
    await repository.admitOne({
      now: "2026-08-26T10:00:02.000Z",
      rendererContractVersion: "portable-okf-v5"
    });
    const job = await repository.claimOne({
      workerId: "navigation-worker",
      now: "2026-08-26T10:00:03.000Z"
    });
    expect(job).not.toBeNull();
    const entries = Array.from({ length: 400 }, (_, index) => ({
      id: `entry-${index}`,
      sortKey: `${String(index).padStart(4, "0")}-${"s".repeat(160)}`,
      name: `Document ${index} ${"n".repeat(160)}`,
      targetPath: `pages/large/document-${index}.md`,
      kind: "file" as const
    }));
    const output = [{
      normalizedPath: "pages/large/index.md",
      logicalPath: "pages/large/index.md",
      action: "put" as const,
      entryKind: "directory-index",
      sourceFilePublicId: null,
      sourceRevisionPublicId: null,
      objectId: "navigation-output-object",
      checksumSha256: "2".repeat(64),
      byteCount: 20,
      contentType: "text/markdown; charset=utf-8",
      producerFingerprintSha256: "3".repeat(64),
      navigationMutations: [{
        directoryPath: "pages/large",
        touchedLeaves: [{
          id: "navigation-leaf",
          previousLeafId: null,
          nextLeafId: null,
          revision: 1,
          entries
        }],
        removedLeafIds: []
      }]
    }];
    expect(Buffer.byteLength(JSON.stringify(
      output[0]!.navigationMutations), "utf8")).toBeGreaterThan(65_536);
    await expect(repository.persistManifest({
      jobPublicId: job!.publicId,
      attemptToken: job!.attemptToken!,
      fingerprintSha256: fingerprintDocumentPublicationOutputs(output),
      outputs: output,
      persistedAt: "2026-08-26T10:00:04.000Z"
    })).resolves.toBe(true);
    await sql.begin(async (transaction) => {
      await activatePostgresDocumentPublicationPages({
        transaction: transaction as unknown as DatabaseClient,
        jobPublicId: job!.publicId,
        knowledgeBaseId: "navigation-kb",
        targetReadinessSequence: 1,
        activatedAt: "2026-08-26T10:00:05.000Z"
      });
    });
    await expect(sql<Array<{
      output_navigation_bytes: number | string;
      normalized_entry_count: number | string;
      active_entry_count: number | string;
    }>>`
      SELECT
        (SELECT octet_length(navigation_mutations::text)
         FROM focowiki.publication_job_outputs
         WHERE job_public_id = ${job!.publicId}) AS output_navigation_bytes,
        (SELECT count(*) FROM focowiki.publication_job_navigation_entries
         WHERE job_public_id = ${job!.publicId}) AS normalized_entry_count,
        (SELECT count(*) FROM focowiki.generated_directory_leaf_entries
         WHERE knowledge_base_id = 'navigation-kb'
           AND directory_path = 'pages/large') AS active_entry_count
    `).resolves.toEqual([{
      output_navigation_bytes: 2,
      normalized_entry_count: "400",
      active_entry_count: "400"
    }]);
  }, 120_000);

  async function seed(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('navigation-kb', 'Navigation', 1)
    `;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'navigation-output-object', 'objects/navigation-output-object',
        ${"2".repeat(64)}, 20, 'text/markdown; charset=utf-8',
        'okf-generated-markdown-v1', 'verified', 'navigation-output-attempt',
        '2026-08-26T10:00:00.000Z'
      )
    `;
  }
});

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
