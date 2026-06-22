import { resolve } from "node:path";
import { ValidationError, redactSecrets } from "./errors.js";

export const DEFAULT_MODEL_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL_REQUEST_MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MODEL_REQUEST_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL_SUGGESTION_CONCURRENCY = 2;
const DEFAULT_MODEL_TRANSIENT_RETRY_DELAY_MS = 60_000;
const DEFAULT_MODEL_REQUEST_MIN_INTERVAL_MS = 2_000;
const INTERNAL_PAGINATION_DEFAULT_PAGE_SIZE = 50;
const INTERNAL_PAGINATION_MAX_PAGE_SIZE = 200;
const INTERNAL_PAGINATION_CURSOR_TTL_SECONDS = 900;
const DEFAULT_UPLOAD_TASK_CONCURRENCY = 1;
const DEFAULT_UPLOAD_FILE_PROCESSING_CONCURRENCY = 1;
const DEFAULT_UPLOAD_STORAGE_CONCURRENCY = 4;
const DEFAULT_PUBLICATION_MODE = "batch";
const DEFAULT_PUBLICATION_BATCH_SIZE = 300;
const DEFAULT_PUBLICATION_INTERVAL_SECONDS = 300;
const DEFAULT_INDEX_SHARD_SIZE = 1_000;
const DEFAULT_GRAPH_EDGE_SHARD_SIZE = 5_000;
const DEFAULT_OKF_LOG_MAX_ENTRIES = 100;
const DEFAULT_OKF_LOG_MAX_BYTES = 65_536;
const DEFAULT_ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
const DEFAULT_ADMIN_SESSION_SECRET_MIN_LENGTH = 32;
const DEFAULT_SECURITY_AUDIT_RETENTION_DAYS = 30;
const DEFAULT_LOG_FILE_MAX_BYTES = 10_485_760;
const DEFAULT_LOG_FILE_MAX_FILES = 5;

export type RuntimeLogLevel = "error" | "warn" | "info" | "debug";
export type PublicationMode = "batch" | "manual" | "per_file";

export type RateLimitConfig = {
  max: number;
  windowSeconds: number;
};

export type RuntimeSecurityConfig = {
  environment: "development" | "production";
  adminTrustedOrigins: string[];
  allowedHosts: string[];
  trustedProxy: boolean;
  origins: {
    adminUi: string;
    adminApi: string;
    publicOpenApi: string;
  };
  session: {
    ttlSeconds: number;
    secretMinLength: number;
    cookieSecure: boolean;
    cookieSameSite: "Lax" | "Strict" | "None";
  };
  rateLimits: {
    adminLogin: RateLimitConfig;
    adminApi: RateLimitConfig;
    upload: RateLimitConfig;
    publicOpenApi: RateLimitConfig;
  };
  audit: {
    retentionDays: number;
  };
};

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
    taskConcurrency: number;
    fileProcessingConcurrency: number;
    storageConcurrency: number;
  };
  publication: {
    mode: PublicationMode;
    batchSize: number;
    intervalSeconds: number;
    indexShardSize: number;
    graphEdgeShardSize: number;
  };
  pagination: {
    defaultPageSize: number;
    maxPageSize: number;
    cursorTtlSeconds: number;
  };
  okf?: {
    log: {
      maxEntries: number;
      maxBytes: number;
    };
  } | undefined;
  logging?: {
    level: RuntimeLogLevel;
    file?: {
      directory: string;
      maxBytes: number;
      maxFiles: number;
    };
  };
  model:
    | {
        enabled: true;
        apiKey: string;
        modelName: string;
        baseUrl: string;
        contextWindowTokens: number;
        requestMaxTimeoutMs: number;
        requestIdleTimeoutMs: number;
        suggestionConcurrency: number;
        transientRetryDelayMs: number;
        requestMinIntervalMs: number;
      }
    | {
        enabled: false;
      };
  corsOrigins: string[];
  security?: RuntimeSecurityConfig;
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
  rejectDeprecatedPublicApiEnv(env, issues);
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
  const taskConcurrency = optionalPositiveInteger(
    env,
    "UPLOAD_TASK_CONCURRENCY",
    DEFAULT_UPLOAD_TASK_CONCURRENCY,
    issues
  );
  const fileProcessingConcurrency = optionalPositiveInteger(
    env,
    "UPLOAD_FILE_PROCESSING_CONCURRENCY",
    DEFAULT_UPLOAD_FILE_PROCESSING_CONCURRENCY,
    issues
  );
  const storageConcurrency = optionalPositiveInteger(
    env,
    "UPLOAD_STORAGE_CONCURRENCY",
    DEFAULT_UPLOAD_STORAGE_CONCURRENCY,
    issues
  );
  const publication = parsePublicationConfig(env, issues);
  const pagination = createDefaultPaginationConfig();
  const okf = parseOkfConfig(env, issues);
  const corsOrigins = parseUrlList(env, "CORS_ORIGINS", issues);
  const model = parseModelConfig(env, issues);
  const security = parseSecurityConfig(
    env,
    {
      adminPassword,
      adminSessionSecret,
      ports,
      publicBaseUrl,
      storageCredentials: [accessKeyId, secretAccessKey],
      model
    },
    issues
  );
  const logging = parseLoggingConfig(env, security.environment, issues);

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
    okf,
    publicApi: {
      baseUrl: publicBaseUrl
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
      generationBatchSize,
      taskConcurrency,
      fileProcessingConcurrency,
      storageConcurrency
    },
    publication,
    model,
    logging,
    corsOrigins,
    security
  };
}

