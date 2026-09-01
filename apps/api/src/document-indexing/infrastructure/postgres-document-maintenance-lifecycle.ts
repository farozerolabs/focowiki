import type { DatabaseClient } from "../../db/client.js";
import { terminalizePostgresDocumentWork } from
  "./postgres-document-work-terminalization.js";
import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";
import type { SearchProviderIndexDefinition } from
  "../../application/ports/search-provider-runtime.js";
import { createPostgresSemanticGenerationRepository } from
  "../../semantic/infrastructure/postgres-generation-repository.js";
import type { DocumentMaintenancePort } from
  "../application/document-maintenance-phase-runner.js";
import { createDocumentSearchProjectionBootstrap } from
  "../domain/document-search-projection.js";

type Context = Parameters<DocumentMaintenancePort["prepare"]>[0];

export async function ensureDocumentMaintenanceSearchProjection(input: {
  sql: DatabaseClient;
  context: Context;
  providerKind: SearchProviderKind;
  indexUidPrefix: string;
  searchDefinition: SearchProviderIndexDefinition;
}): Promise<void> {
  const projection = createDocumentSearchProjectionBootstrap({
    knowledgeBaseId: input.context.knowledgeBaseId,
    providerKind: input.providerKind,
    indexUidPrefix: input.indexUidPrefix,
    definition: input.searchDefinition
  });
  await input.sql`
    INSERT INTO focowiki.search_projections (
      public_id, knowledge_base_id, provider_kind, provider_index_uid,
      schema_checksum_sha256, settings_checksum_sha256,
      active_contract_revision, document_count, state, revision
    ) VALUES (
      ${projection.publicId}, ${input.context.knowledgeBaseId},
      ${projection.providerKind}, ${projection.providerIndexUid},
      ${projection.schemaChecksumSha256}, ${projection.settingsChecksumSha256},
      0, 0, 'preparing', 0
    )
    ON CONFLICT (knowledge_base_id, provider_kind) DO UPDATE
    SET provider_index_uid = CASE
          WHEN focowiki.search_projections.state = 'active'
            THEN focowiki.search_projections.provider_index_uid
          ELSE excluded.provider_index_uid END,
        schema_checksum_sha256 = excluded.schema_checksum_sha256,
        settings_checksum_sha256 = excluded.settings_checksum_sha256,
        state = CASE WHEN focowiki.search_projections.state = 'active'
          THEN 'active' ELSE 'preparing' END,
        safe_error_code = NULL,
        revision = focowiki.search_projections.revision + 1,
        updated_at = now()
  `;
}

export async function activateDocumentMaintenanceSemanticContract(
  generations: ReturnType<typeof createPostgresSemanticGenerationRepository>,
  context: Context
): Promise<void> {
  const adoption = context.checkpoint.semanticAdoption;
  if (!adoption) return;
  let candidate = await generations.getCandidateByOperation(context);
  if (!candidate) throw maintenanceError("semantic_candidate_missing");
  if (candidate.state === "building") {
    candidate = await generations.transitionCandidate({
      knowledgeBaseId: context.knowledgeBaseId,
      candidatePublicId: candidate.publicId,
      expectedRevision: candidate.revision,
      fromState: "building",
      toState: "validating"
    });
  }
  if (candidate.state === "validating") {
    candidate = await generations.transitionCandidate({
      knowledgeBaseId: context.knowledgeBaseId,
      candidatePublicId: candidate.publicId,
      expectedRevision: candidate.revision,
      fromState: "validating",
      toState: "ready"
    });
  }
  if (candidate.state === "active") return;
  if (candidate.state !== "ready") throw maintenanceError("semantic_candidate_invalid");
  await generations.activateCandidate({
    knowledgeBaseId: context.knowledgeBaseId,
    candidatePublicId: candidate.publicId,
    expectedPredecessorPublicId: adoption.expectedPredecessorPublicId,
    expectedCandidateRevision: candidate.revision,
    activatedAt: new Date().toISOString()
  });
}

