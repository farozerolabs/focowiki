import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { SemanticMaintenanceTarget } from "../domain/contracts.js";
import { semanticContractFingerprint } from
  "../domain/maintenance-contract.js";

type ActiveContractRow = {
  generation_public_id: string;
  contract_public_id: string | null;
};

export async function ensurePostgresSemanticContractBootstrap(
  transaction: TransactionSql,
  input: {
    knowledgeBaseId: string;
    target: SemanticMaintenanceTarget;
    createdAt: string;
  }
): Promise<"created" | "existing"> {
  if (input.target.knowledgeBaseId !== input.knowledgeBaseId) {
    throw bootstrapError("semantic_target_scope_conflict");
  }
  const knowledgeBases = await transaction<Array<{ public_id: string }>>`
    SELECT public_id
    FROM focowiki.knowledge_bases
    WHERE public_id = ${input.knowledgeBaseId}
      AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (!knowledgeBases[0]) throw bootstrapError("knowledge_base_missing");

  const active = await transaction<ActiveContractRow[]>`
    SELECT generation.public_id AS generation_public_id,
           contract.public_id AS contract_public_id
    FROM focowiki.semantic_generations generation
    LEFT JOIN focowiki.semantic_projection_contracts contract
      ON contract.knowledge_base_id = generation.knowledge_base_id
     AND contract.semantic_generation_public_id = generation.public_id
    WHERE generation.knowledge_base_id = ${input.knowledgeBaseId}
      AND generation.generation_role = 'active'
      AND generation.state = 'active'
      AND generation.deleted_at IS NULL
    LIMIT 1
  `;
  if (active[0]) {
    if (!active[0].contract_public_id) {
      throw bootstrapError("semantic_contract_incomplete");
    }
    return "existing";
  }

  const fingerprint = semanticContractFingerprint(input.target);
  const identity = contractIdentity(input.knowledgeBaseId, fingerprint);
  await transaction`
    INSERT INTO focowiki.operations (
      public_id, knowledge_base_id, operation_kind, state,
      expected_resource_revision, target_kind, target_public_id,
      completed_at, created_at, updated_at
    ) VALUES (
      ${identity.operationPublicId}, ${input.knowledgeBaseId},
      'semantic_contract_bootstrap', 'completed', NULL,
      'knowledge_base', ${input.knowledgeBaseId}, ${input.createdAt},
      ${input.createdAt}, ${input.createdAt}
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
      ${identity.generationPublicId}, ${input.knowledgeBaseId},
      ${identity.operationPublicId}, NULL, 'active', 'active',
      ${input.target.generationModelConfigurationPublicId},
      ${input.target.generationModelConfigurationRevision},
      ${input.target.extractionContractVersion},
      ${input.target.graphSchemaVersion},
      ${input.target.promptContractVersion}, ${fingerprint}, 1,
      ${input.createdAt}, ${input.createdAt}
    )
  `;
  await transaction`
    INSERT INTO focowiki.semantic_projection_contracts (
      public_id, knowledge_base_id, semantic_generation_public_id,
      embedding_configuration_revision_public_id,
      search_provider_kind,
      resolved_dimension, normalization, artifact_schema_version,
      vector_schema_version, mapping_fingerprint_sha256, created_at
    ) VALUES (
      ${`semantic-contract-${identity.generationPublicId}`},
      ${input.knowledgeBaseId}, ${identity.generationPublicId},
      ${input.target.embeddingConfigurationRevisionPublicId},
      ${input.target.searchProviderKind}, ${input.target.resolvedDimension},
      ${input.target.normalization}, ${input.target.artifactSchemaVersion},
      ${input.target.vectorSchemaVersion},
      ${input.target.mappingFingerprintSha256}, ${input.createdAt}
    )
  `;
  return "created";
}

function contractIdentity(
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

function bootstrapError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Semantic contract bootstrap failed: ${code}`),
    { code }
  );
}
