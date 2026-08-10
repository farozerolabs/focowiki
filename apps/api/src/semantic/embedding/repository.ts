import type {
  EmbeddingAuthenticationMode,
  EmbeddingConfigurationPrivate
} from "./configuration.js";
import type { EmbeddingNormalization } from "../domain/contracts.js";

export type EmbeddingRevisionWrite = {
  displayName: string;
  authenticationMode: EmbeddingAuthenticationMode;
  baseUrl: string;
  encryptedApiKey: string | null;
  modelName: string;
  requestedDimension: number | null;
  normalization: EmbeddingNormalization;
  maximumInputTokens: number;
  batchSize: number;
  timeoutMs: number;
  retryCount: number;
  minimumIntervalMs: number;
  concurrency: number;
  maximumResponseBytes: number;
  minimumVectorRelevance: number;
  vectorProducingRevisionPublicId: string;
};

export type EmbeddingConfigurationRepository = {
  create(input: EmbeddingRevisionWrite & {
    configurationPublicId: string;
    revisionPublicId: string;
    createdAt: string;
  }): Promise<EmbeddingConfigurationPrivate>;
  createRevision(input: EmbeddingRevisionWrite & {
    configurationPublicId: string;
    revisionPublicId: string;
    createdAt: string;
    expectedConfigurationRevision: number;
    reuseValidationFromRevisionPublicId: string | null;
  }): Promise<EmbeddingConfigurationPrivate>;
  get(configurationPublicId: string): Promise<EmbeddingConfigurationPrivate | null>;
  getRevision(revisionPublicId: string): Promise<EmbeddingConfigurationPrivate | null>;
  list(): Promise<readonly EmbeddingConfigurationPrivate[]>;
  recordValidation(input: {
    configurationPublicId: string;
    revisionPublicId: string;
    status: "valid" | "invalid";
    resolvedDimension: number | null;
    validationFingerprintSha256: string | null;
    safeValidationErrorCode: string | null;
    validatedAt: string;
  }): Promise<EmbeddingConfigurationPrivate>;
  setLifecycle(input: {
    configurationPublicId: string;
    status: "active" | "draft" | "paused";
    expectedConfigurationRevision: number;
  }): Promise<EmbeddingConfigurationPrivate>;
  delete(input: {
    configurationPublicId: string;
    expectedConfigurationRevision: number;
    deletedAt: string;
  }): Promise<boolean>;
  countReferences(configurationPublicId: string): Promise<number>;
};
