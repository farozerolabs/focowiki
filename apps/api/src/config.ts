import { ValidationError, redactSecrets } from "./errors.js";

export const DEFAULT_MODEL_BASE_URL = "https://api.openai.com/v1";

export type RuntimeConfig = {
  admin: {
    username: string;
    password: string;
    sessionSecret: string;
  };
  database: {
    url: string;
  };
  redis: {
    url: string;
  };
  ports: {
    adminApi: number;
    adminUi: number;
    publicOpenApi: number;
  };
  publicApi: {
    baseUrl: string;
    authRequired: boolean;
    apiKey: string | null;
  };
  storage: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix: string;
    forcePathStyle: boolean;
  };
  upload: {
    maxBytes: number;
    maxFiles: number;
    generationBatchSize: number;
  };
  pagination: {
    defaultPageSize: number;
    maxPageSize: number;
    cursorTtlSeconds: number;
  };
  model:
    | {
        enabled: true;
        apiKey: string;
        modelName: string;
        baseUrl: string;
      }
    | {
        enabled: false;
      };
  corsOrigins: string[];
};

export class ConfigValidationError extends ValidationError {
  public constructor(issues: string[]) {
    super("CONFIG_VALIDATION", issues, {
      expose: true,
      status: 500
    });
    this.message = `Invalid runtime configuration: ${issues.join("; ")}`;
    this.name = "ConfigValidationError";
  }
}

type RuntimeEnv = Record<string, string | undefined>;

export function parseRuntimeConfig(env: RuntimeEnv): RuntimeConfig {
  const issues: string[] = [];

  const adminUsername = requireString(env, "ADMIN_USERNAME", issues);
  const adminPassword = requireString(env, "ADMIN_PASSWORD", issues);
  const adminSessionSecret = requireString(env, "ADMIN_SESSION_SECRET", issues);
  const databaseUrl = requireDatabaseUrl(env, "DATABASE_URL", issues);
  const redisUrl = requireRedisUrl(env, "REDIS_URL", issues);
  const ports = parseServicePorts(env, issues);
  const publicBaseUrl = requireUrl(env, "PUBLIC_BASE_URL", issues);
  const publicApiAuthRequired = requireBoolean(env, "PUBLIC_API_AUTH_REQUIRED", issues);
  const publicApiKey = optionalString(env, "PUBLIC_API_KEY");
  const endpoint = requireUrl(env, "S3_ENDPOINT", issues);
  const region = requireString(env, "S3_REGION", issues);
  const bucket = requireString(env, "S3_BUCKET", issues);
  const accessKeyId = requireString(env, "S3_ACCESS_KEY_ID", issues);
  const secretAccessKey = requireString(env, "S3_SECRET_ACCESS_KEY", issues);
  const prefix = normalizePrefix(requireString(env, "S3_PREFIX", issues), issues);
  const forcePathStyle = optionalBoolean(env, "S3_FORCE_PATH_STYLE", false, issues);
  const maxBytes = requirePositiveInteger(env, "MAX_UPLOAD_BYTES", issues);
  const maxFiles = requirePositiveInteger(env, "MAX_UPLOAD_FILES", issues);
  const generationBatchSize = optionalPositiveInteger(env, "GENERATION_BATCH_SIZE", 50, issues);
  const pagination = parsePaginationConfig(env, issues);
  const corsOrigins = parseUrlList(env, "CORS_ORIGINS", issues);
  const model = parseModelConfig(env, issues);

  if (publicApiAuthRequired && !publicApiKey) {
    issues.push("PUBLIC_API_KEY is required when PUBLIC_API_AUTH_REQUIRED is true");
  }

  if (issues.length > 0) {
    throw new ConfigValidationError(issues.map((issue) => redactSecrets(issue)));
  }

  return {
    admin: {
      username: adminUsername,
      password: adminPassword,
      sessionSecret: adminSessionSecret
    },
    database: {
      url: databaseUrl
    },
    redis: {
      url: redisUrl
    },
    ports,
    pagination,
    publicApi: {
      baseUrl: publicBaseUrl,
      authRequired: publicApiAuthRequired,
      apiKey: publicApiAuthRequired ? publicApiKey : null
    },
    storage: {
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      prefix,
      forcePathStyle
    },
    upload: {
      maxBytes,
      maxFiles,
      generationBatchSize
    },
    model,
    corsOrigins
  };
}

export function loadRuntimeConfig(env: RuntimeEnv = process.env): RuntimeConfig {
  return parseRuntimeConfig(env);
}

function optionalString(env: RuntimeEnv, field: string): string | null {
  const value = env[field]?.trim();
  return value ? value : null;
}

function requireString(env: RuntimeEnv, field: string, issues: string[]): string {
  const value = optionalString(env, field);

  if (!value) {
    issues.push(`${field} is required`);
    return "";
  }

  return value;
}

function requireBoolean(env: RuntimeEnv, field: string, issues: string[]): boolean {
  const value = optionalString(env, field);

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  issues.push(`${field} must be true or false`);
  return false;
}

