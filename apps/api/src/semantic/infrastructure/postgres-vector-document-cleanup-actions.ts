import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";

const ACTION_KIND = "semantic_vector_document_cleanup";
const RESOURCE_KIND = "semantic_vector_document";

type CleanupVectorRow = {
  public_id: string;
  provider_document_id: string;
  semantic_generation_public_id: string;
  source_revision_public_id: string;
  mapping_fingerprint_sha256: string;
  search_provider_kind: "meilisearch" | "opensearch";
};

export async function enqueueSemanticVectorDocumentCleanupActions(
  sql: TransactionSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    sourceRevisionPublicId: string;
    notBefore: string;
  }
): Promise<number> {
  validateInput(input);
  const vectors = await sql<CleanupVectorRow[]>`
    SELECT vector.public_id, vector.provider_document_id,
           vector.semantic_generation_public_id,
           vector.source_revision_public_id,
           contract.mapping_fingerprint_sha256,
           contract.search_provider_kind
    FROM focowiki.semantic_vector_documents vector
    JOIN focowiki.semantic_projection_contracts contract
      ON contract.knowledge_base_id = vector.knowledge_base_id
     AND contract.semantic_generation_public_id
       = vector.semantic_generation_public_id
     AND contract.public_id = vector.projection_contract_public_id
    WHERE vector.knowledge_base_id = ${input.knowledgeBaseId}
      AND vector.source_revision_public_id = ${input.sourceRevisionPublicId}
      AND vector.state IN ('candidate', 'active')
      AND vector.deleted_at IS NULL
    ORDER BY vector.public_id COLLATE "C"
  `;
  if (vectors.length === 0) return 0;
  return insertCleanupActions(sql, input, vectors);
}

export async function enqueueUnavailableSemanticVectorDocumentCleanupActions(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    sourceFilePublicIds: readonly string[];
    selectedProviderKind: SearchProviderKind;
    notBefore: string;
  }
): Promise<number> {
  validateSourceInput(input);
  const vectors = await sql<CleanupVectorRow[]>`
    SELECT vector.public_id, vector.provider_document_id,
           vector.semantic_generation_public_id,
           vector.source_revision_public_id,
           contract.mapping_fingerprint_sha256,
           contract.search_provider_kind
    FROM focowiki.semantic_vector_documents vector
    JOIN focowiki.semantic_projection_contracts contract
      ON contract.knowledge_base_id = vector.knowledge_base_id
     AND contract.semantic_generation_public_id
       = vector.semantic_generation_public_id
     AND contract.public_id = vector.projection_contract_public_id
    WHERE vector.knowledge_base_id = ${input.knowledgeBaseId}
      AND vector.source_file_public_id = ANY(${input.sourceFilePublicIds})
      AND contract.search_provider_kind <> ${input.selectedProviderKind}
      AND vector.state IN ('candidate', 'active')
      AND vector.deleted_at IS NULL
    ORDER BY vector.public_id COLLATE "C"
  `;
  if (vectors.length === 0) return 0;
  return insertCleanupActions(sql, input, vectors);
}

async function insertCleanupActions(
  sql: DatabaseClient | TransactionSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    notBefore: string;
  },
  vectors: readonly CleanupVectorRow[]
): Promise<number> {
  const actions = vectors.map((vector) => ({
    public_id: identity("action", input.operationPublicId, vector.public_id),
    operation_public_id: input.operationPublicId,
    knowledge_base_id: input.knowledgeBaseId,
    action_kind: ACTION_KIND,
    cleanup_plane: "search",
    search_provider_kind: vector.search_provider_kind,
    resource_kind: RESOURCE_KIND,
    resource_public_id: vector.public_id,
    required: true,
    sequence_number: 20,
    idempotency_key: identity(
      "idempotency",
      input.operationPublicId,
      vector.public_id
    ),
    request_hash: digest([
      input.knowledgeBaseId,
      input.operationPublicId,
      vector.source_revision_public_id,
      vector.semantic_generation_public_id,
      vector.provider_document_id
    ]),
    checkpoint: {
      semanticGenerationPublicId: vector.semantic_generation_public_id,
      mappingFingerprintSha256: vector.mapping_fingerprint_sha256,
      ...(vector.provider_document_id === vector.public_id
        ? {}
        : { providerDocumentId: vector.provider_document_id })
    },
    state: "queued",
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at: null,
    safe_error_code: null,
    not_before: input.notBefore
  }));
  const inserted = await sql<Array<{ public_id: string }>>`
    INSERT INTO focowiki.cleanup_actions ${sql(
      actions,
      "public_id", "operation_public_id", "knowledge_base_id", "action_kind",
      "cleanup_plane", "search_provider_kind", "resource_kind",
      "resource_public_id", "required", "sequence_number",
      "idempotency_key", "request_hash", "checkpoint", "state",
      "attempt_count", "lease_owner", "lease_expires_at", "safe_error_code",
      "not_before"
    )}
    ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
    RETURNING public_id
  `;
  return inserted.length;
}

function identity(
  kind: string,
  operationPublicId: string,
  vectorPublicId: string
): string {
  return `semantic-vector-cleanup-${kind}-${digest([
    operationPublicId,
    vectorPublicId
  ])}`;
}

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256").update(
    "semantic-vector-document-cleanup-v1"
  );
  for (const part of parts) hash.update("\0").update(part);
  return hash.digest("hex");
}

function validateInput(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  sourceRevisionPublicId: string;
  notBefore: string;
}): void {
  if (
    !input.knowledgeBaseId
    || !input.operationPublicId
    || !input.sourceRevisionPublicId
    || !Number.isFinite(Date.parse(input.notBefore))
  ) throw new Error("Semantic vector cleanup action input is invalid");
}

function validateSourceInput(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  sourceFilePublicIds: readonly string[];
  selectedProviderKind: SearchProviderKind;
  notBefore: string;
}): void {
  if (
    !input.knowledgeBaseId
    || !input.operationPublicId
    || input.sourceFilePublicIds.length < 1
    || input.sourceFilePublicIds.length > 1_000
    || input.sourceFilePublicIds.some((value) =>
      !value || Buffer.byteLength(value) > 255)
    || !["meilisearch", "opensearch"].includes(input.selectedProviderKind)
    || !Number.isFinite(Date.parse(input.notBefore))
  ) throw new Error("Semantic vector cleanup source input is invalid");
}
