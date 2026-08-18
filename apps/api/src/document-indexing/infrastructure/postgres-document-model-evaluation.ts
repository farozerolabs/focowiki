import type { DatabaseClient } from "../../db/client.js";
import type {
  DocumentModelAnalysisResultFact,
  DocumentModelEvaluationRepository,
  DocumentRelationshipEvaluationFact
} from "../application/document-model-evaluation.js";

type AnalysisRow = {
  public_id: string;
  knowledge_base_id: string;
  source_revision_public_id: string;
  model_configuration_public_id: string;
  model_configuration_revision: number;
  prompt_contract_sha256: string;
  model_input_sha256: string;
  result: Record<string, unknown>;
  warnings: unknown;
};

type RelationshipRow = {
  public_id: string;
  knowledge_base_id: string;
  source_revision_public_id: string;
  target_revision_public_id: string;
  evidence_fingerprint_sha256: string;
  model_configuration_public_id: string;
  model_configuration_revision: number;
  prompt_contract_sha256: string;
  decision: string;
  confidence: number;
  result: Record<string, unknown>;
};

export function createPostgresDocumentModelEvaluationRepository(
  sql: DatabaseClient
): DocumentModelEvaluationRepository {
  const repository: DocumentModelEvaluationRepository = {
    async findAnalysis(input) {
      const rows = await sql<AnalysisRow[]>`
        SELECT public_id, knowledge_base_id, source_revision_public_id,
               model_configuration_public_id, model_configuration_revision,
               prompt_contract_sha256, model_input_sha256, result, warnings
        FROM focowiki.document_model_analysis_results
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND public_id = ${input.publicId}
      `;
      return rows[0] ? analysisFact(rows[0]) : null;
    },

    async findReusableAnalysis(input) {
      const rows = await sql<AnalysisRow[]>`
        SELECT public_id, knowledge_base_id, source_revision_public_id,
               model_configuration_public_id, model_configuration_revision,
               prompt_contract_sha256, model_input_sha256, result, warnings
        FROM focowiki.document_model_analysis_results
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND model_configuration_public_id = ${input.modelConfigurationPublicId}
          AND model_configuration_revision = ${input.modelConfigurationRevision}
          AND prompt_contract_sha256 = ${input.promptContractSha256}
          AND model_input_sha256 = ${input.modelInputSha256}
        ORDER BY created_at DESC, public_id COLLATE "C"
        LIMIT 1
      `;
      return rows[0] ? analysisFact(rows[0]) : null;
    },

    async storeAnalysis(input) {
      validateAnalysis(input);
      await sql`
        INSERT INTO focowiki.document_model_analysis_results (
          public_id, knowledge_base_id, source_revision_public_id,
          model_configuration_public_id, model_configuration_revision,
          prompt_contract_sha256, model_input_sha256, result, warnings
        ) VALUES (
          ${input.publicId}, ${input.knowledgeBaseId},
          ${input.sourceRevisionPublicId},
          ${input.modelConfigurationPublicId},
          ${input.modelConfigurationRevision}, ${input.promptContractSha256},
          ${input.modelInputSha256},
          ${sql.json(input.result as never)},
          ${sql.json([...input.warnings] as never)}
        )
        ON CONFLICT DO NOTHING
      `;
      const stored = await repository.findAnalysis({
        publicId: input.publicId,
        knowledgeBaseId: input.knowledgeBaseId
      });
      if (!stored || !sameAnalysisIdentity(stored, input)) {
        throw evaluationRepositoryError("analysis_identity_conflict");
      }
      return stored;
    },

    async findRelationships(input) {
      const publicIds = boundedPublicIds(input.publicIds);
      if (publicIds.length === 0) return [];
      const rows = await sql<RelationshipRow[]>`
        SELECT public_id, knowledge_base_id, source_revision_public_id,
               target_revision_public_id, evidence_fingerprint_sha256,
               model_configuration_public_id, model_configuration_revision,
               prompt_contract_sha256, decision, confidence, result
        FROM focowiki.relationship_evaluations
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND public_id IN ${sql(publicIds)}
        ORDER BY public_id COLLATE "C"
      `;
      return rows.map(relationshipFact);
    },

    async findReusableRelationships(input) {
      const targetRevisionPublicIds = boundedPublicIds(
        input.targetRevisionPublicIds
      );
      const evidenceFingerprintSha256s = boundedChecksums(
        input.evidenceFingerprintSha256s
      );
      if (targetRevisionPublicIds.length === 0
        || evidenceFingerprintSha256s.length === 0) return [];
      const rows = await sql<RelationshipRow[]>`
        SELECT DISTINCT ON (
                 target_revision_public_id, evidence_fingerprint_sha256
               )
               public_id, knowledge_base_id, source_revision_public_id,
               target_revision_public_id, evidence_fingerprint_sha256,
               model_configuration_public_id, model_configuration_revision,
               prompt_contract_sha256, decision, confidence, result
        FROM focowiki.relationship_evaluations
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND target_revision_public_id IN ${sql(targetRevisionPublicIds)}
          AND evidence_fingerprint_sha256 IN ${sql(evidenceFingerprintSha256s)}
          AND model_configuration_public_id = ${input.modelConfigurationPublicId}
          AND model_configuration_revision = ${input.modelConfigurationRevision}
          AND prompt_contract_sha256 = ${input.promptContractSha256}
        ORDER BY target_revision_public_id, evidence_fingerprint_sha256,
                 created_at DESC, public_id COLLATE "C"
      `;
      return rows.map(relationshipFact);
    },

    async storeRelationships(input) {
      if (input.evaluations.length > 1_000) {
        throw evaluationRepositoryError("relationship_evaluation_limit_exceeded");
      }
      for (const evaluation of input.evaluations) {
        validateRelationship(evaluation);
        await sql`
          INSERT INTO focowiki.relationship_evaluations (
            public_id, knowledge_base_id, source_revision_public_id,
            target_revision_public_id, evidence_fingerprint_sha256,
            model_configuration_public_id, model_configuration_revision,
            prompt_contract_sha256, decision, confidence, result
          ) VALUES (
            ${evaluation.publicId}, ${evaluation.knowledgeBaseId},
            ${evaluation.sourceRevisionPublicId},
            ${evaluation.targetRevisionPublicId},
            ${evaluation.evidenceFingerprintSha256},
            ${evaluation.modelConfigurationPublicId},
            ${evaluation.modelConfigurationRevision},
            ${evaluation.promptContractSha256}, ${evaluation.decision},
            ${evaluation.confidence},
            ${sql.json(evaluation.result as never)}
          )
          ON CONFLICT DO NOTHING
        `;
      }
      const stored = await repository.findRelationships({
        knowledgeBaseId: input.evaluations[0]?.knowledgeBaseId ?? "",
        publicIds: input.evaluations.map((item) => item.publicId)
      });
      if (stored.length !== input.evaluations.length) {
        throw evaluationRepositoryError("relationship_evaluation_missing");
      }
      const expected = new Map(input.evaluations.map((item) => [item.publicId, item]));
      if (stored.some((item) => !sameRelationshipIdentity(
        item,
        expected.get(item.publicId)!
      ))) {
        throw evaluationRepositoryError("relationship_evaluation_identity_conflict");
      }
      return stored;
    }
  };
  return repository;
}

