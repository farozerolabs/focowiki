import type { DatabaseClient } from "../../db/client.js";
import type {
  SearchProviderIndexDefinition,
  SearchProviderKind
} from "../../application/ports/search-provider-runtime.js";
import {
  createSemanticAdoptionCandidatePublicId,
  semanticContractFingerprint
} from "../../semantic/domain/maintenance-contract.js";
import { createPostgresSemanticGenerationRepository } from
  "../../semantic/infrastructure/postgres-generation-repository.js";
import type { DocumentMaintenancePort } from
  "../application/document-maintenance-phase-runner.js";
import {
  activateDocumentMaintenanceSearchProjection,
  activateDocumentMaintenanceSemanticContract,
  assertDocumentMaintenanceScope,
  countStableDocumentMaintenanceSources,
  ensureDocumentMaintenanceSearchProjection,
  restoreUnfinishedDocumentMaintenanceSources
} from "./postgres-document-maintenance-lifecycle.js";
import { scheduleDocumentMaintenancePage } from
  "./postgres-document-maintenance-scheduling.js";

const AWAITING_DOCUMENT_CLEANUP_CURSOR = "awaiting-document-cleanup";

export function createPostgresDocumentMaintenance(input: {
  sql: DatabaseClient;
  providerKind: SearchProviderKind;
  indexUidPrefix: string;
  searchDefinition: SearchProviderIndexDefinition;
  pageSize: number | (() => Promise<number>);
  reconciliationPageSize?: number | (() => Promise<number>);
  reconciliation?: {
    runPage(input: {
      knowledgeBaseId: string;
      limit: number;
      cursor: string | null;
    }): Promise<{
      processedCount: number;
      nextCursor: string | null;
    }>;
  };
}): DocumentMaintenancePort & {
  terminate(context: {
    knowledgeBaseId: string;
    operationPublicId: string;
    outcome: "completed" | "failed" | "superseded";
  }): Promise<void>;
} {
  if (typeof input.pageSize === "number") assertPageSize(input.pageSize);
  if (typeof input.reconciliationPageSize === "number") {
    assertPageSize(input.reconciliationPageSize);
  }
  const generations = createPostgresSemanticGenerationRepository(input.sql);
  return {
    async prepare(context) {
      await assertDocumentMaintenanceScope(input.sql, context);
      const documentCount = await countStableDocumentMaintenanceSources(
        input.sql,
        context.knowledgeBaseId
      );
      await ensureDocumentMaintenanceSearchProjection({
        sql: input.sql,
        context,
        providerKind: input.providerKind,
        indexUidPrefix: input.indexUidPrefix,
        searchDefinition: input.searchDefinition
      });
      const semantic = context.checkpoint.semanticAdoption;
      if (semantic) {
        const existing = await generations.getCandidateByOperation(context);
        if (!existing) {
          await generations.createCandidate({
            operationPublicId: context.operationPublicId,
            candidatePublicId: createSemanticAdoptionCandidatePublicId(context),
            expectedPredecessorPublicId: semantic.expectedPredecessorPublicId,
            target: semantic.target,
            contractFingerprintSha256: semanticContractFingerprint(semantic.target)
          });
        }
      }
      return { documentCount };
    },

    async schedulePage(context) {
      return scheduleDocumentMaintenancePage({
        sql: input.sql,
        providerKind: input.providerKind,
        pageSize: await resolvePageSize(input.pageSize),
        context
      });
    },

    async reconcile(context) {
      if (!input.reconciliation) throw maintenanceError("reconciliation_unavailable");
      const cleanup = await readMaintenanceCleanupState(
        input.sql,
        context.operationPublicId,
        input.providerKind
      );
      if (cleanup.failedCount > 0) {
        throw maintenanceError("document_maintenance_cleanup_failed");
      }
      if (cleanup.liveCount > 0) {
        return {
          processedCount: 0,
          nextCursor: AWAITING_DOCUMENT_CLEANUP_CURSOR
        };
      }
      return input.reconciliation.runPage({
        knowledgeBaseId: context.knowledgeBaseId,
        limit: await resolvePageSize(input.reconciliationPageSize ?? input.pageSize),
        cursor: context.cursor === AWAITING_DOCUMENT_CLEANUP_CURSOR
          ? null : context.cursor
      });
    },

    async readProgress(context) {
      const rows = await input.sql<Array<{
        document_count: number | string;
        available_count: number | string;
        error_count: number | string;
        pending_count: number | string;
      }>>`
        SELECT count(*) AS document_count,
               count(*) FILTER (WHERE state = 'available') AS available_count,
               count(*) FILTER (WHERE state IN (
                 'error', 'cancelled', 'superseded', 'deleting'
               )) AS error_count,
               count(*) FILTER (WHERE state IN ('waiting', 'processing'))
                 AS pending_count
        FROM focowiki.document_processing_jobs
        WHERE knowledge_base_id = ${context.knowledgeBaseId}
          AND operation_public_id = ${context.operationPublicId}
      `;
      const row = rows[0]!;
      return {
        documentCount: count(row.document_count),
        availableCount: count(row.available_count),
        errorCount: count(row.error_count),
        pendingCount: count(row.pending_count)
      };
    },

    async validate(context) {
      const rows = await input.sql<Array<{ valid: boolean }>>`
        SELECT NOT EXISTS (
          SELECT 1
          FROM focowiki.document_processing_jobs job
          JOIN focowiki.source_file_active_revisions active
            ON active.knowledge_base_id = job.knowledge_base_id
           AND active.source_file_public_id = job.source_file_public_id
          WHERE job.knowledge_base_id = ${context.knowledgeBaseId}
            AND job.operation_public_id = ${context.operationPublicId}
            AND (
              job.state <> 'available'
              OR active.current_source_revision_public_id
                <> job.source_revision_public_id
              OR active.active_source_revision_public_id
                <> job.source_revision_public_id
              OR NOT EXISTS (
                SELECT 1 FROM focowiki.generated_page_heads page
                WHERE page.knowledge_base_id = job.knowledge_base_id
                  AND page.source_file_public_id = job.source_file_public_id
                  AND page.source_revision_public_id = job.source_revision_public_id
                  AND page.entry_kind = 'source'
              )
              OR NOT EXISTS (
                SELECT 1 FROM focowiki.search_document_owners owner
                WHERE owner.knowledge_base_id = job.knowledge_base_id
                  AND owner.source_file_public_id = job.source_file_public_id
                  AND owner.source_revision_public_id = job.source_revision_public_id
                  AND owner.provider_kind = ${input.providerKind}
                  AND owner.state = 'active'
              )
            )
        ) AS valid
      `;
      if (rows[0]?.valid !== true) throw maintenanceError("validation_failed");
    },

    async activate(context) {
      await activateDocumentMaintenanceSemanticContract(generations, context);
      await activateDocumentMaintenanceSearchProjection(input.sql, {
        ...context,
        providerKind: input.providerKind
      });
    },

    async cleanup() {},

    async terminate(context) {
      if (context.outcome === "completed") return;
      await restoreUnfinishedDocumentMaintenanceSources(input.sql, context);
      await generations.discardCandidateByOperation(context);
      await input.sql`
        UPDATE focowiki.search_projections
        SET state = 'failed', safe_error_code = 'document_maintenance_failed',
            revision = revision + 1, updated_at = now()
        WHERE knowledge_base_id = ${context.knowledgeBaseId}
          AND provider_kind = ${input.providerKind}
          AND state = 'preparing'
      `;
    }
  };
}

