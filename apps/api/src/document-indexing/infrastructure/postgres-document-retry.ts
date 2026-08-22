import type { DatabaseClient } from "../../db/client.js";
import { documentFixedWorkInputFingerprints } from
  "../domain/document-fixed-work-identity.js";
import { createPostgresDocumentJobRepository } from
  "./postgres-document-job-repository.js";
import { enqueuePostgresDocumentWebhookEvent } from
  "./postgres-document-webhook-event.js";

type RetryRow = {
  public_id: string;
  operation_public_id: string;
  operation_kind: string;
  source_file_public_id: string;
  source_revision_public_id: string;
  state: string;
  retryable: boolean;
  attempt_count: number | string;
  total_attempt_count: number | string;
  manual_retry_count: number | string;
  maximum_attempts: number | string;
  revision: number | string;
  active_source_revision_public_id: string | null;
  active_generated_path: string | null;
  logical_path: string;
  title: string;
  metadata: Record<string, unknown>;
  resource_revision: number | string;
  object_id: string;
  checksum_sha256: string;
  byte_count: number | string;
  content_type: string;
  created_at: string | Date;
};

type CurrentProcessingContractRow = {
  runtime_settings_revision_public_id: string;
  generation_model_configuration_public_id: string;
  generation_model_configuration_revision: number | string;
  embedding_configuration_revision_public_id: string;
  semantic_generation_public_id: string;
  semantic_contract_version: string;
  maximum_attempts: number | string;
};

export type DocumentRetryOutcome =
  | { outcome: "not_found" }
  | { outcome: "already_running" }
  | { outcome: "not_allowed" }
  | { outcome: "resource_conflict" }
  | {
      outcome: "accepted";
      documentJobPublicId: string;
      operationPublicId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      activeSourceRevisionPublicId: string | null;
      activeGeneratedPath: string | null;
      logicalPath: string;
      title: string;
      metadata: Readonly<Record<string, unknown>>;
      resourceRevision: number;
      byteCount: number;
      contentType: string;
      createdAt: string;
      retryCount: number;
      jobRevision: number;
    };

export function createPostgresDocumentRetry(
  sql: DatabaseClient,
  options: { webhookRetentionMilliseconds?: number } = {}
) {
  return async (input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    retriedAt: string;
  }): Promise<DocumentRetryOutcome> => {
    validateInput(input);
    return sql.begin(async (transaction) => {
      const rows = await transaction<RetryRow[]>`
        SELECT job.public_id, job.operation_public_id,
               operation.operation_kind,
               job.source_file_public_id, job.source_revision_public_id,
               job.state, job.retryable, job.attempt_count,
               job.total_attempt_count, job.manual_retry_count,
               job.maximum_attempts, job.revision,
               active.active_source_revision_public_id,
               page.logical_path AS active_generated_path,
               source.logical_path, source.title, source.metadata,
               source.revision AS resource_revision,
               revision.object_id, revision.checksum_sha256,
               revision.byte_count,
               revision.content_type, revision.created_at
        FROM focowiki.source_files source
        JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = source.knowledge_base_id
         AND active.source_file_public_id = source.public_id
        JOIN focowiki.source_revisions revision
          ON revision.knowledge_base_id = active.knowledge_base_id
         AND revision.source_file_public_id = active.source_file_public_id
         AND revision.public_id = active.current_source_revision_public_id
        JOIN focowiki.document_processing_jobs job
          ON job.knowledge_base_id = active.knowledge_base_id
         AND job.source_file_public_id = active.source_file_public_id
         AND job.source_revision_public_id = active.current_source_revision_public_id
        JOIN focowiki.operations operation
          ON operation.knowledge_base_id = job.knowledge_base_id
         AND operation.public_id = job.operation_public_id
        LEFT JOIN focowiki.generated_page_heads page
          ON page.knowledge_base_id = active.knowledge_base_id
         AND page.source_file_public_id = active.source_file_public_id
         AND page.source_revision_public_id = active.active_source_revision_public_id
         AND page.entry_kind = 'source'
        WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.public_id = ${input.sourceFilePublicId}
          AND source.deleted_at IS NULL
          AND revision.deleted_at IS NULL
        FOR UPDATE OF source, active, revision, job
      `;
      const row = rows[0];
      if (!row) {
        const source = await transaction<Array<{ exists: boolean }>>`
          SELECT true AS exists
          FROM focowiki.source_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.sourceFilePublicId}
            AND deleted_at IS NULL
        `;
        return source[0] ? { outcome: "resource_conflict" } : { outcome: "not_found" };
      }
      if (row.state === "waiting" || row.state === "processing") {
        return { outcome: "already_running" };
      }
      if (row.state !== "error" || !row.retryable) {
        return { outcome: "not_allowed" };
      }
      const contract = await readCurrentProcessingContract(
        transaction as unknown as DatabaseClient,
        input.knowledgeBaseId
      );
      if (!contract) return { outcome: "resource_conflict" };
      if (!["upload", "source_directory_move"].includes(row.operation_kind)) {
        await transaction`
          DELETE FROM focowiki.operation_results
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${row.operation_public_id}
        `;
        await transaction`
          UPDATE focowiki.operations
          SET state = 'processing', completed_at = NULL,
              updated_at = ${input.retriedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${row.operation_public_id}
        `;
      }
      const removed = await transaction<Array<{ public_id: string }>>`
        DELETE FROM focowiki.document_processing_jobs
        WHERE public_id = ${row.public_id}
          AND state = 'error' AND retryable
          AND revision = ${Number(row.revision)}
        RETURNING public_id
      `;
      if (!removed[0]) return { outcome: "resource_conflict" };
      const maximumAttempts = count(contract.maximum_attempts);
      await createPostgresDocumentJobRepository(
        transaction as unknown as DatabaseClient
      ).create({
        publicId: row.public_id,
        knowledgeBaseId: input.knowledgeBaseId,
        operationPublicId: row.operation_public_id,
        sourceFilePublicId: row.source_file_public_id,
        sourceRevisionPublicId: row.source_revision_public_id,
        runtimeSettingsRevisionPublicId:
          contract.runtime_settings_revision_public_id,
        generationModelConfigurationPublicId:
          contract.generation_model_configuration_public_id,
        generationModelConfigurationRevision: count(
          contract.generation_model_configuration_revision
        ),
        embeddingConfigurationRevisionPublicId:
          contract.embedding_configuration_revision_public_id,
        semanticGenerationPublicId: contract.semantic_generation_public_id,
        semanticContractVersion: contract.semantic_contract_version,
        maximumAttempts,
        acceptedAt: input.retriedAt,
        inputFingerprints: documentFixedWorkInputFingerprints({
          sourceChecksumSha256: row.checksum_sha256,
          runtimeSettingsRevisionPublicId:
            contract.runtime_settings_revision_public_id,
          generationModelConfigurationPublicId:
            contract.generation_model_configuration_public_id,
          generationModelConfigurationRevision: count(
            contract.generation_model_configuration_revision
          ),
          embeddingConfigurationRevisionPublicId:
            contract.embedding_configuration_revision_public_id,
          semanticContractVersion: contract.semantic_contract_version
        })
      });
      const [updated] = await transaction<Array<{ revision: number | string }>>`
        UPDATE focowiki.document_processing_jobs
        SET total_attempt_count = ${Number(row.total_attempt_count)},
            manual_retry_count = ${Number(row.manual_retry_count) + 1},
            blocking_work_kind = 'prepare',
            revision = ${Number(row.revision) + 1}
        WHERE public_id = ${row.public_id}
        RETURNING revision
      `;
      if (!updated) throw documentRetryError("job_rebuild_failed");
      if (options.webhookRetentionMilliseconds !== undefined) {
        await enqueuePostgresDocumentWebhookEvent(transaction, {
          documentJobPublicId: row.public_id,
          documentJobRevision: Number(updated.revision),
          knowledgeBaseId: input.knowledgeBaseId,
          operationPublicId: row.operation_public_id,
          sourceFilePublicId: row.source_file_public_id,
          eventType: "document.waiting",
          state: "waiting",
          occurredAt: input.retriedAt,
          expiresAt: new Date(
            Date.parse(input.retriedAt) + options.webhookRetentionMilliseconds
          ).toISOString()
        });
      }
      return {
        outcome: "accepted",
        documentJobPublicId: row.public_id,
        operationPublicId: row.operation_public_id,
        sourceFilePublicId: row.source_file_public_id,
        sourceRevisionPublicId: row.source_revision_public_id,
        activeSourceRevisionPublicId: row.active_source_revision_public_id,
        activeGeneratedPath: row.active_generated_path,
        logicalPath: row.logical_path,
        title: row.title,
        metadata: row.metadata,
        resourceRevision: Number(row.resource_revision),
        byteCount: Number(row.byte_count),
        contentType: row.content_type,
        createdAt: timestamp(row.created_at),
        retryCount: Number(row.total_attempt_count),
        jobRevision: Number(updated.revision)
      };
    });
  };
}

