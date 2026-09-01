import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresDocumentSourceMetadataRepository } from
  "../src/document-indexing/infrastructure/postgres-document-source-metadata.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document source metadata repair PostgreSQL", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_source_metadata_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 4 });
  const repository = createPostgresDocumentSourceMetadataRepository(
    sql as unknown as DatabaseClient
  );
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('knowledge-base-metadata', 'Metadata repair', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('knowledge-base-metadata', 1)
    `;
    await seedSource(sql, "active", true);
    await seedSource(sql, "inactive", false);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("claims only active missing metadata and completes presentation and file atomically",
    async () => {
      const claimed = await repository.claim({
        now: "2026-09-01T00:00:00.000Z",
        staleBefore: "2026-08-31T23:30:00.000Z",
        limit: 10
      });

      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        sourceFilePublicId: "source-file-active",
        sourceRevisionPublicId: "source-revision-active"
      });
      await expect(repository.complete({
        ...claimed[0]!,
        title: "Active Guide",
        metadata: {
          title: "Active Guide",
          resource: "https://example.test/active"
        },
        completedAt: "2026-09-01T00:01:00.000Z"
      })).resolves.toBe(true);
      await expect(sql<Array<{
        title: string;
        metadata: Record<string, unknown>;
        presentation_title: string;
        presentation_metadata: Record<string, unknown>;
        metadata_parsed_at: Date | null;
      }>>`
        SELECT source.title, source.metadata,
               presentation.title AS presentation_title,
               presentation.metadata AS presentation_metadata,
               presentation.metadata_parsed_at
        FROM focowiki.source_files source
        JOIN focowiki.source_revision_presentations presentation
          ON presentation.knowledge_base_id = source.knowledge_base_id
         AND presentation.source_file_public_id = source.public_id
        WHERE source.public_id = 'source-file-active'
      `).resolves.toEqual([{
        title: "Active Guide",
        metadata: {
          title: "Active Guide",
          resource: "https://example.test/active"
        },
        presentation_title: "Active Guide",
        presentation_metadata: {
          title: "Active Guide",
          resource: "https://example.test/active"
        },
        metadata_parsed_at: expect.any(Date)
      }]);
      await expect(repository.complete({
        ...claimed[0]!,
        title: "Stale overwrite",
        metadata: {},
        completedAt: "2026-09-01T00:02:00.000Z"
      })).resolves.toBe(false);
    });

  it("marks newly prepared revisions so they never enter stock repair", async () => {
    await repository.persistPrepared({
      knowledgeBaseId: "knowledge-base-metadata",
      sourceFilePublicId: "source-file-inactive",
      sourceRevisionPublicId: "source-revision-inactive",
      title: "Prepared Guide",
      metadata: { title: "Prepared Guide", custom: "retained" },
      parsedAt: "2026-09-01T00:03:00.000Z"
    });

    await expect(sql<Array<{
      title: string;
      metadata: Record<string, unknown>;
      metadata_parsed_at: Date | null;
    }>>`
      SELECT title, metadata, metadata_parsed_at
      FROM focowiki.source_revision_presentations
      WHERE source_revision_public_id = 'source-revision-inactive'
    `).resolves.toEqual([{
      title: "Prepared Guide",
      metadata: { title: "Prepared Guide", custom: "retained" },
      metadata_parsed_at: expect.any(Date)
    }]);
  });
});

async function seedSource(
  sql: ReturnType<typeof postgres>,
  suffix: string,
  active: boolean
): Promise<void> {
  const checksum = (active ? "a" : "b").repeat(64);
  await sql`
    INSERT INTO focowiki.object_registrations (
      object_id, storage_key, checksum_sha256, byte_count, content_type,
      object_format, state, write_attempt_public_id, verified_at
    ) VALUES (
      ${`source-sha256:${suffix}`}, ${`source/${suffix}.md`}, ${checksum}, 10,
      'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
      ${`write-${suffix}`}, now()
    )
  `;
  await sql`
    INSERT INTO focowiki.source_files (
      public_id, knowledge_base_id, logical_path, normalized_path,
      title, metadata, revision
    ) VALUES (
      ${`source-file-${suffix}`}, 'knowledge-base-metadata',
      ${`${suffix}.md`}, ${`${suffix}.md`}, ${suffix}, '{}'::jsonb, 1
    )
  `;
  await sql`
    INSERT INTO focowiki.source_revisions (
      public_id, knowledge_base_id, source_file_public_id, object_id,
      checksum_sha256, byte_count, content_type
    ) VALUES (
      ${`source-revision-${suffix}`}, 'knowledge-base-metadata',
      ${`source-file-${suffix}`}, ${`source-sha256:${suffix}`}, ${checksum}, 10,
      'text/markdown; charset=utf-8'
    )
  `;
  await sql`
    INSERT INTO focowiki.source_revision_presentations (
      knowledge_base_id, source_file_public_id, source_revision_public_id,
      logical_path, normalized_path, title, metadata
    ) VALUES (
      'knowledge-base-metadata', ${`source-file-${suffix}`},
      ${`source-revision-${suffix}`}, ${`${suffix}.md`}, ${`${suffix}.md`},
      ${suffix}, '{}'::jsonb
    )
  `;
  await sql`
    INSERT INTO focowiki.source_file_active_revisions (
      knowledge_base_id, source_file_public_id,
      current_source_revision_public_id, active_source_revision_public_id,
      activation_sequence
    ) VALUES (
      'knowledge-base-metadata', ${`source-file-${suffix}`},
      ${`source-revision-${suffix}`},
      ${active ? `source-revision-${suffix}` : null}, 1
    )
  `;
}

function withDatabase(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
