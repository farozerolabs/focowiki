import type { DatabaseClient } from "../../db/client.js";
import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";
import type {
  DocumentObsoleteCleanupAction,
  DocumentObsoleteCleanupPlane
} from "../application/document-obsolete-artifact-cleanup.js";

type CleanupRow = {
  public_id: string;
  knowledge_base_id: string;
  source_revision_public_id: string;
  search_provider_kind: SearchProviderKind | null;
  cleanup_plane: string;
  resource_kind: DocumentObsoleteCleanupAction["resourceKind"];
  resource_public_id: string;
  attempt_count: number | string;
  maximum_attempts: number | string;
};

export function createPostgresDocumentObsoleteCleanup(sql: DatabaseClient) {
  return {
    actions: {
      async claim(input: {
        owner: string;
        searchProviderKind: SearchProviderKind | null;
        limit: number;
        leaseExpiresAt: string;
      }): Promise<readonly DocumentObsoleteCleanupAction[]> {
        validateClaim(input);
        const rows = await sql<CleanupRow[]>`
          WITH exhausted AS (
            UPDATE focowiki.cleanup_actions
            SET state = 'failed', lease_owner = NULL,
                lease_expires_at = NULL,
                safe_error_code = 'cleanup_attempts_exhausted',
                completed_at = now(), updated_at = now()
            WHERE action_kind = 'document_obsolete_artifact'
              AND state IN ('queued', 'retry', 'running')
              AND attempt_count >= maximum_attempts
            RETURNING public_id
          ), candidates AS (
            SELECT public_id
            FROM focowiki.cleanup_actions
            WHERE action_kind = 'document_obsolete_artifact'
              AND attempt_count < maximum_attempts
              AND (
                (state IN ('queued', 'retry') AND not_before <= now())
                OR (state = 'running' AND lease_expires_at <= now())
              )
              AND (
                cleanup_plane = 'object_storage'
                OR search_provider_kind IS NOT DISTINCT FROM ${input.searchProviderKind}
              )
            ORDER BY priority, not_before, sequence_number, public_id
            FOR UPDATE SKIP LOCKED
            LIMIT ${input.limit}
          )
          UPDATE focowiki.cleanup_actions action
          SET state = 'running', attempt_count = action.attempt_count + 1,
              lease_owner = ${input.owner},
              lease_expires_at = ${input.leaseExpiresAt},
              safe_error_code = NULL, updated_at = now()
          FROM candidates
          WHERE action.public_id = candidates.public_id
          RETURNING action.public_id, action.knowledge_base_id,
                    action.source_revision_public_id,
                    action.cleanup_plane, action.search_provider_kind,
                    action.resource_kind,
                    action.resource_public_id, action.attempt_count,
                    action.maximum_attempts
        `;
        return rows.map(mapAction);
      }
    },

    ownership: {
      async isCurrentOwner(action: DocumentObsoleteCleanupAction): Promise<boolean> {
        const rows = await sql<Array<{ owned: boolean }>>`
          SELECT CASE ${action.resourceKind}
            WHEN 'search_document' THEN EXISTS (
              SELECT 1 FROM focowiki.search_document_owners owner
              WHERE owner.knowledge_base_id = ${action.knowledgeBaseId}
                AND owner.provider_document_id = ${action.resourcePublicId}
                AND owner.state = 'active'
            )
            WHEN 'vector_document' THEN EXISTS (
              SELECT 1 FROM focowiki.semantic_vector_documents vector
              WHERE vector.knowledge_base_id = ${action.knowledgeBaseId}
                AND vector.public_id = ${action.resourcePublicId}
                AND vector.state = 'active'
            )
            WHEN 'generated_object' THEN EXISTS (
              SELECT 1 FROM focowiki.generated_page_heads head
              WHERE head.knowledge_base_id = ${action.knowledgeBaseId}
                AND head.object_id = ${action.resourcePublicId}
            )
            ELSE false
          END AS owned
        `;
        return rows[0]?.owned === true;
      }
    },

    complete(input: { publicId: string; owner: string; completedAt: string }) {
      return transition(sql, input, "completed", null, input.completedAt);
    },

    async retry(input: {
      publicId: string;
      owner: string;
      notBefore: string;
      safeErrorCode: string;
    }): Promise<boolean> {
      validateTransition(input);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.cleanup_actions
        SET state = 'retry', lease_owner = NULL, lease_expires_at = NULL,
            not_before = ${input.notBefore},
            safe_error_code = ${input.safeErrorCode}, updated_at = now()
        WHERE public_id = ${input.publicId}
          AND action_kind = 'document_obsolete_artifact'
          AND state = 'running' AND lease_owner = ${input.owner}
        RETURNING public_id
      `;
      return rows.length === 1;
    },

    fail(input: {
      publicId: string;
      owner: string;
      safeErrorCode: string;
      failedAt: string;
    }) {
      return transition(sql, input, "failed", input.safeErrorCode, input.failedAt);
    },

    audit: {
      async record(input: {
        action: DocumentObsoleteCleanupAction;
        result: "success" | "failure";
        reasonCode: string | null;
        recordedAt: string;
      }): Promise<void> {
        const publicId = `audit-document-cleanup-${input.action.publicId}`;
        await sql`
          INSERT INTO focowiki.security_audit_events (
            public_id, knowledge_base_id, actor_public_id, event_type,
            target_kind, target_public_id, result, reason_code,
            source_ip, user_agent, metadata, created_at, expires_at
          ) VALUES (
            ${publicId}, ${input.action.knowledgeBaseId}, NULL,
            'document.obsolete_artifact_cleanup',
            ${input.action.resourceKind}, ${input.action.resourcePublicId},
            ${input.result}, ${input.reasonCode}, NULL, NULL,
            ${sql.json({
              cleanupActionPublicId: input.action.publicId,
              sourceRevisionPublicId: input.action.sourceRevisionPublicId,
              plane: input.action.plane
            })}, ${input.recordedAt},
            ${new Date(Date.parse(input.recordedAt) + 31 * 86_400_000).toISOString()}
          )
          ON CONFLICT (created_at, public_id) DO NOTHING
        `;
      }
    }
  };
}

async function transition(
  sql: DatabaseClient,
  input: { publicId: string; owner: string },
  state: "completed" | "failed",
  safeErrorCode: string | null,
  completedAt: string
): Promise<boolean> {
  validateTransition({ ...input, safeErrorCode, completedAt });
  const rows = await sql<Array<{ public_id: string }>>`
    UPDATE focowiki.cleanup_actions
    SET state = ${state}, lease_owner = NULL, lease_expires_at = NULL,
        safe_error_code = ${safeErrorCode}, completed_at = ${completedAt},
        updated_at = ${completedAt}
    WHERE public_id = ${input.publicId}
      AND action_kind = 'document_obsolete_artifact'
      AND state = 'running' AND lease_owner = ${input.owner}
    RETURNING public_id
  `;
  return rows.length === 1;
}

function mapAction(row: CleanupRow): DocumentObsoleteCleanupAction {
  if (!["object_storage", "search", "vector"].includes(row.cleanup_plane)) {
    throw cleanupRepositoryError("stored_action_invalid");
  }
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    searchProviderKind: row.search_provider_kind,
    plane: row.cleanup_plane as DocumentObsoleteCleanupPlane,
    resourceKind: row.resource_kind,
    resourcePublicId: row.resource_public_id,
    attempt: Number(row.attempt_count),
    maximumAttempts: Number(row.maximum_attempts)
  };
}

function validateClaim(input: {
  owner: string;
  searchProviderKind: SearchProviderKind | null;
  limit: number;
  leaseExpiresAt: string;
}): void {
  if (!input.owner || Buffer.byteLength(input.owner, "utf8") > 255
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000
    || input.searchProviderKind !== null
      && input.searchProviderKind !== "opensearch"
      && input.searchProviderKind !== "meilisearch"
    || !Number.isFinite(Date.parse(input.leaseExpiresAt))) {
    throw cleanupRepositoryError("invalid_input");
  }
}

function validateTransition(input: {
  publicId: string;
  owner: string;
  safeErrorCode?: string | null;
  notBefore?: string;
  completedAt?: string;
}): void {
  if (!input.publicId || !input.owner
    || input.safeErrorCode !== undefined && input.safeErrorCode !== null
      && (!input.safeErrorCode || input.safeErrorCode.length > 128)
    || input.notBefore !== undefined && !Number.isFinite(Date.parse(input.notBefore))
    || input.completedAt !== undefined && !Number.isFinite(Date.parse(input.completedAt))) {
    throw cleanupRepositoryError("invalid_input");
  }
}

function cleanupRepositoryError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document cleanup repository error: ${code}`), { code });
}
