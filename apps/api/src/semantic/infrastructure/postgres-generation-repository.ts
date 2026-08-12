import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type {
  SemanticActiveProjectionRecord,
  SemanticGenerationRecord,
  SemanticGenerationRepositoryPort
} from "../application/ports.js";
import { cloneSemanticGenerationFacts } from
  "./postgres-generation-fact-cloner.js";

type GenerationRow = {
  public_id: string;
  knowledge_base_id: string;
  operation_public_id: string;
  expected_predecessor_public_id: string | null;
  generation_role: SemanticGenerationRecord["role"];
  state: SemanticGenerationRecord["state"];
  contract_fingerprint_sha256: string;
  revision: number | string;
};

type ActiveProjectionRow = GenerationRow & {
  generation_model_configuration_public_id: string;
  generation_model_configuration_revision: number | string;
  extraction_contract_version: string;
  graph_schema_version: string;
  prompt_contract_version: string;
  projection_contract_public_id: string;
  embedding_configuration_revision_public_id: string;
  embedding_query_policy_revision_public_id: string;
  minimum_vector_relevance: number;
  search_provider_kind: "meilisearch" | "opensearch";
  resolved_dimension: number;
  normalization: "none" | "l2";
  artifact_schema_version: string;
  vector_schema_version: string;
  mapping_fingerprint_sha256: string;
};

export type SemanticGenerationRepositoryErrorCode =
  | "candidate_conflict"
  | "candidate_missing"
  | "fact_clone_conflict"
  | "invalid_input"
  | "knowledge_base_missing"
  | "predecessor_conflict"
  | "revision_conflict";

export class SemanticGenerationRepositoryError extends Error {
  public constructor(public readonly code: SemanticGenerationRepositoryErrorCode) {
    super(`Semantic generation repository error: ${code}`);
    this.name = "SemanticGenerationRepositoryError";
  }
}