function optionalBoolean(
  env: RuntimeEnv,
  field: string,
  fallback: boolean,
  issues: string[]
): boolean {
  const value = optionalString(env, field);

  if (!value) {
    return fallback;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  issues.push(`${field} must be true or false`);
  return fallback;
}

function requirePositiveInteger(env: RuntimeEnv, field: string, issues: string[]): number {
  const value = optionalString(env, field);
  const parsed = value ? Number(value) : Number.NaN;

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    issues.push(`${field} must be a positive integer`);
    return 0;
  }

  return parsed;
}

function optionalPositiveInteger(
  env: RuntimeEnv,
  field: string,
  fallback: number,
  issues: string[]
): number {
  const value = optionalString(env, field);

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    issues.push(`${field} must be a positive integer`);
    return fallback;
  }

  return parsed;
}

function parseServicePorts(env: RuntimeEnv, issues: string[]): RuntimeConfig["ports"] {
  const ports = {
    adminApi: optionalHighPort(env, "ADMIN_API_PORT", 43_000, issues),
    adminUi: optionalHighPort(env, "ADMIN_UI_PORT", 43_100, issues),
    publicOpenApi: optionalHighPort(env, "PUBLIC_OPENAPI_PORT", 43_200, issues)
  };
  const values = Object.values(ports);

  if (new Set(values).size !== values.length) {
    issues.push("ADMIN_API_PORT, ADMIN_UI_PORT, and PUBLIC_OPENAPI_PORT must be distinct");
  }

  return ports;
}

function optionalHighPort(
  env: RuntimeEnv,
  field: string,
  fallback: number,
  issues: string[]
): number {
  const value = optionalString(env, field);
  const parsed = value ? Number(value) : fallback;

  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65_535) {
    issues.push(`${field} must be a high valid TCP port`);
    return fallback;
  }

  return parsed;
}

function parsePaginationConfig(
  env: RuntimeEnv,
  issues: string[]
): RuntimeConfig["pagination"] {
  const defaultPageSize = optionalPositiveInteger(env, "ADMIN_LIST_PAGE_SIZE", 50, issues);
  const maxPageSize = optionalPositiveInteger(env, "ADMIN_LIST_MAX_PAGE_SIZE", 200, issues);
  const cursorTtlSeconds = optionalPositiveInteger(
    env,
    "ADMIN_PAGINATION_CURSOR_TTL_SECONDS",
    900,
    issues
  );

  if (defaultPageSize > maxPageSize) {
    issues.push("ADMIN_LIST_PAGE_SIZE must be less than or equal to ADMIN_LIST_MAX_PAGE_SIZE");
  }

  return {
    defaultPageSize,
    maxPageSize,
    cursorTtlSeconds
  };
}

function requireUrl(env: RuntimeEnv, field: string, issues: string[]): string {
  const value = requireString(env, field, issues);

  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      issues.push(`${field} must use http or https`);
      return value;
    }

    return value.replace(/\/+$/, "");
  } catch {
    issues.push(`${field} must be a valid URL`);
    return value;
  }
}

function requireDatabaseUrl(env: RuntimeEnv, field: string, issues: string[]): string {
  const value = requireString(env, field, issues);

  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);

    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      issues.push(`${field} must use postgres or postgresql`);
    }

    return value;
  } catch {
    issues.push(`${field} must be a valid PostgreSQL URL`);
    return value;
  }
}

function requireRedisUrl(env: RuntimeEnv, field: string, issues: string[]): string {
  const value = requireString(env, field, issues);

  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);

    if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
      issues.push(`${field} must use redis or rediss`);
    }

    return value;
  } catch {
    issues.push(`${field} must be a valid Redis URL`);
    return value;
  }
}

function normalizePrefix(prefix: string, issues: string[]): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, "");

  if (!normalized || normalized.includes("..") || normalized.includes("\\")) {
    issues.push("S3_PREFIX must be a non-empty relative prefix");
  }

  return normalized;
}

function parseModelConfig(
  env: RuntimeEnv,
  issues: string[]
): RuntimeConfig["model"] {
  const apiKey = optionalString(env, "MODEL_API_KEY");
  const modelName = optionalString(env, "MODEL_NAME");

  if (!apiKey || !modelName) {
    return { enabled: false };
  }

  const rawBaseUrl = optionalString(env, "MODEL_BASE_URL") ?? DEFAULT_MODEL_BASE_URL;
  const baseUrl = validateUrl("MODEL_BASE_URL", rawBaseUrl, issues);

  return {
    enabled: true,
    apiKey,
    modelName,
    baseUrl
  };
}

function parseUrlList(env: RuntimeEnv, field: string, issues: string[]): string[] {
  return parseStringList(env, field).map((value) => validateUrl(field, value, issues));
}

function validateUrl(field: string, value: string, issues: string[]): string {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      issues.push(`${field} must use http or https`);
      return value;
    }

    return value.replace(/\/+$/, "");
  } catch {
    issues.push(`${field} must be a valid URL`);
    return value;
  }
}

function parseStringList(env: RuntimeEnv, field: string): string[] {
  return (
    env[field]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? []
  );
}
