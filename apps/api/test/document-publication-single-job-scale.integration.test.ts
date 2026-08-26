import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION } from
  "../src/document-indexing/application/document-publication-renderer-contract.js";
import { fingerprintDocumentPublicationOutputs } from
  "../src/document-indexing/application/document-publication-manifest.js";
import { createPostgresDocumentPublicationActivation } from
  "../src/document-indexing/infrastructure/postgres-document-publication-activation.js";
import { createPostgresDocumentPublicationJobRepository } from
  "../src/document-indexing/infrastructure/postgres-document-publication-job-repository.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("single-job publication scale", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_single_scale_${
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
    await seedReadyDeletionItems();
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("commits more than 256 items through frozen monotonic jobs", async () => {
    const repository = createPostgresDocumentPublicationJobRepository(database);
    const activation = createPostgresDocumentPublicationActivation({
      sql: database
    });
    const first = await repository.admitOne({
      now: "2026-08-26T01:00:02.000Z",
      rendererContractVersion: DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION
    });
    expect(first?.items).toHaveLength(256);
    const frozenFirstMembership = first!.items.map((item) => item.publicId);

    await commitJob({
      repository,
      activation,
      workerId: "scale-worker-a",
      claimAt: "2026-08-26T01:00:03.000Z",
      persistAt: "2026-08-26T01:00:04.000Z",
      activateAt: "2026-08-26T01:00:05.000Z"
    });
    await expect(readProgress()).resolves.toEqual({
      activeRevision: "1",
      availableCount: "256",
      committedItemCount: "256",
      pendingItemCount: "1"
    });
    expect((await repository.readJob(first!.publicId))?.items.map(
      (item) => item.publicId
    )).toEqual(frozenFirstMembership);

    const second = await repository.admitOne({
      now: "2026-08-26T01:00:06.000Z",
      rendererContractVersion: DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION
    });
    expect(second?.items).toHaveLength(1);
    expect(second?.items[0]?.publicId).toBe("scale-item-257");
    await commitJob({
      repository,
      activation,
      workerId: "scale-worker-b",
      claimAt: "2026-08-26T01:00:07.000Z",
      persistAt: "2026-08-26T01:00:08.000Z",
      activateAt: "2026-08-26T01:00:09.000Z"
    });
    await expect(readProgress()).resolves.toEqual({
      activeRevision: "2",
      availableCount: "257",
      committedItemCount: "257",
      pendingItemCount: "0"
    });
    await expect(sql<Array<{ maximum_membership: number | string }>>`
      SELECT max(member_count) AS maximum_membership
      FROM (
        SELECT count(*) AS member_count
        FROM focowiki.publication_job_items
        GROUP BY job_public_id
      ) memberships
    `).resolves.toEqual([{ maximum_membership: "256" }]);
  }, 120_000);

  async function commitJob(input: Readonly<{
    repository: ReturnType<typeof createPostgresDocumentPublicationJobRepository>;
    activation: ReturnType<typeof createPostgresDocumentPublicationActivation>;
    workerId: string;
    claimAt: string;
    persistAt: string;
    activateAt: string;
  }>): Promise<void> {
    const claimed = await input.repository.claimOne({
      workerId: input.workerId,
      now: input.claimAt
    });
    expect(claimed).not.toBeNull();
    const output = [{
      normalizedPath: "index.md",
      logicalPath: "index.md",
      action: "put" as const,
      entryKind: "root-index",
      sourceFilePublicId: null,
      sourceRevisionPublicId: null,
      objectId: "scale-output-object",
      checksumSha256: "2".repeat(64),
      byteCount: 20,
      contentType: "text/markdown; charset=utf-8",
      producerFingerprintSha256: "3".repeat(64),
      navigationMutations: []
    }];
    await expect(input.repository.persistManifest({
      jobPublicId: claimed!.publicId,
      attemptToken: claimed!.attemptToken!,
      fingerprintSha256: fingerprintDocumentPublicationOutputs(output),
      outputs: output,
      persistedAt: input.persistAt
    })).resolves.toBe(true);
    await expect(input.activation.activate({
      jobPublicId: claimed!.publicId,
      attemptToken: claimed!.attemptToken!,
      activatedAt: input.activateAt
    })).resolves.toMatchObject({
      knowledgeBaseId: "single-scale-kb"
    });
  }

  async function readProgress() {
    const rows = await sql<Array<{
      active_revision: number | string;
      available_count: number | string;
      committed_item_count: number | string;
      pending_item_count: number | string;
    }>>`
      SELECT head.active_revision,
             count(job.public_id) FILTER (WHERE job.state = 'available')
               AS available_count,
             count(item.public_id) FILTER (WHERE item.outcome = 'committed')
               AS committed_item_count,
             head.pending_item_count
      FROM focowiki.knowledge_base_publication_heads head
      LEFT JOIN focowiki.document_processing_jobs job
        ON job.knowledge_base_id = head.knowledge_base_id
      LEFT JOIN focowiki.publication_items item
        ON item.document_job_public_id = job.public_id
      WHERE head.knowledge_base_id = 'single-scale-kb'
      GROUP BY head.active_revision, head.pending_item_count
    `;
    return {
      activeRevision: String(rows[0]?.active_revision),
      availableCount: String(rows[0]?.available_count),
      committedItemCount: String(rows[0]?.committed_item_count),
      pendingItemCount: String(rows[0]?.pending_item_count)
    };
  }

  async function seedReadyDeletionItems(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('single-scale-kb', 'Single scale', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('single-scale-kb', 0)
    `;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES
        ('scale-source-object', 'objects/scale-source-object', ${"1".repeat(64)},
         10, 'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
         'scale-source-attempt', '2026-08-26T00:59:00.000Z'),
        ('scale-output-object', 'objects/scale-output-object', ${"2".repeat(64)},
         20, 'text/markdown; charset=utf-8',
         'okf-generated-markdown-v1', 'verified', 'scale-output-attempt',
         '2026-08-26T00:59:00.000Z')
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, created_at, updated_at
      )
      SELECT 'scale-operation-' || sequence,
             'single-scale-kb', 'source_delete', 'processing',
             'source_file', 'scale-source-' || sequence,
             '2026-08-26T01:00:00.000Z'::timestamptz,
             '2026-08-26T01:00:00.000Z'::timestamptz
      FROM generate_series(1, 257) sequence
    `;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, metadata, revision, created_at, updated_at
      )
      SELECT 'scale-source-' || sequence, 'single-scale-kb',
             'documents/' || lpad(sequence::text, 3, '0') || '.md',
             'documents/' || lpad(sequence::text, 3, '0') || '.md',
             'Scale ' || sequence, '{}'::jsonb, 1,
             '2026-08-26T01:00:00.000Z'::timestamptz,
             '2026-08-26T01:00:00.000Z'::timestamptz
      FROM generate_series(1, 257) sequence
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type, created_at
      )
      SELECT 'scale-revision-' || sequence, 'single-scale-kb',
             'scale-source-' || sequence, 'scale-source-object',
             ${"1".repeat(64)}, 10, 'text/markdown; charset=utf-8',
             '2026-08-26T01:00:00.000Z'::timestamptz
      FROM generate_series(1, 257) sequence
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence, updated_at
      )
      SELECT 'single-scale-kb', 'scale-source-' || sequence,
             'scale-revision-' || sequence, 'scale-revision-' || sequence,
             0, '2026-08-26T01:00:00.000Z'::timestamptz
      FROM generate_series(1, 257) sequence
    `;
    await sql.begin(async (rawTransaction) => {
      const transaction = rawTransaction as unknown as typeof sql;
      await transaction`SET LOCAL session_replication_role = replica`;
      await transaction`
        INSERT INTO focowiki.document_processing_jobs (
          public_id, knowledge_base_id, operation_public_id,
          source_file_public_id, source_revision_public_id,
          runtime_settings_revision_public_id,
          generation_model_configuration_public_id,
          generation_model_configuration_revision,
          embedding_configuration_revision_public_id,
          semantic_generation_public_id, semantic_contract_version,
          state, maximum_attempts, required_work_count,
          active_work_kinds, blocking_work_kind,
          accepted_at, started_at, created_at, updated_at
        )
        SELECT 'scale-document-job-' || sequence, 'single-scale-kb',
               'scale-operation-' || sequence, 'scale-source-' || sequence,
               'scale-revision-' || sequence, 'scale-settings',
               'scale-model', 1, 'scale-embedding', 'scale-semantic',
               'scale-contract', 'processing', 3, 2, '{}'::text[],
               'knowledge_projection',
               '2026-08-26T01:00:00.000Z'::timestamptz,
               '2026-08-26T01:00:00.000Z'::timestamptz,
               '2026-08-26T01:00:00.000Z'::timestamptz,
               '2026-08-26T01:00:00.000Z'::timestamptz
        FROM generate_series(1, 257) sequence
      `;
    });
    await sql`
      INSERT INTO focowiki.document_artifact_work (
        public_id, knowledge_base_id, document_job_public_id,
        source_file_public_id, source_revision_public_id, work_kind,
        resource_lane, input_fingerprint_sha256, state, maximum_attempts,
        next_eligible_at, created_at, updated_at
      )
      SELECT 'scale-work-' || work_kind || '-' || sequence,
             'single-scale-kb', 'scale-document-job-' || sequence,
             'scale-source-' || sequence, 'scale-revision-' || sequence,
             work_kind, 'database', ${"4".repeat(64)}, state, 3,
             '2026-08-26T01:00:00.000Z'::timestamptz,
             '2026-08-26T01:00:00.000Z'::timestamptz,
             '2026-08-26T01:00:00.000Z'::timestamptz
      FROM generate_series(1, 257) sequence
      CROSS JOIN (VALUES
        ('knowledge_projection'::text, 'waiting_on_projection'::text),
        ('activate'::text, 'waiting'::text)
      ) work(work_kind, state)
    `;
    await sql`
      INSERT INTO focowiki.publication_items (
        public_id, mutation_public_id, knowledge_base_id,
        document_job_public_id, source_file_public_id,
        source_revision_public_id, operation, prior_logical_path,
        next_logical_path, affected_evidence, readiness_sequence,
        created_at, updated_at
      )
      SELECT 'scale-item-' || lpad(sequence::text, 3, '0'),
             'scale-mutation-' || sequence, 'single-scale-kb',
             'scale-document-job-' || sequence, 'scale-source-' || sequence,
             'scale-revision-' || sequence, 'delete',
             'documents/' || lpad(sequence::text, 3, '0') || '.md', NULL,
             '{}'::jsonb, sequence,
             '2026-08-26T01:00:00.000Z'::timestamptz,
             '2026-08-26T01:00:00.000Z'::timestamptz
      FROM generate_series(1, 257) sequence
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_publication_heads (
        knowledge_base_id, active_revision, active_readiness_sequence,
        latest_readiness_sequence, pending_item_count,
        oldest_pending_at, latest_pending_at, updated_at
      ) VALUES (
        'single-scale-kb', 0, 0, 257, 257,
        '2026-08-26T01:00:00.000Z', '2026-08-26T01:00:00.000Z',
        '2026-08-26T01:00:00.000Z'
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
