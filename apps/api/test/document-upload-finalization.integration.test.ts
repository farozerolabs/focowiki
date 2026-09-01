import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresDocumentArtifactWorkRepository } from
  "../src/document-indexing/infrastructure/postgres-document-artifact-work-repository.js";
import { createDocumentCleanupReceiptHandler } from
  "../src/document-indexing/infrastructure/production-document-fixed-runtime-support.js";
import { createStorageVnextUploadCoordinator } from
  "../src/storage-vnext/upload/upload-coordinator.js";
import { createPostgresStorageVnextUploadRepository } from
  "../src/storage-vnext/upload/postgres-repository.js";
import { createPostgresStorageVnextUploadTerminalPort } from
  "../src/storage-vnext/upload/postgres-terminal.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";
import { requireUploadSession } from
  "../src/storage-vnext/api/postgres-admin-upload-session-store.js";
import { createPostgresStorageVnextOperationRead } from
  "../src/storage-vnext/api/postgres-operation-read.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document upload finalization PostgreSQL", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_document_upload_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 6 });
  const database = sql as unknown as DatabaseClient;
  const repository = createPostgresStorageVnextUploadRepository(database, {
    sourceWorkRetentionMilliseconds: 86_400_000
  });
  const terminal = createPostgresStorageVnextUploadTerminalPort(database, {
    resultRetentionMilliseconds: 86_400_000
  });
  const work = createPostgresDocumentArtifactWorkRepository(database);
  const operationRead = createPostgresStorageVnextOperationRead(database);
  const coordinator = createStorageVnextUploadCoordinator({
    repository,
    terminal,
    bodyWriter: createBodyWriter(sql),
    limits: { maximumEntries: 10, maximumManifestBytes: 262_144 }
  });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await sql`
      INSERT INTO focowiki.runtime_setting_revisions (
        public_id, checksum_sha256, settings_values
      ) VALUES (
        'runtime-settings-document-upload', ${"a".repeat(64)},
        ${sql.json({ sections: { worker: { jobMaxAttempts: 3 } } })}
      )
    `;
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('knowledge-base-document-upload', 'Document upload', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('knowledge-base-document-upload', 0)
    `;
    await seedRequiredProcessingContract(sql);
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

  it("rejects finalization before the mandatory model contract is active", async () => {
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('knowledge-base-document-upload-unconfigured', 'Unconfigured upload', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('knowledge-base-document-upload-unconfigured', 0)
    `;
    const current = entry(
      "entry-unconfigured",
      "source-file-unconfigured",
      "Unconfigured.md",
      "# Unconfigured\n"
    );
    await coordinator.openSession({
      knowledgeBaseId: "knowledge-base-document-upload-unconfigured",
      operationPublicId: "operation-document-upload-unconfigured",
      sessionPublicId: "session-document-upload-unconfigured",
      idempotencyKey: "request-document-upload-unconfigured",
      settingsRevisionPublicId: "runtime-settings-document-upload",
      entries: [current],
      createdAt: "2026-08-14T04:00:00.000Z",
      expiresAt: "2026-08-14T06:00:00.000Z"
    });
    await coordinator.putEntry({
      knowledgeBaseId: "knowledge-base-document-upload-unconfigured",
      sessionPublicId: "session-document-upload-unconfigured",
      entryPublicId: current.entryPublicId,
      body: chunks(current.body)
    });

    await expect(coordinator.finalizeSession({
      knowledgeBaseId: "knowledge-base-document-upload-unconfigured",
      sessionPublicId: "session-document-upload-unconfigured",
      completedAt: "2026-08-14T04:01:00.000Z"
    })).rejects.toMatchObject({
      code: "UPLOAD_PROCESSING_CONFIGURATION_REQUIRED"
    });
    await expect(sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count
      FROM focowiki.document_processing_jobs
      WHERE knowledge_base_id = 'knowledge-base-document-upload-unconfigured'
    `).resolves.toEqual([{ count: "0" }]);
  });

  it("keeps one upload operation processing until independent document outcomes are terminal", async () => {
    const entries = [
      entry("entry-one", "source-file-one", "Guides/One.md", "# One\n"),
      entry("entry-two", "source-file-two", "Guides/Two.md", "# Two\n")
    ];
    await coordinator.openSession({
      knowledgeBaseId: "knowledge-base-document-upload",
      operationPublicId: "operation-document-upload",
      sessionPublicId: "session-document-upload",
      idempotencyKey: "request-document-upload",
      settingsRevisionPublicId: "runtime-settings-document-upload",
      entries,
      createdAt: "2026-08-14T05:00:00.000Z",
      expiresAt: "2026-08-14T06:00:00.000Z"
    });
    for (const current of entries) {
      await coordinator.putEntry({
        knowledgeBaseId: "knowledge-base-document-upload",
        sessionPublicId: "session-document-upload",
        entryPublicId: current.entryPublicId,
        body: chunks(current.body)
      });
    }
    await expect(coordinator.finalizeSession({
      knowledgeBaseId: "knowledge-base-document-upload",
      sessionPublicId: "session-document-upload",
      completedAt: "2026-08-14T05:01:00.000Z"
    })).resolves.toMatchObject({
      acceptedRevisionCount: 2,
      sourceWorkCount: 2,
      downstreamProcessingState: "queued"
    });

    const jobs = await sql<Array<{
      public_id: string;
      operation_public_id: string;
      state: string;
      active_source_revision_public_id: string | null;
    }>>`
      SELECT job.public_id, job.operation_public_id, job.state,
             active.active_source_revision_public_id
      FROM focowiki.document_processing_jobs job
      JOIN focowiki.source_file_active_revisions active
        ON active.knowledge_base_id = job.knowledge_base_id
       AND active.source_file_public_id = job.source_file_public_id
       AND active.current_source_revision_public_id = job.source_revision_public_id
      WHERE job.knowledge_base_id = 'knowledge-base-document-upload'
      ORDER BY job.public_id
    `;
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) =>
      job.operation_public_id === "operation-document-upload"
      && job.state === "waiting"
      && job.active_source_revision_public_id === null)).toBe(true);
    await expect(sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.operations
      WHERE public_id = 'operation-document-upload'
    `).resolves.toEqual([{ state: "processing" }]);
    await expect(requireUploadSession(
      database,
      "knowledge-base-document-upload",
      "session-document-upload"
    )).resolves.toMatchObject({
      id: "session-document-upload",
      operationId: "operation-document-upload",
      state: "finalizing"
    });
    await expect(operationRead.get({
      knowledgeBaseId: "knowledge-base-document-upload",
      operationId: "operation-document-upload"
    })).resolves.toMatchObject({
      kind: "upload",
      state: "processing",
      result: {
        totalCount: 2,
        waitingCount: 2,
        processingCount: 0,
        availableCount: 0,
        failedCount: 0
      }
    });
    await expect(sql<Array<{
      session_public_id: string;
      received_entry_count: number;
    }>>`
      SELECT session_public_id, received_entry_count
      FROM focowiki.upload_operation_summaries
      WHERE operation_public_id = 'operation-document-upload'
    `).resolves.toEqual([{
      session_public_id: "session-document-upload",
      received_entry_count: 2
    }]);

    await sql`
      DELETE FROM focowiki.upload_sessions
      WHERE public_id = 'session-document-upload'
    `;

    await sql`
      UPDATE focowiki.document_processing_jobs
      SET state = 'available', terminal_at = '2026-08-14T05:02:00.000Z',
          started_at = accepted_at, updated_at = '2026-08-14T05:02:00.000Z'
      WHERE public_id = ${jobs[0]!.public_id}
    `;
    const cleanup = createDocumentCleanupReceiptHandler({
      sql: database,
      now: () => "2026-08-14T05:02:00.500Z"
    });
    await expect(cleanup({
      claimed: {
        publicId: `cleanup-${jobs[0]!.public_id}`,
        knowledgeBaseId: "knowledge-base-document-upload",
        documentJobPublicId: jobs[0]!.public_id,
        sourceFilePublicId: "source-file-one",
        sourceRevisionPublicId: "source-revision-source-file-one-entry-one",
        kind: "cleanup",
        resourceLane: "cleanup",
        inputFingerprintSha256: "c".repeat(64),
        attemptCount: 1,
        maximumAttempts: 3,
        leaseOwner: "worker-cleanup",
        leaseExpiresAt: "2026-08-14T05:03:00.000Z",
        startedAt: "2026-08-14T05:02:00.000Z"
      },
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      value: { schemaVersion: "document-cleanup-receipt-v1" }
    });
    await expect(operationRead.get({
      knowledgeBaseId: "knowledge-base-document-upload",
      operationId: "operation-document-upload"
    })).resolves.toMatchObject({
      kind: "upload",
      state: "processing",
      result: {
        totalCount: 2,
        waitingCount: 1,
        availableCount: 1,
        failedCount: 0
      }
    });
    const failedJob = jobs[1]!;
    await sql`
      UPDATE focowiki.document_processing_jobs
      SET state = 'processing', started_at = accepted_at,
          total_attempt_count = 1,
          active_work_kinds = ARRAY['prepare']::text[],
          blocking_work_kind = 'prepare',
          updated_at = '2026-08-14T05:02:01.000Z'
      WHERE public_id = ${failedJob.public_id}
    `;
    const failedWork = await sql<Array<{ public_id: string }>>`
      UPDATE focowiki.document_artifact_work
      SET state = 'running', attempt_count = 1,
          lease_owner = 'worker-document-upload',
          lease_expires_at = '2026-08-14T05:03:01.000Z',
          started_at = '2026-08-14T05:02:01.000Z',
          updated_at = '2026-08-14T05:02:01.000Z'
      WHERE document_job_public_id = ${failedJob.public_id}
        AND work_kind = 'prepare'
      RETURNING public_id
    `;
    expect(failedWork).toHaveLength(1);
    await expect(work.fail({
      publicId: failedWork[0]!.public_id,
      workerId: "worker-document-upload",
      now: "2026-08-14T05:02:02.000Z",
      errorCode: "DOCUMENT_BODY_INVALID",
      safeMessage: null,
      retryable: true,
      nextEligibleAt: null
    })).resolves.toBe("error");

    await expect(sql<Array<{
      state: string;
      retryable: boolean;
      next_attempt_at: string | null;
    }>>`
      SELECT state, retryable, next_attempt_at
      FROM focowiki.document_processing_jobs
      WHERE public_id = ${failedJob.public_id}
    `).resolves.toEqual([{
      state: "error",
      retryable: true,
      next_attempt_at: null
    }]);

    const results = await sql<Array<{
      state: string;
      terminal_state: string;
      result_summary: Record<string, unknown>;
    }>>`
      SELECT operation.state, result.terminal_state, result.result_summary
      FROM focowiki.operations operation
      JOIN focowiki.operation_results result
        ON result.knowledge_base_id = operation.knowledge_base_id
       AND result.public_id = operation.public_id
      WHERE operation.public_id = 'operation-document-upload'
    `;
    expect(results).toEqual([{
      state: "completed",
      terminal_state: "completed",
      result_summary: expect.objectContaining({
        expectedEntryCount: 2,
        receivedEntryCount: 2,
        availableCount: 1,
        failedCount: 1,
        cancelledCount: 0,
        supersededCount: 0
      })
    }]);
    await expect(operationRead.get({
      knowledgeBaseId: "knowledge-base-document-upload",
      operationId: "operation-document-upload"
    })).resolves.toMatchObject({
      kind: "upload",
      state: "completed",
      result: {
        totalCount: 2,
        availableCount: 1,
        failedCount: 1,
        waitingCount: 0,
        processingCount: 0
      }
    });
    await expect(sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM focowiki.upload_sessions
      WHERE operation_public_id = 'operation-document-upload'
    `).resolves.toEqual([{ count: "0" }]);
    await expect(sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM focowiki.upload_operation_summaries
      WHERE operation_public_id = 'operation-document-upload'
    `).resolves.toEqual([{ count: "0" }]);
  });

  it("converges an all-success upload after the final cleanup work commits", async () => {
    const current = entry(
      "entry-cleanup-terminal",
      "source-file-cleanup-terminal",
      "Guides/Cleanup terminal.md",
      "# Cleanup terminal\n"
    );
    await coordinator.openSession({
      knowledgeBaseId: "knowledge-base-document-upload",
      operationPublicId: "operation-cleanup-terminal",
      sessionPublicId: "session-cleanup-terminal",
      idempotencyKey: "request-cleanup-terminal",
      settingsRevisionPublicId: "runtime-settings-document-upload",
      entries: [current],
      createdAt: "2026-08-14T07:00:00.000Z",
      expiresAt: "2026-08-14T08:00:00.000Z"
    });
    await coordinator.putEntry({
      knowledgeBaseId: "knowledge-base-document-upload",
      sessionPublicId: "session-cleanup-terminal",
      entryPublicId: current.entryPublicId,
      body: chunks(current.body)
    });
    await coordinator.finalizeSession({
      knowledgeBaseId: "knowledge-base-document-upload",
      sessionPublicId: "session-cleanup-terminal",
      completedAt: "2026-08-14T07:01:00.000Z"
    });
    const [job] = await sql<Array<{
      public_id: string;
      source_revision_public_id: string;
    }>>`
      SELECT public_id, source_revision_public_id
      FROM focowiki.document_processing_jobs
      WHERE operation_public_id = 'operation-cleanup-terminal'
    `;
    expect(job).toBeDefined();
    await sql`
      UPDATE focowiki.document_artifact_work
      SET state = 'completed', attempt_count = 1,
          started_at = '2026-08-14T07:01:00.000Z',
          ended_at = '2026-08-14T07:01:01.000Z',
          updated_at = '2026-08-14T07:01:01.000Z'
      WHERE document_job_public_id = ${job!.public_id}
        AND work_kind <> 'cleanup'
    `;
    const [cleanupWork] = await sql<Array<{ public_id: string }>>`
      UPDATE focowiki.document_artifact_work
      SET state = 'running', attempt_count = 1,
          lease_owner = 'worker-cleanup-terminal',
          lease_expires_at = '2026-08-14T07:03:00.000Z',
          started_at = '2026-08-14T07:01:01.000Z',
          updated_at = '2026-08-14T07:01:01.000Z'
      WHERE document_job_public_id = ${job!.public_id}
        AND work_kind = 'cleanup'
      RETURNING public_id
    `;
    await sql`
      UPDATE focowiki.document_processing_jobs
      SET state = 'processing', started_at = accepted_at,
          active_work_kinds = ARRAY['cleanup']::text[],
          blocking_work_kind = 'cleanup',
          updated_at = '2026-08-14T07:01:01.000Z'
      WHERE public_id = ${job!.public_id}
    `;
    const cleanup = createDocumentCleanupReceiptHandler({
      sql: database,
      now: () => "2026-08-14T07:01:02.000Z"
    });
    const receipt = await cleanup({
      claimed: {
        publicId: cleanupWork!.public_id,
        knowledgeBaseId: "knowledge-base-document-upload",
        documentJobPublicId: job!.public_id,
        sourceFilePublicId: current.sourceFilePublicId,
        sourceRevisionPublicId: job!.source_revision_public_id,
        kind: "cleanup",
        resourceLane: "cleanup",
        inputFingerprintSha256: "e".repeat(64),
        attemptCount: 1,
        maximumAttempts: 3,
        leaseOwner: "worker-cleanup-terminal",
        leaseExpiresAt: "2026-08-14T07:03:00.000Z",
        startedAt: "2026-08-14T07:01:01.000Z"
      },
      signal: new AbortController().signal
    });
    await sql`
      UPDATE focowiki.operations
      SET state = 'completed', completed_at = '2026-08-14T07:01:01.500Z',
          updated_at = '2026-08-14T07:01:01.500Z'
      WHERE public_id = 'operation-cleanup-terminal'
    `;
    await expect(work.complete({
      publicId: cleanupWork!.public_id,
      workerId: "worker-cleanup-terminal",
      now: "2026-08-14T07:01:02.000Z",
      receipt: {
        kind: "cleanup",
        key: receipt.key,
        inputFingerprintSha256: "e".repeat(64),
        outputFingerprintSha256: receipt.outputFingerprintSha256,
        value: receipt.value
      }
    })).resolves.toBe(true);
    await expect(operationRead.get({
      knowledgeBaseId: "knowledge-base-document-upload",
      operationId: "operation-cleanup-terminal"
    })).resolves.toMatchObject({ state: "completed" });
    await expect(sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM focowiki.upload_sessions
      WHERE public_id = 'session-cleanup-terminal'
    `).resolves.toEqual([{ count: "0" }]);
  });
});

async function seedRequiredProcessingContract(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO focowiki.model_configs (
      public_id, provider, model, secret_reference, config, enabled, revision
    ) VALUES (
      'model-config-document-upload', 'openai-compatible', 'generation-model',
      'runtime/test-generation-model', '{}'::jsonb, true, 1
    )
  `;
  await sql`
    INSERT INTO focowiki.embedding_configurations (
      public_id, display_name, lifecycle_status, revision
    ) VALUES (
      'embedding-document-upload', 'Embedding', 'active', 1
    )
  `;
  await sql`
    INSERT INTO focowiki.embedding_configuration_revisions (
      public_id, configuration_public_id, revision_number, authentication_mode,
      base_url, model_name, requested_dimension, resolved_dimension,
      normalization, maximum_input_tokens, batch_size, timeout_ms, retry_count,
      minimum_interval_ms, concurrency, maximum_response_bytes,
      vector_producing_revision_public_id,
      validation_status, validation_fingerprint_sha256, validated_at
    ) VALUES (
      'embedding-revision-document-upload', 'embedding-document-upload', 1,
      'none', 'http://embedding.local/v1', 'embedding-model', 3, 3,
      'l2', 8192, 16, 5000, 1, 0, 2, 1048576,
      'embedding-revision-document-upload', 'valid', ${"b".repeat(64)}, now()
    )
  `;
  await sql`
    UPDATE focowiki.embedding_configurations
    SET active_revision_public_id = 'embedding-revision-document-upload'
    WHERE public_id = 'embedding-document-upload'
  `;
  await sql`
    INSERT INTO focowiki.operations (
      public_id, knowledge_base_id, operation_kind, state, completed_at
    ) VALUES (
      'operation-semantic-document-upload', 'knowledge-base-document-upload',
      'semantic_contract_bootstrap', 'completed', now()
    )
  `;
  await sql`
    INSERT INTO focowiki.semantic_generations (
      public_id, knowledge_base_id, operation_public_id,
      expected_predecessor_public_id, generation_role, state,
      generation_model_configuration_public_id,
      generation_model_configuration_revision,
      extraction_contract_version, graph_schema_version,
      prompt_contract_version, contract_fingerprint_sha256,
      revision, activated_at
    ) VALUES (
      'semantic-generation-document-upload', 'knowledge-base-document-upload',
      'operation-semantic-document-upload', NULL, 'active', 'active',
      'model-config-document-upload', 1, 'extract-v1', 'graph-v1',
      'prompt-v1', ${"c".repeat(64)}, 1, now()
    )
  `;
  await sql`
    INSERT INTO focowiki.semantic_projection_contracts (
      public_id, knowledge_base_id, semantic_generation_public_id,
      embedding_configuration_revision_public_id,
      search_provider_kind,
      resolved_dimension, normalization, artifact_schema_version,
      vector_schema_version, mapping_fingerprint_sha256
    ) VALUES (
      'semantic-contract-document-upload', 'knowledge-base-document-upload',
      'semantic-generation-document-upload',
      'embedding-revision-document-upload', 'opensearch', 3, 'l2',
      'artifact-v1', 'vector-v1', ${"d".repeat(64)}
    )
  `;
}

function entry(
  entryPublicId: string,
  sourceFilePublicId: string,
  logicalPath: string,
  body: string
) {
  const bytes = Buffer.from(body, "utf8");
  return {
    entryPublicId,
    sourceFilePublicId,
    logicalPath,
    byteCount: bytes.byteLength,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: "text/markdown; charset=utf-8",
    body
  };
}

function createBodyWriter(sql: postgres.Sql) {
  return {
    putVerifiedStream: vi.fn(async (input: {
      body: AsyncIterable<Uint8Array>;
      checksumSha256: string;
      byteCount: number;
      contentType: string;
      writeAttemptPublicId: string;
    }) => {
      for await (const _chunk of input.body) void _chunk;
      const objectId = `source-sha256:${input.checksumSha256}`;
      await sql`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count, content_type,
          object_format, state, write_attempt_public_id, verified_at,
          zero_owner_since, created_at
        ) VALUES (
          ${objectId}, ${`document-upload/${input.checksumSha256}.md`},
          ${input.checksumSha256}, ${input.byteCount}, ${input.contentType},
          'source-markdown-v1', 'verified', ${input.writeAttemptPublicId}, now(),
          now(), now()
        )
      `;
      return {
        outcome: "stored" as const,
        objectId,
        checksumSha256: input.checksumSha256,
        byteCount: input.byteCount,
        contentType: input.contentType
      };
    })
  };
}

async function* chunks(body: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(body, "utf8");
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