async function readCurrentProcessingContract(
  sql: DatabaseClient,
  knowledgeBaseId: string
): Promise<CurrentProcessingContractRow | null> {
  const rows = await sql<CurrentProcessingContractRow[]>`
    SELECT current.revision_public_id AS runtime_settings_revision_public_id,
           model.public_id AS generation_model_configuration_public_id,
           model.revision AS generation_model_configuration_revision,
           contract.embedding_configuration_revision_public_id,
           generation.public_id AS semantic_generation_public_id,
           generation.contract_fingerprint_sha256 AS semantic_contract_version,
           (settings.settings_values #>>
             '{sections,worker,jobMaxAttempts}')::integer AS maximum_attempts
    FROM focowiki.runtime_setting_current current
    JOIN focowiki.runtime_setting_revisions settings
      ON settings.public_id = current.revision_public_id
    JOIN LATERAL (
      SELECT public_id, revision
      FROM focowiki.model_configs
      WHERE knowledge_base_id IS NULL
        AND enabled = true
        AND config ->> 'status' = 'active'
      ORDER BY updated_at DESC, public_id DESC
      LIMIT 1
    ) model ON true
    JOIN focowiki.semantic_generations generation
      ON generation.knowledge_base_id = ${knowledgeBaseId}
     AND generation.generation_role = 'active'
     AND generation.state = 'active'
     AND generation.deleted_at IS NULL
    JOIN focowiki.semantic_projection_contracts contract
      ON contract.knowledge_base_id = generation.knowledge_base_id
     AND contract.semantic_generation_public_id = generation.public_id
    WHERE current.singleton = true
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const maximumAttempts = Number(row.maximum_attempts);
  const modelRevision = Number(row.generation_model_configuration_revision);
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1
    || maximumAttempts > 100 || !Number.isSafeInteger(modelRevision)
    || modelRevision < 1) {
    return null;
  }
  return row;
}

function count(value: number | string): number {
  return Number(value);
}

function validateInput(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  retriedAt: string;
}): void {
  if ([input.knowledgeBaseId, input.sourceFilePublicId]
    .some((value) => !value || Buffer.byteLength(value, "utf8") > 255)
    || !Number.isFinite(Date.parse(input.retriedAt))) {
    throw documentRetryError("input_invalid");
  }
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function documentRetryError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document retry error: ${code}`), { code });
}
