import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";
import { createSemanticAdoptionCandidatePublicId } from
  "../../semantic/domain/maintenance-contract.js";
import type { SemanticMaintenanceTarget } from
  "../../semantic/domain/contracts.js";
import { createDocumentSourceRevisionPublicId } from
  "../domain/source-revision-identity.js";
import { createStorageVnextUploadIdentity } from
  "../../storage-vnext/upload/identity.js";
import type { DocumentMaintenancePort } from
  "../application/document-maintenance-phase-runner.js";
import { createDocumentJobPublicId } from
  "../domain/document-job-identity.js";
import { documentFixedWorkInputFingerprints } from
  "../domain/document-fixed-work-identity.js";
import { createPostgresDocumentJobRepository } from
  "./postgres-document-job-repository.js";
import { enqueuePostgresDocumentWebhookEvent } from
  "./postgres-document-webhook-event.js";

type Context = Parameters<DocumentMaintenancePort["prepare"]>[0];

type SourceRow = {
  source_file_public_id: string;
  source_revision_public_id: string;
  object_id: string;
  checksum_sha256: string;
  byte_count: number | string;
  content_type: string;
  directory_public_id: string | null;
  logical_path: string;
  normalized_path: string;
  title: string;
  metadata: Record<string, unknown>;
};

type SemanticContract = {
  generationPublicId: string;
  generationModelConfigurationPublicId: string;
  generationModelConfigurationRevision: number;
  embeddingConfigurationRevisionPublicId: string;
  semanticContractVersion: string;
  reuseSemanticGenerationPublicId: string | null;
};

export async function scheduleDocumentMaintenancePage(input: {
  sql: DatabaseClient;
  providerKind: SearchProviderKind;
  pageSize: number;
  context: Context & { cursor: string | null };
}) {
  const contract = await readSemanticContract(input.sql, input.context);
  const settingsRevisionPublicId = await readSettingsRevision(
    input.sql,
    input.context.operationPublicId
  );
  await readSelectedSearchProjection(
    input.sql,
    input.context.knowledgeBaseId,
    input.providerKind
  );
  const rows = await readSourcePage(input.sql, {
    ...input.context,
    limit: input.pageSize
  });
  if (rows.length === 0) {
    return {
      ...emptyPage(),
      documentCount: input.context.checkpoint.expectedCount
    };
  }
  await input.sql.begin(async (transaction) => {
    for (const source of rows) {
      await scheduleSource(transaction, {
        context: input.context,
        source,
        contract,
        settingsRevisionPublicId
      });
    }
  });
  const last = rows.at(-1)!;
  return {
    scheduledCount: rows.length,
    processedBytes: rows.reduce(
      (total, row) => total + Number(row.byte_count),
      0
    ),
    nextCursor: rows.length === input.pageSize
      ? last.source_file_public_id : null,
    documentCount: input.context.checkpoint.expectedCount
  };
}

async function readSourcePage(
  sql: DatabaseClient,
  input: Context & { cursor: string | null; limit: number }
): Promise<SourceRow[]> {
  return sql<SourceRow[]>`
    SELECT source.public_id AS source_file_public_id,
           revision.public_id AS source_revision_public_id,
           revision.object_id, revision.checksum_sha256,
           revision.byte_count, revision.content_type,
           presentation.directory_public_id, presentation.logical_path,
           presentation.normalized_path, presentation.title,
           presentation.metadata
    FROM focowiki.source_files source
    JOIN focowiki.source_file_active_revisions active
      ON active.knowledge_base_id = source.knowledge_base_id
     AND active.source_file_public_id = source.public_id
    JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = active.knowledge_base_id
     AND revision.source_file_public_id = active.source_file_public_id
     AND revision.public_id = active.active_source_revision_public_id
     AND revision.deleted_at IS NULL
    JOIN focowiki.source_revision_presentations presentation
      ON presentation.knowledge_base_id = revision.knowledge_base_id
     AND presentation.source_file_public_id = revision.source_file_public_id
     AND presentation.source_revision_public_id = revision.public_id
    WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
      AND source.deleted_at IS NULL
      AND active.active_source_revision_public_id IS NOT NULL
      AND active.current_source_revision_public_id
        = active.active_source_revision_public_id
      AND (${input.cursor}::text IS NULL
        OR source.public_id COLLATE "C" > ${input.cursor}::text COLLATE "C")
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.document_processing_jobs planned
        WHERE planned.knowledge_base_id = source.knowledge_base_id
          AND planned.operation_public_id = ${input.operationPublicId}
          AND planned.source_file_public_id = source.public_id
      )
    ORDER BY source.public_id COLLATE "C"
    LIMIT ${input.limit}
  `;
}

