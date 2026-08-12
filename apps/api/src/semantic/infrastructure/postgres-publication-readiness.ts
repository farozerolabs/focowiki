import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { StorageVnextReleaseLifecycleHooks } from
  "../../storage-vnext/release/postgres-repository.js";
import { STORAGE_VNEXT_RECOVERABLE_PUBLICATION_FAILURE_CODE } from
  "../../storage-vnext/publication/source-eligibility.js";
import { enqueuePostgresStorageVnextWebhookEvents } from
  "../../storage-vnext/webhook/postgres-repository.js";

type SourceReadinessRow = {
  public_id: string;
  source_revision_public_id: string;
};

export function createPostgresSemanticPublicationReadinessHooks():
StorageVnextReleaseLifecycleHooks {
  return {
    async beforeActivate(input) {
      await completePublicationBarriers(input.transaction, {
        knowledgeBaseId: input.knowledgeBaseId,
        candidatePublicId: input.candidatePublicId,
        operationPublicId: input.operationPublicId,
        completedAt: input.activatedAt
      });
      const blocked = await input.transaction<Array<{ present: boolean }>>`
        WITH selected_source AS MATERIALIZED (
          SELECT fact.knowledge_base_id,
                 fact.fact_public_id AS source_file_public_id
          FROM focowiki.release_candidate_changed_facts fact
          WHERE fact.knowledge_base_id = ${input.knowledgeBaseId}
            AND fact.candidate_public_id = ${input.candidatePublicId}
            AND fact.fact_kind = 'source_file'
            AND fact.change_kind <> 'deleted'
          UNION
          SELECT dependency.knowledge_base_id,
                 dependency.dependency_public_id AS source_file_public_id
          FROM focowiki.release_candidate_dependencies dependency
          JOIN focowiki.operations operation
            ON operation.knowledge_base_id = dependency.knowledge_base_id
           AND operation.public_id = ${input.operationPublicId}
           AND operation.operation_kind = 'maintenance'
          WHERE dependency.knowledge_base_id = ${input.knowledgeBaseId}
            AND dependency.candidate_public_id = ${input.candidatePublicId}
            AND dependency.dependency_kind = 'search'
            AND dependency.reason_code = 'search_document'
        )
        SELECT EXISTS (
          SELECT 1
          FROM selected_source source
          JOIN focowiki.source_file_current_revisions current_revision
            ON current_revision.knowledge_base_id = source.knowledge_base_id
           AND current_revision.source_file_public_id = source.source_file_public_id
          WHERE EXISTS (
              SELECT 1
              FROM focowiki.semantic_stage_work_items stage
              JOIN focowiki.semantic_generations generation
                ON generation.knowledge_base_id = stage.knowledge_base_id
               AND generation.public_id = stage.semantic_generation_public_id
               AND generation.generation_role = 'active'
               AND generation.state = 'active'
               AND generation.deleted_at IS NULL
              WHERE stage.knowledge_base_id = source.knowledge_base_id
                AND stage.source_file_public_id = source.source_file_public_id
                AND stage.source_revision_public_id
                  = current_revision.source_revision_public_id
                AND stage.operation_public_id = (
                  SELECT latest.operation_public_id
                  FROM focowiki.semantic_stage_work_items latest
                  WHERE latest.knowledge_base_id = source.knowledge_base_id
                    AND latest.semantic_generation_public_id = generation.public_id
                    AND latest.source_file_public_id = source.source_file_public_id
                    AND latest.source_revision_public_id
                      = current_revision.source_revision_public_id
                  ORDER BY latest.created_at DESC,
                    latest.operation_public_id COLLATE "C" DESC
                  LIMIT 1
                )
                AND stage.stage_kind <> 'validation'
                AND stage.state <> 'completed'
            )
        ) AS present
      `;
      if (blocked[0]?.present === true) {
        throw readinessError("semantic_publication_barrier_incomplete");
      }
      await recordSelectedModelInvocations(input.transaction, {
        knowledgeBaseId: input.knowledgeBaseId,
        candidatePublicId: input.candidatePublicId,
        operationPublicId: input.operationPublicId
      });
      const ready = await input.transaction<SourceReadinessRow[]>`
        WITH selected_source AS MATERIALIZED (
          SELECT fact.knowledge_base_id,
                 fact.fact_public_id AS source_file_public_id
          FROM focowiki.release_candidate_changed_facts fact
          WHERE fact.knowledge_base_id = ${input.knowledgeBaseId}
            AND fact.candidate_public_id = ${input.candidatePublicId}
            AND fact.fact_kind = 'source_file'
            AND fact.change_kind <> 'deleted'
          UNION
          SELECT dependency.knowledge_base_id,
                 dependency.dependency_public_id AS source_file_public_id
          FROM focowiki.release_candidate_dependencies dependency
          JOIN focowiki.operations operation
            ON operation.knowledge_base_id = dependency.knowledge_base_id
           AND operation.public_id = ${input.operationPublicId}
           AND operation.operation_kind = 'maintenance'
          WHERE dependency.knowledge_base_id = ${input.knowledgeBaseId}
            AND dependency.candidate_public_id = ${input.candidatePublicId}
            AND dependency.dependency_kind = 'search'
            AND dependency.reason_code = 'search_document'
        )
        UPDATE focowiki.source_files source
        SET status = 'ready', safe_error_code = NULL,
            safe_error_message = NULL, revision = source.revision + 1,
            updated_at = ${input.activatedAt}
        FROM selected_source selected,
             focowiki.source_file_current_revisions current_revision
        WHERE source.knowledge_base_id = selected.knowledge_base_id
          AND source.public_id = selected.source_file_public_id
          AND source.deleted_at IS NULL
          AND (
            source.status = 'processing'
            OR (
              source.status = 'failed'
              AND source.safe_error_code =
                ${STORAGE_VNEXT_RECOVERABLE_PUBLICATION_FAILURE_CODE}
            )
          )
          AND current_revision.knowledge_base_id = source.knowledge_base_id
          AND current_revision.source_file_public_id = source.public_id
        RETURNING source.public_id,
                  current_revision.source_revision_public_id
      `;
      await recordEvents(input.transaction, {
        knowledgeBaseId: input.knowledgeBaseId,
        candidatePublicId: input.candidatePublicId,
        sources: ready,
        stageKey: "generation_activation",
        messageKey: "sourceFiles.phase.generationActivation",
        severity: "info",
        createdAt: input.activatedAt,
        expiresAt: input.eventExpiresAt
      });
      await enqueueCompletionWebhooks(input.transaction, {
        knowledgeBaseId: input.knowledgeBaseId,
        sources: ready,
        createdAt: input.activatedAt,
        expiresAt: input.eventExpiresAt
      });
    },

    async beforeTerminate(input) {
      const failed = await input.transaction<SourceReadinessRow[]>`
        UPDATE focowiki.source_files source
        SET status = 'failed', safe_error_code = ${input.reasonCode},
            safe_error_message = NULL, revision = source.revision + 1,
            updated_at = ${input.terminatedAt}
        FROM focowiki.release_candidate_changed_facts fact,
             focowiki.source_file_current_revisions current_revision
        WHERE fact.knowledge_base_id = ${input.knowledgeBaseId}
          AND fact.candidate_public_id = ${input.candidatePublicId}
          AND fact.fact_kind = 'source_file'
          AND fact.change_kind <> 'deleted'
          AND source.knowledge_base_id = fact.knowledge_base_id
          AND source.public_id = fact.fact_public_id
          AND source.deleted_at IS NULL
          AND source.status = 'processing'
          AND current_revision.knowledge_base_id = source.knowledge_base_id
          AND current_revision.source_file_public_id = source.public_id
        RETURNING source.public_id,
                  current_revision.source_revision_public_id
      `;
      await input.transaction`
        UPDATE focowiki.semantic_stage_work_items validation
        SET state = 'failed', safe_error_code = ${input.reasonCode},
            completed_at = ${input.terminatedAt},
            revision = validation.revision + 1,
            updated_at = ${input.terminatedAt}
        FROM focowiki.semantic_stage_work_items publication
        WHERE publication.knowledge_base_id = ${input.knowledgeBaseId}
          AND publication.stage_kind = 'publication'
          AND publication.checkpoint ->> 'candidatePublicId'
            = ${input.candidatePublicId}
          AND validation.knowledge_base_id = publication.knowledge_base_id
          AND validation.operation_public_id = publication.operation_public_id
          AND validation.source_file_public_id = publication.source_file_public_id
          AND validation.source_revision_public_id
            = publication.source_revision_public_id
          AND validation.stage_kind = 'validation'
          AND validation.state IN ('queued', 'retry')
      `;
      await recordEvents(input.transaction, {
        knowledgeBaseId: input.knowledgeBaseId,
        candidatePublicId: input.candidatePublicId,
        sources: failed,
        stageKey: "projection_generation",
        messageKey: "sourceFiles.phase.projectionGeneration",
        severity: "error",
        createdAt: input.terminatedAt,
        expiresAt: input.eventExpiresAt
      });
    }
  };
}

