import { resolve } from "node:path";
import { ValidationError, redactSecrets } from "./errors.js";

const DEFAULT_DATABASE_POOL_MAX = 10;
const DEFAULT_WORKER_DATABASE_POOL_MAX = 6;
const DEFAULT_ADMIN_LIST_PAGE_SIZE = 50;
const DEFAULT_ADMIN_LIST_MAX_PAGE_SIZE = 200;
const DEFAULT_TREE_CHILD_PAGE_SIZE = 100;
const DEFAULT_TREE_CHILD_MAX_PAGE_SIZE = 500;
const DEFAULT_PAGINATION_CURSOR_TTL_SECONDS = 900;
const DEFAULT_GENERATED_CONTENT_MAX_BYTES = 10_485_760;
const DEFAULT_UPLOAD_MAX_BYTES = 1_048_576;
const DEFAULT_GENERATION_BATCH_SIZE = 50;
const DEFAULT_UPLOAD_FILE_PROCESSING_CONCURRENCY = 1;
export const DEFAULT_UPLOAD_SESSION_SETTINGS = {
  sessionTtlSeconds: 86_400,
  manifestPageSize: 500,
  contentBatchMaxFiles: 24,
  contentBatchMaxBytes: 16_777_216
} as const;
const DEFAULT_WORKER_SOURCE_FILE_CONCURRENCY = 2;
const DEFAULT_WORKER_CLAIM_BATCH_SIZE = 10;
const DEFAULT_WORKER_POLL_INTERVAL_MS = 1_000;
const DEFAULT_WORKER_LOCK_TTL_SECONDS = 900;
const DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_WORKER_JOB_MAX_ATTEMPTS = 3;
const DEFAULT_WORKER_JOB_RETRY_DELAY_MS = 30_000;
const DEFAULT_WORKER_QUEUE_BACKPRESSURE_LIMIT = 5_000;
const DEFAULT_WORKER_QUEUE_BACKPRESSURE_KB_LIMIT = 2_000;
const DEFAULT_WORKER_QUEUE_BACKPRESSURE_MAX_AGE_SECONDS = 3_600;
const DEFAULT_WORKER_QUEUE_BACKPRESSURE_RETRY_AFTER_SECONDS = 60;
const DEFAULT_WORKER_SHUTDOWN_GRACE_MS = 30_000;
const DEFAULT_WORKER_COMPLETED_JOB_RETENTION_DAYS = 7;
const DEFAULT_WORKER_FAILED_JOB_RETENTION_DAYS = 30;
const DEFAULT_WORKER_DEAD_LETTER_RETENTION_DAYS = 90;
const DEFAULT_WORKER_RETENTION_CLEANUP_BATCH_SIZE = 1_000;
const DEFAULT_WORKER_HARD_DELETE_CONCURRENCY = 1;
const DEFAULT_WORKER_HARD_DELETE_DATABASE_BATCH_SIZE = 1_000;
const DEFAULT_WORKER_HARD_DELETE_OBJECT_BATCH_SIZE = 1_000;
const DEFAULT_WORKER_HARD_DELETE_MAX_ATTEMPTS = 3;
const DEFAULT_WORKER_HARD_DELETE_RETRY_DELAY_MS = 60_000;
const DEFAULT_WORKER_HARD_DELETE_FAILED_RETENTION_DAYS = 30;
const DEFAULT_WORKER_HARD_DELETE_VERSION_PURGE_ENABLED = false;
const DEFAULT_PUBLICATION_MODE = "batch";
const DEFAULT_PUBLICATION_BATCH_SIZE = 300;
const DEFAULT_PUBLICATION_INTERVAL_SECONDS = 300;
const DEFAULT_INDEX_SHARD_SIZE = 1_000;
const DEFAULT_LINK_INDEX_SHARD_SIZE = 1_000;
const DEFAULT_MANIFEST_SHARD_SIZE = 1_000;
const DEFAULT_GRAPH_MAINTENANCE_BATCH_SIZE = 500;
const DEFAULT_ROOT_SUMMARY_LIMIT = 500;
const DEFAULT_DIRECTORY_INDEX_MAX_ENTRIES = 200;
const DEFAULT_DIRECTORY_INDEX_MAX_BYTES = 65_536;
const DEFAULT_GRAPH_CANDIDATE_LIMIT = 200;
const DEFAULT_GRAPH_ACCEPTED_EDGE_LIMIT = 50;
const DEFAULT_GRAPH_SEARCH_DEFAULT_DEPTH = 1;
const DEFAULT_GRAPH_SEARCH_MAX_DEPTH = 2;
const DEFAULT_GRAPH_SEARCH_DEFAULT_FANOUT = 10;
const DEFAULT_GRAPH_SEARCH_MAX_FANOUT = 25;
const DEFAULT_GRAPH_PUBLICATION_SHARD_SIZE = 5_000;
const DEFAULT_GRAPH_CACHE_TTL_SECONDS = 5;
const DEFAULT_GRAPH_GENERIC_PHRASE_THRESHOLD = 4;
const DEFAULT_OKF_LOG_MAX_ENTRIES = 100;
const DEFAULT_OKF_LOG_MAX_BYTES = 65_536;
const DEFAULT_ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
const DEFAULT_SECURITY_AUDIT_RETENTION_DAYS = 30;
const DEFAULT_LOG_FILE_MAX_BYTES = 10_485_760;
const DEFAULT_LOG_FILE_MAX_FILES = 5;
export type RuntimeLogLevel = "error" | "warn" | "info" | "debug";
export type PublicationMode = "batch" | "manual" | "per_file";
export type GraphRuntimeConfig = {
  candidateLimit: number;
  acceptedEdgeLimit: number;
  searchDefaultDepth: 0 | 1 | 2;
  searchMaxDepth: 0 | 1 | 2;
  searchDefaultFanout: number;
  searchMaxFanout: number;
  insightEnabled: boolean;
  modelReviewEnabled: boolean;
  publicationShardSize: number;
  cacheTtlSeconds: number;
  genericPhraseThreshold: number;
};