async function scheduleSource(
  sql: TransactionSql,
  input: {
    context: Context;
    source: SourceRow;
    contract: SemanticContract;
    settingsRevisionPublicId: string;
  }
): Promise<void> {
  const revisionPublicId = createDocumentSourceRevisionPublicId({
    knowledgeBaseId: input.context.knowledgeBaseId,
    sourceFilePublicId: input.source.source_file_public_id,
    checksum: input.source.checksum_sha256,
    variant: `maintenance:${input.context.operationPublicId}`
  });
  const jobPublicId = createDocumentJobPublicId({
    knowledgeBaseId: input.context.knowledgeBaseId,
    sourceRevisionPublicId: revisionPublicId
  });
  const acceptedAt = new Date().toISOString();
  await sql`
    INSERT INTO focowiki.source_revisions (
      public_id, knowledge_base_id, source_file_public_id, object_id,
      checksum_sha256, byte_count, content_type, created_at
    ) VALUES (
      ${revisionPublicId}, ${input.context.knowledgeBaseId},
      ${input.source.source_file_public_id}, ${input.source.object_id},
      ${input.source.checksum_sha256}, ${Number(input.source.byte_count)},
      ${input.source.content_type}, ${acceptedAt}
    ) ON CONFLICT (public_id) DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.source_revision_presentations (
      knowledge_base_id, source_file_public_id, source_revision_public_id,
      directory_public_id, logical_path, normalized_path, title, metadata,
      created_at
    ) VALUES (
      ${input.context.knowledgeBaseId}, ${input.source.source_file_public_id},
      ${revisionPublicId}, ${input.source.directory_public_id},
      ${input.source.logical_path}, ${input.source.normalized_path},
      ${input.source.title}, ${sql.json(input.source.metadata as never)},
      ${acceptedAt}
    ) ON CONFLICT DO NOTHING
  `;
  await createPostgresDocumentJobRepository(
    sql as unknown as DatabaseClient
  ).create({
    publicId: jobPublicId,
    knowledgeBaseId: input.context.knowledgeBaseId,
    operationPublicId: input.context.operationPublicId,
    sourceFilePublicId: input.source.source_file_public_id,
    sourceRevisionPublicId: revisionPublicId,
    runtimeSettingsRevisionPublicId: input.settingsRevisionPublicId,
    generationModelConfigurationPublicId:
      input.contract.generationModelConfigurationPublicId,
    generationModelConfigurationRevision:
      input.contract.generationModelConfigurationRevision,
    embeddingConfigurationRevisionPublicId:
      input.contract.embeddingConfigurationRevisionPublicId,
    semanticGenerationPublicId: input.contract.generationPublicId,
    semanticContractVersion: input.contract.semanticContractVersion,
    maximumAttempts: input.context.checkpoint.maxAttempts,
    acceptedAt,
    inputFingerprints: documentFixedWorkInputFingerprints({
      sourceChecksumSha256: input.source.checksum_sha256,
      runtimeSettingsRevisionPublicId: input.settingsRevisionPublicId,
      generationModelConfigurationPublicId:
        input.contract.generationModelConfigurationPublicId,
      generationModelConfigurationRevision:
        input.contract.generationModelConfigurationRevision,
      embeddingConfigurationRevisionPublicId:
        input.contract.embeddingConfigurationRevisionPublicId,
      semanticContractVersion: input.contract.semanticContractVersion
    })
  });
  await enqueuePostgresDocumentWebhookEvent(sql, {
    documentJobPublicId: jobPublicId,
    documentJobRevision: 0,
    knowledgeBaseId: input.context.knowledgeBaseId,
    operationPublicId: input.context.operationPublicId,
    sourceFilePublicId: input.source.source_file_public_id,
    eventType: "document.waiting",
    state: "waiting",
    occurredAt: acceptedAt,
    expiresAt: input.context.checkpoint.resultExpiresAt
  });
  await sql`
    INSERT INTO focowiki.object_owners (
      public_id, knowledge_base_id, object_id, owner_kind,
      source_revision_public_id
    ) VALUES (
      ${createStorageVnextUploadIdentity(
        "live-owner",
        "document-maintenance",
        revisionPublicId,
        input.source.object_id
      )}, ${input.context.knowledgeBaseId}, ${input.source.object_id},
      'source_revision', ${revisionPublicId}
    ) ON CONFLICT DO NOTHING
  `;
  const updated = await sql<Array<{ source_file_public_id: string }>>`
    UPDATE focowiki.source_file_active_revisions
    SET current_source_revision_public_id = ${revisionPublicId},
        updated_at = ${acceptedAt}
    WHERE knowledge_base_id = ${input.context.knowledgeBaseId}
      AND source_file_public_id = ${input.source.source_file_public_id}
      AND current_source_revision_public_id = ${input.source.source_revision_public_id}
      AND active_source_revision_public_id = ${input.source.source_revision_public_id}
    RETURNING source_file_public_id
  `;
  if (updated.length !== 1) throw maintenanceError("source_revision_conflict");
}