async function readMaintenanceCleanupState(
  sql: DatabaseClient,
  operationPublicId: string,
  providerKind: SearchProviderKind
): Promise<{ liveCount: number; failedCount: number }> {
  const rows = await sql<Array<{
    live_count: number | string;
    failed_count: number | string;
  }>>`
    SELECT count(*) FILTER (
             WHERE state IN ('queued', 'running', 'retry')
           ) AS live_count,
           count(*) FILTER (WHERE state = 'failed') AS failed_count
    FROM focowiki.cleanup_actions
    WHERE operation_public_id = ${operationPublicId}
      AND action_kind IN ('document_obsolete_artifact', 'zero_owner_object')
      AND (
        cleanup_plane = 'object_storage'
        OR search_provider_kind IS NULL
        OR search_provider_kind = ${providerKind}
      )
  `;
  return {
    liveCount: count(rows[0]?.live_count ?? 0),
    failedCount: count(rows[0]?.failed_count ?? 0)
  };
}

function count(value: number | string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw maintenanceError("count_invalid");
  }
  return result;
}

function assertPageSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw maintenanceError("page_size_invalid");
  }
}

async function resolvePageSize(
  value: number | (() => Promise<number>)
): Promise<number> {
  const pageSize = typeof value === "number" ? value : await value();
  assertPageSize(pageSize);
  return pageSize;
}

function maintenanceError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Postgres document maintenance error: ${code}`), {
    code
  });
}
