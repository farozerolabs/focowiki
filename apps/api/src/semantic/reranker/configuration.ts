export const RERANKER_AUTHENTICATION_MODES = ["api_key", "none"] as const;
export type RerankerAuthenticationMode =
  (typeof RERANKER_AUTHENTICATION_MODES)[number];

export type RerankerConfigurationDraft = {
  displayName: string;
  authenticationMode: RerankerAuthenticationMode;
  baseUrl: string;
  apiKey: string | null;
  modelName: string;
  timeoutMs: number;
  retryCount: number;
  minimumIntervalMs: number;
  concurrency: number;
};

export type RerankerConfigurationIssue = {
  field: keyof RerankerConfigurationDraft;
  code: string;
};

export type RerankerConfigurationPublic = Omit<
  RerankerConfigurationDraft,
  "apiKey"
> & {
  publicId: string;
  revisionPublicId: string;
  revision: number;
  apiKeyConfigured: boolean;
  validationStatus: "not_tested" | "valid" | "invalid";
  validationFingerprintSha256: string | null;
  safeValidationErrorCode: string | null;
  lifecycleStatus: "draft" | "active" | "paused";
  createdAt: string;
};

export type RerankerConfigurationPrivate = RerankerConfigurationPublic & {
  encryptedApiKey: string | null;
};

export function validateRerankerConfigurationDraft(
  input: RerankerConfigurationDraft,
  options: { apiKeyMayBeOmitted?: boolean } = {}
): RerankerConfigurationIssue[] {
  const issues: RerankerConfigurationIssue[] = [];
  boundedText(issues, "displayName", input.displayName, 255);
  if (!RERANKER_AUTHENTICATION_MODES.includes(input.authenticationMode as never)) {
    issues.push({
      field: "authenticationMode",
      code: "invalid_authentication_mode"
    });
  }
  validateBaseUrl(issues, input.baseUrl, input.authenticationMode);
  if (input.authenticationMode === "api_key") {
    if (
      input.apiKey === null && !options.apiKeyMayBeOmitted
      || input.apiKey !== null
        && (!input.apiKey.trim() || Buffer.byteLength(input.apiKey) > 16_384)
    ) issues.push({ field: "apiKey", code: "api_key_required" });
  } else if (input.apiKey !== null) {
    issues.push({ field: "apiKey", code: "api_key_forbidden" });
  }
  boundedText(issues, "modelName", input.modelName, 255);
  integer(issues, "timeoutMs", input.timeoutMs, 100, 300_000);
  integer(issues, "retryCount", input.retryCount, 0, 10);
  integer(issues, "minimumIntervalMs", input.minimumIntervalMs, 0, 60_000);
  integer(issues, "concurrency", input.concurrency, 1, 64);
  return issues;
}

function validateBaseUrl(
  issues: RerankerConfigurationIssue[],
  value: string,
  authenticationMode: RerankerAuthenticationMode
): void {
  if (!value || Buffer.byteLength(value) > 2_048) {
    issues.push({ field: "baseUrl", code: "invalid_base_url" });
    return;
  }
  try {
    const url = new URL(value);
    const local = isLocalHostname(url.hostname);
    const path = url.pathname.replace(/\/+$/u, "");
    if (
      !["http:", "https:"].includes(url.protocol)
      || url.username || url.password || url.search || url.hash
      || path.endsWith("/rerank") || path.endsWith("/chat/completions")
      || authenticationMode === "api_key" && url.protocol !== "https:" && !local
      || authenticationMode === "none" && !local
    ) throw new Error("invalid");
  } catch {
    issues.push({ field: "baseUrl", code: "invalid_base_url" });
  }
}

function isLocalHostname(value: string): boolean {
  return value === "localhost" || value === "127.0.0.1" || value === "::1"
    || /^10\./u.test(value) || /^192\.168\./u.test(value)
    || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(value)
    || !value.includes(".") || value.endsWith(".local");
}

function boundedText(
  issues: RerankerConfigurationIssue[],
  field: "displayName" | "modelName",
  value: string,
  maximumBytes: number
): void {
  if (!value.trim() || Buffer.byteLength(value) > maximumBytes) {
    issues.push({ field, code: "invalid_text" });
  }
}

function integer(
  issues: RerankerConfigurationIssue[],
  field: keyof RerankerConfigurationDraft,
  value: number,
  minimum: number,
  maximum: number
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    issues.push({ field, code: "out_of_bounds" });
  }
}
