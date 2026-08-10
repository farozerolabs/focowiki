import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import { semanticContractFingerprint } from
  "../../semantic/application/adoption.js";
import type { SemanticMaintenanceTarget } from
  "../../semantic/domain/contracts.js";
import type { StorageVnextKnowledgeBaseFact } from
  "../catalog/ports.js";

type KnowledgeBaseRow = {
  public_id: string;
  name: string;
  description: string | null;
  revision: number | string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

export type StorageVnextKnowledgeBaseCreationPort = {
  create(input: {
    publicId: string;
    name: string;
    description: string | null;
  }): Promise<StorageVnextKnowledgeBaseFact>;
};

export function createPostgresKnowledgeBaseCreation(input: {
  sql: DatabaseClient;
  resolveSemanticTarget(
    knowledgeBaseId: string
  ): Promise<SemanticMaintenanceTarget | null>;
  clock?: () => string;
}): StorageVnextKnowledgeBaseCreationPort {
  const clock = input.clock ?? (() => new Date().toISOString());
  return {
    async create(request) {
      assertCreationRequest(request);
      const target = await input.resolveSemanticTarget(request.publicId);
      if (target && target.knowledgeBaseId !== request.publicId) {
        throw creationError("semantic_target_scope_conflict");
      }
      const createdAt = clock();
      assertTimestamp(createdAt);
      return input.sql.begin(async (transaction) => {
        const rows = await transaction<KnowledgeBaseRow[]>`
          INSERT INTO focowiki.knowledge_bases
            (public_id, name, description, revision, created_at, updated_at)
          VALUES (
            ${request.publicId}, ${request.name}, ${request.description}, 1,
            ${createdAt}, ${createdAt}
          )
          RETURNING public_id, name, description, revision,
                    created_at, updated_at, deleted_at
        `;
        const row = rows[0];
        if (!row) throw creationError("knowledge_base_create_conflict");
        if (target) {
          const fingerprint = semanticContractFingerprint(target);
          const identity = emptyContractIdentity(request.publicId, fingerprint);
          await transaction`
            INSERT INTO focowiki.operations (
              public_id, knowledge_base_id, operation_kind, state,
              expected_resource_revision, target_kind, target_public_id,
              completed_at, created_at, updated_at
            ) VALUES (
              ${identity.operationPublicId}, ${request.publicId},
              'semantic_contract_bootstrap', 'completed', NULL,
              'knowledge_base', ${request.publicId}, ${createdAt},
              ${createdAt}, ${createdAt}
            )
          `;
          await transaction`
            INSERT INTO focowiki.semantic_generations (
              public_id, knowledge_base_id, operation_public_id,
              expected_predecessor_public_id, generation_role, state,
              generation_model_configuration_public_id,
              generation_model_configuration_revision,
              extraction_contract_version, graph_schema_version,
              prompt_contract_version, contract_fingerprint_sha256,
              revision, created_at, activated_at
            ) VALUES (
              ${identity.generationPublicId}, ${request.publicId},
              ${identity.operationPublicId}, NULL, 'active', 'active',
              ${target.generationModelConfigurationPublicId},
              ${target.generationModelConfigurationRevision},
              ${target.extractionContractVersion}, ${target.graphSchemaVersion},
              ${target.promptContractVersion}, ${fingerprint}, 1,
              ${createdAt}, ${createdAt}
            )
          `;
          await transaction`
            INSERT INTO focowiki.semantic_projection_contracts (
              public_id, knowledge_base_id, semantic_generation_public_id,
              embedding_configuration_revision_public_id,
              embedding_query_policy_revision_public_id,
              minimum_vector_relevance, search_provider_kind,
              resolved_dimension, normalization, artifact_schema_version,
              vector_schema_version, mapping_fingerprint_sha256, created_at
            ) VALUES (
              ${`semantic-contract-${identity.generationPublicId}`},
              ${request.publicId}, ${identity.generationPublicId},
              ${target.embeddingConfigurationRevisionPublicId},
              ${target.embeddingQueryPolicyRevisionPublicId},
              ${target.minimumVectorRelevance},
              ${target.searchProviderKind}, ${target.resolvedDimension},
              ${target.normalization}, ${target.artifactSchemaVersion},
              ${target.vectorSchemaVersion},
              ${target.mappingFingerprintSha256}, ${createdAt}
            )
          `;
        }
        return mapKnowledgeBase(row);
      });
    }
  };
}

function emptyContractIdentity(
  knowledgeBaseId: string,
  contractFingerprintSha256: string
): { operationPublicId: string; generationPublicId: string } {
  const digest = createHash("sha256")
    .update(`${knowledgeBaseId}\u001f${contractFingerprintSha256}`)
    .digest("hex");
  return {
    operationPublicId: `semantic-contract-bootstrap-${digest}`,
    generationPublicId: `semantic-generation-${digest}`
  };
}

function mapKnowledgeBase(row: KnowledgeBaseRow): StorageVnextKnowledgeBaseFact {
  return {
    publicId: row.public_id,
    name: row.name,
    description: row.description,
    revision: Number(row.revision),
    visibility: row.deleted_at ? "deleted" : "current",
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function assertCreationRequest(input: {
  publicId: string;
  name: string;
  description: string | null;
}): void {
  if (
    !input.publicId || Buffer.byteLength(input.publicId) > 255
    || !input.name || Buffer.byteLength(input.name) > 255
    || (input.description !== null
      && Buffer.byteLength(input.description) > 16_384)
  ) throw creationError("invalid_input");
}

function assertTimestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw creationError("invalid_clock");
  }
}

function creationError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Knowledge-base creation error: ${code}`),
    { code }
  );
}