async function recordSelectedModelInvocations(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
  }
): Promise<void> {
  await transaction`
    WITH selected_source AS MATERIALIZED (
      SELECT fact.knowledge_base_id,
             fact.fact_public_id AS source_file_public_id
      FROM focowiki.release_candidate_changed_facts fact
      WHERE fact.knowledge_base_id = ${input.knowledgeBaseId}
        AND fact.candidate_public_id = ${input.candidatePublicId}
        AND fact.fact_kind = 'source_file'
        AND fact.change_kind <> 'deleted'
      UNION
      SELECT dependency.knowledge_base_id,
             dependency.dependency_public_id AS source_file_public_id
      FROM focowiki.release_candidate_dependencies dependency
      JOIN focowiki.operations operation
        ON operation.knowledge_base_id = dependency.knowledge_base_id
       AND operation.public_id = ${input.operationPublicId}
       AND operation.operation_kind = 'maintenance'
      WHERE dependency.knowledge_base_id = ${input.knowledgeBaseId}
        AND dependency.candidate_public_id = ${input.candidatePublicId}
        AND dependency.dependency_kind = 'search'
        AND dependency.reason_code = 'search_document'
    ), invocation AS MATERIALIZED (
      SELECT DISTINCT ON (stage.source_file_public_id)
             stage.source_file_public_id,
             stage.source_revision_public_id,
             model.model AS model_name,
             stage.created_at AS started_at,
             stage.completed_at AS ended_at
      FROM selected_source source
      JOIN focowiki.source_file_current_revisions current_revision
        ON current_revision.knowledge_base_id = source.knowledge_base_id
       AND current_revision.source_file_public_id = source.source_file_public_id
      JOIN focowiki.semantic_stage_work_items stage
        ON stage.knowledge_base_id = source.knowledge_base_id
       AND stage.source_file_public_id = source.source_file_public_id
       AND stage.source_revision_public_id
         = current_revision.source_revision_public_id
       AND stage.stage_kind = 'extraction'
       AND stage.state = 'completed'
       AND stage.completed_at IS NOT NULL
      JOIN focowiki.semantic_generations generation
        ON generation.knowledge_base_id = stage.knowledge_base_id
       AND generation.public_id = stage.semantic_generation_public_id
       AND generation.generation_role = 'active'
       AND generation.state = 'active'
       AND generation.deleted_at IS NULL
      JOIN focowiki.semantic_source_reconciliations reconciliation
        ON reconciliation.knowledge_base_id = stage.knowledge_base_id
       AND reconciliation.semantic_generation_public_id
         = stage.semantic_generation_public_id
       AND reconciliation.source_file_public_id = stage.source_file_public_id
       AND reconciliation.source_revision_public_id
         = stage.source_revision_public_id
       AND reconciliation.skeleton_selected = true
      JOIN focowiki.model_configs model
        ON model.public_id = generation.generation_model_configuration_public_id
       AND model.revision = generation.generation_model_configuration_revision
      ORDER BY stage.source_file_public_id,
               stage.created_at DESC,
               stage.public_id COLLATE "C" DESC
    )
    UPDATE focowiki.source_files source
    SET model_invocation_source_revision_public_id
          = invocation.source_revision_public_id,
        model_invocation_status = 'completed',
        model_invocation_model_name = invocation.model_name,
        model_invocation_started_at = invocation.started_at,
        model_invocation_ended_at = invocation.ended_at,
        model_invocation_warning_count = 0,
        model_invocation_error_code = NULL
    FROM invocation
    WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
      AND source.public_id = invocation.source_file_public_id
      AND source.deleted_at IS NULL
  `;
}

