import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { normalizeSourceRelativePath } from "../../domain/source-path.js";
import { createDocumentSourceRevisionPublicId } from
  "../domain/source-revision-identity.js";
import { createStorageVnextUploadIdentity } from
  "../../storage-vnext/upload/identity.js";
import { createDocumentJobPublicId } from
  "../domain/document-job-identity.js";
import { documentFixedWorkInputFingerprints } from
  "../domain/document-fixed-work-identity.js";
import { createPostgresDocumentJobRepository } from
  "./postgres-document-job-repository.js";
import { readDocumentSemanticContract } from
  "./postgres-document-semantic-contract.js";
import { enqueuePostgresDocumentWebhookEvent } from
  "./postgres-document-webhook-event.js";
import type { DirectoryMoveClaim } from
  "./postgres-document-directory-move-support.js";

type DirectoryMoveSource = {
  public_id: string;
  directory_public_id: string | null;
  logical_path: string;
  normalized_path: string;
  title: string;
  metadata: Record<string, unknown>;
  revision: number | string;
  active_source_revision_public_id: string;
  object_id: string;
  checksum_sha256: string;
  byte_count: number | string;
  content_type: string;
};

export async function readSourcePage(
  sql: TransactionSql,
  claimed: DirectoryMoveClaim,
  limit: number
): Promise<DirectoryMoveSource[]> {
  return sql<DirectoryMoveSource[]>`
    WITH RECURSIVE subtree AS (
      SELECT public_id FROM focowiki.source_directories
      WHERE knowledge_base_id = ${claimed.knowledgeBaseId}
        AND public_id = ${claimed.checkpoint.sourceDirectoryPublicId}
        AND deleted_at IS NULL
      UNION ALL
      SELECT child.public_id
      FROM focowiki.source_directories child
      JOIN subtree parent ON child.parent_public_id = parent.public_id
      WHERE child.knowledge_base_id = ${claimed.knowledgeBaseId}
        AND child.deleted_at IS NULL
    )
    SELECT source.public_id, source.directory_public_id,
           source.logical_path, source.normalized_path,
           source.title, source.metadata, source.revision,
           active.active_source_revision_public_id,
           revision.object_id, revision.checksum_sha256,
           revision.byte_count, revision.content_type
    FROM focowiki.source_files source
    JOIN subtree ON subtree.public_id = source.directory_public_id
    JOIN focowiki.source_file_active_revisions active
      ON active.knowledge_base_id = source.knowledge_base_id
     AND active.source_file_public_id = source.public_id
     AND active.active_source_revision_public_id IS NOT NULL
    JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = active.knowledge_base_id
     AND revision.source_file_public_id = active.source_file_public_id
     AND revision.public_id = active.active_source_revision_public_id
     AND revision.deleted_at IS NULL
    WHERE source.knowledge_base_id = ${claimed.knowledgeBaseId}
      AND source.deleted_at IS NULL
      AND source.public_id > ${claimed.checkpoint.cursorSourceFilePublicId ?? ""}
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.document_processing_jobs job
        WHERE job.knowledge_base_id = source.knowledge_base_id
          AND job.operation_public_id = ${claimed.operationPublicId}
          AND job.source_file_public_id = source.public_id
      )
    ORDER BY source.public_id COLLATE "C"
    LIMIT ${limit}
    FOR UPDATE OF source, active
  `;
}

