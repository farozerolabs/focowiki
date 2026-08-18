import { createHash } from "node:crypto";
import type { ModelProviderObservation } from "@focowiki/okf";

export type DocumentModelAnalysisFingerprint = {
  publicId: string;
  modelInputSha256: string;
};

export type DocumentRelationshipEvaluationFingerprint = {
  publicId: string;
  evidenceFingerprintSha256: string;
};

export type DocumentModelEvaluationExecution = {
  firstLayer: {
    ownerIdentity: string;
    reused: boolean;
    providerRequestCount: number;
    waitTimeMs: number;
    serviceTimeMs: number;
    providerObservations?: readonly ModelProviderObservation[];
  };
  candidateDelta: {
    ownerIdentity: string;
    reusedDecisionCount: number;
    evaluatedDecisionCount: number;
    providerRequestCount: number;
    waitTimeMs: number;
    serviceTimeMs: number;
    providerObservations?: readonly ModelProviderObservation[];
  };
};

export type DocumentModelAnalysisResultFact = DocumentModelAnalysisFingerprint & {
  knowledgeBaseId: string;
  sourceRevisionPublicId: string;
  modelConfigurationPublicId: string;
  modelConfigurationRevision: number;
  promptContractSha256: string;
  result: Readonly<Record<string, unknown>>;
  warnings: readonly string[];
};

export type DocumentRelationshipEvaluationFact =
  DocumentRelationshipEvaluationFingerprint & {
    knowledgeBaseId: string;
    sourceRevisionPublicId: string;
    targetRevisionPublicId: string;
    modelConfigurationPublicId: string;
    modelConfigurationRevision: number;
    promptContractSha256: string;
    decision: "accepted" | "rejected";
    confidence: number;
    result: Readonly<Record<string, unknown>>;
  };

export type DocumentModelEvaluationRepository = {
  findAnalysis(input: {
    publicId: string;
    knowledgeBaseId: string;
  }): Promise<DocumentModelAnalysisResultFact | null>;
  findReusableAnalysis(input: {
    knowledgeBaseId: string;
    modelConfigurationPublicId: string;
    modelConfigurationRevision: number;
    promptContractSha256: string;
    modelInputSha256: string;
  }): Promise<DocumentModelAnalysisResultFact | null>;
  storeAnalysis(input: DocumentModelAnalysisResultFact): Promise<
    DocumentModelAnalysisResultFact
  >;
  findRelationships(input: {
    knowledgeBaseId: string;
    publicIds: readonly string[];
  }): Promise<readonly DocumentRelationshipEvaluationFact[]>;
  findReusableRelationships(input: {
    knowledgeBaseId: string;
    targetRevisionPublicIds: readonly string[];
    evidenceFingerprintSha256s: readonly string[];
    modelConfigurationPublicId: string;
    modelConfigurationRevision: number;
    promptContractSha256: string;
  }): Promise<readonly DocumentRelationshipEvaluationFact[]>;
  storeRelationships(input: {
    evaluations: readonly DocumentRelationshipEvaluationFact[];
  }): Promise<readonly DocumentRelationshipEvaluationFact[]>;
};

export function createDocumentModelAnalysisFingerprint(input: {
  sourceRevisionPublicId: string;
  modelConfigurationPublicId: string;
  modelConfigurationRevision: number;
  promptContractSha256: string;
  modelInput: Readonly<Record<string, unknown>>;
}): DocumentModelAnalysisFingerprint {
  validateIdentity(input.sourceRevisionPublicId);
  validateModel(input);
  const modelInputSha256 = digest(input.modelInput);
  const identitySha256 = digest({
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    modelConfigurationPublicId: input.modelConfigurationPublicId,
    modelConfigurationRevision: input.modelConfigurationRevision,
    promptContractSha256: input.promptContractSha256,
    modelInputSha256
  });
  return {
    publicId: `document-model-analysis-${identitySha256}`,
    modelInputSha256
  };
}

export function createDocumentRelationshipEvaluationFingerprint(input: {
  sourceRevisionPublicId: string;
  targetRevisionPublicId: string;
  evidence: Readonly<Record<string, unknown>>;
  modelConfigurationPublicId: string;
  modelConfigurationRevision: number;
  promptContractSha256: string;
}): DocumentRelationshipEvaluationFingerprint {
  validateIdentity(input.sourceRevisionPublicId);
  validateIdentity(input.targetRevisionPublicId);
  if (input.sourceRevisionPublicId === input.targetRevisionPublicId) {
    throw evaluationError("relationship_revision_identity_invalid");
  }
  validateModel(input);
  const evidenceFingerprintSha256 = digest(input.evidence);
  const identitySha256 = digest({
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    targetRevisionPublicId: input.targetRevisionPublicId,
    evidenceFingerprintSha256,
    modelConfigurationPublicId: input.modelConfigurationPublicId,
    modelConfigurationRevision: input.modelConfigurationRevision,
    promptContractSha256: input.promptContractSha256
  });
  return {
    publicId: `relationship-evaluation-${identitySha256}`,
    evidenceFingerprintSha256
  };
}

function validateModel(input: {
  modelConfigurationPublicId: string;
  modelConfigurationRevision: number;
  promptContractSha256: string;
}): void {
  validateIdentity(input.modelConfigurationPublicId);
  if (!Number.isSafeInteger(input.modelConfigurationRevision)
    || input.modelConfigurationRevision < 1
    || !/^[0-9a-f]{64}$/u.test(input.promptContractSha256)) {
    throw evaluationError("model_evaluation_contract_invalid");
  }
}

function validateIdentity(value: string): void {
  if (!value || Buffer.byteLength(value, "utf8") > 255) {
    throw evaluationError("model_evaluation_identity_invalid");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw evaluationError("model_evaluation_value_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw evaluationError("model_evaluation_value_invalid");
}

function evaluationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document model evaluation error: ${code}`), { code });
}