function analysisFact(row: AnalysisRow): DocumentModelAnalysisResultFact {
  const warnings = Array.isArray(row.warnings)
    ? row.warnings.filter((item): item is string => typeof item === "string")
    : [];
  const fact: DocumentModelAnalysisResultFact = {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    modelConfigurationPublicId: row.model_configuration_public_id,
    modelConfigurationRevision: Number(row.model_configuration_revision),
    promptContractSha256: row.prompt_contract_sha256,
    modelInputSha256: row.model_input_sha256,
    result: row.result,
    warnings
  };
  validateAnalysis(fact);
  return fact;
}

function relationshipFact(row: RelationshipRow): DocumentRelationshipEvaluationFact {
  const fact: DocumentRelationshipEvaluationFact = {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    targetRevisionPublicId: row.target_revision_public_id,
    evidenceFingerprintSha256: row.evidence_fingerprint_sha256,
    modelConfigurationPublicId: row.model_configuration_public_id,
    modelConfigurationRevision: Number(row.model_configuration_revision),
    promptContractSha256: row.prompt_contract_sha256,
    decision: row.decision === "accepted" ? "accepted" : "rejected",
    confidence: Number(row.confidence),
    result: row.result
  };
  validateRelationship(fact);
  return fact;
}

function validateAnalysis(input: DocumentModelAnalysisResultFact): void {
  if (!input.publicId.startsWith("document-model-analysis-")
    || !identity(input.knowledgeBaseId) || !identity(input.sourceRevisionPublicId)
    || !identity(input.modelConfigurationPublicId)
    || !Number.isSafeInteger(input.modelConfigurationRevision)
    || input.modelConfigurationRevision < 1
    || !checksum(input.promptContractSha256) || !checksum(input.modelInputSha256)
    || typeof input.result !== "object" || input.result === null
    || !Array.isArray(input.warnings)
    || input.warnings.some((warning) => !warning || warning.length > 256)) {
    throw evaluationRepositoryError("analysis_invalid");
  }
}