export function createPostgresSemanticGenerationRepository(
  sql: DatabaseClient
): SemanticGenerationRepositoryPort {
  return {
    async createCandidate(input) {
      assertCreateInput(input);
      return sql.begin(async (transaction) => {
        await lockKnowledgeBase(transaction, input.target.knowledgeBaseId);
        const active = await readActive(transaction, input.target.knowledgeBaseId, true);
        if ((active?.public_id ?? null) !== input.expectedPredecessorPublicId) {
          throw repositoryError("predecessor_conflict");
        }
        const liveCandidates = await transaction<Array<{ public_id: string }>>`
          SELECT public_id
          FROM focowiki.semantic_generations
          WHERE knowledge_base_id = ${input.target.knowledgeBaseId}
            AND generation_role = 'candidate'
            AND state IN ('building', 'validating', 'ready')
            AND deleted_at IS NULL
          FOR UPDATE
        `;
        if (liveCandidates[0]) throw repositoryError("candidate_conflict");
        const rows = await transaction<GenerationRow[]>`
          INSERT INTO focowiki.semantic_generations (
            public_id, knowledge_base_id, operation_public_id,
            expected_predecessor_public_id, generation_role, state,
            generation_model_configuration_public_id,
            generation_model_configuration_revision,
            extraction_contract_version, graph_schema_version,
            prompt_contract_version, contract_fingerprint_sha256, revision
          ) VALUES (
            ${input.candidatePublicId}, ${input.target.knowledgeBaseId},
            ${input.operationPublicId}, ${input.expectedPredecessorPublicId},
            'candidate', 'building',
            ${input.target.generationModelConfigurationPublicId},
            ${input.target.generationModelConfigurationRevision},
            ${input.target.extractionContractVersion},
            ${input.target.graphSchemaVersion}, ${input.target.promptContractVersion},
            ${input.contractFingerprintSha256}, 0
          )
          RETURNING public_id, knowledge_base_id, operation_public_id,
                    expected_predecessor_public_id, generation_role, state,
                    contract_fingerprint_sha256, revision
        `;
        const row = rows[0];
        if (!row) throw repositoryError("candidate_conflict");
        await transaction`
          INSERT INTO focowiki.semantic_projection_contracts (
            public_id, knowledge_base_id, semantic_generation_public_id,
            embedding_configuration_revision_public_id,
            embedding_query_policy_revision_public_id,
            minimum_vector_relevance, search_provider_kind,
            resolved_dimension, normalization, artifact_schema_version,
            vector_schema_version, mapping_fingerprint_sha256
          ) VALUES (
            ${`semantic-contract-${input.candidatePublicId}`},
            ${input.target.knowledgeBaseId}, ${input.candidatePublicId},
            ${input.target.embeddingConfigurationRevisionPublicId},
            ${input.target.embeddingQueryPolicyRevisionPublicId},
            ${input.target.minimumVectorRelevance},
            ${input.target.searchProviderKind}, ${input.target.resolvedDimension},
            ${input.target.normalization}, ${input.target.artifactSchemaVersion},
            ${input.target.vectorSchemaVersion}, ${input.target.mappingFingerprintSha256}
          )
        `;
        return mapGeneration(row);
      }).catch(mapDatabaseError);
    },

    async getActive(knowledgeBaseId) {
      assertIdentity(knowledgeBaseId);
      const row = await readActive(sql, knowledgeBaseId, false);
      return row ? mapGeneration(row) : null;
    },

    async getActiveProjection(knowledgeBaseId) {
      assertIdentity(knowledgeBaseId);
      const rows = await sql<ActiveProjectionRow[]>`
        SELECT generation.public_id, generation.knowledge_base_id,
               generation.operation_public_id,
               generation.expected_predecessor_public_id,
               generation.generation_role, generation.state,
               generation.contract_fingerprint_sha256, generation.revision,
               generation.generation_model_configuration_public_id,
               generation.generation_model_configuration_revision,
               generation.extraction_contract_version,
               generation.graph_schema_version,
               generation.prompt_contract_version,
               contract.public_id AS projection_contract_public_id,
               contract.embedding_configuration_revision_public_id,
               contract.embedding_query_policy_revision_public_id,
               contract.minimum_vector_relevance,
               contract.search_provider_kind, contract.resolved_dimension,
               contract.normalization, contract.artifact_schema_version,
               contract.vector_schema_version,
               contract.mapping_fingerprint_sha256
        FROM focowiki.semantic_generations generation
        JOIN focowiki.semantic_projection_contracts contract
          ON contract.knowledge_base_id = generation.knowledge_base_id
         AND contract.semantic_generation_public_id = generation.public_id
        JOIN focowiki.knowledge_bases knowledge_base
          ON knowledge_base.public_id = generation.knowledge_base_id
         AND knowledge_base.deleted_at IS NULL
        WHERE generation.knowledge_base_id = ${knowledgeBaseId}
          AND generation.generation_role = 'active'
          AND generation.state = 'active'
          AND generation.deleted_at IS NULL
        LIMIT 1
      `;
      return rows[0] ? mapActiveProjection(rows[0]) : null;
    },

    async cloneReusableFacts(input) {
      assertIdentity(input.knowledgeBaseId);
      assertIdentity(input.predecessorPublicId);
      assertIdentity(input.candidatePublicId);
      if (input.predecessorPublicId === input.candidatePublicId) {
        throw repositoryError("fact_clone_conflict");
      }
      return sql.begin(async (transaction) => {
        await lockKnowledgeBase(transaction, input.knowledgeBaseId);
        const compatible = await transaction<Array<{
          candidate_public_id: string;
        }>>`
          SELECT candidate.public_id AS candidate_public_id
          FROM focowiki.semantic_generations candidate
          JOIN focowiki.semantic_generations predecessor
            ON predecessor.knowledge_base_id = candidate.knowledge_base_id
           AND predecessor.public_id = ${input.predecessorPublicId}
           AND predecessor.generation_role = 'active'
           AND predecessor.state = 'active'
           AND predecessor.deleted_at IS NULL
          WHERE candidate.knowledge_base_id = ${input.knowledgeBaseId}
            AND candidate.public_id = ${input.candidatePublicId}
            AND candidate.expected_predecessor_public_id
              = predecessor.public_id
            AND candidate.generation_role = 'candidate'
            AND candidate.state = 'building'
            AND candidate.deleted_at IS NULL
            AND candidate.generation_model_configuration_public_id
              = predecessor.generation_model_configuration_public_id
            AND candidate.generation_model_configuration_revision
              = predecessor.generation_model_configuration_revision
            AND candidate.extraction_contract_version
              = predecessor.extraction_contract_version
            AND candidate.graph_schema_version = predecessor.graph_schema_version
            AND candidate.prompt_contract_version
              = predecessor.prompt_contract_version
          FOR UPDATE OF candidate, predecessor
        `;
        if (!compatible[0]) throw repositoryError("fact_clone_conflict");
        const result = await cloneSemanticGenerationFacts(transaction, input);
        if (!result.complete) throw repositoryError("fact_clone_conflict");
        return {
          sourceCount: result.sourceCount,
          factCount: result.factCount
        };
      }).catch(mapDatabaseError);
    },

    async adoptQueryPolicy(input) {
      if (!Number.isFinite(input.minimumVectorRelevance)
        || input.minimumVectorRelevance < 0
        || input.minimumVectorRelevance > 1) {
        throw repositoryError("invalid_input");
      }
      return sql.begin(async (transaction) => {
        const generation = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.semantic_generations
          SET contract_fingerprint_sha256 = ${input.contractFingerprintSha256},
              revision = revision + 1
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.semanticGenerationPublicId}
            AND generation_role = 'active'
            AND state = 'active'
            AND revision = ${input.expectedGenerationRevision}
            AND deleted_at IS NULL
          RETURNING public_id
        `;
        if (!generation[0]) return false;
        const contract = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.semantic_projection_contracts
          SET embedding_query_policy_revision_public_id
                = ${input.embeddingQueryPolicyRevisionPublicId},
              minimum_vector_relevance = ${input.minimumVectorRelevance}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND semantic_generation_public_id = ${input.semanticGenerationPublicId}
          RETURNING public_id
        `;
        if (!contract[0]) throw repositoryError("candidate_missing");
        return true;
      });
    },

    async isWritableProjection(input) {
      assertIdentity(input.knowledgeBaseId);
      assertIdentity(input.semanticGenerationPublicId);
      assertIdentity(input.projectionContractPublicId);
      const rows = await sql<Array<{ writable: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM focowiki.semantic_generations generation
          JOIN focowiki.semantic_projection_contracts contract
            ON contract.knowledge_base_id = generation.knowledge_base_id
           AND contract.semantic_generation_public_id = generation.public_id
          WHERE generation.knowledge_base_id = ${input.knowledgeBaseId}
            AND generation.public_id = ${input.semanticGenerationPublicId}
            AND contract.public_id = ${input.projectionContractPublicId}
            AND generation.deleted_at IS NULL
            AND (
              generation.generation_role = 'candidate'
                AND generation.state IN ('building', 'validating')
              OR generation.generation_role = 'active'
                AND generation.state = 'active'
            )
        ) AS writable
      `;
      return rows[0]?.writable === true;
    },

    async getCandidateByOperation(input) {
      assertIdentity(input.knowledgeBaseId);
      assertIdentity(input.operationPublicId);
      const rows = await sql<GenerationRow[]>`
        SELECT public_id, knowledge_base_id, operation_public_id,
               expected_predecessor_public_id, generation_role, state,
               contract_fingerprint_sha256, revision
        FROM focowiki.semantic_generations
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND operation_public_id = ${input.operationPublicId}
          AND generation_role = 'candidate'
          AND deleted_at IS NULL
        ORDER BY created_at DESC, public_id COLLATE "C"
        LIMIT 1
      `;
      return rows[0] ? mapGeneration(rows[0]) : null;
    },

    async transitionCandidate(input) {
      assertIdentity(input.knowledgeBaseId);
      assertIdentity(input.candidatePublicId);
      assertCandidateTransition(input.fromState, input.toState);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw repositoryError("invalid_input");
      }
      const rows = await sql<GenerationRow[]>`
        UPDATE focowiki.semantic_generations
        SET state = ${input.toState}, revision = revision + 1
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND public_id = ${input.candidatePublicId}
          AND generation_role = 'candidate'
          AND state = ${input.fromState}
          AND revision = ${input.expectedRevision}
          AND deleted_at IS NULL
        RETURNING public_id, knowledge_base_id, operation_public_id,
                  expected_predecessor_public_id, generation_role, state,
                  contract_fingerprint_sha256, revision
      `;
      if (!rows[0]) throw repositoryError("revision_conflict");
      return mapGeneration(rows[0]);
    },

    async activateCandidate(input) {
      assertActivationInput(input);
      return sql.begin(async (transaction) => {
        await lockKnowledgeBase(transaction, input.knowledgeBaseId);
        const active = await readActive(transaction, input.knowledgeBaseId, true);
        if ((active?.public_id ?? null) !== input.expectedPredecessorPublicId) {
          throw repositoryError("predecessor_conflict");
        }
        const candidates = await transaction<GenerationRow[]>`
          SELECT public_id, knowledge_base_id, operation_public_id,
                 expected_predecessor_public_id, generation_role, state,
                 contract_fingerprint_sha256, revision
          FROM focowiki.semantic_generations
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.candidatePublicId}
            AND generation_role = 'candidate'
            AND state = 'ready'
            AND deleted_at IS NULL
          FOR UPDATE
        `;
        const candidate = candidates[0];
        if (!candidate) throw repositoryError("candidate_missing");
        if (Number(candidate.revision) !== input.expectedCandidateRevision) {
          throw repositoryError("revision_conflict");
        }
        if (active) {
          await transaction`
            UPDATE focowiki.semantic_generations
            SET generation_role = 'historical', state = 'superseded',
                revision = revision + 1
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND public_id = ${active.public_id}
              AND generation_role = 'active'
              AND state = 'active'
          `;
        }
        await transaction`
          UPDATE focowiki.semantic_vector_documents
          SET state = 'active'
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND semantic_generation_public_id = ${input.candidatePublicId}
            AND state = 'candidate'
            AND deleted_at IS NULL
        `;
        const rows = await transaction<GenerationRow[]>`
          UPDATE focowiki.semantic_generations
          SET generation_role = 'active', state = 'active',
              activated_at = ${input.activatedAt}, revision = revision + 1
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.candidatePublicId}
            AND generation_role = 'candidate'
            AND state = 'ready'
            AND revision = ${input.expectedCandidateRevision}
          RETURNING public_id, knowledge_base_id, operation_public_id,
                    expected_predecessor_public_id, generation_role, state,
                    contract_fingerprint_sha256, revision
        `;
        if (!rows[0]) throw repositoryError("revision_conflict");
        return mapGeneration(rows[0]);
      }).catch(mapDatabaseError);
    },

    async markCleanupFailed(input) {
      assertIdentity(input.knowledgeBaseId);
      assertIdentity(input.candidatePublicId);
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw repositoryError("invalid_input");
      }
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.semantic_generations
        SET state = 'cleanup_failed', revision = revision + 1
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND public_id = ${input.candidatePublicId}
          AND generation_role = 'candidate'
          AND state IN ('failed', 'cancelled', 'superseded')
          AND revision = ${input.expectedRevision}
        RETURNING public_id
      `;
      return rows.length === 1;
    },

    async discardCandidateByOperation(input) {
      assertIdentity(input.knowledgeBaseId);
      assertIdentity(input.operationPublicId);
      return sql.begin(async (transaction) => {
        const candidates = await transaction<Array<{ public_id: string }>>`
          SELECT public_id
          FROM focowiki.semantic_generations
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND operation_public_id = ${input.operationPublicId}
            AND generation_role = 'candidate'
            AND deleted_at IS NULL
          ORDER BY created_at DESC, public_id COLLATE "C"
          LIMIT 1
          FOR UPDATE
        `;
        const candidatePublicId = candidates[0]?.public_id;
        if (!candidatePublicId) return "missing" as const;
        const artifacts = await transaction<Array<{ artifact_public_id: string }>>`
          SELECT DISTINCT artifact_public_id
          FROM focowiki.embedding_artifact_owners
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND semantic_generation_public_id = ${candidatePublicId}
        `;
        await transaction`
          DELETE FROM focowiki.semantic_generations
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${candidatePublicId}
            AND generation_role = 'candidate'
        `;
        const artifactPublicIds = artifacts.map((row) => row.artifact_public_id);
        if (artifactPublicIds.length > 0) {
          await transaction`
            UPDATE focowiki.embedding_artifacts artifact
            SET state = 'orphaned', deleted_at = NULL
            WHERE artifact.knowledge_base_id = ${input.knowledgeBaseId}
              AND artifact.public_id = ANY(${artifactPublicIds})
              AND NOT EXISTS (
                SELECT 1
                FROM focowiki.embedding_artifact_owners owner
                WHERE owner.artifact_public_id = artifact.public_id
              )
          `;
        }
        return "deleted" as const;
      }).catch(mapDatabaseError);
    }
  };
}

