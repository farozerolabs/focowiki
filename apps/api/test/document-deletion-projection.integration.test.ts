import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresOperationGeneratedPageRepository } from
  "../src/document-indexing/infrastructure/postgres-operation-generated-page-repository.js";
import { createPostgresDocumentDeletionProjectionCommit } from
  "../src/document-indexing/infrastructure/postgres-document-deletion-projection-commit.js";
import { createPostgresDocumentDeletionProjectionContext } from
  "../src/document-indexing/infrastructure/postgres-document-deletion-projection-context.js";
import { createZeroOwnerObjectCleanup } from
  "../src/document-indexing/application/zero-owner-object-cleanup.js";
import { createPostgresZeroOwnerObjectCleanup } from
  "../src/document-indexing/infrastructure/postgres-zero-owner-object-cleanup.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document deletion projection PostgreSQL", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_deletion_projection_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('knowledge-base-projection', 'Projection', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('knowledge-base-projection', 4)
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, completed_at
      ) VALUES (
        'operation-delete-projection', 'knowledge-base-projection',
        'deletion', 'processing', 'source_file', 'source-file-deleted', NULL
      ), (
        'operation-old-projection', 'knowledge-base-projection',
        'deletion', 'completed', 'source_file', 'source-file-older', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.cleanup_actions (
        public_id, knowledge_base_id, operation_public_id,
        action_kind, cleanup_plane, resource_kind, resource_public_id,
        required, priority, sequence_number, idempotency_key, request_hash,
        checkpoint, state, attempt_count, maximum_attempts,
        lease_owner, lease_expires_at, not_before
      ) VALUES (
        'cleanup-delete-projection', 'knowledge-base-projection',
        'operation-delete-projection', 'document_resource_deletion',
        'postgres', 'source_file', 'source-file-deleted', true, 10, 1,
        'delete-projection', ${"1".repeat(64)},
        ${sql.json({
          phase: "reconcile_projection",
          cursor: null,
          affectedSourceCount: 1
        })}, 'running', 1, 3, 'worker-projection',
        now() + interval '1 minute', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count,
        content_type, object_format, state, write_attempt_public_id,
        verified_at
      ) VALUES (
        'object-root-v2', 'generated/object-root-v2', ${"a".repeat(64)}, 12,
        'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
        'verified', 'write-root-v2', now()
      ), (
        'object-root-v1', 'generated/object-root-v1', ${"b".repeat(64)}, 11,
        'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
        'verified', 'write-root-v1', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, revision, deleted_at
      ) VALUES (
        'source-file-deleted', 'knowledge-base-projection',
        'deleted.md', 'deleted.md', 'Deleted', 2,
        (SELECT created_at FROM focowiki.operations
         WHERE public_id = 'operation-delete-projection')
      ), (
        'source-file-survivor', 'knowledge-base-projection',
        'survivor.md', 'survivor.md', 'Survivor', 1, NULL
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES (
        'source-revision-deleted', 'knowledge-base-projection',
        'source-file-deleted', 'object-root-v1', ${"b".repeat(64)}, 11,
        'text/markdown; charset=utf-8'
      ), (
        'source-revision-survivor', 'knowledge-base-projection',
        'source-file-survivor', 'object-root-v2', ${"a".repeat(64)}, 12,
        'text/markdown; charset=utf-8'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence
      ) VALUES (
        'knowledge-base-projection', 'source-file-deleted',
        'source-revision-deleted', NULL, 4
      ), (
        'knowledge-base-projection', 'source-file-survivor',
        'source-revision-survivor', 'source-revision-survivor', 4
      )
    `;
    await sql`
      INSERT INTO focowiki.relation_candidate_pairs (
        public_id, knowledge_base_id,
        first_source_file_public_id, first_source_revision_public_id,
        second_source_file_public_id, second_source_revision_public_id,
        evidence_fingerprint_sha256, state, next_eligible_at
      ) VALUES (
        'relation-pair-deleted', 'knowledge-base-projection',
        'source-file-deleted', 'source-revision-deleted',
        'source-file-survivor', 'source-revision-survivor',
        ${"e".repeat(64)}, 'retired', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.canonical_file_relations (
        public_id, knowledge_base_id, pair_public_id,
        first_source_file_public_id, first_source_revision_public_id,
        second_source_file_public_id, second_source_revision_public_id,
        relation_kind, direction, active, activated_sequence, retired_at
      ) VALUES (
        'relation-deleted', 'knowledge-base-projection',
        'relation-pair-deleted',
        'source-file-deleted', 'source-revision-deleted',
        'source-file-survivor', 'source-revision-survivor',
        'related', 'first_to_second', false, 4,
        (SELECT created_at FROM focowiki.operations
         WHERE public_id = 'operation-delete-projection')
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_candidates (
        public_id, knowledge_base_id, owner_operation_public_id,
        logical_path, normalized_path, entry_kind, object_id,
        checksum_sha256, byte_count, base_activation_revision,
        state, created_at
      ) VALUES (
        'candidate-root-v1', 'knowledge-base-projection',
        'operation-old-projection', 'index.md', 'index.md', 'index',
        'object-root-v1', ${"b".repeat(64)}, 11, 3, 'active', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        page_candidate_public_id, object_id, checksum_sha256,
        byte_count, activation_revision
      ) VALUES (
        'knowledge-base-projection', 'index.md', 'index.md', 'index',
        'candidate-root-v1', 'object-root-v1', ${"b".repeat(64)}, 11, 4
      )
    `;
    await sql`
      INSERT INTO focowiki.search_projections (
        public_id, knowledge_base_id, provider_kind, provider_index_uid,
        schema_checksum_sha256, settings_checksum_sha256,
        active_contract_revision, document_count, state, revision
      ) VALUES (
        'search-projection-delete', 'knowledge-base-projection',
        'opensearch', 'search-index-delete', ${"c".repeat(64)},
        ${"d".repeat(64)}, 1, 3, 'active', 1
      )
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

  it("activates operation-owned replacement pages without a deleted source owner", async () => {
    const repository = createPostgresOperationGeneratedPageRepository(
      sql as unknown as DatabaseClient
    );
    const [candidate] = await repository.stage({
      knowledgeBaseId: "knowledge-base-projection",
      operationPublicId: "operation-delete-projection",
      baseActivationRevision: 4,
      pages: [{
        logicalPath: "index.md",
        normalizedPath: "index.md",
        entryKind: "index",
        sourceFilePublicId: null,
        sourceRevisionPublicId: null,
        objectId: "object-root-v2",
        checksumSha256: "a".repeat(64),
        byteCount: 12
      }],
      stagedAt: "2026-08-14T14:00:00.000Z"
    });
    const action = {
      publicId: "cleanup-delete-projection",
      operationPublicId: "operation-delete-projection",
      knowledgeBaseId: "knowledge-base-projection",
      targetKind: "source_file" as const,
      targetPublicId: "source-file-deleted",
      attempt: 1,
      maximumAttempts: 3,
      checkpoint: {
        phase: "reconcile_projection" as const,
        cursor: null,
        affectedSourceCount: 1
      }
    };
    const commit = createPostgresDocumentDeletionProjectionCommit(
      sql as unknown as DatabaseClient
    );

    await expect(commit.commit({
      action,
      pageCandidates: [candidate!],
      removedPageNormalizedPaths: [],
      navigationMutations: [],
      committedAt: "2026-08-14T14:00:01.000Z"
    })).resolves.toEqual({ activationRevision: 5 });
    await expect(sql`
      SELECT candidate.owner_operation_public_id, candidate.source_revision_public_id,
             head.activation_revision
      FROM focowiki.generated_page_heads head
      JOIN focowiki.generated_page_candidates candidate
        ON candidate.knowledge_base_id = head.knowledge_base_id
       AND candidate.public_id = head.page_candidate_public_id
      WHERE head.knowledge_base_id = 'knowledge-base-projection'
        AND head.normalized_path = 'index.md'
    `).resolves.toEqual([{
      owner_operation_public_id: "operation-delete-projection",
      source_revision_public_id: null,
      activation_revision: "5"
    }]);
    await expect(sql`
      SELECT count(*) AS count FROM focowiki.generated_page_candidates
      WHERE public_id = 'candidate-root-v1'
    `).resolves.toEqual([{ count: "0" }]);
    await expect(sql`
      SELECT state, resource_public_id FROM focowiki.cleanup_actions
      WHERE action_kind = 'zero_owner_object'
        AND resource_public_id = 'object-root-v1'
    `).resolves.toEqual([{
      state: "queued",
      resource_public_id: "object-root-v1"
    }]);
    await sql`
      UPDATE focowiki.cleanup_actions
      SET not_before = now() - interval '1 second'
      WHERE action_kind = 'zero_owner_object'
        AND resource_public_id = 'object-root-v1'
    `;
    const removeZeroOwner = vi.fn().mockResolvedValue(undefined);
    const cleanup = createZeroOwnerObjectCleanup({
      actions: createPostgresZeroOwnerObjectCleanup(
        sql as unknown as DatabaseClient
      ),
      objects: { removeZeroOwner }
    });
    await expect(cleanup.run({
      owner: "worker-cleanup",
      limit: 10,
      now: "2026-08-14T14:00:02.000Z",
      leaseExpiresAt: "2026-08-14T14:01:02.000Z",
      retryAt: "2026-08-14T14:00:04.000Z",
      signal: new AbortController().signal
    })).resolves.toMatchObject({ completed: 1 });
    expect(removeZeroOwner).toHaveBeenCalledWith("object-root-v1");
    await expect(sql`
      SELECT state FROM focowiki.cleanup_actions
      WHERE action_kind = 'zero_owner_object'
        AND resource_public_id = 'object-root-v1'
    `).resolves.toEqual([{ state: "completed" }]);
  });

  it("retires the search projection when a knowledge base is cleared", async () => {
    const commit = createPostgresDocumentDeletionProjectionCommit(
      sql as unknown as DatabaseClient
    );
    await commit.clearKnowledgeBase({
      action: {
        publicId: "cleanup-delete-projection",
        operationPublicId: "operation-delete-projection",
        knowledgeBaseId: "knowledge-base-projection",
        targetKind: "knowledge_base",
        targetPublicId: "knowledge-base-projection",
        attempt: 1,
        maximumAttempts: 3,
        checkpoint: {
          phase: "reconcile_projection",
          cursor: null,
          affectedSourceCount: 1
        }
      },
      committedAt: "2026-08-14T14:00:03.000Z"
    });
    await expect(sql`
      SELECT state, document_count, provider_operation_ref
      FROM focowiki.search_projections
      WHERE public_id = 'search-projection-delete'
    `).resolves.toEqual([{
      state: "retired",
      document_count: "0",
      provider_operation_ref: null
    }]);
  });

  it("keeps the surviving endpoint dirty after acceptance retires its relation", async () => {
    const context = createPostgresDocumentDeletionProjectionContext(
      sql as unknown as DatabaseClient
    );
    await expect(context.read({
      action: {
        publicId: "cleanup-delete-projection",
        operationPublicId: "operation-delete-projection",
        knowledgeBaseId: "knowledge-base-projection",
        targetKind: "source_file",
        targetPublicId: "source-file-deleted",
        attempt: 1,
        maximumAttempts: 3,
        checkpoint: {
          phase: "reconcile_projection",
          cursor: null,
          affectedSourceCount: 1
        }
      },
      maximumSources: 10,
      maximumRelations: 10
    })).resolves.toMatchObject({
      affectedSurvivorSourceFilePublicIds: ["source-file-survivor"],
      obsoleteRelationPublicIds: ["relation-deleted"]
    });
  });
});

function databaseConnectionUrl(connectionUrl: string, database: string): string {
  const value = new URL(connectionUrl);
  value.pathname = `/${database}`;
  return value.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
