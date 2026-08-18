import type { DatabaseClient } from "../../db/client.js";
import type { ClaimedDocumentArtifactWork } from
  "../application/document-work-port.js";

export type DocumentWorkProcessingContext = {
  job: {
    operationPublicId: string;
    operationKind: string;
    runtimeSettingsRevisionPublicId: string;
    generationModelConfigurationPublicId: string | null;
    generationModelConfigurationRevision: number | null;
    embeddingConfigurationRevisionPublicId: string | null;
    semanticGenerationPublicId: string | null;
    semanticContractVersion: string;
    readinessSequence: number;
    acceptedAt: string;
  };
  source: {
    priorActiveSourceRevisionPublicId: string | null;
    objectId: string;
    resourceRevision: number;
    checksumSha256: string;
    byteCount: number;
    contentType: string;
    logicalPath: string;
    normalizedPath: string;
    title: string;
    metadata: Readonly<Record<string, unknown>>;
  };
  runtimeSettings: Readonly<Record<string, unknown>>;
};

type ContextRow = {
  operation_public_id: string;
  operation_kind: string;
  runtime_settings_revision_public_id: string;
  generation_model_configuration_public_id: string | null;
  generation_model_configuration_revision: number | string | null;
  embedding_configuration_revision_public_id: string | null;
  semantic_generation_public_id: string | null;
  semantic_contract_version: string;
  readiness_sequence: number | string;
  accepted_at: string | Date;
  prior_active_source_revision_public_id: string | null;
  object_id: string;
  resource_revision: number | string;
  checksum_sha256: string;
  byte_count: number | string;
  content_type: string;
  logical_path: string;
  normalized_path: string;
  title: string;
  metadata: unknown;
  settings_values: unknown;
};

export function createPostgresDocumentWorkContext(sql: DatabaseClient) {
  return {
    async read(work: ClaimedDocumentArtifactWork): Promise<DocumentWorkProcessingContext> {
      const rows = await sql<ContextRow[]>`
        SELECT job.operation_public_id, operation.operation_kind,
               job.runtime_settings_revision_public_id,
               job.generation_model_configuration_public_id,
               job.generation_model_configuration_revision,
               job.embedding_configuration_revision_public_id,
               job.semantic_generation_public_id,
               job.semantic_contract_version, job.readiness_sequence,
               job.accepted_at,
               active.active_source_revision_public_id
                 AS prior_active_source_revision_public_id,
               revision.object_id, source.revision AS resource_revision,
               revision.checksum_sha256, revision.byte_count,
               revision.content_type, presentation.logical_path,
               presentation.normalized_path, presentation.title,
               presentation.metadata, settings.settings_values
        FROM focowiki.document_artifact_work artifact_work
        JOIN focowiki.document_processing_jobs job
          ON job.knowledge_base_id = artifact_work.knowledge_base_id
         AND job.public_id = artifact_work.document_job_public_id
         AND job.source_revision_public_id = artifact_work.source_revision_public_id
        JOIN focowiki.operations operation
          ON operation.knowledge_base_id = job.knowledge_base_id
         AND operation.public_id = job.operation_public_id
        JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = job.knowledge_base_id
         AND active.source_file_public_id = job.source_file_public_id
         AND active.current_source_revision_public_id = job.source_revision_public_id
        JOIN focowiki.source_revisions revision
          ON revision.knowledge_base_id = job.knowledge_base_id
         AND revision.source_file_public_id = job.source_file_public_id
         AND revision.public_id = job.source_revision_public_id
         AND revision.deleted_at IS NULL
        JOIN focowiki.source_revision_presentations presentation
          ON presentation.knowledge_base_id = job.knowledge_base_id
         AND presentation.source_file_public_id = job.source_file_public_id
         AND presentation.source_revision_public_id = job.source_revision_public_id
        JOIN focowiki.runtime_setting_revisions settings
          ON settings.public_id = job.runtime_settings_revision_public_id
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.public_id = job.knowledge_base_id
         AND knowledge_base.deleted_at IS NULL
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = job.knowledge_base_id
         AND source.public_id = job.source_file_public_id
         AND source.deleted_at IS NULL
        WHERE artifact_work.public_id = ${work.publicId}
          AND artifact_work.knowledge_base_id = ${work.knowledgeBaseId}
          AND artifact_work.document_job_public_id = ${work.documentJobPublicId}
          AND artifact_work.source_file_public_id = ${work.sourceFilePublicId}
          AND artifact_work.source_revision_public_id = ${work.sourceRevisionPublicId}
          AND artifact_work.work_kind = ${work.kind}
          AND artifact_work.state = 'running'
          AND artifact_work.lease_owner = ${work.leaseOwner}
          AND artifact_work.lease_expires_at > now()
      `;
      if (rows.length !== 1) throw contextError("document_work_context_unavailable");
      return mapContext(rows[0]!);
    }
  };
}

function mapContext(row: ContextRow): DocumentWorkProcessingContext {
  const byteCount = Number(row.byte_count);
  const resourceRevision = Number(row.resource_revision);
  const modelRevision = row.generation_model_configuration_revision === null
    ? null : Number(row.generation_model_configuration_revision);
  if (!row.object_id || !/^[0-9a-f]{64}$/u.test(row.checksum_sha256)
    || !Number.isSafeInteger(byteCount) || byteCount < 0
    || !Number.isSafeInteger(resourceRevision) || resourceRevision < 0
    || (modelRevision !== null
      && (!Number.isSafeInteger(modelRevision) || modelRevision < 1))
    || !Number.isSafeInteger(Number(row.readiness_sequence))
    || Number(row.readiness_sequence) < 1
    || !row.content_type || !row.logical_path || !row.normalized_path
    || !row.title) {
    throw contextError("document_work_context_invalid");
  }
  return {
        job: {
          operationPublicId: row.operation_public_id,
          operationKind: row.operation_kind,
      runtimeSettingsRevisionPublicId: row.runtime_settings_revision_public_id,
      generationModelConfigurationPublicId:
        row.generation_model_configuration_public_id,
      generationModelConfigurationRevision: modelRevision,
      embeddingConfigurationRevisionPublicId:
        row.embedding_configuration_revision_public_id,
      semanticGenerationPublicId: row.semantic_generation_public_id,
      semanticContractVersion: row.semantic_contract_version,
      readinessSequence: Number(row.readiness_sequence),
      acceptedAt: timestamp(row.accepted_at)
    },
    source: {
      priorActiveSourceRevisionPublicId:
        row.prior_active_source_revision_public_id,
      objectId: row.object_id,
      resourceRevision,
      checksumSha256: row.checksum_sha256,
      byteCount,
      contentType: row.content_type,
      logicalPath: row.logical_path,
      normalizedPath: row.normalized_path,
      title: row.title,
      metadata: recordValue(row.metadata, "source_metadata_invalid")
    },
    runtimeSettings: recordValue(
      row.settings_values,
      "runtime_settings_revision_invalid"
    )
  };
}

function recordValue(
  value: unknown,
  code: string
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw contextError(code);
  }
  return value as Readonly<Record<string, unknown>>;
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function contextError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document work context error: ${code}`), { code });
}