export async function stageSourcePage(
  sql: TransactionSql,
  claimed: DirectoryMoveClaim,
  sources: readonly DirectoryMoveSource[],
  now: string
): Promise<void> {
  const semantic = await readDocumentSemanticContract(sql, claimed.knowledgeBaseId);
  for (const source of sources) {
    const suffix = source.logical_path.slice(
      claimed.checkpoint.sourceLogicalPath.length
    );
    const path = normalizeSourceRelativePath(
      `${claimed.checkpoint.destinationLogicalPath}${suffix}`
    );
    const sourceRevisionPublicId = createDocumentSourceRevisionPublicId({
      knowledgeBaseId: claimed.knowledgeBaseId,
      sourceFilePublicId: source.public_id,
      checksum: source.checksum_sha256,
      variant: `presentation:${path.pathKey}`
    });
    const documentJobPublicId = createDocumentJobPublicId({
      knowledgeBaseId: claimed.knowledgeBaseId,
      sourceRevisionPublicId
    });
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type, created_at
      ) VALUES (
        ${sourceRevisionPublicId}, ${claimed.knowledgeBaseId}, ${source.public_id},
        ${source.object_id}, ${source.checksum_sha256}, ${Number(source.byte_count)},
        ${source.content_type}, ${now}
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revision_presentations (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        directory_public_id, logical_path, normalized_path, title, metadata,
        created_at
      ) VALUES (
        ${claimed.knowledgeBaseId}, ${source.public_id}, ${sourceRevisionPublicId},
        ${source.directory_public_id}, ${path.relativePath}, ${path.pathKey},
        ${source.title}, ${sql.json(source.metadata as never)}, ${now}
      )
    `;
    await sql`
      UPDATE focowiki.source_files
      SET revision = revision + 1, updated_at = ${now}
      WHERE knowledge_base_id = ${claimed.knowledgeBaseId}
        AND public_id = ${source.public_id}
        AND revision = ${Number(source.revision)}
    `;
    await sql`
      UPDATE focowiki.source_file_active_revisions
      SET current_source_revision_public_id = ${sourceRevisionPublicId},
          updated_at = ${now}
      WHERE knowledge_base_id = ${claimed.knowledgeBaseId}
        AND source_file_public_id = ${source.public_id}
        AND active_source_revision_public_id = ${source.active_source_revision_public_id}
    `;
    const settings = await sql<Array<{ settings_revision_public_id: string }>>`
      SELECT settings_revision_public_id
      FROM focowiki.operation_work_items
      WHERE operation_public_id = ${claimed.operationPublicId}
        AND work_kind = 'mutation'
      LIMIT 1
    `;
    const settingsRevisionPublicId = settings[0]?.settings_revision_public_id;
    if (!settingsRevisionPublicId) {
      throw new Error("Directory move settings revision is unavailable");
    }
    const generationModelConfigurationRevision = Number(
      semantic.generation_model_configuration_revision
    );
    await createPostgresDocumentJobRepository(
      sql as unknown as DatabaseClient
    ).create({
      publicId: documentJobPublicId,
      knowledgeBaseId: claimed.knowledgeBaseId,
      operationPublicId: claimed.operationPublicId,
      sourceFilePublicId: source.public_id,
      sourceRevisionPublicId,
      runtimeSettingsRevisionPublicId: settingsRevisionPublicId,
      generationModelConfigurationPublicId:
        semantic.generation_model_configuration_public_id,
      generationModelConfigurationRevision,
      embeddingConfigurationRevisionPublicId:
        semantic.embedding_configuration_revision_public_id,
      semanticGenerationPublicId: semantic.semantic_generation_public_id,
      semanticContractVersion: semantic.semantic_contract_version,
      maximumAttempts: claimed.checkpoint.maximumAttempts,
      acceptedAt: now,
      inputFingerprints: documentFixedWorkInputFingerprints({
        sourceChecksumSha256: source.checksum_sha256,
        runtimeSettingsRevisionPublicId: settingsRevisionPublicId,
        generationModelConfigurationPublicId:
          semantic.generation_model_configuration_public_id,
        generationModelConfigurationRevision,
        embeddingConfigurationRevisionPublicId:
          semantic.embedding_configuration_revision_public_id,
        semanticContractVersion: semantic.semantic_contract_version
      })
    });
    await enqueuePostgresDocumentWebhookEvent(sql, {
      documentJobPublicId,
      documentJobRevision: 0,
      knowledgeBaseId: claimed.knowledgeBaseId,
      operationPublicId: claimed.operationPublicId,
      sourceFilePublicId: source.public_id,
      eventType: "document.waiting",
      state: "waiting",
      occurredAt: now,
      expiresAt: claimed.checkpoint.resultExpiresAt
    });
    await sql`
      INSERT INTO focowiki.object_owners (
        public_id, knowledge_base_id, object_id, owner_kind,
        source_revision_public_id
      ) VALUES (
        ${createStorageVnextUploadIdentity(
          "live-owner", "directory-move", sourceRevisionPublicId,
          source.object_id
        )}, ${claimed.knowledgeBaseId}, ${source.object_id}, 'source_revision',
        ${sourceRevisionPublicId}
      )
    `;
    await sql`
      UPDATE focowiki.object_registrations
      SET zero_owner_since = NULL
      WHERE object_id = ${source.object_id}
    `;
  }
}
