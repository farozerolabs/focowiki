import { statSync } from "node:fs";
import { readConfiguredSecret } from "../security/configured-secret.js";
import { isSearchProviderKind, type SearchProviderKind } from
  "../application/ports/search-provider-runtime.js";

const INDEX_PREFIX_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/u;
const MAX_CA_FILE_BYTES = 1_048_576;

export type { SearchProviderKind } from
  "../application/ports/search-provider-runtime.js";
export type OpenSearchAwsService = "es" | "aoss";

export type MeilisearchStartupConfig = {
  provider: "meilisearch";
  endpoint: string;
  apiKey: string;
  metricsApiKey: string;
  indexPrefix: string;
};

export type OpenSearchStartupConfig = {
  provider: "opensearch";
  endpoint: string;
  indexPrefix: string;
  auth:
    | { mode: "none" }
    | { mode: "basic"; username: string; password: string }
    | {
        mode: "aws_sigv4";
        region: string;
        service: OpenSearchAwsService;
      };
  tls: {
    caFile?: string;
  };
};

export type SearchStartupConfig =
  | MeilisearchStartupConfig
  | OpenSearchStartupConfig;

type RuntimeEnv = Record<string, string | undefined>;

export function parseSearchStartupConfig(input: {
  env: RuntimeEnv;
  environment: "development" | "production";
  issues: string[];
}): SearchStartupConfig {
  const provider = parseProvider(input.env, input.issues);
  const indexPrefix = requireValue(
    input.env,
    "SEARCH_INDEX_PREFIX",
    input.issues
  );
  if (indexPrefix && !INDEX_PREFIX_PATTERN.test(indexPrefix)) {
    input.issues.push(
      "SEARCH_INDEX_PREFIX must start with a lowercase letter or number and contain at most 80 lowercase letters, numbers, underscores, or hyphens"
    );
  }

  return provider === "opensearch"
    ? parseOpenSearch(input, indexPrefix)
    : parseMeilisearch(input, indexPrefix);
}

function parseProvider(
  env: RuntimeEnv,
  issues: string[]
): SearchProviderKind {
  const provider = requireValue(env, "SEARCH_PROVIDER", issues);
  if (isSearchProviderKind(provider)) {
    return provider;
  }
  if (provider) {
    issues.push("SEARCH_PROVIDER must be opensearch or meilisearch");
  }
  return "meilisearch";
}

function parseMeilisearch(
  input: {
    env: RuntimeEnv;
    environment: "development" | "production";
    issues: string[];
  },
  indexPrefix: string
): MeilisearchStartupConfig {
  const endpoint = requireHttpUrl(
    input.env,
    "MEILI_HOST",
    input.issues,
    false
  );
  const apiKey = readConfiguredSecret({
    env: input.env,
    valueField: "MEILI_API_KEY",
    fileField: "MEILI_API_KEY_FILE",
    issues: input.issues
  });
  const metricsApiKey = readConfiguredSecret({
    env: input.env,
    valueField: "MEILI_METRICS_API_KEY",
    fileField: "MEILI_METRICS_API_KEY_FILE",
    issues: input.issues
  });

  if (input.environment === "production" && !apiKey) {
    input.issues.push("MEILI_API_KEY is required in production");
  }
  if (input.environment === "production" && !metricsApiKey) {
    input.issues.push("MEILI_METRICS_API_KEY is required in production");
  }

  return {
    provider: "meilisearch",
    endpoint,
    apiKey,
    metricsApiKey: metricsApiKey || apiKey,
    indexPrefix
  };
}

function parseOpenSearch(
  input: {
    env: RuntimeEnv;
    environment: "development" | "production";
    issues: string[];
  },
  indexPrefix: string
): OpenSearchStartupConfig {
  const endpoint = requireHttpUrl(
    input.env,
    "OPENSEARCH_URL",
    input.issues,
    input.environment === "production"
  );
  const tls = parseOpenSearchTls(input.env, input.issues);
  const mode = requireValue(
    input.env,
    "OPENSEARCH_AUTH_MODE",
    input.issues
  );

  if (mode === "none") {
    if (input.environment === "production") {
      input.issues.push(
        "OPENSEARCH_AUTH_MODE none is not allowed in production"
      );
    }
    return {
      provider: "opensearch",
      endpoint,
      indexPrefix,
      auth: { mode: "none" },
      tls
    };
  }

  if (mode === "basic") {
    const username = requireValue(
      input.env,
      "OPENSEARCH_USERNAME",
      input.issues
    );
    const password = readConfiguredSecret({
      env: input.env,
      valueField: "OPENSEARCH_PASSWORD",
      fileField: "OPENSEARCH_PASSWORD_FILE",
      issues: input.issues,
      filePrecedence: true
    });
    if (!password) input.issues.push("OPENSEARCH_PASSWORD is required for basic auth");
    return {
      provider: "opensearch",
      endpoint,
      indexPrefix,
      auth: { mode: "basic", username, password },
      tls
    };
  }

  if (mode === "aws_sigv4") {
    const region = requireValue(
      input.env,
      "OPENSEARCH_AWS_REGION",
      input.issues
    );
    const serviceValue = requireValue(
      input.env,
      "OPENSEARCH_AWS_SERVICE",
      input.issues
    );
    if (serviceValue !== "es" && serviceValue !== "aoss" && serviceValue) {
      input.issues.push("OPENSEARCH_AWS_SERVICE must be es or aoss");
    }
    return {
      provider: "opensearch",
      endpoint,
      indexPrefix,
      auth: {
        mode: "aws_sigv4",
        region,
        service: serviceValue === "aoss" ? "aoss" : "es"
      },
      tls
    };
  }

  if (mode) {
    input.issues.push(
      "OPENSEARCH_AUTH_MODE must be basic, aws_sigv4, or none"
    );
  }
  return {
    provider: "opensearch",
    endpoint,
    indexPrefix,
    auth: { mode: "none" },
    tls
  };
}

function parseOpenSearchTls(
  env: RuntimeEnv,
  issues: string[]
): OpenSearchStartupConfig["tls"] {
  const caFile = optionalValue(env, "OPENSEARCH_CA_FILE");
  if (!caFile) return {};
  try {
    const stats = statSync(caFile);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_CA_FILE_BYTES) {
      issues.push("OPENSEARCH_CA_FILE must reference a non-empty bounded CA file");
      return {};
    }
  } catch {
    issues.push("OPENSEARCH_CA_FILE must reference a readable CA file");
    return {};
  }
  return { caFile };
}

function requireHttpUrl(
  env: RuntimeEnv,
  field: string,
  issues: string[],
  requireHttps: boolean
): string {
  const value = requireValue(env, field, issues);
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      issues.push(`${field} must not include embedded credentials`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      issues.push(`${field} must use http or https`);
    } else if (requireHttps && url.protocol !== "https:") {
      issues.push(`${field} must use https in production`);
    }
    return value.replace(/\/+$/u, "");
  } catch {
    issues.push(`${field} must be a valid URL`);
    return value;
  }
}

function requireValue(
  env: RuntimeEnv,
  field: string,
  issues: string[]
): string {
  const value = optionalValue(env, field);
  if (!value) {
    issues.push(`${field} is required`);
    return "";
  }
  return value;
}

function optionalValue(env: RuntimeEnv, field: string): string | null {
  const value = env[field]?.trim();
  return value ? value : null;
}
