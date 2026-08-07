import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";

const ACTION_KIND = "candidate_projection";
const RESOURCE_KIND = "superseded_candidate_object";

export type StorageVnextCandidateObjectCleanupAction = {
  actionPublicId: string;
  objectId: string;
};

export type StorageVnextCandidateObjectCleanupActionRepository = {
  listPage(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    limit: number;
  }): Promise<readonly StorageVnextCandidateObjectCleanupAction[]>;
  complete(input: {
    actionPublicId: string;
    knowledgeBaseId: string;
    operationPublicId: string;
  }): Promise<boolean>;
};

export async function enqueueStorageVnextCandidateObjectCleanupActions(
  sql: TransactionSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    candidateRootPublicId: string;
    objectIds: readonly string[];
  }
): Promise<number> {
  if (input.objectIds.length === 0) return 0;
  const rows = await sql<Array<{ object_id: string }>>`
    SELECT registration.object_id
    FROM focowiki.object_registrations registration
    WHERE registration.object_id = ANY(${[...new Set(input.objectIds)]})
      AND registration.state = 'verified'
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.object_owners owner
        WHERE owner.object_id = registration.object_id
      )
    ORDER BY registration.object_id
  `;
  if (rows.length === 0) return 0;
  const actions = rows.map(({ object_id: objectId }) => ({
    public_id: identity("action", input.operationPublicId, objectId),
    operation_public_id: input.operationPublicId,
    knowledge_base_id: input.knowledgeBaseId,
    action_kind: ACTION_KIND,
    cleanup_plane: "object_storage",
    resource_kind: RESOURCE_KIND,
    resource_public_id: objectId,
    required: true,
    sequence_number: 30,
    idempotency_key: identity("idempotency", input.operationPublicId, objectId),
    request_hash: digest([
      input.knowledgeBaseId,
      input.operationPublicId,
      input.candidateRootPublicId,
      objectId
    ]),
    checkpoint: {},
    state: "queued",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at: null,
    safe_error_code: null,
    not_before: new Date()
  }));
  const inserted = await sql<Array<{ public_id: string }>>`
    INSERT INTO focowiki.cleanup_actions ${sql(
      actions,
      "public_id", "operation_public_id", "knowledge_base_id", "action_kind",
      "cleanup_plane", "resource_kind", "resource_public_id", "required",
      "sequence_number", "idempotency_key", "request_hash", "checkpoint",
      "state", "attempt_count", "lease_owner", "lease_expires_at",
      "safe_error_code", "not_before"
    )}
    ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
    RETURNING public_id
  `;
  return inserted.length;
}

export function createPostgresStorageVnextCandidateObjectCleanupActionRepository(
  sql: DatabaseClient
): StorageVnextCandidateObjectCleanupActionRepository {
  return {
    async listPage(input) {
      validateScope(input);
      const limit = validateLimit(input.limit);
      const rows = await sql<Array<{
        public_id: string;
        resource_public_id: string;
      }>>`
        SELECT public_id, resource_public_id
        FROM focowiki.cleanup_actions
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND operation_public_id = ${input.operationPublicId}
          AND action_kind = ${ACTION_KIND}
          AND cleanup_plane = 'object_storage'
          AND resource_kind = ${RESOURCE_KIND}
          AND state IN ('queued', 'retry')
        ORDER BY resource_public_id, public_id
        LIMIT ${limit}
      `;
      return rows.map((row) => ({
        actionPublicId: row.public_id,
        objectId: row.resource_public_id
      }));
    },

    async complete(input) {
      validateScope(input);
      if (!input.actionPublicId) throw actionError("invalid_input");
      const rows = await sql<Array<{ public_id: string }>>`
        DELETE FROM focowiki.cleanup_actions
        WHERE public_id = ${input.actionPublicId}
          AND knowledge_base_id = ${input.knowledgeBaseId}
          AND operation_public_id = ${input.operationPublicId}
          AND action_kind = ${ACTION_KIND}
          AND cleanup_plane = 'object_storage'
          AND resource_kind = ${RESOURCE_KIND}
          AND state IN ('queued', 'retry')
        RETURNING public_id
      `;
      return rows.length === 1;
    }
  };
}

function identity(kind: string, operationPublicId: string, objectId: string): string {
  return `candidate-object-cleanup-${kind}-${digest([operationPublicId, objectId])}`;
}

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256").update("storage-vnext-candidate-object-cleanup-v1");
  for (const part of parts) hash.update("\0").update(part);
  return hash.digest("hex");
}

function validateScope(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
}): void {
  if (!input.knowledgeBaseId || !input.operationPublicId) {
    throw actionError("invalid_input");
  }
}

function validateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw actionError("invalid_input");
  }
  return value;
}

function actionError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext candidate object cleanup action error: ${code}`),
    { code }
  );
}