const WEBHOOK_EVENT_BATCH_SIZE = 1_000;

async function enqueueCompletionWebhooks(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    sources: readonly SourceReadinessRow[];
    createdAt: string;
    expiresAt: string;
  }
): Promise<void> {
  for (let offset = 0; offset < input.sources.length; offset += WEBHOOK_EVENT_BATCH_SIZE) {
    const events = input.sources
      .slice(offset, offset + WEBHOOK_EVENT_BATCH_SIZE)
      .map((source) => ({
        eventPublicId: `event-source-completed-${createHash("sha256")
          .update(source.source_revision_public_id)
          .digest("hex")}`,
        eventType: "source_file.completed" as const,
        payload: {
          knowledgeBaseId: input.knowledgeBaseId,
          sourceFileId: source.public_id,
          sourceRevisionId: source.source_revision_public_id
        },
        createdAt: input.createdAt,
        expiresAt: input.expiresAt
      }));
    await enqueuePostgresStorageVnextWebhookEvents(transaction, events);
  }
}

async function completePublicationBarriers(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
    completedAt: string;
  }
): Promise<void> {
  await transaction`
    WITH selected_source AS MATERIALIZED (
      SELECT fact.knowledge_base_id,
             fact.fact_public_id AS source_file_public_id
      FROM focowiki.release_candidate_changed_facts fact
      WHERE fact.knowledge_base_id = ${input.knowledgeBaseId}
        AND fact.candidate_public_id = ${input.candidatePublicId}
        AND fact.fact_kind = 'source_file'
        AND fact.change_kind <> 'deleted'
      UNION
      SELECT dependency.knowledge_base_id,
             dependency.dependency_public_id AS source_file_public_id
      FROM focowiki.release_candidate_dependencies dependency
      JOIN focowiki.operations operation
        ON operation.knowledge_base_id = dependency.knowledge_base_id
       AND operation.public_id = ${input.operationPublicId}
       AND operation.operation_kind = 'maintenance'
      WHERE dependency.knowledge_base_id = ${input.knowledgeBaseId}
        AND dependency.candidate_public_id = ${input.candidatePublicId}
        AND dependency.dependency_kind = 'search'
        AND dependency.reason_code = 'search_document'
    ), latest_operation AS MATERIALIZED (
      SELECT DISTINCT ON (
        source.knowledge_base_id,
        source.source_file_public_id
      )
        source.knowledge_base_id,
        source.source_file_public_id,
        current_revision.source_revision_public_id,
        stage.semantic_generation_public_id,
        stage.operation_public_id
      FROM selected_source source
      JOIN focowiki.source_file_current_revisions current_revision
        ON current_revision.knowledge_base_id = source.knowledge_base_id
       AND current_revision.source_file_public_id = source.source_file_public_id
      JOIN focowiki.semantic_stage_work_items stage
        ON stage.knowledge_base_id = source.knowledge_base_id
       AND stage.source_file_public_id = source.source_file_public_id
       AND stage.source_revision_public_id
         = current_revision.source_revision_public_id
      JOIN focowiki.semantic_generations generation
        ON generation.knowledge_base_id = stage.knowledge_base_id
       AND generation.public_id = stage.semantic_generation_public_id
       AND generation.generation_role = 'active'
       AND generation.state = 'active'
       AND generation.deleted_at IS NULL
      ORDER BY source.knowledge_base_id,
               source.source_file_public_id,
               stage.created_at DESC,
               stage.operation_public_id COLLATE "C" DESC
    ), eligible_validation AS MATERIALIZED (
      SELECT validation.public_id
      FROM latest_operation latest
      JOIN focowiki.semantic_stage_work_items validation
        ON validation.knowledge_base_id = latest.knowledge_base_id
       AND validation.semantic_generation_public_id
         = latest.semantic_generation_public_id
       AND validation.operation_public_id = latest.operation_public_id
       AND validation.source_file_public_id = latest.source_file_public_id
       AND validation.source_revision_public_id
         = latest.source_revision_public_id
       AND validation.stage_kind = 'validation'
      WHERE (
          validation.state IN ('queued', 'retry')
          OR (
            validation.state = 'failed'
            AND validation.safe_error_code
              = ${STORAGE_VNEXT_RECOVERABLE_PUBLICATION_FAILURE_CODE}
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM focowiki.semantic_stage_work_items predecessor
          WHERE predecessor.knowledge_base_id = latest.knowledge_base_id
            AND predecessor.semantic_generation_public_id
              = latest.semantic_generation_public_id
            AND predecessor.operation_public_id = latest.operation_public_id
            AND predecessor.source_file_public_id = latest.source_file_public_id
            AND predecessor.source_revision_public_id
              = latest.source_revision_public_id
            AND predecessor.stage_kind <> 'validation'
            AND predecessor.state <> 'completed'
        )
    )
    UPDATE focowiki.semantic_stage_work_items validation
    SET state = 'completed', safe_error_code = NULL,
        checkpoint = validation.checkpoint || ${transaction.json({
          releaseCandidatePublicId: input.candidatePublicId,
          releaseActivated: true
        })},
        completed_at = ${input.completedAt},
        revision = validation.revision + 1,
        updated_at = ${input.completedAt}
    FROM eligible_validation eligible
    WHERE validation.public_id = eligible.public_id
  `;
}