export function loadRuntimeConfig(env: RuntimeEnv = process.env): RuntimeConfig {
  return parseRuntimeConfig(env);
}

export function resolveSecurityConfig(
  config: Pick<RuntimeConfig, "ports" | "publicApi"> & {
    security?: RuntimeSecurityConfig;
  }
): RuntimeSecurityConfig {
  return config.security ?? createDefaultSecurityConfig(config);
}

function optionalString(env: RuntimeEnv, field: string): string | null {
  const value = env[field]?.trim();
  return value ? value : null;
}

function rejectDeprecatedPublicApiEnv(env: RuntimeEnv, issues: string[]): void {
  if (Object.hasOwn(env, "PUBLIC_API_KEY")) {
    issues.push("PUBLIC_API_KEY is no longer supported; manage OpenAPI keys in Admin UI");
  }

  if (Object.hasOwn(env, "PUBLIC_API_AUTH_REQUIRED")) {
    issues.push("PUBLIC_API_AUTH_REQUIRED is no longer supported; public OpenAPI keys are always required");
  }
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

function optionalNonNegativeInteger(
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

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    issues.push(`${field} must be a non-negative integer`);
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

function createDefaultPaginationConfig(): RuntimeConfig["pagination"] {
  return {
    defaultPageSize: INTERNAL_PAGINATION_DEFAULT_PAGE_SIZE,
    maxPageSize: INTERNAL_PAGINATION_MAX_PAGE_SIZE,
    cursorTtlSeconds: INTERNAL_PAGINATION_CURSOR_TTL_SECONDS
  };
}

function parsePublicationConfig(
  env: RuntimeEnv,
  issues: string[]
): RuntimeConfig["publication"] {
  return {
    mode: parsePublicationMode(env, issues),
    batchSize: optionalPositiveInteger(
      env,
      "PUBLICATION_BATCH_SIZE",
      DEFAULT_PUBLICATION_BATCH_SIZE,
      issues
    ),
    intervalSeconds: optionalPositiveInteger(
      env,
      "PUBLICATION_INTERVAL_SECONDS",
      DEFAULT_PUBLICATION_INTERVAL_SECONDS,
      issues
    ),
    indexShardSize: optionalPositiveInteger(
      env,
      "INDEX_SHARD_SIZE",
      DEFAULT_INDEX_SHARD_SIZE,
      issues
    ),
    graphEdgeShardSize: optionalPositiveInteger(
      env,
      "GRAPH_EDGE_SHARD_SIZE",
      DEFAULT_GRAPH_EDGE_SHARD_SIZE,
      issues
    )
  };
}

function parsePublicationMode(env: RuntimeEnv, issues: string[]): PublicationMode {
  const value = optionalString(env, "PUBLICATION_MODE") ?? DEFAULT_PUBLICATION_MODE;

  if (value === "batch" || value === "manual" || value === "per_file") {
    return value;
  }

  issues.push("PUBLICATION_MODE must be batch, manual, or per_file");
  return DEFAULT_PUBLICATION_MODE;
}

function parseOkfConfig(env: RuntimeEnv, issues: string[]): RuntimeConfig["okf"] {
  return {
    log: {
      maxEntries: optionalPositiveInteger(
        env,
        "OKF_LOG_MAX_ENTRIES",
        DEFAULT_OKF_LOG_MAX_ENTRIES,
        issues
      ),
      maxBytes: optionalPositiveInteger(
        env,
        "OKF_LOG_MAX_BYTES",
        DEFAULT_OKF_LOG_MAX_BYTES,
        issues
      )
    }
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
  const contextWindowTokens = requirePositiveInteger(
    env,
    "MODEL_CONTEXT_WINDOW_TOKENS",
    issues
  );
  const requestMaxTimeoutMs = optionalPositiveInteger(
    env,
    "MODEL_REQUEST_MAX_TIMEOUT_MS",
    DEFAULT_MODEL_REQUEST_MAX_TIMEOUT_MS,
    issues
  );
  const requestIdleTimeoutMs = optionalPositiveInteger(
    env,
    "MODEL_REQUEST_IDLE_TIMEOUT_MS",
    DEFAULT_MODEL_REQUEST_IDLE_TIMEOUT_MS,
    issues
  );
  const suggestionConcurrency = optionalPositiveInteger(
    env,
    "MODEL_SUGGESTION_CONCURRENCY",
    DEFAULT_MODEL_SUGGESTION_CONCURRENCY,
    issues
  );
  const transientRetryDelayMs = optionalPositiveInteger(
    env,
    "MODEL_TRANSIENT_RETRY_DELAY_MS",
    DEFAULT_MODEL_TRANSIENT_RETRY_DELAY_MS,
    issues
  );
  const requestMinIntervalMs = optionalNonNegativeInteger(
    env,
    "MODEL_REQUEST_MIN_INTERVAL_MS",
    DEFAULT_MODEL_REQUEST_MIN_INTERVAL_MS,
    issues
  );

  if (requestIdleTimeoutMs > requestMaxTimeoutMs) {
    issues.push("MODEL_REQUEST_IDLE_TIMEOUT_MS must be less than or equal to MODEL_REQUEST_MAX_TIMEOUT_MS");
  }

  return {
    enabled: true,
    apiKey,
    modelName,
    baseUrl,
    contextWindowTokens,
    requestMaxTimeoutMs,
    requestIdleTimeoutMs,
    suggestionConcurrency,
    transientRetryDelayMs,
    requestMinIntervalMs
  };
}

function parseSecurityConfig(
  env: RuntimeEnv,
  input: {
    adminPassword: string;
    adminSessionSecret: string;
    ports: RuntimeConfig["ports"];
    publicBaseUrl: string;
    storageCredentials: string[];
    model: RuntimeConfig["model"];
  },
  issues: string[]
): RuntimeSecurityConfig {
  const environment = parseEnvironment(env, issues);
  const sessionSecretMinLength = optionalPositiveInteger(
    env,
    "ADMIN_SESSION_SECRET_MIN_LENGTH",
    DEFAULT_ADMIN_SESSION_SECRET_MIN_LENGTH,
    issues
  );
  const cookieSecure = optionalBoolean(
    env,
    "ADMIN_SESSION_COOKIE_SECURE",
    environment === "production",
    issues
  );
  const cookieSameSite = parseCookieSameSite(env, issues);
  const adminUiOrigin = optionalOrigin(
    env,
    "ADMIN_PUBLIC_ORIGIN",
    `http://localhost:${input.ports.adminUi}`,
    issues
  );
  const adminApiOrigin = optionalOrigin(
    env,
    "ADMIN_API_PUBLIC_ORIGIN",
    `http://localhost:${input.ports.adminApi}`,
    issues
  );
  const publicOpenApiOrigin = optionalOrigin(
    env,
    "PUBLIC_OPENAPI_PUBLIC_ORIGIN",
    input.publicBaseUrl,
    issues
  );
  const configuredTrustedOrigins = parseOriginList(env, "ADMIN_TRUSTED_ORIGINS", issues);
  const adminTrustedOrigins =
    configuredTrustedOrigins.length > 0
      ? configuredTrustedOrigins
      : uniqueStrings([
          `http://localhost:${input.ports.adminUi}`,
          `http://127.0.0.1:${input.ports.adminUi}`,
          adminUiOrigin
        ]);
  const allowedHosts = parseStringList(env, "ALLOWED_HOSTS").map((value) => value.toLowerCase());
  const trustedProxy = optionalBoolean(env, "TRUSTED_PROXY_MODE", false, issues);

  if (input.adminSessionSecret.length < sessionSecretMinLength) {
    issues.push("ADMIN_SESSION_SECRET is shorter than ADMIN_SESSION_SECRET_MIN_LENGTH");
  }

  if (cookieSameSite === "None" && !cookieSecure) {
    issues.push("ADMIN_SESSION_COOKIE_SAME_SITE=None requires ADMIN_SESSION_COOKIE_SECURE=true");
  }

  if (environment === "production") {
    validateProductionSecurity({
      adminPassword: input.adminPassword,
      adminSessionSecret: input.adminSessionSecret,
      storageCredentials: input.storageCredentials,
      model: input.model,
      cookieSecure,
      origins: [adminUiOrigin, adminApiOrigin, publicOpenApiOrigin],
      allowedHosts,
      issues
    });
  }

  return {
    environment,
    adminTrustedOrigins,
    allowedHosts,
    trustedProxy,
    origins: {
      adminUi: adminUiOrigin,
      adminApi: adminApiOrigin,
      publicOpenApi: publicOpenApiOrigin
    },
    session: {
      ttlSeconds: optionalPositiveInteger(
        env,
        "ADMIN_SESSION_TTL_SECONDS",
        DEFAULT_ADMIN_SESSION_TTL_SECONDS,
        issues
      ),
      secretMinLength: sessionSecretMinLength,
      cookieSecure,
      cookieSameSite
    },
    rateLimits: {
      adminLogin: parseRateLimit(env, "ADMIN_LOGIN", 8, 900, issues),
      adminApi: parseRateLimit(env, "ADMIN_API", 600, 60, issues),
      upload: parseRateLimit(env, "UPLOAD", 20, 3_600, issues),
      publicOpenApi: parseRateLimit(env, "PUBLIC_OPENAPI", 1_200, 60, issues)
    },
    audit: {
      retentionDays: optionalPositiveInteger(
        env,
        "SECURITY_AUDIT_RETENTION_DAYS",
        DEFAULT_SECURITY_AUDIT_RETENTION_DAYS,
        issues
      )
    }
  };
}

function createDefaultSecurityConfig(
  config: Pick<RuntimeConfig, "ports" | "publicApi">
): RuntimeSecurityConfig {
  return {
    environment: "development",
    adminTrustedOrigins: [
      `http://localhost:${config.ports.adminUi}`,
      `http://127.0.0.1:${config.ports.adminUi}`
    ],
    allowedHosts: [],
    trustedProxy: false,
    origins: {
      adminUi: `http://localhost:${config.ports.adminUi}`,
      adminApi: `http://localhost:${config.ports.adminApi}`,
      publicOpenApi: config.publicApi.baseUrl
    },
    session: {
      ttlSeconds: DEFAULT_ADMIN_SESSION_TTL_SECONDS,
      secretMinLength: DEFAULT_ADMIN_SESSION_SECRET_MIN_LENGTH,
      cookieSecure: false,
      cookieSameSite: "Lax"
    },
    rateLimits: {
      adminLogin: {
        max: 8,
        windowSeconds: 900
      },
      adminApi: {
        max: 600,
        windowSeconds: 60
      },
      upload: {
        max: 20,
        windowSeconds: 3_600
      },
      publicOpenApi: {
        max: 1_200,
        windowSeconds: 60
      }
    },
    audit: {
      retentionDays: DEFAULT_SECURITY_AUDIT_RETENTION_DAYS
    }
  };
}

function parseEnvironment(
  env: RuntimeEnv,
  issues: string[]
): RuntimeSecurityConfig["environment"] {
  const value = optionalString(env, "APP_ENV") ?? "development";

  if (value === "development" || value === "production") {
    return value;
  }

  issues.push("APP_ENV must be development or production");
  return "development";
}

function parseCookieSameSite(
  env: RuntimeEnv,
  issues: string[]
): RuntimeSecurityConfig["session"]["cookieSameSite"] {
  const value = (optionalString(env, "ADMIN_SESSION_COOKIE_SAME_SITE") ?? "Lax").toLowerCase();

  if (value === "lax") {
    return "Lax";
  }

  if (value === "strict") {
    return "Strict";
  }

  if (value === "none") {
    return "None";
  }

  issues.push("ADMIN_SESSION_COOKIE_SAME_SITE must be Lax, Strict, or None");
  return "Lax";
}

function parseRateLimit(
  env: RuntimeEnv,
  prefix: string,
  fallbackMax: number,
  fallbackWindowSeconds: number,
  issues: string[]
): RateLimitConfig {
  return {
    max: optionalPositiveInteger(env, `${prefix}_RATE_LIMIT_MAX`, fallbackMax, issues),
    windowSeconds: optionalPositiveInteger(
      env,
      `${prefix}_RATE_LIMIT_WINDOW_SECONDS`,
      fallbackWindowSeconds,
      issues
    )
  };
}

function parseLoggingConfig(
  env: RuntimeEnv,
  environment: RuntimeSecurityConfig["environment"],
  issues: string[]
): NonNullable<RuntimeConfig["logging"]> {
  const fallback: RuntimeLogLevel = environment === "production" ? "info" : "debug";
  const value = optionalString(env, "LOG_LEVEL") ?? fallback;
  const file = parseFileLoggingConfig(env, issues);

  if (isRuntimeLogLevel(value)) {
    return { level: value, file };
  }

  issues.push("LOG_LEVEL must be error, warn, info, or debug");
  return { level: fallback, file };
}

function parseFileLoggingConfig(
  env: RuntimeEnv,
  issues: string[]
): NonNullable<NonNullable<RuntimeConfig["logging"]>["file"]> {
  return {
    directory: resolve(process.cwd(), optionalString(env, "LOG_FILE_DIR") ?? "logs"),
    maxBytes: optionalPositiveInteger(
      env,
      "LOG_FILE_MAX_BYTES",
      DEFAULT_LOG_FILE_MAX_BYTES,
      issues
    ),
    maxFiles: optionalPositiveInteger(
      env,
      "LOG_FILE_MAX_FILES",
      DEFAULT_LOG_FILE_MAX_FILES,
      issues
    )
  };
}

function isRuntimeLogLevel(value: string): value is RuntimeLogLevel {
  return value === "error" || value === "warn" || value === "info" || value === "debug";
}

function optionalOrigin(
  env: RuntimeEnv,
  field: string,
  fallback: string,
  issues: string[]
): string {
  return validateOrigin(field, optionalString(env, field) ?? fallback, issues);
}

function parseOriginList(env: RuntimeEnv, field: string, issues: string[]): string[] {
  return parseStringList(env, field).map((value) => validateOrigin(field, value, issues));
}

function validateOrigin(field: string, value: string, issues: string[]): string {
  try {
    const url = new URL(value);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      issues.push(`${field} must use http or https`);
      return value;
    }

    return url.origin;
  } catch {
    issues.push(`${field} must be a valid URL origin`);
    return value;
  }
}

function validateProductionSecurity(input: {
  adminPassword: string;
  adminSessionSecret: string;
  storageCredentials: string[];
  model: RuntimeConfig["model"];
  cookieSecure: boolean;
  origins: string[];
  allowedHosts: string[];
  issues: string[];
}) {
  const placeholderChecks: Array<[string, string | null]> = [
    ["ADMIN_PASSWORD", input.adminPassword],
    ["ADMIN_SESSION_SECRET", input.adminSessionSecret],
    ["S3_ACCESS_KEY_ID", input.storageCredentials[0] ?? null],
    ["S3_SECRET_ACCESS_KEY", input.storageCredentials[1] ?? null],
    ["MODEL_API_KEY", input.model.enabled ? input.model.apiKey : null]
  ];

  for (const [field, value] of placeholderChecks) {
    if (value && isPlaceholderSecret(value)) {
      input.issues.push(`${field} must not use a placeholder value in production`);
    }
  }

  if (!input.cookieSecure) {
    input.issues.push("ADMIN_SESSION_COOKIE_SECURE must be true in production");
  }

  if (input.allowedHosts.length === 0) {
    input.issues.push("ALLOWED_HOSTS is required in production");
  }

  for (const origin of input.origins) {
    if (!origin.startsWith("https://")) {
      input.issues.push("Production public origins must use https");
      break;
    }
  }
}

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();

  return (
    normalized === "dev" ||
    normalized === "secret" ||
    normalized === "password" ||
    normalized === "change-me" ||
    normalized === "changeme" ||
    normalized === "replace-me" ||
    normalized === "admin-password" ||
    normalized === "public-secret" ||
    normalized === "model-secret" ||
    normalized === "s3-access-key" ||
    normalized === "s3-secret-key" ||
    normalized.includes("change-this") ||
    normalized.includes("placeholder")
  );
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
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
