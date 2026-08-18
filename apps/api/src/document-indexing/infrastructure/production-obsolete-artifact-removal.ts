import { createHash } from "node:crypto";
import type { RuntimeConfig } from "../../config.js";
import type { DatabaseClient } from "../../db/client.js";
import { createRuntimeSearchProvider } from "../../runtime/search-provider.js";
import { createRuntimeSettingsDefaults } from "../../runtime-settings/validation.js";
import { semanticVectorIndexUid } from
  "../../semantic/vector/projection-planner.js";
import { createStorageVnextVersionAwareObjectDeletion } from
  "../../storage-vnext/ownership/version-aware-deletion.js";
import type { DocumentObsoleteCleanupAction } from
  "../application/document-obsolete-artifact-cleanup.js";

export async function removeProductionDocumentObsoleteArtifact(input: {
  sql: DatabaseClient;
  config: RuntimeConfig;
  search: ReturnType<typeof createRuntimeSearchProvider> | null;
  objectDeletion: ReturnType<typeof createStorageVnextVersionAwareObjectDeletion>;
  action: DocumentObsoleteCleanupAction;
}): Promise<void> {
  if (input.action.plane === "object_storage") {
    await input.sql`
      DELETE FROM focowiki.generated_page_candidates candidate
      WHERE candidate.knowledge_base_id = ${input.action.knowledgeBaseId}
        AND candidate.object_id = ${input.action.resourcePublicId}
        AND candidate.state = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM focowiki.generated_page_heads head
          WHERE head.knowledge_base_id = candidate.knowledge_base_id
            AND head.page_candidate_public_id = candidate.public_id
        )
    `;
    await input.objectDeletion.deleteZeroOwner(input.action.resourcePublicId);
    return;
  }
  if (!input.search || !input.config.search) {
    throw productionObsoleteArtifactError("search_provider_unavailable");
  }
  if (input.action.searchProviderKind !== input.config.search.provider) {
    throw productionObsoleteArtifactError("search_provider_mismatch");
  }
  if (input.action.plane === "search") {
    const rows = await input.sql<Array<{
      provider_index_uid: string;
      provider_document_id: string;
    }>>`
      SELECT projection.provider_index_uid, owner.provider_document_id
      FROM focowiki.search_document_owners owner
      JOIN focowiki.search_projections projection
        ON projection.knowledge_base_id = owner.knowledge_base_id
       AND projection.public_id = owner.search_projection_public_id
      WHERE owner.knowledge_base_id = ${input.action.knowledgeBaseId}
        AND owner.source_revision_public_id
          = ${input.action.sourceRevisionPublicId}
        AND owner.provider_document_id = ${input.action.resourcePublicId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return;
    await awaitSearchReceipt(input.search, await input.search.write.deleteDocuments({
      indexUid: row.provider_index_uid,
      documentIds: [row.provider_document_id],
      correlation: cleanupCorrelation(input.action.publicId)
    }), input.config);
    await input.sql`
      DELETE FROM focowiki.search_document_owners
      WHERE knowledge_base_id = ${input.action.knowledgeBaseId}
        AND source_revision_public_id = ${input.action.sourceRevisionPublicId}
        AND provider_document_id = ${row.provider_document_id}
    `;
    return;
  }
  const rows = await input.sql<Array<{
    semantic_generation_public_id: string;
    provider_document_id: string;
    mapping_fingerprint_sha256: string;
  }>>`
    SELECT document.semantic_generation_public_id,
           document.provider_document_id,
           contract.mapping_fingerprint_sha256
    FROM focowiki.semantic_vector_documents document
    JOIN focowiki.semantic_projection_contracts contract
      ON contract.public_id = document.projection_contract_public_id
    WHERE document.knowledge_base_id = ${input.action.knowledgeBaseId}
      AND document.source_revision_public_id
        = ${input.action.sourceRevisionPublicId}
      AND document.public_id = ${input.action.resourcePublicId}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return;
  if (!input.search.vector) {
    throw productionObsoleteArtifactError("vector_provider_unavailable");
  }
  const indexUid = semanticVectorIndexUid({
    indexPrefix: input.config.search.indexPrefix,
    knowledgeBaseId: input.action.knowledgeBaseId,
    semanticGenerationPublicId: row.semantic_generation_public_id,
    mappingFingerprintSha256: row.mapping_fingerprint_sha256
  });
  await awaitVectorReceipt(input.search, await input.search.vector.deleteDocuments({
    indexUid,
    knowledgeBaseId: input.action.knowledgeBaseId,
    semanticGenerationPublicId: row.semantic_generation_public_id,
    documentIds: [row.provider_document_id],
    correlation: cleanupCorrelation(input.action.publicId)
  }), input.config);
  await input.sql`
    UPDATE focowiki.semantic_vector_documents
    SET state = 'deleted', deleted_at = now()
    WHERE knowledge_base_id = ${input.action.knowledgeBaseId}
      AND semantic_generation_public_id = ${row.semantic_generation_public_id}
      AND public_id = ${input.action.resourcePublicId}
  `;
}

async function awaitSearchReceipt(
  provider: ReturnType<typeof createRuntimeSearchProvider>,
  receipt: Awaited<ReturnType<typeof provider.write.deleteDocuments>>,
  config: RuntimeConfig
): Promise<void> {
  if (receipt.state === "completed") return;
  await pollReceipt(
    () => provider.operations.getOperation({ operationRef: receipt.operationRef }),
    config
  );
}

async function awaitVectorReceipt(
  provider: ReturnType<typeof createRuntimeSearchProvider>,
  receipt: Awaited<ReturnType<NonNullable<typeof provider.vector>["deleteDocuments"]>>,
  config: RuntimeConfig
): Promise<void> {
  if (receipt.state === "completed") return;
  if (!provider.vector) {
    throw productionObsoleteArtifactError("vector_provider_unavailable");
  }
  await pollReceipt(
    () => provider.vector!.getOperation({ operationRef: receipt.operationRef }),
    config
  );
}

async function pollReceipt(
  read: () => Promise<{ state: "pending" | "completed" } | {
    state: "failed"; errorCode: string;
  }>,
  config: RuntimeConfig
): Promise<void> {
  const settings = createRuntimeSettingsDefaults(config).search;
  const deadline = Date.now() + settings.taskTimeoutMs;
  while (Date.now() < deadline) {
    const status = await read();
    if (status.state === "completed") return;
    if (status.state === "failed") {
      throw productionObsoleteArtifactError(status.errorCode);
    }
    await new Promise((resolve) => setTimeout(resolve, settings.taskPollIntervalMs));
  }
  throw productionObsoleteArtifactError("search_operation_timeout");
}

function cleanupCorrelation(value: string): string {
  return `document-cleanup-${createHash("sha256").update(value).digest("hex")}`;
}

function productionObsoleteArtifactError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Production background error: ${code}`), { code });
}
