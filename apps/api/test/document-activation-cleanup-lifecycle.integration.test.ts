import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { DOCUMENT_WORK_KINDS } from
  "../src/document-indexing/domain/document-work-graph.js";
import { documentFixedWorkPublicId } from
  "../src/document-indexing/domain/document-fixed-work-identity.js";
import { createPostgresDocumentArtifactWorkRepository } from
  "../src/document-indexing/infrastructure/postgres-document-artifact-work-repository.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";
import { seedRequiredDocumentProcessingContract } from
  "./helpers/document-processing-contract.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document activation and cleanup lifecycle", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_document_activation_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const repository = createPostgresDocumentArtifactWorkRepository(
    sql as unknown as DatabaseClient
  );
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await seedDocument();
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

  it("makes the document available at activation while cleanup remains visible", async () => {
    await expect(repository.complete(receipt("activate", "2026-08-16T00:00:07.000Z")))
      .resolves.toBe(true);
    await expect(readJob()).resolves.toEqual([{
      state: "available",
      completed_work_count: 7,
      required_work_count: 8,
      blocking_work_kind: "cleanup",
      terminal_at: new Date("2026-08-16T00:00:07.000Z")
    }]);

    await sql`
      UPDATE focowiki.document_artifact_work
      SET state = 'running', attempt_count = 1,
          lease_owner = 'worker-cleanup',
          lease_expires_at = '2026-08-16T00:02:00.000Z',
          started_at = '2026-08-16T00:00:08.000Z',
          updated_at = '2026-08-16T00:00:08.000Z'
      WHERE public_id = ${documentFixedWorkPublicId("document-job-1", "cleanup")}
    `;
    await expect(repository.complete(receipt("cleanup", "2026-08-16T00:00:09.000Z")))
      .resolves.toBe(true);
    await expect(readJob()).resolves.toEqual([{
      state: "available",
      completed_work_count: 8,
      required_work_count: 8,
      blocking_work_kind: null,
      terminal_at: new Date("2026-08-16T00:00:07.000Z")
    }]);
  });

  it("keeps an available document available when cleanup permanently fails", async () => {
    await sql`
      UPDATE focowiki.document_processing_jobs
      SET state = 'available', completed_work_count = 7,
          blocking_work_kind = 'cleanup',
          terminal_at = '2026-08-16T00:00:07.000Z'
      WHERE public_id = 'document-job-1'
    `;
    await sql`
      UPDATE focowiki.document_artifact_work
      SET state = 'running', attempt_count = maximum_attempts,
          lease_owner = 'worker-cleanup',
          lease_expires_at = '2026-08-16T00:02:00.000Z',
          started_at = '2026-08-16T00:00:08.000Z',
          updated_at = '2026-08-16T00:00:08.000Z'
      WHERE public_id = ${documentFixedWorkPublicId("document-job-1", "cleanup")}
    `;

    await expect(repository.fail({
      publicId: documentFixedWorkPublicId("document-job-1", "cleanup"),
      workerId: "worker-cleanup",
      now: "2026-08-16T00:00:09.000Z",
      errorCode: "PROJECTION_CLEANUP_FAILED",
      safeMessage: null,
      retryable: false,
      nextEligibleAt: null
    })).resolves.toBe("error");

    await expect(readJob()).resolves.toEqual([{
      state: "available",
      completed_work_count: 7,
      required_work_count: 8,
      blocking_work_kind: "cleanup",
      terminal_at: new Date("2026-08-16T00:00:07.000Z")
    }]);
  });

  function receipt(kind: "activate" | "cleanup", now: string) {
    return {
      publicId: documentFixedWorkPublicId("document-job-1", kind),
      workerId: `worker-${kind}`,
      now,
      receipt: {
        kind: kind === "activate" ? "activation" as const : "cleanup" as const,
        key: kind === "activate" ? "current" : "obsolete",
        inputFingerprintSha256: kind === "activate" ? "7".repeat(64) : "8".repeat(64),
        outputFingerprintSha256: kind === "activate" ? "a".repeat(64) : "b".repeat(64),
        value: { state: kind === "activate" ? "available" : "completed" }
      }
    };
  }

  function readJob() {
    return sql<Array<{
      state: string;
      completed_work_count: number;
      required_work_count: number;
      blocking_work_kind: string | null;
      terminal_at: Date;
    }>>`
      SELECT state, completed_work_count, required_work_count,
             blocking_work_kind, terminal_at
      FROM focowiki.document_processing_jobs
      WHERE public_id = 'document-job-1'
    `;
  }

  async function seedDocument(): Promise<void> {
    await sql`
      INSERT INTO focowiki.runtime_setting_revisions (
        public_id, checksum_sha256, settings_values
      ) VALUES ('runtime-1', ${"1".repeat(64)}, '{}'::jsonb)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('knowledge-base-1', 'Activation lifecycle', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('knowledge-base-1', 0)
    `;
    const contract = await seedRequiredDocumentProcessingContract(
      sql,
      "knowledge-base-1"
    );
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, metadata, revision
      ) VALUES (
        'source-file-1', 'knowledge-base-1', 'document.md', 'document.md',
        'Document', '{}'::jsonb, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'object-1', 'document.md', ${"2".repeat(64)}, 10,
        'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
        'write-1', '2026-08-16T00:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES (
        'source-revision-1', 'knowledge-base-1', 'source-file-1', 'object-1',
        ${"2".repeat(64)}, 10, 'text/markdown; charset=utf-8'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence
      ) VALUES (
        'knowledge-base-1', 'source-file-1', 'source-revision-1', NULL, 0
      )
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id
      ) VALUES (
        'operation-1', 'knowledge-base-1', 'source_replace', 'processing',
        'source_file', 'source-file-1'
      )
    `;
    await sql`
      INSERT INTO focowiki.document_processing_jobs (
        public_id, knowledge_base_id, operation_public_id,
        source_file_public_id, source_revision_public_id,
        runtime_settings_revision_public_id,
        generation_model_configuration_public_id,
        generation_model_configuration_revision,
        embedding_configuration_revision_public_id,
        semantic_generation_public_id, semantic_contract_version,
        state, maximum_attempts, required_work_count, completed_work_count,
        accepted_at, started_at, revision, created_at, updated_at
      ) VALUES (
        'document-job-1', 'knowledge-base-1', 'operation-1',
        'source-file-1', 'source-revision-1', 'runtime-1',
        ${contract.generationModelConfigurationPublicId},
        ${contract.generationModelConfigurationRevision},
        ${contract.embeddingConfigurationRevisionPublicId},
        ${contract.semanticGenerationPublicId},
        'document-fixed-dag-v1', 'processing', 3, 8, 6,
        '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z', 1,
        '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z'
      )
    `;
    await repository.createFixedGraph({
      knowledgeBaseId: "knowledge-base-1",
      documentJobPublicId: "document-job-1",
      sourceFilePublicId: "source-file-1",
      sourceRevisionPublicId: "source-revision-1",
      acceptedAt: "2026-08-16T00:00:00.000Z",
      maximumAttempts: 3,
      inputFingerprints: Object.fromEntries(DOCUMENT_WORK_KINDS.map((kind, index) => [
        kind,
        (index + 1).toString(16).repeat(64)
      ])) as Record<(typeof DOCUMENT_WORK_KINDS)[number], string>
    });
    await sql`
      UPDATE focowiki.document_artifact_work
      SET state = CASE
            WHEN work_kind IN (
              'prepare', 'first_layer', 'content_projection', 'graphrag',
              'relation_reconcile', 'knowledge_projection'
            ) THEN 'completed'
            WHEN work_kind = 'activate' THEN 'running'
            ELSE state END,
          attempt_count = CASE WHEN work_kind = 'activate' THEN 1 ELSE attempt_count END,
          lease_owner = CASE WHEN work_kind = 'activate' THEN 'worker-activate' END,
          lease_expires_at = CASE WHEN work_kind = 'activate'
            THEN '2026-08-16T00:02:00.000Z'::timestamptz END,
          started_at = CASE WHEN work_kind = 'activate'
            THEN '2026-08-16T00:00:06.000Z'::timestamptz END,
          ended_at = CASE WHEN work_kind IN (
            'prepare', 'first_layer', 'content_projection', 'graphrag',
            'relation_reconcile', 'knowledge_projection'
          ) THEN '2026-08-16T00:00:06.000Z'::timestamptz END,
          updated_at = '2026-08-16T00:00:06.000Z'
      WHERE document_job_public_id = 'document-job-1'
    `;
  }
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
