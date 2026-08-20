import type { DatabaseClient } from "../../db/client.js";
import type { TransactionSql } from "postgres";
import {
  queuePostgresReleasedDocumentRevisionObjects,
  readPostgresDocumentRevisionObjectIds
} from "./postgres-document-revision-object-release.js";

type RevisionPurgeAction = {
  publicId: string;
  knowledgeBaseId: string;
  operationPublicId: string | null;
  sourceRevisionPublicId: string;
};

type PurgeOutcome = "completed" | "retried" | "failed";

export async function enqueuePostgresReplacedDocumentRevisionPurge(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  operationPublicId: string;
  documentJobPublicId: string;
  sourceRevisionPublicId: string;
  createdAt: string;
}): Promise<boolean> {
  const rows = await input.transaction<Array<{ public_id: string }>>`
    INSERT INTO focowiki.cleanup_actions (
      public_id, knowledge_base_id, operation_public_id,
      document_job_public_id, source_revision_public_id,
      action_kind, cleanup_plane, search_provider_kind,
      resource_kind, resource_public_id, required, priority,
      sequence_number, idempotency_key, request_hash, checkpoint,
      state, attempt_count, maximum_attempts, not_before,
      created_at, updated_at
    )
    SELECT 'cleanup-replaced-revision-' || md5(
             ${input.documentJobPublicId} || chr(31)
             || ${input.sourceRevisionPublicId}
           ),
           ${input.knowledgeBaseId}, ${input.operationPublicId},
           ${input.documentJobPublicId}, ${input.sourceRevisionPublicId},
           'document_revision_purge', 'postgres', NULL,
           'source_revision', ${input.sourceRevisionPublicId}, true, 20, 0,
           'replaced-revision:' || ${input.documentJobPublicId}
             || ':' || ${input.sourceRevisionPublicId},
           md5(${input.sourceRevisionPublicId}),
           jsonb_build_object(
             'schemaVersion', 'replaced-document-revision-purge-v1'
           ),
           'queued', 0, 10, ${input.createdAt}, ${input.createdAt},
           ${input.createdAt}
    WHERE NOT EXISTS (
      SELECT 1
      FROM focowiki.source_file_active_revisions active
      WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
        AND (
          active.current_source_revision_public_id
            = ${input.sourceRevisionPublicId}
          OR active.active_source_revision_public_id
            = ${input.sourceRevisionPublicId}
        )
    )
    ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
    RETURNING public_id
  `;
  return rows.length === 1;
}

export function createPostgresDocumentRevisionPurge(sql: DatabaseClient) {
  return {
    async runBatch(input: {
      owner: string;
      limit: number;
      now: string;
      leaseExpiresAt: string;
      signal?: AbortSignal;
    }): Promise<{
      claimed: number;
      completed: number;
      retried: number;
      failed: number;
    }> {
      validateInput(input);
      const actions = await claim(sql, input);
      const result = {
        claimed: actions.length,
        completed: 0,
        retried: 0,
        failed: 0
      };
      for (const action of actions) {
        throwIfAborted(input.signal);
        const outcome = await sql.begin((transaction) => processAction(
          transaction,
          action,
          input.owner,
          input.now
        ));
        result[outcome] += 1;
      }
      return result;
    }
  };
}

async function claim(
  sql: DatabaseClient,
  input: { owner: string; limit: number; leaseExpiresAt: string }
): Promise<RevisionPurgeAction[]> {
  const rows = await sql<Array<{
    public_id: string;
    knowledge_base_id: string;
    operation_public_id: string | null;
    resource_public_id: string;
  }>>`
    WITH candidates AS (
      SELECT public_id
      FROM focowiki.cleanup_actions
      WHERE action_kind = 'document_revision_purge'
        AND state IN ('queued', 'retry')
        AND not_before <= now()
      ORDER BY priority, not_before, public_id COLLATE "C"
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
              action.operation_public_id, action.resource_public_id
  `;
  return rows.map((row) => ({
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    operationPublicId: row.operation_public_id,
    sourceRevisionPublicId: row.resource_public_id
  }));
}