export async function activateDocumentMaintenanceSearchProjection(
  sql: DatabaseClient,
  input: Context & { providerKind: SearchProviderKind }
): Promise<void> {
  await sql.begin(async (transaction) => {
    const selected = await transaction<Array<{
      public_id: string;
      state: string;
    }>>`
      SELECT public_id, state FROM focowiki.search_projections
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND provider_kind = ${input.providerKind}
      FOR UPDATE
    `;
    const row = selected[0];
    if (!row) throw maintenanceError("search_projection_missing");
    if (row.state === "active") return;
    if (row.state !== "preparing") {
      throw maintenanceError("search_projection_invalid");
    }
    await transaction`
      UPDATE focowiki.search_projections
      SET state = 'retired', revision = revision + 1, updated_at = now()
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND state = 'active' AND public_id <> ${row.public_id}
    `;
    await transaction`
      UPDATE focowiki.search_projections projection
      SET state = 'active', active_contract_revision = active_contract_revision + 1,
          document_count = (
            SELECT count(*) FROM focowiki.search_document_owners owner
            WHERE owner.knowledge_base_id = projection.knowledge_base_id
              AND owner.search_projection_public_id = projection.public_id
              AND owner.state = 'active'
          ), revision = revision + 1, updated_at = now()
      WHERE public_id = ${row.public_id} AND state = 'preparing'
    `;
  });
}

export async function restoreUnfinishedDocumentMaintenanceSources(
  sql: DatabaseClient,
  context: { knowledgeBaseId: string; operationPublicId: string }
): Promise<void> {
  const terminalAt = new Date().toISOString();
  await sql.begin(async (transaction) => {
    const unfinishedJobs = await transaction<Array<{ public_id: string }>>`
      SELECT public_id
      FROM focowiki.document_processing_jobs
      WHERE knowledge_base_id = ${context.knowledgeBaseId}
        AND operation_public_id = ${context.operationPublicId}
        AND state IN ('waiting', 'processing', 'error')
      FOR UPDATE
    `;
    await transaction`
      UPDATE focowiki.source_file_active_revisions active
      SET current_source_revision_public_id = active.active_source_revision_public_id,
          updated_at = ${terminalAt}
      FROM focowiki.document_processing_jobs job
      WHERE job.knowledge_base_id = ${context.knowledgeBaseId}
        AND job.operation_public_id = ${context.operationPublicId}
        AND job.state <> 'available'
        AND active.knowledge_base_id = job.knowledge_base_id
        AND active.source_file_public_id = job.source_file_public_id
        AND active.current_source_revision_public_id = job.source_revision_public_id
        AND active.active_source_revision_public_id IS NOT NULL
    `;
    await transaction`
      UPDATE focowiki.document_processing_jobs
      SET state = 'superseded',
          started_at = coalesce(started_at, accepted_at),
          terminal_at = ${terminalAt},
          next_attempt_at = NULL,
          safe_error_code = NULL, safe_error_message = NULL, retryable = false,
          active_work_kinds = '{}'::text[], blocking_work_kind = NULL,
          retrying_work_kind = NULL,
          revision = revision + 1, updated_at = ${terminalAt}
      WHERE knowledge_base_id = ${context.knowledgeBaseId}
        AND operation_public_id = ${context.operationPublicId}
        AND state IN ('waiting', 'processing', 'error')
    `;
    await terminalizePostgresDocumentWork({
      sql: transaction,
      documentJobPublicIds: unfinishedJobs.map((job) => job.public_id),
      state: "superseded",
      terminalAt
    });
  });
}

export async function assertDocumentMaintenanceScope(
  sql: DatabaseClient,
  context: Context
): Promise<void> {
  const rows = await sql<Array<{ valid: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM focowiki.knowledge_bases knowledge_base
      JOIN focowiki.operations operation
        ON operation.knowledge_base_id = knowledge_base.public_id
      WHERE knowledge_base.public_id = ${context.knowledgeBaseId}
        AND knowledge_base.deleted_at IS NULL
        AND knowledge_base.revision = ${context.checkpoint.baseResourceRevision}
        AND operation.public_id = ${context.operationPublicId}
        AND operation.operation_kind = 'maintenance'
    ) AS valid
  `;
  if (rows[0]?.valid !== true) throw maintenanceError("stale_plan");
}

export async function countStableDocumentMaintenanceSources(
  sql: DatabaseClient,
  knowledgeBaseId: string
): Promise<number> {
  const rows = await sql<Array<{ count: number | string }>>`
    SELECT count(*) AS count
    FROM focowiki.source_files source
    JOIN focowiki.source_file_active_revisions active
      ON active.knowledge_base_id = source.knowledge_base_id
     AND active.source_file_public_id = source.public_id
    WHERE source.knowledge_base_id = ${knowledgeBaseId}
      AND source.deleted_at IS NULL
      AND active.active_source_revision_public_id IS NOT NULL
      AND active.current_source_revision_public_id
        = active.active_source_revision_public_id
  `;
  const result = Number(rows[0]?.count ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw maintenanceError("count_invalid");
  }
  return result;
}

function maintenanceError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Postgres document maintenance error: ${code}`), {
    code
  });
}
