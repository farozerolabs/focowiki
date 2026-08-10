import type { EmbeddingNormalization } from "../domain/contracts.js";

export const EMBEDDING_AUTHENTICATION_MODES = ["api_key", "none"] as const;
export type EmbeddingAuthenticationMode =
  (typeof EMBEDDING_AUTHENTICATION_MODES)[number];

export type EmbeddingConfigurationDraft = {
  displayName: string;
  authenticationMode: EmbeddingAuthenticationMode;
  baseUrl: string;
  apiKey: string | null;
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
};

export type EmbeddingConfigurationIssue = {
  field: keyof EmbeddingConfigurationDraft;
  code: string;
};

export type EmbeddingConfigurationPublic = Omit<
  EmbeddingConfigurationDraft,
  "apiKey"
> & {
  publicId: string;
  revisionPublicId: string;
  revision: number;
  vectorProducingRevisionPublicId: string;
  queryPolicyRevisionPublicId: string;
  apiKeyConfigured: boolean;
  resolvedDimension: number | null;
  validationStatus: "not_tested" | "valid" | "invalid";
  validationFingerprintSha256: string | null;
  safeValidationErrorCode: string | null;
  lifecycleStatus: "draft" | "active" | "paused";
  createdAt: string;
};

export type EmbeddingConfigurationPrivate = EmbeddingConfigurationPublic & {
  encryptedApiKey: string | null;
};

export function validateEmbeddingConfigurationDraft(
  input: EmbeddingConfigurationDraft,
  options: { apiKeyMayBeOmitted?: boolean } = {}
): EmbeddingConfigurationIssue[] {
  const issues: EmbeddingConfigurationIssue[] = [];
  boundedText(issues, "displayName", input.displayName, 255);
  if (!EMBEDDING_AUTHENTICATION_MODES.includes(input.authenticationMode as never)) {
    issues.push({ field: "authenticationMode", code: "invalid_authentication_mode" });
  }
  validateEndpoint(issues, input.baseUrl, input.authenticationMode);
  if (input.authenticationMode === "api_key") {
    if (
      input.apiKey === null
      && !options.apiKeyMayBeOmitted
      || input.apiKey !== null
        && (!input.apiKey.trim() || Buffer.byteLength(input.apiKey) > 16_384)
    ) issues.push({ field: "apiKey", code: "api_key_required" });
  } else if (input.apiKey !== null) {
    issues.push({ field: "apiKey", code: "api_key_forbidden" });
  }
  boundedText(issues, "modelName", input.modelName, 255);
  nullableInteger(issues, "requestedDimension", input.requestedDimension, 1, 65_536);
  if (input.normalization !== "none" && input.normalization !== "l2") {
    issues.push({ field: "normalization", code: "invalid_normalization" });
  }
  integer(issues, "maximumInputTokens", input.maximumInputTokens, 1, 1_048_576);
  integer(issues, "batchSize", input.batchSize, 1, 2_048);
  integer(issues, "timeoutMs", input.timeoutMs, 100, 300_000);
  integer(issues, "retryCount", input.retryCount, 0, 10);
  integer(issues, "minimumIntervalMs", input.minimumIntervalMs, 0, 60_000);
  integer(issues, "concurrency", input.concurrency, 1, 64);
  integer(issues, "maximumResponseBytes", input.maximumResponseBytes, 1_024, 67_108_864);
  finiteNumber(
    issues,
    "minimumVectorRelevance",
    input.minimumVectorRelevance,
    0,
    1
  );
  return issues;
}

function validateEndpoint(
  issues: EmbeddingConfigurationIssue[],
  value: string,
  authenticationMode: EmbeddingAuthenticationMode
): void {
  if (!value || Buffer.byteLength(value) > 2_048) {
    issues.push({ field: "baseUrl", code: "invalid_base_url" });
    return;
  }
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash
      || authenticationMode === "api_key"
        && url.protocol !== "https:"
        && !isLocalHostname(url.hostname)
      || authenticationMode === "none"
        && !isLocalHostname(url.hostname)
    ) throw new Error("invalid");
  } catch {
    issues.push({ field: "baseUrl", code: "invalid_base_url" });
  }
}

function isLocalHostname(value: string): boolean {
  return value === "localhost"
    || value === "127.0.0.1"
    || value === "::1"
    || /^10\./u.test(value)
    || /^192\.168\./u.test(value)
    || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(value)
    || !value.includes(".")
    || value.endsWith(".local");
}

function boundedText(
  issues: EmbeddingConfigurationIssue[],
  field: "displayName" | "modelName",
  value: string,
  maximumBytes: number
): void {
  if (!value.trim() || Buffer.byteLength(value) > maximumBytes) {
    issues.push({ field, code: "invalid_text" });
  }
}

function nullableInteger(
  issues: EmbeddingConfigurationIssue[],
  field: "requestedDimension",
  value: number | null,
  minimum: number,
  maximum: number
): void {
  if (value !== null) integer(issues, field, value, minimum, maximum);
}

function integer(
  issues: EmbeddingConfigurationIssue[],
  field: keyof EmbeddingConfigurationDraft,
  value: number,
  minimum: number,
  maximum: number
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    issues.push({ field, code: "out_of_bounds" });
  }
}

function finiteNumber(
  issues: EmbeddingConfigurationIssue[],
  field: "minimumVectorRelevance",
  value: number,
  minimum: number,
  maximum: number
): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    issues.push({ field, code: "invalid_number" });
  }
}