async function recordEvents(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    sources: readonly SourceReadinessRow[];
    stageKey: "projection_generation" | "generation_activation";
    messageKey: string;
    severity: "info" | "error";
    createdAt: string;
    expiresAt: string;
  }
): Promise<void> {
  if (input.sources.length === 0) return;
  await transaction`
    UPDATE focowiki.source_event_summaries event
    SET ended_at = ${input.createdAt}
    FROM unnest(
      ${input.sources.map((source) => source.public_id)}::text[],
      ${input.sources.map((source) => source.source_revision_public_id)}::text[]
    ) AS source(source_file_public_id, source_revision_public_id)
    WHERE event.knowledge_base_id = ${input.knowledgeBaseId}
      AND event.source_file_public_id = source.source_file_public_id
      AND event.source_revision_public_id = source.source_revision_public_id
      AND event.started_at IS NOT NULL
      AND event.started_at <= ${input.createdAt}
      AND event.ended_at IS NULL
  `;
  await transaction`
    INSERT INTO focowiki.source_event_summaries (
      public_id, knowledge_base_id, source_file_public_id,
      source_revision_public_id, sequence_number, stage_key, message_key,
      started_at, ended_at, severity, created_at, expires_at
    )
    SELECT
      'source-event-release-' || md5(
        ${input.candidatePublicId} || chr(31) || source_file_public_id
      ),
      ${input.knowledgeBaseId}, source_file_public_id,
      source_revision_public_id, 100, ${input.stageKey},
      ${input.messageKey}, ${input.createdAt}, ${input.createdAt},
      ${input.severity}, ${input.createdAt}, ${input.expiresAt}
    FROM unnest(
      ${input.sources.map((source) => source.public_id)}::text[],
      ${input.sources.map((source) => source.source_revision_public_id)}::text[]
    ) AS source(source_file_public_id, source_revision_public_id)
    ON CONFLICT (public_id) DO NOTHING
  `;
}

function readinessError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Semantic publication readiness error: ${code}`),
    { code }
  );
}
