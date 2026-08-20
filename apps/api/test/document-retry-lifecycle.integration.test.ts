import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresDocumentRetry } from
  "../src/document-indexing/infrastructure/postgres-document-retry.js";
import { createPostgresDocumentTaskRemoval } from
  "../src/document-indexing/infrastructure/postgres-document-task-removal.js";
import { createPostgresDocumentRevisionPurge } from
  "../src/document-indexing/infrastructure/postgres-document-revision-purge.js";
import { createPostgresDocumentArtifactWorkRepository } from
  "../src/document-indexing/infrastructure/postgres-document-artifact-work-repository.js";
import { createPostgresProjectionDirtyScopeRepository } from
  "../src/document-indexing/infrastructure/postgres-projection-dirty-scope-repository.js";
import { createPostgresProjectionScopeContributions } from
  "../src/document-indexing/infrastructure/postgres-projection-scope-contributions.js";
import { createPostgresGeneratedPageRepository } from
  "../src/document-indexing/infrastructure/postgres-generated-page-repository.js";
import { DOCUMENT_WORK_KINDS } from
  "../src/document-indexing/domain/document-work-graph.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";
import { seedRequiredDocumentProcessingContract } from
  "./helpers/document-processing-contract.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document retry lifecycle PostgreSQL", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_document_retry_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const retry = createPostgresDocumentRetry(sql as unknown as DatabaseClient);
  const removeTasks = createPostgresDocumentTaskRemoval(sql as unknown as DatabaseClient);
  const revisionPurge = createPostgresDocumentRevisionPurge(
    sql as unknown as DatabaseClient
  );
  let databaseCreated = false;
  let processingContract!: Awaited<ReturnType<
    typeof seedRequiredDocumentProcessingContract
  >>;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await sql`
      INSERT INTO focowiki.runtime_setting_revisions (
        public_id, checksum_sha256, settings_values
      ) VALUES ('runtime-retry', ${"1".repeat(64)}, '{}'::jsonb)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('knowledge-base-retry', 'Retry', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('knowledge-base-retry', 0)
    `;
    processingContract = await seedRequiredDocumentProcessingContract(
      sql,
      "knowledge-base-retry"
    );
    await seedFailedDocument({
      sourceFilePublicId: "source-file-retryable",
      sourceRevisionPublicId: "source-revision-retryable",
      operationPublicId: "operation-retryable",
      documentJobPublicId: "document-job-retryable",
      retryable: true
    });
    await seedFailedDocument({
      sourceFilePublicId: "source-file-upload-retryable",
      sourceRevisionPublicId: "source-revision-upload-retryable",
      operationPublicId: "operation-upload-retryable",
      documentJobPublicId: "document-job-upload-retryable",
      operationKind: "upload",
      retryable: true
    });
    await seedFailedDocument({
      sourceFilePublicId: "source-file-directory-move-retryable",
      sourceRevisionPublicId: "source-revision-directory-move-retryable",
      operationPublicId: "operation-directory-move-retryable",
      documentJobPublicId: "document-job-directory-move-retryable",
      operationKind: "source_directory_move",
      retryable: true
    });
    await seedFailedDocument({
      sourceFilePublicId: "source-file-deterministic",
      sourceRevisionPublicId: "source-revision-deterministic",
      operationPublicId: "operation-deterministic",
      documentJobPublicId: "document-job-deterministic",
      retryable: false
    });
    await seedFailedDocument({
      sourceFilePublicId: "source-file-replacement",
      sourceRevisionPublicId: "source-revision-replacement-failed",
      operationPublicId: "operation-replacement",
      documentJobPublicId: "document-job-replacement",
      retryable: false
    });
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'object-replacement-active', 'replacement-active.md', ${"3".repeat(64)},
        18, 'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
        'write-replacement-active', '2026-08-14T08:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES (
        'source-revision-replacement-active', 'knowledge-base-retry',
        'source-file-replacement', 'object-replacement-active',
        ${"3".repeat(64)}, 18, 'text/markdown; charset=utf-8'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revision_presentations (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, metadata
      ) VALUES (
        'knowledge-base-retry', 'source-file-replacement',
        'source-revision-replacement-active', 'replacement.md',
        'replacement.md', 'Replacement active', '{}'::jsonb
      )
    `;
    await sql`
      UPDATE focowiki.source_file_active_revisions
      SET active_source_revision_public_id = 'source-revision-replacement-active'
      WHERE source_file_public_id = 'source-file-replacement'
    `;
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

  it("reopens only the current retryable error job and clears stale presentation", async () => {
    const dirtyScopes = createPostgresProjectionDirtyScopeRepository(
      sql as unknown as DatabaseClient
    );
    const scopePublicId = await dirtyScopes.mark({
      knowledgeBaseId: "knowledge-base-retry",
      kind: "source",
      key: "source-file-retryable",
      requiredSequence: 5,
      nextEligibleAt: "2026-08-14T09:59:00.000Z"
    });
    const [claimedScope] = await dirtyScopes.claim({
      workerId: "scope-retry-test",
      now: "2026-08-14T09:59:01.000Z",
      leaseDurationMs: 1_000,
      limit: 1
    });
    await expect(dirtyScopes.fail({
      publicId: claimedScope!.publicId,
      workerId: "scope-retry-test",
      now: "2026-08-14T09:59:02.000Z",
      errorCode: "portable_record_invalid",
      retryable: true,
      nextEligibleAt: null
    })).resolves.toBe("error");
    await createPostgresProjectionScopeContributions(
      sql as unknown as DatabaseClient
    ).contribute({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFilePublicId: "source-file-retryable",
      sourceRevisionPublicId: "source-revision-retryable",
      documentJobPublicId: "document-job-retryable",
      scopes: [{ publicId: scopePublicId, requiredSequence: 5 }]
    });

    await expect(retry({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFilePublicId: "source-file-retryable",
      retriedAt: "2026-08-14T10:00:00.000Z"
    })).resolves.toMatchObject({
      outcome: "accepted",
      documentJobPublicId: "document-job-retryable",
      retryCount: 3,
      jobRevision: 5
    });
    await expect(sql<Array<{
      state: string;
      blocking_work_kind: string | null;
      attempt_count: number;
      maximum_attempts: number;
      failure_count: number;
      total_attempt_count: number | string;
      manual_retry_count: number;
      completed_work_count: number;
      started_at: string | Date | null;
      terminal_at: string | null;
      safe_error_code: string | null;
      retryable: boolean;
      model_status: string | null;
      operation_state: string;
      result_count: number;
    }>>`
      SELECT job.state, job.blocking_work_kind, job.attempt_count,
             job.maximum_attempts,
             job.failure_count, job.total_attempt_count,
             job.manual_retry_count, job.completed_work_count, job.started_at,
             job.terminal_at,
             job.safe_error_code, job.retryable, job.model_status,
             operation.state AS operation_state,
             count(result.public_id)::integer AS result_count
      FROM focowiki.document_processing_jobs job
      JOIN focowiki.operations operation
        ON operation.knowledge_base_id = job.knowledge_base_id
       AND operation.public_id = job.operation_public_id
      LEFT JOIN focowiki.operation_results result
        ON result.knowledge_base_id = operation.knowledge_base_id
       AND result.public_id = operation.public_id
      WHERE job.public_id = 'document-job-retryable'
      GROUP BY job.public_id, operation.public_id
    `).resolves.toEqual([{
      state: "waiting",
      blocking_work_kind: "first_layer",
      attempt_count: 0,
      maximum_attempts: 3,
      failure_count: 0,
      total_attempt_count: "3",
      manual_retry_count: 1,
      completed_work_count: 0,
      started_at: new Date("2026-08-14T09:00:00.000Z"),
      terminal_at: null,
      safe_error_code: null,
      retryable: false,
      model_status: null,
      operation_state: "processing",
      result_count: 0
    }]);
    await expect(sql<Array<{
      state: string;
      attempt_count: number;
      safe_error_code: string | null;
      retryable: boolean;
    }>>`
      SELECT state, attempt_count, safe_error_code, retryable
      FROM focowiki.projection_dirty_scopes
      WHERE public_id = ${scopePublicId}
    `).resolves.toEqual([{
      state: "waiting",
      attempt_count: 0,
      safe_error_code: null,
      retryable: false
    }]);
    await expect(retry({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFilePublicId: "source-file-retryable",
      retriedAt: "2026-08-14T10:00:01.000Z"
    })).resolves.toEqual({ outcome: "already_running" });
  });

  it("does not retry a deterministic terminal body failure", async () => {
    await expect(retry({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFilePublicId: "source-file-deterministic",
      retriedAt: "2026-08-14T10:00:00.000Z"
    })).resolves.toEqual({ outcome: "not_allowed" });
  });

  it("preserves the first terminal stage when concurrent work fails later", async () => {
    const [row] = await sql<Array<{ public_id: string }>>`
      UPDATE focowiki.document_artifact_work
      SET state = 'running', lease_owner = 'late-worker',
          lease_expires_at = '2026-08-14T10:05:00.000Z',
          started_at = '2026-08-14T10:00:00.000Z'
      WHERE document_job_public_id = 'document-job-deterministic'
        AND work_kind = 'content_projection'
      RETURNING public_id
    `;
    const work = createPostgresDocumentArtifactWorkRepository(
      sql as unknown as DatabaseClient
    );

    await expect(work.fail({
      publicId: row!.public_id,
      workerId: "late-worker",
      now: "2026-08-14T10:00:01.000Z",
      errorCode: "provider_request_rejected",
      safeMessage: null,
      retryable: true,
      nextEligibleAt: null
    })).resolves.toBe("error");

    await expect(sql<Array<{
      blocking_work_kind: string;
      safe_error_code: string;
      failure_count: number;
    }>>`
      SELECT blocking_work_kind, safe_error_code, failure_count
      FROM focowiki.document_processing_jobs
      WHERE public_id = 'document-job-deterministic'
    `).resolves.toEqual([{
      blocking_work_kind: "first_layer",
      safe_error_code: "DOCUMENT_BODY_INVALID",
      failure_count: 3
    }]);
  });

  it("keeps the terminal upload operation intact when retrying one document", async () => {
    await expect(retry({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFilePublicId: "source-file-upload-retryable",
      retriedAt: "2026-08-14T10:10:00.000Z"
    })).resolves.toMatchObject({
      outcome: "accepted",
      documentJobPublicId: "document-job-upload-retryable",
      operationPublicId: "operation-upload-retryable"
    });
    await expect(sql<Array<{
      job_state: string;
      operation_state: string;
      result_count: number;
    }>>`
      SELECT job.state AS job_state, operation.state AS operation_state,
             count(result.public_id)::integer AS result_count
      FROM focowiki.document_processing_jobs job
      JOIN focowiki.operations operation
        ON operation.knowledge_base_id = job.knowledge_base_id
       AND operation.public_id = job.operation_public_id
      LEFT JOIN focowiki.operation_results result
        ON result.knowledge_base_id = operation.knowledge_base_id
       AND result.public_id = operation.public_id
      WHERE job.public_id = 'document-job-upload-retryable'
      GROUP BY job.public_id, operation.public_id
    `).resolves.toEqual([{
      job_state: "waiting",
      operation_state: "completed",
      result_count: 1
    }]);
  });

  it("keeps the failed directory move terminal when retrying one document", async () => {
    await expect(retry({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFilePublicId: "source-file-directory-move-retryable",
      retriedAt: "2026-08-14T10:15:00.000Z"
    })).resolves.toMatchObject({
      outcome: "accepted",
      documentJobPublicId: "document-job-directory-move-retryable",
      operationPublicId: "operation-directory-move-retryable"
    });
    await expect(sql<Array<{
      job_state: string;
      operation_state: string;
      result_code: string;
    }>>`
      SELECT job.state AS job_state, operation.state AS operation_state,
             result.result_code
      FROM focowiki.document_processing_jobs job
      JOIN focowiki.operations operation
        ON operation.knowledge_base_id = job.knowledge_base_id
       AND operation.public_id = job.operation_public_id
      JOIN focowiki.operation_results result
        ON result.knowledge_base_id = operation.knowledge_base_id
       AND result.public_id = operation.public_id
      WHERE job.public_id = 'document-job-directory-move-retryable'
    `).resolves.toEqual([{
      job_state: "waiting",
      operation_state: "failed",
      result_code: "DOCUMENT_BODY_INVALID"
    }]);
  });

  it("stages a new immutable page candidate when retry output changes", async () => {
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'object-generated-retry-v1', 'generated/retry-v1.md', ${"a".repeat(64)},
        11, 'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
        'verified', 'write-generated-retry-v1', now()
      ), (
        'object-generated-retry-v2', 'generated/retry-v2.md', ${"b".repeat(64)},
        12, 'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
        'verified', 'write-generated-retry-v2', now()
      )
    `;
    const [work] = await sql<Array<{ public_id: string }>>`
      SELECT public_id
      FROM focowiki.document_artifact_work
      WHERE document_job_public_id = 'document-job-retryable'
        AND work_kind = 'first_layer'
    `;
    const pages = createPostgresGeneratedPageRepository(
      sql as unknown as DatabaseClient
    );
    const common = {
      knowledgeBaseId: "knowledge-base-retry",
      sourceWorkPublicId: work!.public_id,
      sourceFilePublicId: "source-file-retryable",
      sourceRevisionPublicId: "source-revision-retryable",
      baseActivationRevision: 1,
      stagedAt: "2026-08-14T10:20:00.000Z"
    };
    const first = await pages.stage({
      ...common,
      pages: [{
        logicalPath: "index.md",
        normalizedPath: "index.md",
        entryKind: "index",
        sourceFilePublicId: null,
        sourceRevisionPublicId: null,
        objectId: "object-generated-retry-v1",
        checksumSha256: "a".repeat(64),
        byteCount: 11
      }]
    });
    const second = await pages.stage({
      ...common,
      stagedAt: "2026-08-14T10:20:01.000Z",
      pages: [{
        logicalPath: "index.md",
        normalizedPath: "index.md",
        entryKind: "index",
        sourceFilePublicId: null,
        sourceRevisionPublicId: null,
        objectId: "object-generated-retry-v2",
        checksumSha256: "b".repeat(64),
        byteCount: 12
      }]
    });

    expect(first[0]!.pageCandidatePublicId)
      .not.toBe(second[0]!.pageCandidatePublicId);
    await expect(sql<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM focowiki.generated_page_candidates
      WHERE source_revision_public_id = 'source-revision-retryable'
        AND normalized_path = 'index.md'
    `).resolves.toEqual([{ count: 2 }]);
    await expect(sql<Array<{ count: number }>>`
      SELECT count(*)::integer AS count
      FROM focowiki.object_owners owner
      JOIN focowiki.generated_page_candidates candidate
        ON candidate.public_id = owner.generated_page_candidate_public_id
      WHERE candidate.source_revision_public_id = 'source-revision-retryable'
        AND candidate.normalized_path = 'index.md'
    `).resolves.toEqual([{ count: 2 }]);
  });

  it("deletes a never-active failed source and queues bounded cleanup", async () => {
    await expect(removeTasks({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFilePublicIds: ["source-file-deterministic"],
      removedAt: "2026-08-14T11:00:00.000Z",
      resultExpiresAt: "2026-08-15T11:00:00.000Z"
    })).resolves.toEqual([{
      sourceFilePublicId: "source-file-deterministic",
      outcome: "source_deletion_accepted"
    }]);
    await expect(sql<Array<{
      deleted: boolean;
      job_state: string;
      cleanup_state: string;
      action_kind: string;
      resource_kind: string;
      cleanup_document_job_public_id: string | null;
      cleanup_source_revision_public_id: string | null;
    }>>`
      SELECT source.deleted_at IS NOT NULL AS deleted,
             job.state AS job_state, cleanup.state AS cleanup_state,
             cleanup.action_kind,
             cleanup.resource_kind,
             cleanup.document_job_public_id AS cleanup_document_job_public_id,
             cleanup.source_revision_public_id AS cleanup_source_revision_public_id
      FROM focowiki.source_files source
      JOIN focowiki.document_processing_jobs job
        ON job.source_file_public_id = source.public_id
      JOIN focowiki.cleanup_actions cleanup
        ON cleanup.resource_kind = 'source_file'
       AND cleanup.resource_public_id = source.public_id
      WHERE source.public_id = 'source-file-deterministic'
    `).resolves.toEqual([{
      deleted: true,
      job_state: "cancelled",
      cleanup_state: "queued",
      action_kind: "document_resource_deletion",
      resource_kind: "source_file",
      cleanup_document_job_public_id: null,
      cleanup_source_revision_public_id: null
    }]);
  });

  it("removes only a failed replacement attempt and restores the active revision", async () => {
    await expect(removeTasks({
      knowledgeBaseId: "knowledge-base-retry",
      sourceFilePublicIds: ["source-file-replacement"],
      removedAt: "2026-08-14T11:05:00.000Z",
      resultExpiresAt: "2026-08-15T11:05:00.000Z"
    })).resolves.toEqual([{
      sourceFilePublicId: "source-file-replacement",
      outcome: "failed_attempt_removed",
      activeSourceRevisionPublicId: "source-revision-replacement-active"
    }]);
    await expect(sql<Array<{
      current_source_revision_public_id: string;
      active_source_revision_public_id: string;
      deleted: boolean;
      job_state: string;
      action_kind: string;
      cleanup_kind: string;
    }>>`
      SELECT active.current_source_revision_public_id,
             active.active_source_revision_public_id,
             source.deleted_at IS NOT NULL AS deleted,
             job.state AS job_state, cleanup.action_kind,
             cleanup.resource_kind AS cleanup_kind
      FROM focowiki.source_files source
      JOIN focowiki.source_file_active_revisions active
        ON active.source_file_public_id = source.public_id
      JOIN focowiki.document_processing_jobs job
        ON job.source_file_public_id = source.public_id
       AND job.source_revision_public_id = 'source-revision-replacement-failed'
      JOIN focowiki.cleanup_actions cleanup
        ON cleanup.document_job_public_id = job.public_id
      WHERE source.public_id = 'source-file-replacement'
    `).resolves.toEqual([{
      current_source_revision_public_id: "source-revision-replacement-active",
      active_source_revision_public_id: "source-revision-replacement-active",
      deleted: false,
      job_state: "superseded",
      action_kind: "document_revision_purge",
      cleanup_kind: "source_revision"
    }]);

    await expect(revisionPurge.runBatch({
      owner: "worker-revision-purge",
      limit: 10,
      now: "2026-08-14T11:05:01.000Z",
      leaseExpiresAt: "2026-08-14T11:06:01.000Z"
    })).resolves.toEqual({
      claimed: 1,
      completed: 1,
      retried: 0,
      failed: 0
    });
    await expect(sql<Array<{
      current_source_revision_public_id: string;
      active_source_revision_public_id: string;
      failed_revision_count: string;
      cleanup_state: string;
      cleanup_document_job_public_id: string | null;
      cleanup_source_revision_public_id: string | null;
    }>>`
      SELECT active.current_source_revision_public_id,
             active.active_source_revision_public_id,
             (
               SELECT count(*)::text
               FROM focowiki.source_revisions revision
               WHERE revision.public_id = 'source-revision-replacement-failed'
             ) AS failed_revision_count,
             cleanup.state AS cleanup_state,
             cleanup.document_job_public_id AS cleanup_document_job_public_id,
             cleanup.source_revision_public_id AS cleanup_source_revision_public_id
      FROM focowiki.source_file_active_revisions active
      JOIN focowiki.cleanup_actions cleanup
        ON cleanup.resource_kind = 'source_revision'
       AND cleanup.resource_public_id = 'source-revision-replacement-failed'
      WHERE active.source_file_public_id = 'source-file-replacement'
    `).resolves.toEqual([{
      current_source_revision_public_id: "source-revision-replacement-active",
      active_source_revision_public_id: "source-revision-replacement-active",
      failed_revision_count: "0",
      cleanup_state: "completed",
      cleanup_document_job_public_id: null,
      cleanup_source_revision_public_id: null
    }]);
  });

  async function seedFailedDocument(input: {
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    operationPublicId: string;
    documentJobPublicId: string;
    operationKind?: "source_replace" | "source_directory_move" | "upload";
    retryable: boolean;
  }): Promise<void> {
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, metadata, revision
      ) VALUES (
        ${input.sourceFilePublicId}, 'knowledge-base-retry',
        ${`${input.sourceFilePublicId}.md`}, ${`${input.sourceFilePublicId}.md`},
        ${input.sourceFilePublicId}, '{}'::jsonb, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        ${`object-${input.sourceFilePublicId}`}, ${`${input.sourceFilePublicId}.md`},
        ${"2".repeat(64)}, 16, 'text/markdown; charset=utf-8',
        'source-markdown-v1', 'verified', ${`write-${input.sourceFilePublicId}`},
        '2026-08-14T09:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES (
        ${input.sourceRevisionPublicId}, 'knowledge-base-retry',
        ${input.sourceFilePublicId}, ${`object-${input.sourceFilePublicId}`},
        ${"2".repeat(64)}, 16, 'text/markdown; charset=utf-8'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revision_presentations (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, metadata
      ) VALUES (
        'knowledge-base-retry', ${input.sourceFilePublicId},
        ${input.sourceRevisionPublicId}, ${`${input.sourceFilePublicId}.md`},
        ${`${input.sourceFilePublicId}.md`}, ${input.sourceFilePublicId}, '{}'::jsonb
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence
      ) VALUES (
        'knowledge-base-retry', ${input.sourceFilePublicId},
        ${input.sourceRevisionPublicId}, NULL, 0
      )
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, completed_at
      ) VALUES (
        ${input.operationPublicId}, 'knowledge-base-retry',
        ${input.operationKind ?? "source_replace"},
        ${input.operationKind === "upload" ? "completed" : "failed"},
        'source_file', ${input.sourceFilePublicId},
        '2026-08-14T09:05:00.000Z'
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
        state, attempt_count, failure_count, total_attempt_count,
        maximum_attempts, required_work_count, completed_work_count,
        blocking_work_kind, retryable, safe_error_code,
        model_status, model_name, model_started_at, model_ended_at,
        model_warning_count, model_error_code,
        accepted_at, started_at, terminal_at,
        revision, created_at, updated_at
      ) VALUES (
        ${input.documentJobPublicId}, 'knowledge-base-retry',
        ${input.operationPublicId}, ${input.sourceFilePublicId},
        ${input.sourceRevisionPublicId}, 'runtime-retry',
        ${processingContract.generationModelConfigurationPublicId},
        ${processingContract.generationModelConfigurationRevision},
        ${processingContract.embeddingConfigurationRevisionPublicId},
        ${processingContract.semanticGenerationPublicId},
        'document-fixed-dag-v1', 'error', 3, 3, 3, 3, 8, 0,
        'first_layer', ${input.retryable},
        'DOCUMENT_BODY_INVALID', 'failed', 'generation-model',
        '2026-08-14T09:00:00.000Z', '2026-08-14T09:04:00.000Z', 0,
        'DOCUMENT_BODY_INVALID',
        '2026-08-14T09:00:00.000Z', '2026-08-14T09:00:00.000Z',
        '2026-08-14T09:05:00.000Z', 4,
        '2026-08-14T09:00:00.000Z', '2026-08-14T09:05:00.000Z'
      )
    `;
    await createPostgresDocumentArtifactWorkRepository(
      sql as unknown as DatabaseClient
    ).createFixedGraph({
      knowledgeBaseId: "knowledge-base-retry",
      documentJobPublicId: input.documentJobPublicId,
      sourceFilePublicId: input.sourceFilePublicId,
      sourceRevisionPublicId: input.sourceRevisionPublicId,
      acceptedAt: "2026-08-14T09:00:00.000Z",
      maximumAttempts: 3,
      inputFingerprints: Object.fromEntries(
        DOCUMENT_WORK_KINDS.map((kind, index) => [
          kind,
          (index + 1).toString(16).repeat(64)
        ])
      ) as Record<(typeof DOCUMENT_WORK_KINDS)[number], string>
    });
    await sql`
      UPDATE focowiki.document_artifact_work
      SET state = 'error', attempt_count = 3,
          safe_error_code = 'DOCUMENT_BODY_INVALID',
          retryable = ${input.retryable},
          started_at = '2026-08-14T09:00:00.000Z',
          ended_at = '2026-08-14T09:05:00.000Z'
      WHERE document_job_public_id = ${input.documentJobPublicId}
        AND work_kind = 'first_layer'
    `;
    await sql`
      INSERT INTO focowiki.operation_results (
        public_id, knowledge_base_id, operation_kind, terminal_state,
        result_code, result_summary, correlation_public_id,
        completed_at, expires_at
      ) VALUES (
        ${input.operationPublicId}, 'knowledge-base-retry',
        ${input.operationKind ?? "source_replace"},
        ${input.operationKind === "upload" ? "completed" : "failed"},
        ${input.operationKind === "upload"
          ? "UPLOAD_DOCUMENTS_TERMINAL"
          : "DOCUMENT_BODY_INVALID"}, '{}'::jsonb,
        ${input.documentJobPublicId}, '2026-08-14T09:05:00.000Z',
        '2026-08-15T09:05:00.000Z'
      )
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
