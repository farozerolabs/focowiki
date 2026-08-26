import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresDocumentDeletionAcceptance } from
  "../src/document-indexing/infrastructure/postgres-document-deletion-acceptance.js";
import { createDocumentResourceDeletionWorker } from
  "../src/document-indexing/application/document-resource-deletion-worker.js";
import { createPostgresDocumentResourceDeletion } from
  "../src/document-indexing/infrastructure/postgres-document-resource-deletion.js";
import { createPostgresOperationGeneratedPageRepository } from
  "../src/document-indexing/infrastructure/postgres-operation-generated-page-repository.js";
import { createPostgresStorageVnextOperationRead } from
  "../src/storage-vnext/api/postgres-operation-read.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";
import { seedRequiredDocumentProcessingContract } from
  "./helpers/document-processing-contract.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document deletion acceptance PostgreSQL", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_document_delete_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const accept = createPostgresDocumentDeletionAcceptance(
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
      ) VALUES ('runtime-delete', ${"1".repeat(64)}, '{}'::jsonb)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('knowledge-base-delete', 'Delete', 1),
             ('knowledge-base-delete-empty', 'Delete empty', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('knowledge-base-delete', 2),
               ('knowledge-base-delete-empty', 0)
    `;
    processingContract = await seedRequiredDocumentProcessingContract(
      sql,
      "knowledge-base-delete"
    );
    await sql`
      INSERT INTO focowiki.source_directories (
        public_id, knowledge_base_id, parent_public_id,
        logical_path, normalized_path, title, revision
      ) VALUES (
        'source-directory-delete', 'knowledge-base-delete', NULL,
        'Guides', 'guides', 'Guides', 1
      ), (
        'source-directory-cleanup', 'knowledge-base-delete', NULL,
        'Cleanup', 'cleanup', 'Cleanup', 1
      )
    `;
    await seedAvailableSource("source-file-delete", "root.md", null);
    await seedAvailableSource(
      "source-file-provider-delete",
      "provider-delete.md",
      null
    );
    await seedAvailableSource("source-file-delete-history", "history.md", null);
    await seedNewAvailableRevision("source-file-delete-history", "history.md");
    await seedAvailableSource(
      "source-file-directory-delete",
      "Guides/nested.md",
      "source-directory-delete"
    );
    await seedAvailableSource(
      "source-file-directory-cleanup",
      "Cleanup/nested.md",
      "source-directory-cleanup"
    );
    await seedAvailableSource(
      "source-file-embedding-delete",
      "embedding-delete.md",
      null
    );
    await seedAvailableSource(
      "source-file-upload-reference-delete",
      "upload-reference-delete.md",
      null
    );
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

  it("writes deletion tombstones without hiding the active projection", async () => {
    const sourceFilePublicId = "source-file-coherent-delete";
    const operationPublicId = "operation-coherent-delete";
    await seedAvailableSource(sourceFilePublicId, "coherent-delete.md", null);
    await sql`
      INSERT INTO focowiki.document_projection_records (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, summary, metadata, headings,
        entities, content_type, checksum_sha256, byte_count,
        tokenizer_contract_version, navigation_term_fingerprint_sha256, active
      ) VALUES (
        'knowledge-base-delete', ${sourceFilePublicId},
        ${`${sourceFilePublicId}-revision`}, 'coherent-delete.md',
        'coherent-delete.md', 'Coherent delete', 'Deletion projection fact',
        '{}'::jsonb, '{}'::text[], '{}'::text[],
        'text/markdown; charset=utf-8', ${"2".repeat(64)}, 10,
        'nodejieba-test-v1', ${"3".repeat(64)}, true
      )
    `;
    await accept({
      knowledgeBaseId: "knowledge-base-delete",
      targetKind: "source_file",
      targetPublicId: sourceFilePublicId,
      expectedResourceRevision: 1,
      operationPublicId,
      idempotencyKey: "coherent-delete-request",
      maximumAttempts: 3,
      requestedAt: "2026-08-14T10:00:00.000Z",
      expiresAt: "2026-08-15T10:00:00.000Z"
    });
    await expect(sql`
      SELECT source.deleted_at IS NOT NULL AS deleted,
             active.active_source_revision_public_id,
             item.operation, item.outcome,
             cleanup.checkpoint->>'phase' AS cleanup_phase
      FROM focowiki.source_files source
      JOIN focowiki.source_file_active_revisions active
        ON active.knowledge_base_id = source.knowledge_base_id
       AND active.source_file_public_id = source.public_id
      JOIN focowiki.publication_items item
        ON item.knowledge_base_id = source.knowledge_base_id
       AND item.source_file_public_id = source.public_id
       AND item.affected_evidence->>'deletionOperationPublicId'
             = ${operationPublicId}
      JOIN focowiki.cleanup_actions cleanup
        ON cleanup.knowledge_base_id = source.knowledge_base_id
       AND cleanup.operation_public_id = ${operationPublicId}
       AND cleanup.action_kind = 'document_resource_deletion'
      WHERE source.public_id = ${sourceFilePublicId}
    `).resolves.toEqual([{
      deleted: true,
      active_source_revision_public_id: `${sourceFilePublicId}-revision`,
      operation: "delete",
      outcome: "pending",
      cleanup_phase: "reconcile_projection"
    }]);
  });

  it("immediately excludes a file and makes replay return the same affected count", async () => {
    const request = {
      knowledgeBaseId: "knowledge-base-delete",
      targetKind: "source_file" as const,
      targetPublicId: "source-file-delete",
      expectedResourceRevision: 1,
      operationPublicId: "operation-delete-file",
      idempotencyKey: "delete-file-request",
      maximumAttempts: 3,
      requestedAt: "2026-08-14T12:00:00.000Z",
      expiresAt: "2026-08-15T12:00:00.000Z"
    };
    await expect(accept(request)).resolves.toEqual({
      operationPublicId: "operation-delete-file",
      affectedSourceCount: 1,
      replayed: false
    });
    await expect(accept({
      ...request,
      operationPublicId: "operation-delete-file-retry",
      requestedAt: "2026-08-14T12:00:01.000Z",
      expiresAt: "2026-08-15T12:00:01.000Z"
    })).resolves.toEqual({
      operationPublicId: "operation-delete-file",
      affectedSourceCount: 1,
      replayed: true
    });
    await expect(deletionFacts("source-file-delete")).resolves.toEqual([{
      deleted: true,
      active_source_revision_public_id: "source-file-delete-revision",
      job_state: "deleting",
      cleanup_state: "queued"
    }]);
  });

  it("applies authoritative directory and knowledge-base visibility without publication", async () => {
    await expect(accept({
      knowledgeBaseId: "knowledge-base-delete",
      targetKind: "source_directory",
      targetPublicId: "source-directory-delete",
      expectedResourceRevision: 1,
      operationPublicId: "operation-delete-directory",
      idempotencyKey: "delete-directory-request",
      maximumAttempts: 3,
      requestedAt: "2026-08-14T12:05:00.000Z",
      expiresAt: "2026-08-15T12:05:00.000Z"
    })).resolves.toMatchObject({ affectedSourceCount: 1 });
    await expect(deletionFacts("source-file-directory-delete")).resolves.toEqual([{
      deleted: true,
      active_source_revision_public_id: "source-file-directory-delete-revision",
      job_state: "deleting",
      cleanup_state: "queued"
    }]);
    await seedKnowledgeBaseScopedProjectionRows(sql);
    await expect(accept({
      knowledgeBaseId: "knowledge-base-delete-empty",
      targetKind: "knowledge_base",
      targetPublicId: "knowledge-base-delete-empty",
      expectedResourceRevision: 1,
      operationPublicId: "operation-delete-knowledge-base",
      idempotencyKey: "delete-knowledge-base-request",
      maximumAttempts: 3,
      requestedAt: "2026-08-14T12:10:00.000Z",
      expiresAt: "2026-08-15T12:10:00.000Z"
    })).resolves.toMatchObject({ affectedSourceCount: 0 });
    await expect(sql<Array<{ deleted: boolean }>>`
      SELECT deleted_at IS NOT NULL AS deleted
      FROM focowiki.knowledge_bases
      WHERE public_id = 'knowledge-base-delete-empty'
    `).resolves.toEqual([{ deleted: true }]);
    await sql`
      UPDATE focowiki.operations
      SET state = 'completed', completed_at = now(), updated_at = now()
      WHERE public_id = 'operation-delete-knowledge-base'
    `;
    const [knowledgeBaseCleanup] = await sql<Array<{ public_id: string }>>`
      UPDATE focowiki.cleanup_actions
      SET state = 'running', lease_owner = 'knowledge-base-delete-worker',
          lease_expires_at = now() + interval '1 minute'
      WHERE operation_public_id = 'operation-delete-knowledge-base'
        AND action_kind = 'document_resource_deletion'
      RETURNING public_id
    `;
    expect(knowledgeBaseCleanup?.public_id).toBeTruthy();
    const deletion = createPostgresDocumentResourceDeletion(
      sql as unknown as DatabaseClient
    );
    await expect(deletion.actions.complete({
      publicId: knowledgeBaseCleanup!.public_id,
      owner: "knowledge-base-delete-worker",
      completedAt: new Date().toISOString()
    })).resolves.toBe(true);
    await expect(sql`
      SELECT count(*) AS count FROM focowiki.knowledge_bases
      WHERE public_id = 'knowledge-base-delete-empty'
    `).resolves.toEqual([{ count: "0" }]);
    await expect(sql`
      SELECT count(*) AS count
      FROM focowiki.publication_jobs
      WHERE knowledge_base_id = 'knowledge-base-delete-empty'
    `).resolves.toEqual([{ count: "0" }]);
    await expect(sql<Array<{ zero_owner_since: Date | string | null }>>`
      SELECT zero_owner_since FROM focowiki.object_registrations
      WHERE object_id = 'empty-knowledge-base-generated-object'
    `).resolves.toEqual([{
      zero_owner_since: expect.any(Date)
    }]);
    await expect(sql`
      SELECT state FROM focowiki.cleanup_actions
      WHERE action_kind = 'zero_owner_object'
        AND resource_public_id = 'empty-knowledge-base-generated-object'
        AND checkpoint ->> 'schemaVersion'
              = 'knowledge-base-publication-cleanup-v2'
    `).resolves.toEqual([{ state: "queued" }]);
    const operationRead = createPostgresStorageVnextOperationRead(
      sql as unknown as DatabaseClient
    );
    await expect(operationRead.get({
      knowledgeBaseId: "knowledge-base-delete-empty",
      operationId: "operation-delete-knowledge-base"
    })).resolves.toMatchObject({
      id: "operation-delete-knowledge-base",
      kind: "knowledge_base_delete",
      state: "completed",
      targetKind: "knowledge_base",
      targetId: "knowledge-base-delete-empty"
    });
    await expect(sql`
      SELECT sum(remaining)::text AS count
      FROM (
        SELECT count(*) AS remaining FROM focowiki.relation_candidate_pairs
        WHERE knowledge_base_id = 'knowledge-base-delete-empty'
        UNION ALL
        SELECT count(*) FROM focowiki.relation_directed_evidence
        WHERE knowledge_base_id = 'knowledge-base-delete-empty'
        UNION ALL
        SELECT count(*) FROM focowiki.canonical_file_relations
        WHERE knowledge_base_id = 'knowledge-base-delete-empty'
        UNION ALL
        SELECT count(*) FROM focowiki.search_family_receipts
        WHERE knowledge_base_id = 'knowledge-base-delete-empty'
        UNION ALL
        SELECT count(*) FROM focowiki.generated_page_bases
        WHERE knowledge_base_id = 'knowledge-base-delete-empty'
        UNION ALL
        SELECT count(*) FROM focowiki.publication_jobs
        WHERE knowledge_base_id = 'knowledge-base-delete-empty'
      ) scoped_rows
    `).resolves.toEqual([{ count: "0" }]);
  });

  it("accepts a new deletion after the same directory path is recreated",
    async () => {
      await sql`
        INSERT INTO focowiki.source_directories (
          public_id, knowledge_base_id, parent_public_id,
          logical_path, normalized_path, title, revision
        ) VALUES (
          'source-directory-recreated', 'knowledge-base-delete', NULL,
          'Recreated', 'recreated', 'Recreated', 1
        )
      `;
      await seedAvailableSource(
        "source-file-recreated",
        "Recreated/document.md",
        "source-directory-recreated"
      );
      const first = {
        knowledgeBaseId: "knowledge-base-delete",
        targetKind: "source_directory" as const,
        targetPublicId: "source-directory-recreated",
        expectedResourceRevision: 1,
        operationPublicId: "operation-delete-recreated-first",
        idempotencyKey: "delete-recreated-first",
        maximumAttempts: 3,
        requestedAt: "2026-08-14T12:07:00.000Z",
        expiresAt: "2026-08-15T12:07:00.000Z"
      };
      await expect(accept(first)).resolves.toMatchObject({
        affectedSourceCount: 1,
        replayed: false
      });
      await sql`
        UPDATE focowiki.source_directories
        SET deleted_at = NULL, revision = 1
        WHERE public_id = 'source-directory-recreated'
      `;
      await sql`
        UPDATE focowiki.source_files
        SET deleted_at = NULL
        WHERE public_id = 'source-file-recreated'
      `;
      await sql`
        UPDATE focowiki.document_processing_jobs
        SET state = 'available', terminal_at = now(), revision = revision + 1
        WHERE source_file_public_id = 'source-file-recreated'
      `;

      await expect(accept({
        ...first,
        operationPublicId: "operation-delete-recreated-second",
        idempotencyKey: "delete-recreated-second",
        requestedAt: "2026-08-14T12:08:00.000Z",
        expiresAt: "2026-08-15T12:08:00.000Z"
      })).resolves.toMatchObject({
        operationPublicId: "operation-delete-recreated-second",
        affectedSourceCount: 1,
        replayed: false
      });
    });

  it("resumes bounded directory cleanup from its durable checkpoint", async () => {
    const requestedAt = new Date().toISOString();
    const accepted = await accept({
      knowledgeBaseId: "knowledge-base-delete",
      targetKind: "source_directory",
      targetPublicId: "source-directory-cleanup",
      expectedResourceRevision: 1,
      operationPublicId: "operation-cleanup-directory",
      idempotencyKey: "cleanup-directory-request",
      maximumAttempts: 3,
      requestedAt,
      expiresAt: new Date(Date.parse(requestedAt) + 86_400_000).toISOString()
    });
    expect(accepted.affectedSourceCount).toBe(1);
    const ports = createPostgresDocumentResourceDeletion(
      sql as unknown as DatabaseClient
    );
    await sql`
      UPDATE focowiki.cleanup_actions
      SET state = 'completed', completed_at = now(), updated_at = now()
      WHERE action_kind = 'document_resource_deletion'
        AND operation_public_id <> 'operation-cleanup-directory'
        AND state IN ('queued', 'running', 'retry')
    `;
    let completed = false;
    for (let iteration = 0; iteration < 8 && !completed; iteration += 1) {
      await sql`
        UPDATE focowiki.cleanup_actions
        SET state = 'completed', completed_at = now(), updated_at = now()
        WHERE operation_public_id = 'operation-cleanup-directory'
          AND action_kind <> 'document_resource_deletion'
          AND state IN ('queued', 'running', 'retry')
      `;
      await sql`
        UPDATE focowiki.cleanup_actions SET not_before = now() - interval '1 second'
        WHERE operation_public_id = 'operation-cleanup-directory'
          AND action_kind = 'document_resource_deletion'
      `;
      const now = new Date().toISOString();
      const worker = createDocumentResourceDeletionWorker({
        ...ports,
        projections: {
          async reconcile({ action }) {
            await sql`
              UPDATE focowiki.publication_items
              SET outcome = 'committed', completed_at = now(), updated_at = now()
              WHERE knowledge_base_id = ${action.knowledgeBaseId}
                AND affected_evidence->>'deletionOperationPublicId'
                      = ${action.operationPublicId}
            `;
            return {
              done: false,
              processedSourceCount: 0,
              checkpoint: {
                phase: "deactivate" as const,
                cursor: null,
                affectedSourceCount: action.checkpoint.affectedSourceCount
              }
            };
          }
        }
      });
      const outcome = await worker.runBatch({
        owner: `cleanup-worker-${iteration}`,
        limit: 1,
        pageSize: 2,
        now,
        leaseExpiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
        retryDelayMilliseconds: 1,
        signal: new AbortController().signal
      });
      completed = outcome.completed === 1;
    }
    const cleanupDebug = await sql<Array<{
      state: string;
      safe_error_code: string | null;
      checkpoint: Record<string, unknown>;
    }>>`
      SELECT state, safe_error_code, checkpoint
      FROM focowiki.cleanup_actions
      WHERE operation_public_id = 'operation-cleanup-directory'
        AND action_kind = 'document_resource_deletion'
    `;
    expect(completed, JSON.stringify(cleanupDebug)).toBe(true);
    await expect(sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count FROM focowiki.source_files
      WHERE public_id = 'source-file-directory-cleanup'
    `).resolves.toEqual([{ count: "0" }]);
    await expect(sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count FROM focowiki.source_directories
      WHERE public_id = 'source-directory-cleanup'
    `).resolves.toEqual([{ count: "0" }]);
    await expect(sql<Array<{ state: string; operation_state: string }>>`
      SELECT cleanup.state, operation.state AS operation_state
      FROM focowiki.cleanup_actions cleanup
      JOIN focowiki.operations operation
        ON operation.public_id = cleanup.operation_public_id
      WHERE cleanup.operation_public_id = 'operation-cleanup-directory'
        AND cleanup.action_kind = 'document_resource_deletion'
    `).resolves.toEqual([{
      state: "completed",
      operation_state: "completed"
    }]);
  });

  it("detaches historical revision presentations when deleting an empty directory", async () => {
    await sql`
      INSERT INTO focowiki.source_directories (
        public_id, knowledge_base_id, parent_public_id,
        logical_path, normalized_path, title, revision
      ) VALUES (
        'source-directory-history', 'knowledge-base-delete', NULL,
        'History', 'history', 'History', 1
      )
    `;
    await seedAvailableSource("source-file-history-outside", "outside.md", null);
    await sql`
      INSERT INTO focowiki.source_revision_presentations (
        knowledge_base_id, source_file_public_id,
        source_revision_public_id, directory_public_id,
        logical_path, normalized_path, title
      ) VALUES (
        'knowledge-base-delete', 'source-file-history-outside',
        'source-file-history-outside-revision', 'source-directory-history',
        'History/outside.md', 'history/outside.md', 'Outside'
      )
    `;

    await expect(sql`
      DELETE FROM focowiki.source_directories
      WHERE knowledge_base_id = 'knowledge-base-delete'
        AND public_id = 'source-directory-history'
    `).resolves.toBeDefined();
    await expect(sql`
      SELECT directory_public_id, logical_path
      FROM focowiki.source_revision_presentations
      WHERE knowledge_base_id = 'knowledge-base-delete'
        AND source_revision_public_id = 'source-file-history-outside-revision'
    `).resolves.toEqual([{
      directory_public_id: null,
      logical_path: "History/outside.md"
    }]);
  });

  it("marks only the latest job deleting when a source has available history", async () => {
    await sql`
      INSERT INTO focowiki.document_artifact_work (
        public_id, knowledge_base_id, document_job_public_id,
        source_file_public_id, source_revision_public_id,
        work_kind, resource_lane, input_fingerprint_sha256,
        state, attempt_count, maximum_attempts, next_eligible_at,
        started_at, ended_at
      ) VALUES (
        'work-delete-neighbor', 'knowledge-base-delete',
        'source-file-delete-history-job-new',
        'source-file-delete-history',
        'source-file-delete-history-revision-new',
        'knowledge_projection', 'database_mutation', ${"4".repeat(64)},
        'completed', 1, 3, '2026-08-14T11:03:00.000Z',
        '2026-08-14T11:03:00.000Z', '2026-08-14T11:03:01.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_candidates (
        public_id, knowledge_base_id, owner_operation_public_id,
        source_work_public_id,
        logical_path, normalized_path, entry_kind,
        source_file_public_id, source_revision_public_id,
        page_source_file_public_id, page_source_revision_public_id,
        object_id, checksum_sha256, byte_count,
        base_activation_revision, state
      ) VALUES (
        'candidate-delete-neighbor', 'knowledge-base-delete', NULL,
        'work-delete-neighbor',
        'pages/embedding-delete.md', 'pages/embedding-delete.md', 'source',
        'source-file-delete-history',
        'source-file-delete-history-revision-new',
        'source-file-embedding-delete',
        'source-file-embedding-delete-revision',
        'source-file-delete-history-object-new', ${"3".repeat(64)}, 11,
        2, 'active'
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        source_file_public_id, source_revision_public_id,
        page_candidate_public_id, object_id, checksum_sha256,
        byte_count, activation_revision
      ) VALUES (
        'knowledge-base-delete', 'pages/embedding-delete.md',
        'pages/embedding-delete.md', 'source',
        'source-file-embedding-delete',
        'source-file-embedding-delete-revision',
        'candidate-delete-neighbor', 'source-file-delete-history-object-new',
        ${"3".repeat(64)}, 11, 2
      )
    `;
    await expect(accept({
      knowledgeBaseId: "knowledge-base-delete",
      targetKind: "source_file",
      targetPublicId: "source-file-delete-history",
      expectedResourceRevision: 1,
      operationPublicId: "operation-delete-file-history",
      idempotencyKey: "delete-file-history-request",
      maximumAttempts: 3,
      requestedAt: "2026-08-14T12:02:00.000Z",
      expiresAt: "2026-08-15T12:02:00.000Z"
    })).resolves.toMatchObject({ affectedSourceCount: 1 });
    await expect(sql<Array<{ state: string }>>`
      SELECT state FROM focowiki.document_processing_jobs
      WHERE source_file_public_id = 'source-file-delete-history'
      ORDER BY accepted_at
    `).resolves.toEqual([{ state: "available" }, { state: "deleting" }]);
    await expect(sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count FROM focowiki.generated_page_heads
      WHERE knowledge_base_id = 'knowledge-base-delete'
        AND normalized_path = 'index-history.md'
    `).resolves.toEqual([{ count: "1" }]);
    await expect(sql<Array<{
      owner_operation_public_id: string | null;
      source_file_public_id: string | null;
      page_source_file_public_id: string | null;
    }>>`
      SELECT owner_operation_public_id, source_file_public_id,
             page_source_file_public_id
      FROM focowiki.generated_page_candidates
      WHERE knowledge_base_id = 'knowledge-base-delete'
        AND public_id = 'candidate-delete-history'
    `).resolves.toEqual([{
      owner_operation_public_id: "source-file-delete-history-operation-new",
      source_file_public_id: null,
      page_source_file_public_id: "source-file-delete-history"
    }]);
    await expect(sql`
      SELECT owner_operation_public_id, source_file_public_id,
             source_revision_public_id, page_source_file_public_id,
             page_source_revision_public_id
      FROM focowiki.generated_page_candidates
      WHERE public_id = 'candidate-delete-neighbor'
    `).resolves.toEqual([{
      owner_operation_public_id: null,
      source_file_public_id: "source-file-delete-history",
      source_revision_public_id: "source-file-delete-history-revision-new",
      page_source_file_public_id: "source-file-embedding-delete",
      page_source_revision_public_id: "source-file-embedding-delete-revision"
    }]);
    const operationPages = createPostgresOperationGeneratedPageRepository(
      sql as unknown as DatabaseClient
    );
    await expect(operationPages.stage({
      knowledgeBaseId: "knowledge-base-delete",
      operationPublicId: "operation-delete-file-history",
      baseActivationRevision: 2,
      pages: [{
        logicalPath: "pages/embedding-delete.md",
        normalizedPath: "pages/embedding-delete.md",
        entryKind: "source",
        sourceFilePublicId: "source-file-embedding-delete",
        sourceRevisionPublicId: "source-file-embedding-delete-revision",
        objectId: "source-file-delete-history-object-new",
        checksumSha256: "3".repeat(64),
        byteCount: 11
      }],
      stagedAt: "2026-08-14T12:02:00.500Z"
    })).resolves.toHaveLength(1);
    await sql`
      DELETE FROM focowiki.generated_page_candidates
      WHERE knowledge_base_id = 'knowledge-base-delete'
        AND owner_operation_public_id = 'operation-delete-file-history'
        AND normalized_path = 'pages/embedding-delete.md'
    `;
    const ports = createPostgresDocumentResourceDeletion(
      sql as unknown as DatabaseClient
    );
    await expect(ports.processor.processPage({
      action: {
        publicId: "cleanup-delete-file-history",
        operationPublicId: "operation-delete-file-history",
        knowledgeBaseId: "knowledge-base-delete",
        targetKind: "source_file",
        targetPublicId: "source-file-delete-history",
        attempt: 1,
        maximumAttempts: 3,
        checkpoint: {
          phase: "deactivate",
          cursor: null,
          affectedSourceCount: 1
        }
      },
      pageSize: 10,
      now: "2026-08-14T12:02:01.000Z",
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      done: false,
      checkpoint: { phase: "await_external" }
    });
    await expect(sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count FROM focowiki.generated_page_heads
      WHERE knowledge_base_id = 'knowledge-base-delete'
        AND normalized_path = 'index-history.md'
    `).resolves.toEqual([{ count: "1" }]);
    await expect(ports.processor.processPage({
      action: {
        publicId: "cleanup-delete-file-history",
        operationPublicId: "operation-delete-file-history",
        knowledgeBaseId: "knowledge-base-delete",
        targetKind: "source_file",
        targetPublicId: "source-file-delete-history",
        attempt: 1,
        maximumAttempts: 3,
        checkpoint: {
          phase: "purge",
          cursor: null,
          affectedSourceCount: 1
        }
      },
      pageSize: 10,
      now: "2026-08-14T12:02:02.000Z",
      signal: new AbortController().signal
    })).resolves.toMatchObject({ done: false });
    await expect(sql`
      SELECT owner_operation_public_id, source_work_public_id,
             source_file_public_id, page_source_file_public_id
      FROM focowiki.generated_page_candidates
      WHERE public_id IN ('candidate-delete-history', 'candidate-delete-neighbor')
      ORDER BY public_id COLLATE "C"
    `).resolves.toEqual([{
      owner_operation_public_id: "operation-delete-file-history",
      source_work_public_id: null,
      source_file_public_id: null,
      page_source_file_public_id: null
    }, {
      owner_operation_public_id: "operation-delete-file-history",
      source_work_public_id: null,
      source_file_public_id: null,
      page_source_file_public_id: "source-file-embedding-delete"
    }]);
  });

  it("preserves the search provider on cleanup actions created by deletion", async () => {
    await sql`
      INSERT INTO focowiki.search_projections (
        public_id, knowledge_base_id, provider_kind, provider_index_uid,
        schema_checksum_sha256, settings_checksum_sha256, state
      ) VALUES (
        'search-provider-delete', 'knowledge-base-delete', 'opensearch',
        'provider-delete-index', ${"a".repeat(64)}, ${"b".repeat(64)}, 'active'
      )
    `;
    await sql`
      INSERT INTO focowiki.search_document_owners (
        knowledge_base_id, search_projection_public_id, provider_kind,
        provider_document_id, document_kind, source_file_public_id,
        source_revision_public_id, document_checksum_sha256, state,
        acknowledged_at
      ) VALUES (
        'knowledge-base-delete', 'search-provider-delete', 'opensearch',
        'provider-document-delete', 'file', 'source-file-provider-delete',
        'source-file-provider-delete-revision', ${"c".repeat(64)}, 'active', now()
      )
    `;
    const requestedAt = new Date().toISOString();
    await accept({
      knowledgeBaseId: "knowledge-base-delete",
      targetKind: "source_file",
      targetPublicId: "source-file-provider-delete",
      expectedResourceRevision: 1,
      operationPublicId: "operation-delete-provider",
      idempotencyKey: "delete-provider-request",
      maximumAttempts: 3,
      requestedAt,
      expiresAt: new Date(Date.parse(requestedAt) + 86_400_000).toISOString()
    });
    const ports = createPostgresDocumentResourceDeletion(
      sql as unknown as DatabaseClient
    );
    await ports.processor.processPage({
      action: {
        publicId: "cleanup-delete-provider",
        operationPublicId: "operation-delete-provider",
        knowledgeBaseId: "knowledge-base-delete",
        targetKind: "source_file",
        targetPublicId: "source-file-provider-delete",
        attempt: 1,
        maximumAttempts: 3,
        checkpoint: {
          phase: "deactivate",
          cursor: null,
          affectedSourceCount: 1
        }
      },
      pageSize: 10,
      now: requestedAt,
      signal: new AbortController().signal
    });
    await expect(sql`
      SELECT cleanup_plane, search_provider_kind, resource_public_id, state
      FROM focowiki.cleanup_actions
      WHERE operation_public_id = 'operation-delete-provider'
        AND action_kind = 'document_obsolete_artifact'
    `).resolves.toEqual([{
      cleanup_plane: "search",
      search_provider_kind: "opensearch",
      resource_public_id: "provider-document-delete",
      state: "queued"
    }]);
  });

  it("releases upload-entry object references while deactivating a deleted source", async () => {
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id
      ) VALUES (
        'operation-upload-reference-delete', 'knowledge-base-delete',
        'upload', 'processing', 'knowledge_base', 'knowledge-base-delete'
      )
    `;
    await sql`
      INSERT INTO focowiki.upload_sessions (
        public_id, knowledge_base_id, operation_public_id,
        manifest_fingerprint, state,
        expected_entry_count, expected_byte_count,
        received_entry_count, received_byte_count, expires_at
      ) VALUES (
        'upload-reference-delete', 'knowledge-base-delete',
        'operation-upload-reference-delete', ${"4".repeat(64)}, 'finalizing',
        1, 10, 1, 10, now() + interval '1 day'
      )
    `;
    await sql`
      INSERT INTO focowiki.upload_entries (
        upload_session_public_id, entry_public_id, knowledge_base_id,
        source_file_public_id, logical_path, normalized_path,
        checksum_sha256, byte_count, content_type, object_id, state
      ) VALUES (
        'upload-reference-delete', 'upload-entry-reference-delete',
        'knowledge-base-delete', 'source-file-upload-reference-delete',
        'upload-reference-delete.md', 'upload-reference-delete.md',
        ${"2".repeat(64)}, 10, 'text/markdown; charset=utf-8',
        'source-file-upload-reference-delete-object', 'verified'
      )
    `;
    const requestedAt = new Date().toISOString();
    await accept({
      knowledgeBaseId: "knowledge-base-delete",
      targetKind: "source_file",
      targetPublicId: "source-file-upload-reference-delete",
      expectedResourceRevision: 1,
      operationPublicId: "operation-delete-upload-reference",
      idempotencyKey: "delete-upload-reference-request",
      maximumAttempts: 3,
      requestedAt,
      expiresAt: new Date(Date.parse(requestedAt) + 86_400_000).toISOString()
    });
    const ports = createPostgresDocumentResourceDeletion(
      sql as unknown as DatabaseClient
    );
    await ports.processor.processPage({
      action: {
        publicId: "cleanup-delete-upload-reference",
        operationPublicId: "operation-delete-upload-reference",
        knowledgeBaseId: "knowledge-base-delete",
        targetKind: "source_file",
        targetPublicId: "source-file-upload-reference-delete",
        attempt: 1,
        maximumAttempts: 3,
        checkpoint: {
          phase: "deactivate",
          cursor: null,
          affectedSourceCount: 1
        }
      },
      pageSize: 10,
      now: requestedAt,
      signal: new AbortController().signal
    });
    await expect(sql`
      SELECT count(*) AS count FROM focowiki.upload_entries
      WHERE source_file_public_id = 'source-file-upload-reference-delete'
    `).resolves.toEqual([{ count: "0" }]);
    await expect(sql`
      SELECT count(*) AS count FROM focowiki.cleanup_actions
      WHERE operation_public_id = 'operation-delete-upload-reference'
        AND action_kind = 'zero_owner_object'
        AND resource_public_id = 'source-file-upload-reference-delete-object'
    `).resolves.toEqual([{ count: "0" }]);
    await ports.processor.processPage({
      action: {
        publicId: "cleanup-delete-upload-reference",
        operationPublicId: "operation-delete-upload-reference",
        knowledgeBaseId: "knowledge-base-delete",
        targetKind: "source_file",
        targetPublicId: "source-file-upload-reference-delete",
        attempt: 1,
        maximumAttempts: 3,
        checkpoint: {
          phase: "purge",
          cursor: null,
          affectedSourceCount: 1
        }
      },
      pageSize: 10,
      now: requestedAt,
      signal: new AbortController().signal
    });
    await expect(sql`
      SELECT state, resource_public_id FROM focowiki.cleanup_actions
      WHERE operation_public_id = 'operation-delete-upload-reference'
        AND action_kind = 'zero_owner_object'
        AND resource_public_id = 'source-file-upload-reference-delete-object'
    `).resolves.toEqual([{
      state: "queued",
      resource_public_id: "source-file-upload-reference-delete-object"
    }]);
  });

  it("converges the upload operation when a waiting source is deleted", async () => {
    const requestedAt = new Date().toISOString();
    const sourceFilePublicId = "source-file-waiting-upload-delete";
    const sourceRevisionPublicId = `${sourceFilePublicId}-revision`;
    const documentJobPublicId = `${sourceFilePublicId}-job`;
    const uploadOperationPublicId = "operation-waiting-upload-delete";
    const uploadSessionPublicId = "upload-waiting-upload-delete";
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'source-file-waiting-upload-delete-object',
        'waiting-upload-delete.md', ${"5".repeat(64)}, 10,
        'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
        'write-source-file-waiting-upload-delete', ${requestedAt}
      )
    `;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, revision, created_at, updated_at
      ) VALUES (
        ${sourceFilePublicId}, 'knowledge-base-delete',
        'waiting-upload-delete.md', 'waiting-upload-delete.md',
        'Waiting upload delete', 1, ${requestedAt}, ${requestedAt}
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type, created_at
      ) VALUES (
        ${sourceRevisionPublicId}, 'knowledge-base-delete',
        ${sourceFilePublicId}, 'source-file-waiting-upload-delete-object',
        ${"5".repeat(64)}, 10, 'text/markdown; charset=utf-8', ${requestedAt}
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence, updated_at
      ) VALUES (
        'knowledge-base-delete', ${sourceFilePublicId},
        ${sourceRevisionPublicId}, NULL, 0, ${requestedAt}
      )
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, created_at, updated_at
      ) VALUES (
        ${uploadOperationPublicId}, 'knowledge-base-delete', 'upload',
        'processing', 'knowledge_base', 'knowledge-base-delete',
        ${requestedAt}, ${requestedAt}
      )
    `;
    await sql`
      INSERT INTO focowiki.upload_sessions (
        public_id, knowledge_base_id, operation_public_id,
        manifest_fingerprint, state,
        expected_entry_count, expected_byte_count,
        received_entry_count, received_byte_count,
        expires_at, created_at, updated_at
      ) VALUES (
        ${uploadSessionPublicId}, 'knowledge-base-delete',
        ${uploadOperationPublicId}, ${"6".repeat(64)}, 'finalizing',
        1, 10, 1, 10, ${new Date(Date.parse(requestedAt) + 86_400_000).toISOString()},
        ${requestedAt}, ${requestedAt}
      )
    `;
    await sql`
      INSERT INTO focowiki.upload_entries (
        upload_session_public_id, entry_public_id, knowledge_base_id,
        source_file_public_id, logical_path, normalized_path,
        checksum_sha256, byte_count, content_type, object_id, state
      ) VALUES (
        ${uploadSessionPublicId}, 'upload-entry-waiting-upload-delete',
        'knowledge-base-delete', ${sourceFilePublicId},
        'waiting-upload-delete.md', 'waiting-upload-delete.md',
        ${"5".repeat(64)}, 10, 'text/markdown; charset=utf-8',
        'source-file-waiting-upload-delete-object', 'verified'
      )
    `;
    await sql`
      INSERT INTO focowiki.upload_operation_summaries (
        operation_public_id, knowledge_base_id, session_public_id,
        expected_entry_count, expected_byte_count, received_entry_count,
        received_byte_count, skipped_existing_count, expires_at, created_at
      ) VALUES (
        ${uploadOperationPublicId}, 'knowledge-base-delete',
        ${uploadSessionPublicId}, 1, 10, 1, 10, 0,
        ${new Date(Date.parse(requestedAt) + 86_400_000).toISOString()},
        ${requestedAt}
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
        state, maximum_attempts, required_work_count,
        completed_work_count, retryable, accepted_at,
        revision, created_at, updated_at
      ) VALUES (
        ${documentJobPublicId}, 'knowledge-base-delete',
        ${uploadOperationPublicId}, ${sourceFilePublicId},
        ${sourceRevisionPublicId}, 'runtime-delete',
        ${processingContract.generationModelConfigurationPublicId},
        ${processingContract.generationModelConfigurationRevision},
        ${processingContract.embeddingConfigurationRevisionPublicId},
        ${processingContract.semanticGenerationPublicId},
        'document-fixed-dag-v1', 'waiting', 3, 8, 0, false,
        ${requestedAt}, 1, ${requestedAt}, ${requestedAt}
      )
    `;
    await accept({
      knowledgeBaseId: "knowledge-base-delete",
      targetKind: "source_file",
      targetPublicId: sourceFilePublicId,
      expectedResourceRevision: 1,
      operationPublicId: "operation-delete-waiting-upload",
      idempotencyKey: "delete-waiting-upload-request",
      maximumAttempts: 3,
      requestedAt,
      expiresAt: new Date(Date.parse(requestedAt) + 86_400_000).toISOString()
    });
    const ports = createPostgresDocumentResourceDeletion(
      sql as unknown as DatabaseClient
    );
    await ports.processor.processPage({
      action: {
        publicId: "cleanup-delete-waiting-upload",
        operationPublicId: "operation-delete-waiting-upload",
        knowledgeBaseId: "knowledge-base-delete",
        targetKind: "source_file",
        targetPublicId: sourceFilePublicId,
        attempt: 1,
        maximumAttempts: 3,
        checkpoint: {
          phase: "purge",
          cursor: null,
          affectedSourceCount: 1
        }
      },
      pageSize: 10,
      now: requestedAt,
      signal: new AbortController().signal
    });
    await expect(sql`
      SELECT operation.state, result.result_summary
      FROM focowiki.operations operation
      LEFT JOIN focowiki.operation_results result
        ON result.public_id = operation.public_id
      WHERE operation.public_id = ${uploadOperationPublicId}
    `).resolves.toEqual([{
      state: "completed",
      result_summary: expect.objectContaining({
        totalCount: 1,
        cancelledCount: 1
      })
    }]);
  });

  it("retires embedding artifact ownership before completing source deletion", async () => {
    await sql`
      INSERT INTO focowiki.embedding_configurations (
        public_id, display_name, lifecycle_status, revision
      ) VALUES ('embedding-delete', 'Embedding delete', 'paused', 1)
    `;
    await sql`
      INSERT INTO focowiki.embedding_configuration_revisions (
        public_id, configuration_public_id, revision_number, authentication_mode,
        base_url, model_name, requested_dimension, resolved_dimension,
        normalization, maximum_input_tokens, batch_size, timeout_ms, retry_count,
        minimum_interval_ms, concurrency, maximum_response_bytes,
        minimum_vector_relevance, vector_producing_revision_public_id,
        validation_status, validation_fingerprint_sha256, validated_at
      ) VALUES (
        'embedding-revision-delete', 'embedding-delete', 1, 'none',
        'http://embedding.local/v1', 'embedding-model', 3, 3, 'l2',
        8192, 16, 5000, 1, 0, 2, 1048576, 0.7,
        'embedding-revision-delete', 'valid', ${"c".repeat(64)}, now()
      )
    `;
    await sql`
      UPDATE focowiki.embedding_configurations
      SET active_revision_public_id = 'embedding-revision-delete'
      WHERE public_id = 'embedding-delete'
    `;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'embedding-object-delete', 'semantic/delete-vector', ${"d".repeat(64)}, 12,
        'application/octet-stream', 'semantic-vector-v1', 'verified',
        'write-embedding-delete', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.embedding_artifacts (
        public_id, knowledge_base_id, object_id, owner_kind, owner_public_id,
        source_revision_public_id, canonical_input_sha256, input_kind,
        embedding_configuration_revision_public_id, normalization, dimension,
        artifact_schema_version, vector_checksum_sha256, byte_count, state
      ) VALUES (
        'embedding-artifact-delete', 'knowledge-base-delete',
        'embedding-object-delete', 'content', 'chunk-delete',
        'source-file-embedding-delete-revision', ${"e".repeat(64)}, 'content',
        'embedding-revision-delete', 'l2', 3, 'semantic-vector-v1',
        ${"d".repeat(64)}, 12, 'verified'
      )
    `;
    await sql`
      INSERT INTO focowiki.object_owners (
        public_id, object_id, owner_kind, knowledge_base_id,
        embedding_artifact_public_id
      ) VALUES (
        'object-owner-embedding-delete', 'embedding-object-delete',
        'embedding_artifact',
        'knowledge-base-delete', 'embedding-artifact-delete'
      )
    `;
    await sql`
      INSERT INTO focowiki.document_projection_records (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, summary, metadata, headings,
        entities, content_type, checksum_sha256, byte_count,
        tokenizer_contract_version, navigation_term_fingerprint_sha256, active
      ) VALUES (
        'knowledge-base-delete', 'source-file-embedding-delete',
        'source-file-embedding-delete-revision', 'embedding-delete.md',
        'embedding-delete.md', 'Embedding delete', 'Deletion projection fact',
        '{}'::jsonb, '{}'::text[], '{}'::text[],
        'text/markdown; charset=utf-8', ${"8".repeat(64)}, 12,
        'nodejieba-test-v1', ${"9".repeat(64)}, true
      )
    `;
    const requestedAt = new Date().toISOString();
    await accept({
      knowledgeBaseId: "knowledge-base-delete",
      targetKind: "source_file",
      targetPublicId: "source-file-embedding-delete",
      expectedResourceRevision: 1,
      operationPublicId: "operation-delete-embedding",
      idempotencyKey: "delete-embedding-request",
      maximumAttempts: 3,
      requestedAt,
      expiresAt: new Date(Date.parse(requestedAt) + 86_400_000).toISOString()
    });
    const ports = createPostgresDocumentResourceDeletion(
      sql as unknown as DatabaseClient
    );
    const action = {
      publicId: "cleanup-delete-embedding",
      operationPublicId: "operation-delete-embedding",
      knowledgeBaseId: "knowledge-base-delete",
      targetKind: "source_file" as const,
      targetPublicId: "source-file-embedding-delete",
      attempt: 1,
      maximumAttempts: 3,
      checkpoint: {
        phase: "deactivate" as const,
        cursor: null,
        affectedSourceCount: 1
      }
    };
    await ports.processor.processPage({
      action,
      pageSize: 10,
      now: requestedAt,
      signal: new AbortController().signal
    });
    await expect(sql`
      SELECT state FROM focowiki.embedding_artifacts
      WHERE public_id = 'embedding-artifact-delete'
    `).resolves.toEqual([{ state: "orphaned" }]);
    await expect(sql`
      SELECT active, retired_at IS NOT NULL AS retired
      FROM focowiki.document_projection_records
      WHERE knowledge_base_id = 'knowledge-base-delete'
        AND source_file_public_id = 'source-file-embedding-delete'
    `).resolves.toEqual([{ active: false, retired: true }]);
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'embedding-object-unrelated', 'semantic/unrelated-vector',
        ${"f".repeat(64)}, 12, 'application/octet-stream',
        'semantic-vector-v1', 'verified', 'write-embedding-unrelated', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.embedding_artifacts (
        public_id, knowledge_base_id, object_id, owner_kind, owner_public_id,
        source_revision_public_id, canonical_input_sha256, input_kind,
        embedding_configuration_revision_public_id, normalization, dimension,
        artifact_schema_version, vector_checksum_sha256, byte_count, state
      ) VALUES (
        'embedding-artifact-unrelated', 'knowledge-base-delete',
        'embedding-object-unrelated', 'content', 'chunk-unrelated',
        'unrelated-retired-revision', ${"f".repeat(64)}, 'content',
        'embedding-revision-delete', 'l2', 3, 'semantic-vector-v1',
        ${"f".repeat(64)}, 12, 'orphaned'
      )
    `;
    const firstPurge = await ports.processor.processPage({
      action: { ...action, checkpoint: { ...action.checkpoint, phase: "purge" } },
      pageSize: 10,
      now: requestedAt,
      signal: new AbortController().signal
    });
    expect(firstPurge.checkpoint.phase).toBe("purge");
    const finalPurge = await ports.processor.processPage({
      action: { ...action, checkpoint: firstPurge.checkpoint },
      pageSize: 10,
      now: requestedAt,
      signal: new AbortController().signal
    });
    expect(finalPurge).toMatchObject({
      done: false,
      checkpoint: { phase: "await_external" }
    });
    await expect(sql`
      SELECT count(*) AS count FROM focowiki.embedding_artifacts
      WHERE public_id = 'embedding-artifact-delete'
    `).resolves.toEqual([{ count: "0" }]);
    await expect(sql`
      SELECT state FROM focowiki.embedding_artifacts
      WHERE public_id = 'embedding-artifact-unrelated'
    `).resolves.toEqual([{ state: "orphaned" }]);
    await expect(sql`
      SELECT count(*) AS count FROM focowiki.object_owners
      WHERE object_id = 'embedding-object-delete'
    `).resolves.toEqual([{ count: "0" }]);
    await expect(sql`
      SELECT state, resource_public_id FROM focowiki.cleanup_actions
      WHERE operation_public_id = 'operation-delete-embedding'
        AND action_kind = 'zero_owner_object'
        AND resource_public_id = 'embedding-object-delete'
    `).resolves.toEqual([{
      state: "queued",
      resource_public_id: "embedding-object-delete"
    }]);
  });

  async function seedAvailableSource(
    sourceFilePublicId: string,
    logicalPath: string,
    directoryPublicId: string | null
  ): Promise<void> {
    const revisionPublicId = `${sourceFilePublicId}-revision`;
    const objectId = `${sourceFilePublicId}-object`;
    const operationPublicId = `${sourceFilePublicId}-operation`;
    const jobPublicId = `${sourceFilePublicId}-job`;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        ${objectId}, ${logicalPath}, ${"2".repeat(64)}, 10,
        'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
        ${`write-${sourceFilePublicId}`}, '2026-08-14T11:00:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, directory_public_id,
        logical_path, normalized_path, title, revision
      ) VALUES (
        ${sourceFilePublicId}, 'knowledge-base-delete', ${directoryPublicId},
        ${logicalPath}, ${logicalPath.toLowerCase()}, ${sourceFilePublicId}, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES (
        ${revisionPublicId}, 'knowledge-base-delete', ${sourceFilePublicId},
        ${objectId}, ${"2".repeat(64)}, 10, 'text/markdown; charset=utf-8'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence
      ) VALUES (
        'knowledge-base-delete', ${sourceFilePublicId},
        ${revisionPublicId}, ${revisionPublicId}, 2
      )
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, completed_at
      ) VALUES (
        ${operationPublicId}, 'knowledge-base-delete', 'source_processing',
        'completed', 'source_file', ${sourceFilePublicId},
        '2026-08-14T11:01:00.000Z'
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
        maximum_attempts, required_work_count, completed_work_count, retryable,
        accepted_at, started_at, terminal_at, revision,
        created_at, updated_at
      ) VALUES (
        ${jobPublicId}, 'knowledge-base-delete', ${operationPublicId},
        ${sourceFilePublicId}, ${revisionPublicId}, 'runtime-delete',
        ${processingContract.generationModelConfigurationPublicId},
        ${processingContract.generationModelConfigurationRevision},
        ${processingContract.embeddingConfigurationRevisionPublicId},
        ${processingContract.semanticGenerationPublicId},
        'document-fixed-dag-v1', 'available', 1, 0, 1, 3, 8, 8,
        false, '2026-08-14T11:00:00.000Z',
        '2026-08-14T11:00:00.000Z', '2026-08-14T11:01:00.000Z', 1,
        '2026-08-14T11:00:00.000Z', '2026-08-14T11:01:00.000Z'
      )
    `;
  }

  async function seedKnowledgeBaseScopedProjectionRows(
    sql: postgres.Sql
  ): Promise<void> {
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        'empty-knowledge-base-generated-object', 'generated/empty.json',
        ${"7".repeat(64)}, 2, 'application/json', 'generated_json',
        'verified', 'write-empty-knowledge-base-generated-object', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.relation_candidate_pairs (
        public_id, knowledge_base_id, first_source_file_public_id,
        first_source_revision_public_id, second_source_file_public_id,
        second_source_revision_public_id, evidence_fingerprint_sha256,
        state, next_eligible_at
      ) VALUES (
        'pair-empty-knowledge-base', 'knowledge-base-delete-empty',
        'source-a', 'revision-a', 'source-b', 'revision-b',
        ${"8".repeat(64)}, 'resolved', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.relation_directed_evidence (
        public_id, knowledge_base_id, pair_public_id,
        source_file_public_id, source_revision_public_id,
        target_source_file_public_id, target_source_revision_public_id,
        evidence_kind, evidence_fingerprint_sha256, evidence
      ) VALUES (
        'evidence-empty-knowledge-base', 'knowledge-base-delete-empty',
        'pair-empty-knowledge-base', 'source-a', 'revision-a',
        'source-b', 'revision-b', 'title_alias', ${"9".repeat(64)},
        '{"reason":"test"}'::jsonb
      )
    `;
    await sql`
      INSERT INTO focowiki.canonical_file_relations (
        public_id, knowledge_base_id, pair_public_id,
        first_source_file_public_id, first_source_revision_public_id,
        second_source_file_public_id, second_source_revision_public_id,
        relation_kind, direction
      ) VALUES (
        'relation-empty-knowledge-base', 'knowledge-base-delete-empty',
        'pair-empty-knowledge-base', 'source-a', 'revision-a',
        'source-b', 'revision-b', 'related', 'bidirectional'
      )
    `;
    await sql`
      INSERT INTO focowiki.search_family_receipts (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, provider_kind, family,
        input_fingerprint_sha256, state
      ) VALUES (
        'receipt-empty-knowledge-base', 'knowledge-base-delete-empty',
        'source-a', 'revision-a', 'opensearch', 'content_metadata',
        ${"a".repeat(64)}, 'acknowledged'
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_bases (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, input_fingerprint_sha256,
        object_id, checksum_sha256
      ) VALUES (
        'base-empty-knowledge-base', 'knowledge-base-delete-empty',
        'source-a', 'revision-a', ${"b".repeat(64)},
        'empty-knowledge-base-generated-object', ${"7".repeat(64)}
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_jobs (
        public_id, knowledge_base_id, base_active_revision,
        target_readiness_sequence, renderer_contract_version,
        settings_snapshot, outcome, attempt_count,
        manifest_fingerprint_sha256, manifest_attempt_token,
        completed_at
      ) VALUES (
        'publication-job-empty-knowledge-base',
        'knowledge-base-delete-empty', 0, 1,
        'portable-okf-v2', '{}'::jsonb, 'committed', 1,
        ${"c".repeat(64)}, 'manifest-empty-knowledge-base', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.publication_job_outputs (
        job_public_id, normalized_path, output_order, action,
        logical_path, entry_kind, object_id, checksum_sha256,
        byte_count, content_type, producer_fingerprint_sha256
      ) VALUES (
        'publication-job-empty-knowledge-base', 'index.md', 0, 'put',
        'index.md', 'index', 'empty-knowledge-base-generated-object',
        ${"7".repeat(64)}, 2, 'text/markdown; charset=utf-8',
        ${"d".repeat(64)}
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        object_id, checksum_sha256, byte_count, activation_revision
      ) VALUES (
        'knowledge-base-delete-empty', 'index.md', 'index.md', 'index',
        'empty-knowledge-base-generated-object', ${"7".repeat(64)}, 2, 1
      )
    `;
  }

  async function seedNewAvailableRevision(
    sourceFilePublicId: string,
    logicalPath: string
  ): Promise<void> {
    const revisionPublicId = `${sourceFilePublicId}-revision-new`;
    const objectId = `${sourceFilePublicId}-object-new`;
    const operationPublicId = `${sourceFilePublicId}-operation-new`;
    const jobPublicId = `${sourceFilePublicId}-job-new`;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        ${objectId}, ${`${logicalPath}.new`}, ${"3".repeat(64)}, 11,
        'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
        ${`write-${sourceFilePublicId}-new`}, '2026-08-14T11:02:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES (
        ${revisionPublicId}, 'knowledge-base-delete', ${sourceFilePublicId},
        ${objectId}, ${"3".repeat(64)}, 11, 'text/markdown; charset=utf-8'
      )
    `;
    await sql`
      UPDATE focowiki.source_file_active_revisions
      SET current_source_revision_public_id = ${revisionPublicId},
          active_source_revision_public_id = ${revisionPublicId}
      WHERE knowledge_base_id = 'knowledge-base-delete'
        AND source_file_public_id = ${sourceFilePublicId}
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, completed_at
      ) VALUES (
        ${operationPublicId}, 'knowledge-base-delete', 'source_processing',
        'completed', 'source_file', ${sourceFilePublicId},
        '2026-08-14T11:03:00.000Z'
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
        maximum_attempts, required_work_count, completed_work_count, retryable,
        accepted_at, started_at, terminal_at, revision,
        created_at, updated_at
      ) VALUES (
        ${jobPublicId}, 'knowledge-base-delete', ${operationPublicId},
        ${sourceFilePublicId}, ${revisionPublicId}, 'runtime-delete',
        ${processingContract.generationModelConfigurationPublicId},
        ${processingContract.generationModelConfigurationRevision},
        ${processingContract.embeddingConfigurationRevisionPublicId},
        ${processingContract.semanticGenerationPublicId},
        'document-fixed-dag-v1', 'available', 1, 0, 1, 3, 8, 8,
        false, '2026-08-14T11:02:00.000Z',
        '2026-08-14T11:02:00.000Z', '2026-08-14T11:03:00.000Z', 1,
        '2026-08-14T11:02:00.000Z', '2026-08-14T11:03:00.000Z'
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_candidates (
        public_id, knowledge_base_id, owner_operation_public_id,
        logical_path, normalized_path, entry_kind,
        page_source_file_public_id, page_source_revision_public_id,
        object_id, checksum_sha256, byte_count,
        base_activation_revision, state
      ) VALUES (
        'candidate-delete-history', 'knowledge-base-delete',
        ${operationPublicId}, 'index-history.md', 'index-history.md', 'index',
        ${sourceFilePublicId}, ${revisionPublicId},
        ${objectId}, ${"3".repeat(64)}, 11, 2, 'active'
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        source_file_public_id, source_revision_public_id,
        page_candidate_public_id, object_id, checksum_sha256,
        byte_count, activation_revision
      ) VALUES (
        'knowledge-base-delete', 'index-history.md', 'index-history.md',
        'index', NULL, NULL,
        'candidate-delete-history', ${objectId},
        ${"3".repeat(64)}, 11, 2
      )
    `;
  }

  function deletionFacts(sourceFilePublicId: string) {
    return sql<Array<{
      deleted: boolean;
      active_source_revision_public_id: string | null;
      job_state: string;
      cleanup_state: string;
    }>>`
      SELECT source.deleted_at IS NOT NULL AS deleted,
             active.active_source_revision_public_id,
             job.state AS job_state, cleanup.state AS cleanup_state
      FROM focowiki.source_files source
      JOIN focowiki.source_file_active_revisions active
        ON active.source_file_public_id = source.public_id
      JOIN focowiki.document_processing_jobs job
        ON job.source_file_public_id = source.public_id
      JOIN focowiki.cleanup_actions cleanup
        ON cleanup.operation_public_id IN (
          SELECT public_id FROM focowiki.operations
          WHERE target_public_id = source.public_id
            OR target_public_id = source.directory_public_id
        )
       AND cleanup.action_kind = 'document_resource_deletion'
      WHERE source.public_id = ${sourceFilePublicId}
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