function validateRelationship(input: DocumentRelationshipEvaluationFact): void {
  if (!input.publicId.startsWith("relationship-evaluation-")
    || !identity(input.knowledgeBaseId) || !identity(input.sourceRevisionPublicId)
    || !identity(input.targetRevisionPublicId)
    || input.sourceRevisionPublicId === input.targetRevisionPublicId
    || !identity(input.modelConfigurationPublicId)
    || !Number.isSafeInteger(input.modelConfigurationRevision)
    || input.modelConfigurationRevision < 1
    || !checksum(input.evidenceFingerprintSha256)
    || !checksum(input.promptContractSha256)
    || !["accepted", "rejected"].includes(input.decision)
    || !Number.isFinite(input.confidence)
    || input.confidence < 0 || input.confidence > 1
    || typeof input.result !== "object" || input.result === null) {
    throw evaluationRepositoryError("relationship_evaluation_invalid");
  }
}

function sameAnalysisIdentity(
  left: DocumentModelAnalysisResultFact,
  right: DocumentModelAnalysisResultFact
): boolean {
  return left.publicId === right.publicId
    && left.knowledgeBaseId === right.knowledgeBaseId
    && left.sourceRevisionPublicId === right.sourceRevisionPublicId
    && left.modelConfigurationPublicId === right.modelConfigurationPublicId
    && left.modelConfigurationRevision === right.modelConfigurationRevision
    && left.promptContractSha256 === right.promptContractSha256
    && left.modelInputSha256 === right.modelInputSha256;
}

function sameRelationshipIdentity(
  left: DocumentRelationshipEvaluationFact,
  right: DocumentRelationshipEvaluationFact
): boolean {
  return left.publicId === right.publicId
    && left.knowledgeBaseId === right.knowledgeBaseId
    && left.sourceRevisionPublicId === right.sourceRevisionPublicId
    && left.targetRevisionPublicId === right.targetRevisionPublicId
    && left.evidenceFingerprintSha256 === right.evidenceFingerprintSha256
    && left.modelConfigurationPublicId === right.modelConfigurationPublicId
    && left.modelConfigurationRevision === right.modelConfigurationRevision
    && left.promptContractSha256 === right.promptContractSha256;
}

function boundedPublicIds(values: readonly string[]): string[] {
  const unique = [...new Set(values)];
  if (unique.length > 1_000 || unique.some((value) => !identity(value))) {
    throw evaluationRepositoryError("relationship_evaluation_ids_invalid");
  }
  return unique;
}

function boundedChecksums(values: readonly string[]): string[] {
  const unique = [...new Set(values)];
  if (unique.length > 1_000 || unique.some((value) => !checksum(value))) {
    throw evaluationRepositoryError("relationship_evaluation_checksums_invalid");
  }
  return unique;
}

function identity(value: string): boolean {
  return Boolean(value) && Buffer.byteLength(value, "utf8") <= 255;
}

function checksum(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function evaluationRepositoryError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document model evaluation repository error: ${code}`), {
    code
  });
}