async function readSemanticContract(
  sql: DatabaseClient,
  context: Context
): Promise<SemanticContract> {
  const adoption = context.checkpoint.semanticAdoption;
  if (adoption) {
    return contractFromTarget(
      createSemanticAdoptionCandidatePublicId(context),
      adoption.target,
      adoption.mode === "full" ? null : adoption.expectedPredecessorPublicId
    );
  }
  const rows = await sql<Array<{
    public_id: string;
    generation_model_configuration_public_id: string;
    generation_model_configuration_revision: number | string;
    embedding_configuration_revision_public_id: string;
    extraction_contract_version: string;
  }>>`
    SELECT generation.public_id,
           generation.generation_model_configuration_public_id,
           generation.generation_model_configuration_revision,
           contract.embedding_configuration_revision_public_id,
           generation.extraction_contract_version
    FROM focowiki.semantic_generations generation
    JOIN focowiki.semantic_projection_contracts contract
      ON contract.knowledge_base_id = generation.knowledge_base_id
     AND contract.semantic_generation_public_id = generation.public_id
    WHERE generation.knowledge_base_id = ${context.knowledgeBaseId}
      AND generation.generation_role = 'active'
      AND generation.state = 'active'
      AND generation.deleted_at IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw maintenanceError("semantic_contract_unavailable");
  return {
    generationPublicId: row.public_id,
    generationModelConfigurationPublicId:
      row.generation_model_configuration_public_id,
    generationModelConfigurationRevision:
      count(row.generation_model_configuration_revision),
    embeddingConfigurationRevisionPublicId:
      row.embedding_configuration_revision_public_id,
    semanticContractVersion: row.extraction_contract_version,
    reuseSemanticGenerationPublicId: row.public_id
  };
}

function contractFromTarget(
  generationPublicId: string,
  target: SemanticMaintenanceTarget,
  reuseSemanticGenerationPublicId: string | null
): SemanticContract {
  return {
    generationPublicId,
    generationModelConfigurationPublicId:
      target.generationModelConfigurationPublicId,
    generationModelConfigurationRevision:
      target.generationModelConfigurationRevision,
    embeddingConfigurationRevisionPublicId:
      target.embeddingConfigurationRevisionPublicId,
    semanticContractVersion: target.extractionContractVersion,
    reuseSemanticGenerationPublicId
  };
}

async function readSettingsRevision(sql: DatabaseClient, operationPublicId: string) {
  const rows = await sql<Array<{ settings_revision_public_id: string }>>`
    SELECT settings_revision_public_id
    FROM focowiki.operation_work_items
    WHERE operation_public_id = ${operationPublicId}
      AND work_kind = 'maintenance'
    LIMIT 1
  `;
  if (!rows[0]?.settings_revision_public_id) {
    throw maintenanceError("settings_revision_missing");
  }
  return rows[0].settings_revision_public_id;
}

async function readSelectedSearchProjection(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  providerKind: SearchProviderKind
) {
  const rows = await sql<Array<{ public_id: string }>>`
    SELECT public_id FROM focowiki.search_projections
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND provider_kind = ${providerKind}
      AND state IN ('active', 'preparing')
    LIMIT 1
  `;
  if (!rows[0]) throw maintenanceError("search_projection_missing");
  return rows[0].public_id;
}

function emptyPage() {
  return {
    scheduledCount: 0,
    processedBytes: 0,
    nextCursor: null,
    documentCount: 0
  };
}

function count(value: number | string): number {
  const result = Number(value);
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