export type WorkerRuntimeConfig = {
  databasePoolMax?: number;
  sourceFileConcurrency: number;
  claimBatchSize: number;
  pollIntervalMs: number;
  lockTtlSeconds: number;
  heartbeatIntervalMs?: number;
  jobMaxAttempts: number;
  jobRetryDelayMs: number;
  queueBackpressureLimit: number;
  queueBackpressureKnowledgeBaseLimit?: number;
  queueBackpressureMaxAgeSeconds?: number;
  queueBackpressureRetryAfterSeconds?: number;
  shutdownGraceMs: number;
  completedJobRetentionDays?: number;
  failedJobRetentionDays?: number;
  deadLetterJobRetentionDays?: number;
  retentionCleanupBatchSize?: number;
  hardDeleteConcurrency?: number;
  hardDeleteDatabaseBatchSize?: number;
  hardDeleteObjectBatchSize?: number;
  hardDeleteMaxAttempts?: number;
  hardDeleteRetryDelayMs?: number;
  hardDeleteFailedRetentionDays?: number;
  hardDeleteVersionPurgeEnabled?: boolean;
};

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
  };
  database: {
    url: string;
    poolMax?: number;
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
    generationBatchSize: number;
    fileProcessingConcurrency: number;
    sessionTtlSeconds?: number;
    manifestPageSize?: number;
    contentBatchMaxFiles?: number;
    contentBatchMaxBytes?: number;
  };
  worker?: WorkerRuntimeConfig;
  publication: {
    mode: PublicationMode;
    batchSize: number;
    intervalSeconds: number;
    indexShardSize: number;
    linkIndexShardSize: number;
    manifestShardSize: number;
    graphEdgeShardSize?: number;
    graphCandidateLimit?: number;
    graphMaintenanceBatchSize: number;
    rootSummaryLimit: number;
    directoryIndexMaxEntries?: number;
    directoryIndexMaxBytes?: number;
  };
  graph?: GraphRuntimeConfig;
  pagination: {
    defaultPageSize: number;
    maxPageSize: number;
    treeDefaultPageSize: number;
    treeMaxPageSize: number;
    cursorTtlSeconds: number;
    generatedContentMaxBytes: number;
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
  const databaseUrl = requireDatabaseUrl(env, "DATABASE_URL", issues);
  const databasePoolMax = optionalPositiveInteger(
    env,
    "DATABASE_POOL_MAX",
    DEFAULT_DATABASE_POOL_MAX,
    issues
  );
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
  const maxBytes = DEFAULT_UPLOAD_MAX_BYTES;
  const generationBatchSize = DEFAULT_GENERATION_BATCH_SIZE;
  const fileProcessingConcurrency = DEFAULT_UPLOAD_FILE_PROCESSING_CONCURRENCY;
  const publication = createDefaultPublicationConfig();
  const graph = createDefaultGraphConfig();
  const worker = parseWorkerConfig(env, issues);
  const pagination = parsePaginationConfig(env, issues);
  const okf = createDefaultOkfConfig();
  const corsOrigins = parseUrlList(env, "CORS_ORIGINS", issues);
  const model: RuntimeConfig["model"] = { enabled: false };
  const security = parseSecurityConfig(
    env,
    {
      adminPassword,
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
      password: adminPassword
    },
    database: {
      url: databaseUrl,
      poolMax: databasePoolMax
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
      generationBatchSize,
      fileProcessingConcurrency,
      ...DEFAULT_UPLOAD_SESSION_SETTINGS
    },
    worker,
    publication,
    graph,
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

function parsePaginationConfig(env: RuntimeEnv, issues: string[]): RuntimeConfig["pagination"] {
  const defaultPageSize = optionalPositiveInteger(
    env,
    "ADMIN_LIST_DEFAULT_PAGE_SIZE",
    DEFAULT_ADMIN_LIST_PAGE_SIZE,
    issues
  );
  const maxPageSize = optionalPositiveInteger(
    env,
    "ADMIN_LIST_MAX_PAGE_SIZE",
    DEFAULT_ADMIN_LIST_MAX_PAGE_SIZE,
    issues
  );
  const treeDefaultPageSize = optionalPositiveInteger(
    env,
    "TREE_CHILD_DEFAULT_PAGE_SIZE",
    DEFAULT_TREE_CHILD_PAGE_SIZE,
    issues
  );
  const treeMaxPageSize = optionalPositiveInteger(
    env,
    "TREE_CHILD_MAX_PAGE_SIZE",
    DEFAULT_TREE_CHILD_MAX_PAGE_SIZE,
    issues
  );

  if (defaultPageSize > maxPageSize) {
    issues.push("ADMIN_LIST_DEFAULT_PAGE_SIZE must be less than or equal to ADMIN_LIST_MAX_PAGE_SIZE");
  }

  if (treeDefaultPageSize > treeMaxPageSize) {
    issues.push("TREE_CHILD_DEFAULT_PAGE_SIZE must be less than or equal to TREE_CHILD_MAX_PAGE_SIZE");
  }

  return {
    defaultPageSize,
    maxPageSize,
    treeDefaultPageSize,
    treeMaxPageSize,
    cursorTtlSeconds: optionalPositiveInteger(
      env,
      "PAGINATION_CURSOR_TTL_SECONDS",
      DEFAULT_PAGINATION_CURSOR_TTL_SECONDS,
      issues
    ),
    generatedContentMaxBytes: optionalPositiveInteger(
      env,
      "GENERATED_CONTENT_MAX_BYTES",
      DEFAULT_GENERATED_CONTENT_MAX_BYTES,
      issues
    )
  };
}

function createDefaultPublicationConfig(): RuntimeConfig["publication"] {
  return {
    mode: DEFAULT_PUBLICATION_MODE,
    batchSize: DEFAULT_PUBLICATION_BATCH_SIZE,
    intervalSeconds: DEFAULT_PUBLICATION_INTERVAL_SECONDS,
    indexShardSize: DEFAULT_INDEX_SHARD_SIZE,
    linkIndexShardSize: DEFAULT_LINK_INDEX_SHARD_SIZE,
    manifestShardSize: DEFAULT_MANIFEST_SHARD_SIZE,
    graphMaintenanceBatchSize: DEFAULT_GRAPH_MAINTENANCE_BATCH_SIZE,
    rootSummaryLimit: DEFAULT_ROOT_SUMMARY_LIMIT,
    directoryIndexMaxEntries: DEFAULT_DIRECTORY_INDEX_MAX_ENTRIES,
    directoryIndexMaxBytes: DEFAULT_DIRECTORY_INDEX_MAX_BYTES
  };
}

function createDefaultGraphConfig(): GraphRuntimeConfig {
  return {
    candidateLimit: DEFAULT_GRAPH_CANDIDATE_LIMIT,
    acceptedEdgeLimit: DEFAULT_GRAPH_ACCEPTED_EDGE_LIMIT,
    searchDefaultDepth: DEFAULT_GRAPH_SEARCH_DEFAULT_DEPTH,
    searchMaxDepth: DEFAULT_GRAPH_SEARCH_MAX_DEPTH,
    searchDefaultFanout: DEFAULT_GRAPH_SEARCH_DEFAULT_FANOUT,
    searchMaxFanout: DEFAULT_GRAPH_SEARCH_MAX_FANOUT,
    insightEnabled: true,
    modelReviewEnabled: true,
    publicationShardSize: DEFAULT_GRAPH_PUBLICATION_SHARD_SIZE,
    cacheTtlSeconds: DEFAULT_GRAPH_CACHE_TTL_SECONDS,
    genericPhraseThreshold: DEFAULT_GRAPH_GENERIC_PHRASE_THRESHOLD
  };
}

function parseWorkerConfig(env: RuntimeEnv, issues: string[]): WorkerRuntimeConfig {
  return {
    databasePoolMax: optionalPositiveInteger(
      env,
      "WORKER_DATABASE_POOL_MAX",
      DEFAULT_WORKER_DATABASE_POOL_MAX,
      issues
    ),
    sourceFileConcurrency: DEFAULT_WORKER_SOURCE_FILE_CONCURRENCY,
    claimBatchSize: DEFAULT_WORKER_CLAIM_BATCH_SIZE,
    pollIntervalMs: DEFAULT_WORKER_POLL_INTERVAL_MS,
    lockTtlSeconds: DEFAULT_WORKER_LOCK_TTL_SECONDS,
    heartbeatIntervalMs: DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
    jobMaxAttempts: DEFAULT_WORKER_JOB_MAX_ATTEMPTS,
    jobRetryDelayMs: DEFAULT_WORKER_JOB_RETRY_DELAY_MS,
    queueBackpressureLimit: DEFAULT_WORKER_QUEUE_BACKPRESSURE_LIMIT,
    queueBackpressureKnowledgeBaseLimit: DEFAULT_WORKER_QUEUE_BACKPRESSURE_KB_LIMIT,
    queueBackpressureMaxAgeSeconds: DEFAULT_WORKER_QUEUE_BACKPRESSURE_MAX_AGE_SECONDS,
    queueBackpressureRetryAfterSeconds: DEFAULT_WORKER_QUEUE_BACKPRESSURE_RETRY_AFTER_SECONDS,
    shutdownGraceMs: DEFAULT_WORKER_SHUTDOWN_GRACE_MS,
    completedJobRetentionDays: DEFAULT_WORKER_COMPLETED_JOB_RETENTION_DAYS,
    failedJobRetentionDays: DEFAULT_WORKER_FAILED_JOB_RETENTION_DAYS,
    deadLetterJobRetentionDays: DEFAULT_WORKER_DEAD_LETTER_RETENTION_DAYS,
    retentionCleanupBatchSize: DEFAULT_WORKER_RETENTION_CLEANUP_BATCH_SIZE,
    hardDeleteConcurrency: DEFAULT_WORKER_HARD_DELETE_CONCURRENCY,
    hardDeleteDatabaseBatchSize: DEFAULT_WORKER_HARD_DELETE_DATABASE_BATCH_SIZE,
    hardDeleteObjectBatchSize: DEFAULT_WORKER_HARD_DELETE_OBJECT_BATCH_SIZE,
    hardDeleteMaxAttempts: DEFAULT_WORKER_HARD_DELETE_MAX_ATTEMPTS,
    hardDeleteRetryDelayMs: DEFAULT_WORKER_HARD_DELETE_RETRY_DELAY_MS,
    hardDeleteFailedRetentionDays: DEFAULT_WORKER_HARD_DELETE_FAILED_RETENTION_DAYS,
    hardDeleteVersionPurgeEnabled: DEFAULT_WORKER_HARD_DELETE_VERSION_PURGE_ENABLED
  };
}

export function resolveWorkerConfig(
  config: Pick<RuntimeConfig, "worker">
): WorkerRuntimeConfig {
  return {
    databasePoolMax: config.worker?.databasePoolMax ?? DEFAULT_WORKER_DATABASE_POOL_MAX,
    sourceFileConcurrency:
      config.worker?.sourceFileConcurrency ?? DEFAULT_WORKER_SOURCE_FILE_CONCURRENCY,
    claimBatchSize: config.worker?.claimBatchSize ?? DEFAULT_WORKER_CLAIM_BATCH_SIZE,
    pollIntervalMs: config.worker?.pollIntervalMs ?? DEFAULT_WORKER_POLL_INTERVAL_MS,
    lockTtlSeconds: config.worker?.lockTtlSeconds ?? DEFAULT_WORKER_LOCK_TTL_SECONDS,
    heartbeatIntervalMs:
      config.worker?.heartbeatIntervalMs ?? DEFAULT_WORKER_HEARTBEAT_INTERVAL_MS,
    jobMaxAttempts: config.worker?.jobMaxAttempts ?? DEFAULT_WORKER_JOB_MAX_ATTEMPTS,
    jobRetryDelayMs: config.worker?.jobRetryDelayMs ?? DEFAULT_WORKER_JOB_RETRY_DELAY_MS,
    queueBackpressureLimit:
      config.worker?.queueBackpressureLimit ?? DEFAULT_WORKER_QUEUE_BACKPRESSURE_LIMIT,
    queueBackpressureKnowledgeBaseLimit:
      config.worker?.queueBackpressureKnowledgeBaseLimit ??
      DEFAULT_WORKER_QUEUE_BACKPRESSURE_KB_LIMIT,
    queueBackpressureMaxAgeSeconds:
      config.worker?.queueBackpressureMaxAgeSeconds ??
      DEFAULT_WORKER_QUEUE_BACKPRESSURE_MAX_AGE_SECONDS,
    queueBackpressureRetryAfterSeconds:
      config.worker?.queueBackpressureRetryAfterSeconds ??
      DEFAULT_WORKER_QUEUE_BACKPRESSURE_RETRY_AFTER_SECONDS,
    shutdownGraceMs: config.worker?.shutdownGraceMs ?? DEFAULT_WORKER_SHUTDOWN_GRACE_MS,
    completedJobRetentionDays:
      config.worker?.completedJobRetentionDays ?? DEFAULT_WORKER_COMPLETED_JOB_RETENTION_DAYS,
    failedJobRetentionDays:
      config.worker?.failedJobRetentionDays ?? DEFAULT_WORKER_FAILED_JOB_RETENTION_DAYS,
    deadLetterJobRetentionDays:
      config.worker?.deadLetterJobRetentionDays ?? DEFAULT_WORKER_DEAD_LETTER_RETENTION_DAYS,
    retentionCleanupBatchSize:
      config.worker?.retentionCleanupBatchSize ?? DEFAULT_WORKER_RETENTION_CLEANUP_BATCH_SIZE,
    hardDeleteConcurrency:
      config.worker?.hardDeleteConcurrency ?? DEFAULT_WORKER_HARD_DELETE_CONCURRENCY,
    hardDeleteDatabaseBatchSize:
      config.worker?.hardDeleteDatabaseBatchSize ??
      DEFAULT_WORKER_HARD_DELETE_DATABASE_BATCH_SIZE,
    hardDeleteObjectBatchSize:
      config.worker?.hardDeleteObjectBatchSize ?? DEFAULT_WORKER_HARD_DELETE_OBJECT_BATCH_SIZE,
    hardDeleteMaxAttempts:
      config.worker?.hardDeleteMaxAttempts ?? DEFAULT_WORKER_HARD_DELETE_MAX_ATTEMPTS,
    hardDeleteRetryDelayMs:
      config.worker?.hardDeleteRetryDelayMs ?? DEFAULT_WORKER_HARD_DELETE_RETRY_DELAY_MS,
    hardDeleteFailedRetentionDays:
      config.worker?.hardDeleteFailedRetentionDays ??
      DEFAULT_WORKER_HARD_DELETE_FAILED_RETENTION_DAYS,
    hardDeleteVersionPurgeEnabled:
      config.worker?.hardDeleteVersionPurgeEnabled ??
      DEFAULT_WORKER_HARD_DELETE_VERSION_PURGE_ENABLED
  };
}

export function resolveGraphConfig(
  config: Pick<RuntimeConfig, "graph">
): GraphRuntimeConfig {
  return {
    ...createDefaultGraphConfig(),
    ...(config.graph ?? {})
  };
}

function createDefaultOkfConfig(): RuntimeConfig["okf"] {
  return {
    log: {
      maxEntries: DEFAULT_OKF_LOG_MAX_ENTRIES,
      maxBytes: DEFAULT_OKF_LOG_MAX_BYTES
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

function parseSecurityConfig(
  env: RuntimeEnv,
  input: {
    adminPassword: string;
    ports: RuntimeConfig["ports"];
    publicBaseUrl: string;
    storageCredentials: string[];
    model: RuntimeConfig["model"];
  },
  issues: string[]
): RuntimeSecurityConfig {
  const environment = parseEnvironment(env, issues);
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

  if (cookieSameSite === "None" && !cookieSecure) {
    issues.push("ADMIN_SESSION_COOKIE_SAME_SITE=None requires ADMIN_SESSION_COOKIE_SECURE=true");
  }

  if (environment === "production") {
    validateProductionSecurity({
      adminPassword: input.adminPassword,
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
      cookieSecure,
      cookieSameSite
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
  storageCredentials: string[];
  model: RuntimeConfig["model"];
  cookieSecure: boolean;
  origins: string[];
  allowedHosts: string[];
  issues: string[];
}) {
  const placeholderChecks: Array<[string, string | null]> = [
    ["ADMIN_PASSWORD", input.adminPassword],
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