async function lockKnowledgeBase(
  sql: TransactionSql,
  knowledgeBaseId: string
): Promise<void> {
  const rows = await sql<Array<{ public_id: string }>>`
    SELECT public_id FROM focowiki.knowledge_bases
    WHERE public_id = ${knowledgeBaseId} AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (!rows[0]) throw repositoryError("knowledge_base_missing");
}

async function readActive(
  sql: DatabaseClient | TransactionSql,
  knowledgeBaseId: string,
  lock: boolean
): Promise<GenerationRow | null> {
  const lockClause = lock ? sql`FOR UPDATE` : sql``;
  const rows = await sql<GenerationRow[]>`
    SELECT generation.public_id, generation.knowledge_base_id,
           generation.operation_public_id,
           generation.expected_predecessor_public_id,
           generation.generation_role, generation.state,
           generation.contract_fingerprint_sha256, generation.revision
    FROM focowiki.semantic_generations generation
    JOIN focowiki.knowledge_bases knowledge_base
      ON knowledge_base.public_id = generation.knowledge_base_id
     AND knowledge_base.deleted_at IS NULL
    WHERE generation.knowledge_base_id = ${knowledgeBaseId}
      AND generation.generation_role = 'active'
      AND generation.state = 'active'
      AND generation.deleted_at IS NULL
    ${lockClause}
  `;
  return rows[0] ?? null;
}

function mapGeneration(row: GenerationRow): SemanticGenerationRecord {
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    operationPublicId: row.operation_public_id,
    expectedPredecessorPublicId: row.expected_predecessor_public_id,
    role: row.generation_role,
    state: row.state,
    contractFingerprintSha256: row.contract_fingerprint_sha256,
    revision: Number(row.revision)
  };
}

function mapActiveProjection(row: ActiveProjectionRow): SemanticActiveProjectionRecord {
  return {
    ...mapGeneration(row),
    generationModelConfigurationPublicId:
      row.generation_model_configuration_public_id,
    generationModelConfigurationRevision:
      Number(row.generation_model_configuration_revision),
    extractionContractVersion: row.extraction_contract_version,
    graphSchemaVersion: row.graph_schema_version,
    promptContractVersion: row.prompt_contract_version,
    projectionContractPublicId: row.projection_contract_public_id,
    embeddingConfigurationRevisionPublicId:
      row.embedding_configuration_revision_public_id,
    embeddingQueryPolicyRevisionPublicId:
      row.embedding_query_policy_revision_public_id,
    minimumVectorRelevance: row.minimum_vector_relevance,
    searchProviderKind: row.search_provider_kind,
    resolvedDimension: row.resolved_dimension,
    normalization: row.normalization,
    artifactSchemaVersion: row.artifact_schema_version,
    vectorSchemaVersion: row.vector_schema_version,
    mappingFingerprintSha256: row.mapping_fingerprint_sha256
  };
}

function assertCreateInput(input: Parameters<SemanticGenerationRepositoryPort["createCandidate"]>[0]): void {
  assertIdentity(input.operationPublicId);
  assertIdentity(input.candidatePublicId);
  assertIdentity(input.target.knowledgeBaseId);
  if (!/^[0-9a-f]{64}$/u.test(input.contractFingerprintSha256)) {
    throw repositoryError("invalid_input");
  }
}

function assertActivationInput(input: Parameters<SemanticGenerationRepositoryPort["activateCandidate"]>[0]): void {
  assertIdentity(input.knowledgeBaseId);
  assertIdentity(input.candidatePublicId);
  if (!Number.isSafeInteger(input.expectedCandidateRevision) || input.expectedCandidateRevision < 0) {
    throw repositoryError("invalid_input");
  }
  if (!Number.isFinite(Date.parse(input.activatedAt))) {
    throw repositoryError("invalid_input");
  }
}

function assertCandidateTransition(
  fromState: Parameters<SemanticGenerationRepositoryPort["transitionCandidate"]>[0]["fromState"],
  toState: Parameters<SemanticGenerationRepositoryPort["transitionCandidate"]>[0]["toState"]
): void {
  const allowed = fromState === "building"
    ? ["validating", "failed", "cancelled", "superseded"]
    : fromState === "validating"
      ? ["ready", "failed", "cancelled", "superseded"]
      : ["cancelled", "superseded"];
  if (!allowed.includes(toState)) throw repositoryError("invalid_input");
}

function assertIdentity(value: string): void {
  if (!value || Buffer.byteLength(value) > 255) throw repositoryError("invalid_input");
}

function repositoryError(code: SemanticGenerationRepositoryErrorCode): SemanticGenerationRepositoryError {
  return new SemanticGenerationRepositoryError(code);
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof SemanticGenerationRepositoryError) throw error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  if (code === "23505") throw repositoryError("candidate_conflict");
  if (code === "23503") throw repositoryError("knowledge_base_missing");
  throw error;
}
