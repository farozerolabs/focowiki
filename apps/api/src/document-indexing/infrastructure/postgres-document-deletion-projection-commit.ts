import type { DatabaseClient } from "../../db/client.js";
import type { StagedDocumentPage } from
  "../application/document-generated-page-staging.js";
import type { DocumentDirectoryNavigationMutation } from
  "../application/document-directory-navigation-mutation.js";
import type { DocumentResourceDeletionAction } from
  "../application/document-resource-deletion-worker.js";
import { applyPostgresDocumentDirectoryNavigation } from
  "./postgres-document-directory-navigation.js";
import { allocatePostgresKnowledgeBaseSequence } from
  "./postgres-knowledge-base-sequence.js";
import { bumpPostgresScopedActivationOwners } from
  "./postgres-scoped-activation-owner-repository.js";

export function createPostgresDocumentDeletionProjectionCommit(
  sql: DatabaseClient
) {
  return {
    async commit(input: {
      action: DocumentResourceDeletionAction;
      pageCandidates: readonly StagedDocumentPage[];
      removedPageNormalizedPaths: readonly string[];
      removedDirectoryPrefixes?: readonly string[];
      navigationMutations: readonly DocumentDirectoryNavigationMutation[];
      committedAt: string;
    }): Promise<{ activationRevision: number }> {
      return sql.begin(async (transaction) => {
        const actions = await transaction<Array<{ public_id: string }>>`
          SELECT public_id FROM focowiki.cleanup_actions
          WHERE public_id = ${input.action.publicId}
            AND knowledge_base_id = ${input.action.knowledgeBaseId}
            AND operation_public_id = ${input.action.operationPublicId}
            AND action_kind = 'document_resource_deletion'
            AND state = 'running'
          FOR UPDATE
        `;
        if (!actions[0]) throw deletionProjectionCommitError("action_ownership_lost");
        await bumpPostgresScopedActivationOwners({
          transaction: transaction as unknown as DatabaseClient,
          knowledgeBaseId: input.action.knowledgeBaseId,
          owners: deletionActivationOwners(input),
          now: input.committedAt
        });
        const activationRevision = await allocatePostgresKnowledgeBaseSequence({
          transaction: transaction as unknown as DatabaseClient,
          knowledgeBaseId: input.action.knowledgeBaseId,
          now: input.committedAt
        });
        for (const page of input.pageCandidates) {
          const activated = await transaction<Array<{ public_id: string }>>`
            UPDATE focowiki.generated_page_candidates
            SET state = 'active'
            WHERE knowledge_base_id = ${input.action.knowledgeBaseId}
              AND public_id = ${page.pageCandidatePublicId}
              AND owner_operation_public_id = ${input.action.operationPublicId}
              AND logical_path = ${page.logicalPath}
              AND normalized_path = ${page.normalizedPath}
              AND object_id = ${page.objectId}
              AND checksum_sha256 = ${page.checksumSha256}
              AND state = 'staged'
            RETURNING public_id
          `;
          if (!activated[0]) {
            throw deletionProjectionCommitError("page_candidate_invalid");
          }
          await transaction`
            INSERT INTO focowiki.generated_page_heads (
              knowledge_base_id, logical_path, normalized_path, entry_kind,
              source_file_public_id, source_revision_public_id,
              page_candidate_public_id, object_id, checksum_sha256,
              byte_count, activation_revision, updated_at
            ) VALUES (
              ${input.action.knowledgeBaseId}, ${page.logicalPath},
              ${page.normalizedPath}, ${page.entryKind},
              ${page.sourceFilePublicId}, ${page.sourceRevisionPublicId},
              ${page.pageCandidatePublicId}, ${page.objectId},
              ${page.checksumSha256}, ${page.byteCount},
              ${activationRevision}, ${input.committedAt}
            )
            ON CONFLICT (knowledge_base_id, normalized_path) DO UPDATE
            SET logical_path = EXCLUDED.logical_path,
                entry_kind = EXCLUDED.entry_kind,
                source_file_public_id = EXCLUDED.source_file_public_id,
                source_revision_public_id = EXCLUDED.source_revision_public_id,
                page_candidate_public_id = EXCLUDED.page_candidate_public_id,
                object_id = EXCLUDED.object_id,
                checksum_sha256 = EXCLUDED.checksum_sha256,
                byte_count = EXCLUDED.byte_count,
                activation_revision = EXCLUDED.activation_revision,
                updated_at = EXCLUDED.updated_at
          `;
        }
        if (input.removedPageNormalizedPaths.length > 0) {
          await transaction`
            DELETE FROM focowiki.generated_page_heads
            WHERE knowledge_base_id = ${input.action.knowledgeBaseId}
              AND normalized_path IN ${transaction(input.removedPageNormalizedPaths)}
          `;
        }
        for (const prefix of input.removedDirectoryPrefixes ?? []) {
          if (!prefix.startsWith("pages/") || prefix.includes("..")
            || prefix.includes("\\") || Buffer.byteLength(prefix, "utf8") > 4_096) {
            throw deletionProjectionCommitError("directory_prefix_invalid");
          }
          const normalizedPrefix = prefix.toLocaleLowerCase("en-US");
          await transaction`
            DELETE FROM focowiki.generated_page_heads
            WHERE knowledge_base_id = ${input.action.knowledgeBaseId}
              AND (normalized_path = ${`${normalizedPrefix}/index.md`}
                OR left(normalized_path, char_length(${normalizedPrefix}) + 1)
                  = ${`${normalizedPrefix}/`})
          `;
          await transaction`
            DELETE FROM focowiki.generated_directory_leaf_entries
            WHERE knowledge_base_id = ${input.action.knowledgeBaseId}
              AND (directory_path = ${prefix}
                OR left(directory_path, char_length(${prefix}) + 1)
                  = ${`${prefix}/`})
          `;
          await transaction`
            DELETE FROM focowiki.generated_directory_leaves
            WHERE knowledge_base_id = ${input.action.knowledgeBaseId}
              AND (directory_path = ${prefix}
                OR left(directory_path, char_length(${prefix}) + 1)
                  = ${`${prefix}/`})
          `;
        }
        await transaction`
          WITH stale_candidates AS (
            DELETE FROM focowiki.generated_page_candidates candidate
            WHERE candidate.knowledge_base_id = ${input.action.knowledgeBaseId}
              AND candidate.state = 'active'
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.generated_page_heads head
                WHERE head.knowledge_base_id = candidate.knowledge_base_id
                  AND head.page_candidate_public_id = candidate.public_id
              )
            RETURNING candidate.object_id
          ), stale_objects AS (
            SELECT DISTINCT object_id FROM stale_candidates
          )
          INSERT INTO focowiki.cleanup_actions (
            public_id, knowledge_base_id, operation_public_id,
            action_kind, cleanup_plane, resource_kind, resource_public_id,
            required, priority, sequence_number, idempotency_key,
            request_hash, checkpoint, state, attempt_count,
            maximum_attempts, not_before, created_at, updated_at
          )
          SELECT 'cleanup-deletion-page-' || md5(
                   ${input.action.operationPublicId} || chr(31) || object_id
                 ), ${input.action.knowledgeBaseId},
                 ${input.action.operationPublicId}, 'zero_owner_object',
                 'object_storage', 'zero_owner_object', object_id,
                 true, 30,
                 row_number() OVER (ORDER BY object_id COLLATE "C")::integer,
                 'deletion-page:' || object_id, md5(object_id), '{}'::jsonb,
                 'queued', 0, 8, ${input.committedAt},
                 ${input.committedAt}, ${input.committedAt}
          FROM stale_objects
          ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
        `;
        await applyPostgresDocumentDirectoryNavigation({
          transaction: transaction as unknown as DatabaseClient,
          knowledgeBaseId: input.action.knowledgeBaseId,
          activationRevision,
          mutations: input.navigationMutations,
          activatedAt: input.committedAt
        });
        return { activationRevision };
      });
    },

    async clearKnowledgeBase(input: {
      action: DocumentResourceDeletionAction;
      committedAt: string;
    }): Promise<void> {
      await sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM focowiki.generated_page_heads
          WHERE knowledge_base_id = ${input.action.knowledgeBaseId}
        `;
        await transaction`
          DELETE FROM focowiki.generated_directory_leaf_entries
          WHERE knowledge_base_id = ${input.action.knowledgeBaseId}
        `;
        await transaction`
          DELETE FROM focowiki.generated_directory_leaves
          WHERE knowledge_base_id = ${input.action.knowledgeBaseId}
        `;
        await transaction`
          UPDATE focowiki.search_projections
          SET state = 'retired', document_count = 0,
              provider_operation_ref = NULL,
              revision = revision + 1, updated_at = ${input.committedAt}
          WHERE knowledge_base_id = ${input.action.knowledgeBaseId}
            AND state <> 'retired'
        `;
        await transaction`
          WITH removed_candidates AS (
            DELETE FROM focowiki.generated_page_candidates
            WHERE knowledge_base_id = ${input.action.knowledgeBaseId}
            RETURNING object_id
          ), removed_objects AS (
            SELECT DISTINCT object_id FROM removed_candidates
          )
          INSERT INTO focowiki.cleanup_actions (
            public_id, knowledge_base_id, operation_public_id,
            action_kind, cleanup_plane, resource_kind, resource_public_id,
            required, priority, sequence_number, idempotency_key,
            request_hash, checkpoint, state, attempt_count,
            maximum_attempts, not_before, created_at, updated_at
          )
          SELECT 'cleanup-knowledge-base-page-' || md5(
                   ${input.action.operationPublicId} || chr(31) || object_id
                 ), ${input.action.knowledgeBaseId},
                 ${input.action.operationPublicId}, 'zero_owner_object',
                 'object_storage', 'zero_owner_object', object_id,
                 true, 30,
                 row_number() OVER (ORDER BY object_id COLLATE "C")::integer,
                 'knowledge-base-page:' || object_id, md5(object_id),
                 '{}'::jsonb, 'queued', 0, 8, ${input.committedAt},
                 ${input.committedAt}, ${input.committedAt}
          FROM removed_objects
          ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
        `;
        await allocatePostgresKnowledgeBaseSequence({
          transaction: transaction as unknown as DatabaseClient,
          knowledgeBaseId: input.action.knowledgeBaseId,
          now: input.committedAt
        });
      });
    }
  };
}

function deletionActivationOwners(input: {
  pageCandidates: readonly StagedDocumentPage[];
  removedPageNormalizedPaths: readonly string[];
  removedDirectoryPrefixes?: readonly string[];
}) {
  return [
    ...input.pageCandidates.map((page) => ({
      kind: "page_head" as const,
      key: page.normalizedPath
    })),
    ...input.removedPageNormalizedPaths.map((path) => ({
      kind: "page_head" as const,
      key: path
    })),
    ...(input.removedDirectoryPrefixes ?? []).map((path) => ({
      kind: "directory_leaf" as const,
      key: path
    }))
  ];
}

function deletionProjectionCommitError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Deletion projection commit error: ${code}`), {
    code
  });
}