async function processAction(
  sql: TransactionSql,
  action: RevisionPurgeAction,
  owner: string,
  now: string
): Promise<PurgeOutcome> {
  const locked = await sql<Array<{ public_id: string }>>`
    SELECT public_id
    FROM focowiki.cleanup_actions
    WHERE public_id = ${action.publicId}
      AND action_kind = 'document_revision_purge'
      AND state = 'running' AND lease_owner = ${owner}
    FOR UPDATE
  `;
  if (!locked[0]) throw purgeError("lease_lost");

  const currentOwners = await sql<Array<{ owned: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM focowiki.source_file_active_revisions active
      WHERE active.knowledge_base_id = ${action.knowledgeBaseId}
        AND (
          active.current_source_revision_public_id = ${action.sourceRevisionPublicId}
          OR active.active_source_revision_public_id = ${action.sourceRevisionPublicId}
        )
    ) AS owned
  `;
  if (currentOwners[0]?.owned) {
    await fail(sql, action.publicId, owner, now, "document_revision_still_current");
    return "failed";
  }

  await sql`
    UPDATE focowiki.search_document_owners
    SET state = 'obsolete', updated_at = ${now}
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND source_revision_public_id = ${action.sourceRevisionPublicId}
      AND state <> 'obsolete'
  `;
  await sql`
    UPDATE focowiki.semantic_vector_documents
    SET state = 'deleted', deleted_at = ${now}
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND source_revision_public_id = ${action.sourceRevisionPublicId}
      AND state <> 'deleted'
  `;
  await enqueueExternalArtifactCleanup(sql, action, now);
  const childState = await sql<Array<{
    pending_count: number | string;
    failed_count: number | string;
  }>>`
    SELECT count(*) FILTER (
             WHERE state IN ('queued', 'running', 'retry')
           ) AS pending_count,
           count(*) FILTER (WHERE state = 'failed') AS failed_count
    FROM focowiki.cleanup_actions
    WHERE action_kind = 'document_obsolete_artifact'
      AND checkpoint->>'parentRevisionPurgeActionPublicId' = ${action.publicId}
  `;
  if (Number(childState[0]?.failed_count ?? 0) > 0) {
    await fail(sql, action.publicId, owner, now,
      "document_revision_artifact_cleanup_failed");
    return "failed";
  }
  if (Number(childState[0]?.pending_count ?? 0) > 0) {
    await sql`
      UPDATE focowiki.cleanup_actions
      SET state = 'retry', attempt_count = GREATEST(attempt_count - 1, 0),
          lease_owner = NULL, lease_expires_at = NULL,
          safe_error_code = 'DOCUMENT_REVISION_PURGE_WAITING',
          not_before = ${now}, updated_at = ${now}
      WHERE public_id = ${action.publicId}
        AND state = 'running' AND lease_owner = ${owner}
    `;
    return "retried";
  }

  const releasedObjectIds = await readPostgresDocumentRevisionObjectIds({
    transaction: sql as unknown as DatabaseClient,
    knowledgeBaseId: action.knowledgeBaseId,
    sourceRevisionPublicId: action.sourceRevisionPublicId
  });

  const completed = await sql<Array<{ public_id: string }>>`
    UPDATE focowiki.cleanup_actions
    SET state = 'completed', document_job_public_id = NULL,
        source_revision_public_id = NULL,
        lease_owner = NULL, lease_expires_at = NULL,
        safe_error_code = NULL, completed_at = ${now}, updated_at = ${now}
    WHERE public_id = ${action.publicId}
      AND state = 'running' AND lease_owner = ${owner}
    RETURNING public_id
  `;
  if (!completed[0]) throw purgeError("lease_lost");
  await sql`
    DELETE FROM focowiki.semantic_embedding_artifact_refs reference
    WHERE reference.knowledge_base_id = ${action.knowledgeBaseId}
      AND reference.artifact_public_id IN (
        SELECT artifact.public_id
        FROM focowiki.embedding_artifacts artifact
        WHERE artifact.knowledge_base_id = ${action.knowledgeBaseId}
          AND artifact.source_revision_public_id
            = ${action.sourceRevisionPublicId}
      )
  `;
  await sql`
    DELETE FROM focowiki.semantic_vector_documents
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND source_revision_public_id = ${action.sourceRevisionPublicId}
  `;
  await sql`
    DELETE FROM focowiki.embedding_artifacts
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND source_revision_public_id = ${action.sourceRevisionPublicId}
  `;
  await sql`
    DELETE FROM focowiki.search_family_receipts
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND source_revision_public_id = ${action.sourceRevisionPublicId}
  `;
  await sql`
    DELETE FROM focowiki.relation_candidate_pairs
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND (
        first_source_revision_public_id = ${action.sourceRevisionPublicId}
        OR second_source_revision_public_id = ${action.sourceRevisionPublicId}
      )
  `;
  await sql`
    DELETE FROM focowiki.source_revisions
    WHERE knowledge_base_id = ${action.knowledgeBaseId}
      AND public_id = ${action.sourceRevisionPublicId}
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.source_file_active_revisions active
        WHERE active.knowledge_base_id = ${action.knowledgeBaseId}
          AND (
            active.current_source_revision_public_id = ${action.sourceRevisionPublicId}
            OR active.active_source_revision_public_id = ${action.sourceRevisionPublicId}
          )
      )
  `;
  await queuePostgresReleasedDocumentRevisionObjects({
    transaction: sql as unknown as DatabaseClient,
    knowledgeBaseId: action.knowledgeBaseId,
    operationPublicId: action.operationPublicId,
    purgeActionPublicId: action.publicId,
    objectIds: releasedObjectIds,
    queuedAt: now
  });
  return "completed";
}

async function enqueueExternalArtifactCleanup(
  sql: TransactionSql,
  action: RevisionPurgeAction,
  now: string
): Promise<void> {
  await sql`
    WITH external_artifacts AS (
      SELECT 'search_document'::text AS artifact_kind,
             owner.provider_document_id AS artifact_public_id,
             owner.document_checksum_sha256 AS artifact_checksum_sha256,
             'search'::text AS cleanup_plane,
             owner.provider_kind AS search_provider_kind
      FROM focowiki.search_document_owners owner
      WHERE owner.knowledge_base_id = ${action.knowledgeBaseId}
        AND owner.source_revision_public_id = ${action.sourceRevisionPublicId}
        AND owner.state = 'obsolete'
      UNION ALL
      SELECT 'vector_document'::text, vector.public_id,
             md5(vector.public_id), 'vector'::text,
             contract.search_provider_kind
      FROM focowiki.semantic_vector_documents vector
      JOIN focowiki.semantic_projection_contracts contract
        ON contract.knowledge_base_id = vector.knowledge_base_id
       AND contract.public_id = vector.projection_contract_public_id
      WHERE vector.knowledge_base_id = ${action.knowledgeBaseId}
        AND vector.source_revision_public_id = ${action.sourceRevisionPublicId}
        AND vector.state = 'deleted'
      UNION ALL
      SELECT 'generated_object'::text, candidate.object_id,
             candidate.checksum_sha256, 'object_storage'::text, NULL::text
      FROM focowiki.generated_page_candidates candidate
      WHERE candidate.knowledge_base_id = ${action.knowledgeBaseId}
        AND candidate.source_revision_public_id = ${action.sourceRevisionPublicId}
        AND NOT EXISTS (
          SELECT 1 FROM focowiki.generated_page_heads head
          WHERE head.knowledge_base_id = candidate.knowledge_base_id
            AND head.page_candidate_public_id = candidate.public_id
        )
    )
    INSERT INTO focowiki.cleanup_actions (
      public_id, knowledge_base_id, operation_public_id,
      document_job_public_id, source_revision_public_id,
      action_kind, cleanup_plane, search_provider_kind,
      resource_kind, resource_public_id, required, priority,
      sequence_number, idempotency_key, request_hash, checkpoint,
      state, attempt_count, maximum_attempts, not_before,
      created_at, updated_at
    )
      SELECT 'document-revision-cleanup-' || md5(
             ${action.publicId} || chr(31) || artifact_kind
             || chr(31) || coalesce(search_provider_kind, '')
             || chr(31) || artifact_public_id
           ),
           ${action.knowledgeBaseId}, ${action.operationPublicId}, NULL,
           ${action.sourceRevisionPublicId},
           'document_obsolete_artifact', cleanup_plane, search_provider_kind,
           artifact_kind, artifact_public_id, true, 200,
           row_number() OVER (
             ORDER BY artifact_kind, artifact_public_id COLLATE "C"
           )::integer,
           ${action.publicId} || ':' || artifact_kind || ':'
             || coalesce(search_provider_kind, '') || ':' || artifact_public_id,
             artifact_checksum_sha256,
           jsonb_build_object(
             'artifactChecksumSha256', artifact_checksum_sha256,
             'schemaVersion', 'document-revision-cleanup-v1',
             'parentRevisionPurgeActionPublicId', ${action.publicId}::text
           ),
           'queued', 0, 8, ${now}, ${now}, ${now}
    FROM external_artifacts
    ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
  `;
}

async function fail(
  sql: TransactionSql,
  publicId: string,
  owner: string,
  now: string,
  code: string
): Promise<void> {
  const rows = await sql<Array<{ public_id: string }>>`
    UPDATE focowiki.cleanup_actions
    SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
        safe_error_code = ${code}, completed_at = ${now}, updated_at = ${now}
    WHERE public_id = ${publicId}
      AND state = 'running' AND lease_owner = ${owner}
    RETURNING public_id
  `;
  if (!rows[0]) throw purgeError("lease_lost");
}

function validateInput(input: {
  owner: string;
  limit: number;
  now: string;
  leaseExpiresAt: string;
}): void {
  if (!input.owner || Buffer.byteLength(input.owner, "utf8") > 255
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000
    || !Number.isFinite(Date.parse(input.now))
    || !Number.isFinite(Date.parse(input.leaseExpiresAt))
    || Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) {
    throw purgeError("invalid_input");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? purgeError("cancelled");
}

function purgeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document revision purge error: ${code}`), { code });
}
