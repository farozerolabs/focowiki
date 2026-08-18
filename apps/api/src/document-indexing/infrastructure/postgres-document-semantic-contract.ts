import type { TransactionSql } from "postgres";

export type DocumentSemanticContractRow = {
  semantic_generation_public_id: string;
  generation_model_configuration_public_id: string;
  generation_model_configuration_revision: number | string;
  embedding_configuration_revision_public_id: string;
  semantic_contract_version: string;
};

export async function readDocumentSemanticContract(
  sql: TransactionSql,
  knowledgeBaseId: string
): Promise<DocumentSemanticContractRow> {
  const rows = await sql<DocumentSemanticContractRow[]>`
    SELECT generation.public_id AS semantic_generation_public_id,
           generation.generation_model_configuration_public_id,
           generation.generation_model_configuration_revision,
           contract.embedding_configuration_revision_public_id,
           generation.contract_fingerprint_sha256 AS semantic_contract_version
    FROM focowiki.semantic_generations generation
    JOIN focowiki.semantic_projection_contracts contract
      ON contract.knowledge_base_id = generation.knowledge_base_id
     AND contract.semantic_generation_public_id = generation.public_id
    WHERE generation.knowledge_base_id = ${knowledgeBaseId}
      AND generation.generation_role = 'active'
      AND generation.state = 'active'
      AND generation.deleted_at IS NULL
    LIMIT 1
  `;
  const row = rows[0];
  const modelRevision = Number(row?.generation_model_configuration_revision);
  if (!row || !Number.isSafeInteger(modelRevision) || modelRevision < 1) {
    throw Object.assign(
      new Error("Document processing requires active generation and embedding models"),
      { code: "DOCUMENT_PROCESSING_CONFIGURATION_REQUIRED" }
    );
  }
  return row;
}
