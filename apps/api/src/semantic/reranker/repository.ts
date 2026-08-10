import type {
  RerankerAuthenticationMode,
  RerankerConfigurationPrivate
} from "./configuration.js";

export type RerankerRevisionWrite = {
  displayName: string;
  authenticationMode: RerankerAuthenticationMode;
  baseUrl: string;
  encryptedApiKey: string | null;
  modelName: string;
  timeoutMs: number;
  retryCount: number;
  minimumIntervalMs: number;
  concurrency: number;
};

export type RerankerConfigurationRepository = {
  create(input: RerankerRevisionWrite & {
    configurationPublicId: string;
    revisionPublicId: string;
    createdAt: string;
  }): Promise<RerankerConfigurationPrivate>;
  createRevision(input: RerankerRevisionWrite & {
    configurationPublicId: string;
    revisionPublicId: string;
    expectedConfigurationRevision: number;
    createdAt: string;
  }): Promise<RerankerConfigurationPrivate>;
  get(configurationPublicId: string): Promise<RerankerConfigurationPrivate | null>;
  getRevision(revisionPublicId: string): Promise<RerankerConfigurationPrivate | null>;
  getActive(): Promise<RerankerConfigurationPrivate | null>;
  list(): Promise<readonly RerankerConfigurationPrivate[]>;
  recordValidation(input: {
    configurationPublicId: string;
    revisionPublicId: string;
    status: "valid" | "invalid";
    validationFingerprintSha256: string | null;
    safeValidationErrorCode: string | null;
    validatedAt: string;
  }): Promise<RerankerConfigurationPrivate>;
  setLifecycle(input: {
    configurationPublicId: string;
    status: "active" | "draft" | "paused";
    expectedConfigurationRevision: number;
  }): Promise<RerankerConfigurationPrivate>;
  delete(input: {
    configurationPublicId: string;
    expectedConfigurationRevision: number;
    deletedAt: string;
  }): Promise<boolean>;
};
