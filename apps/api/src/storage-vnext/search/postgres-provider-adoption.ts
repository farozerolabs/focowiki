import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import {
  isSearchProviderKind,
  type SearchProviderKind
} from "../../application/ports/search-provider-runtime.js";
import { enqueueStorageVnextRetiredSearchIndexCleanup } from
  "./postgres-retired-index-cleanup.js";

type KnowledgeBaseRow = {
  revision: number | string;
  deleted_at: Date | string | null;
};

type ActiveProjectionRow = {
  search_projection_public_id: string;
  provider_kind: SearchProviderKind;
  provider_index_uid: string;
  document_count: number | string;
};

type CandidateRow = {
  public_id: string;
  knowledge_base_id: string;
  projection_role: string;
  provider_kind: SearchProviderKind;
  state: string;
};

export type StorageVnextSearchProviderAdoptionResult = {
  outcome: "activated" | "stale" | "not_ready";
  retiredProviderKind: SearchProviderKind | null;
  retiredProviderIndexUid: string | null;
};

export function createPostgresStorageVnextSearchProviderAdoption(
  sql: DatabaseClient,
  input: { selectedProviderKind: SearchProviderKind }
) {
  assertProviderKind(input.selectedProviderKind);
  return {
    async activate(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      candidatePublicId: string;
      expectedResourceRevision: number;
      activatedAt: string;
      cleanupNotBefore: string;
    }): Promise<StorageVnextSearchProviderAdoptionResult> {
      validateRequest(request);
      return sql.begin(async (transaction) => {
        const knowledgeBase = await readKnowledgeBase(
          transaction,
          request.knowledgeBaseId
        );
        if (
          !knowledgeBase
          || knowledgeBase.deleted_at !== null
          || toRevision(knowledgeBase.revision) !== request.expectedResourceRevision
        ) return result("stale");

        const active = await readActiveProjection(
          transaction,
          request.knowledgeBaseId
        );
        if (!active) return result("not_ready");
        if (
          active.search_projection_public_id === request.candidatePublicId
          && active.provider_kind === input.selectedProviderKind
        ) return result("activated");

        const candidate = await readCandidate(
          transaction,
          request.candidatePublicId
        );
        if (
          !candidate
          || candidate.public_id !== request.candidatePublicId
          || candidate.knowledge_base_id !== request.knowledgeBaseId
          || candidate.projection_role !== "candidate"
          || candidate.provider_kind !== input.selectedProviderKind
          || candidate.state !== "ready"
        ) return result("not_ready");

        const ownership = await transaction<Array<{ operation_public_id: string }>>`
          SELECT operation.public_id AS operation_public_id
          FROM focowiki.operations operation
          JOIN focowiki.operation_work_items work
            ON work.knowledge_base_id = operation.knowledge_base_id
           AND work.operation_public_id = operation.public_id
          WHERE operation.knowledge_base_id = ${request.knowledgeBaseId}
            AND operation.public_id = ${request.operationPublicId}
            AND operation.operation_kind = 'maintenance'
            AND operation.state IN ('accepted', 'validating', 'processing', 'publishing')
            AND work.work_kind = 'maintenance'
            AND work.state = 'running'
            AND work.search_provider_kind = ${input.selectedProviderKind}
            AND work.checkpoint ->> 'maintenanceKind' = 'provider_adoption'
          FOR UPDATE OF operation, work
        `;
        if (!ownership[0]) return result("stale");

        await enqueueStorageVnextRetiredSearchIndexCleanup(transaction, {
          ...request,
          domain: "provider_adoption",
          providerKind: active.provider_kind,
          providerIndexUid: active.provider_index_uid,
          documentCount: toNonnegativeInteger(active.document_count)
        });
        const snapshots = await transaction<Array<{ knowledge_base_id: string }>>`
          UPDATE focowiki.active_snapshots
          SET search_projection_public_id = ${request.candidatePublicId},
              revision = revision + 1,
              activated_by_operation_public_id = ${request.operationPublicId},
              publicly_visible_at = ${request.activatedAt}
          WHERE knowledge_base_id = ${request.knowledgeBaseId}
            AND search_projection_public_id = ${active.search_projection_public_id}
          RETURNING knowledge_base_id
        `;
        if (!snapshots[0]) return result("stale");

        const retired = await transaction<Array<{ public_id: string }>>`
          DELETE FROM focowiki.search_projections
          WHERE knowledge_base_id = ${request.knowledgeBaseId}
            AND public_id = ${active.search_projection_public_id}
            AND projection_role = 'active'
            AND provider_kind = ${active.provider_kind}
            AND provider_index_uid = ${active.provider_index_uid}
          RETURNING public_id
        `;
        if (!retired[0]) throw adoptionError("active_projection_conflict");
        const activated = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.search_projections
          SET projection_role = 'active', revision = revision + 1,
              updated_at = ${request.activatedAt}
          WHERE knowledge_base_id = ${request.knowledgeBaseId}
            AND public_id = ${request.candidatePublicId}
            AND projection_role = 'candidate'
            AND provider_kind = ${input.selectedProviderKind}
            AND state = 'ready'
          RETURNING public_id
        `;
        if (!activated[0]) throw adoptionError("candidate_projection_conflict");
        return {
          outcome: "activated" as const,
          retiredProviderKind: active.provider_kind,
          retiredProviderIndexUid: active.provider_index_uid
        };
      });
    }
  };
}

async function readKnowledgeBase(
  sql: TransactionSql,
  knowledgeBaseId: string
): Promise<KnowledgeBaseRow | null> {
  const rows = await sql<KnowledgeBaseRow[]>`
    SELECT revision, deleted_at
    FROM focowiki.knowledge_bases
    WHERE public_id = ${knowledgeBaseId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function readActiveProjection(
  sql: TransactionSql,
  knowledgeBaseId: string
): Promise<ActiveProjectionRow | null> {
  const rows = await sql<ActiveProjectionRow[]>`
    SELECT snapshot.search_projection_public_id,
           projection.provider_kind, projection.provider_index_uid,
           projection.document_count
    FROM focowiki.active_snapshots snapshot
    JOIN focowiki.search_projections projection
      ON projection.knowledge_base_id = snapshot.knowledge_base_id
     AND projection.public_id = snapshot.search_projection_public_id
    WHERE snapshot.knowledge_base_id = ${knowledgeBaseId}
      AND projection.projection_role = 'active'
      AND projection.state = 'ready'
    FOR UPDATE OF snapshot, projection
  `;
  return rows[0] ?? null;
}

async function readCandidate(
  sql: TransactionSql,
  candidatePublicId: string
): Promise<CandidateRow | null> {
  const rows = await sql<CandidateRow[]>`
    SELECT public_id, knowledge_base_id, projection_role, provider_kind, state
    FROM focowiki.search_projections
    WHERE public_id = ${candidatePublicId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

function result(
  outcome: StorageVnextSearchProviderAdoptionResult["outcome"]
): StorageVnextSearchProviderAdoptionResult {
  return {
    outcome,
    retiredProviderKind: null,
    retiredProviderIndexUid: null
  };
}

function validateRequest(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  candidatePublicId: string;
  expectedResourceRevision: number;
  activatedAt: string;
  cleanupNotBefore: string;
}): void {
  for (const value of [
    input.knowledgeBaseId,
    input.operationPublicId,
    input.candidatePublicId
  ]) {
    if (!value || Buffer.byteLength(value) > 255) {
      throw adoptionError("invalid_input");
    }
  }
  if (!Number.isSafeInteger(input.expectedResourceRevision)
    || input.expectedResourceRevision < 0) {
    throw adoptionError("invalid_input");
  }
  for (const timestamp of [input.activatedAt, input.cleanupNotBefore]) {
    if (!Number.isFinite(Date.parse(timestamp))) {
      throw adoptionError("invalid_input");
    }
  }
}

function toRevision(value: number | string): number {
  return toNonnegativeInteger(value);
}

function toNonnegativeInteger(value: number | string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw adoptionError("invalid_persistence");
  }
  return revision;
}

function assertProviderKind(value: unknown): asserts value is SearchProviderKind {
  if (!isSearchProviderKind(value)) throw adoptionError("invalid_configuration");
}

function adoptionError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext search provider adoption error: ${code}`),
    { code }
  );
}
