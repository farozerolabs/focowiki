import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { parseRuntimeConfig } from "../src/config.js";

const validEnv = {
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "admin-password",
  DATABASE_URL: "postgres://focowiki:focowiki@127.0.0.1:5432/focowiki",
  REDIS_URL: "redis://127.0.0.1:6379/0",
  ADMIN_API_PORT: "43000",
  ADMIN_UI_PORT: "43100",
  PUBLIC_OPENAPI_PORT: "43200",
  PUBLIC_BASE_URL: "https://kb.example.com/base",
  S3_ENDPOINT: "https://s3.example.com",
  S3_REGION: "us-east-1",
  S3_BUCKET: "focowiki",
  S3_ACCESS_KEY_ID: "s3-access-key",
  S3_SECRET_ACCESS_KEY: "s3-secret-key",
  S3_PREFIX: "tenant/demo",
  CORS_ORIGINS: "https://admin.example.com,https://docs.example.com"
};

describe("parseRuntimeConfig", () => {
  it("parses required runtime settings", () => {
    const config = parseRuntimeConfig(validEnv);

    expect(config.admin).toEqual({
      username: "admin",
      password: "admin-password"
    });
    expect(config.database).toEqual({
      url: "postgres://focowiki:focowiki@127.0.0.1:5432/focowiki",
      poolMax: 10
    });
    expect(config.redis.url).toBe("redis://127.0.0.1:6379/0");
    expect(config.ports).toEqual({
      adminApi: 43_000,
      adminUi: 43_100,
      publicOpenApi: 43_200
    });
    expect(config.publicApi.baseUrl).toBe("https://kb.example.com/base");
    expect(config.storage).toMatchObject({
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "focowiki",
      accessKeyId: "s3-access-key",
      secretAccessKey: "s3-secret-key",
      prefix: "tenant/demo"
    });
    expect(config.upload).toEqual({
      maxBytes: 1_048_576,
      maxFiles: 24,
      generationBatchSize: 50,
      fileProcessingConcurrency: 1,
      storageConcurrency: 4
    });
    expect(config.publication).toEqual({
      mode: "batch",
      batchSize: 300,
      intervalSeconds: 300,
      indexShardSize: 1_000,
      linkIndexShardSize: 1_000,
      manifestShardSize: 1_000,
      graphEdgeShardSize: 5_000,
      graphCandidateLimit: 200,
      graphMaintenanceBatchSize: 500,
      rootSummaryLimit: 500
    });
    expect(config.worker).toEqual({
      databasePoolMax: 6,
      sourceFileConcurrency: 2,
      claimBatchSize: 10,
      pollIntervalMs: 1_000,
      lockTtlSeconds: 900,
      jobMaxAttempts: 3,
      jobRetryDelayMs: 30_000,
      queueBackpressureLimit: 5_000,
      queueBackpressureKnowledgeBaseLimit: 2_000,
      queueBackpressureMaxAgeSeconds: 3_600,
      queueBackpressureRetryAfterSeconds: 60,
      heartbeatIntervalMs: 15_000,
      shutdownGraceMs: 30_000,
      completedJobRetentionDays: 7,
      failedJobRetentionDays: 30,
      deadLetterJobRetentionDays: 90,
      retentionCleanupBatchSize: 1_000
    });
    expect(config.logging).toEqual({
      level: "debug",
      file: {
        directory: resolve(process.cwd(), "logs"),
        maxBytes: 10_485_760,
        maxFiles: 5
      }
    });
    expect(config.okf).toEqual({
      log: {
        maxEntries: 100,
        maxBytes: 65_536
      }
    });
    expect("i18n" in config).toBe(false);
    expect(config.corsOrigins).toEqual([
      "https://admin.example.com",
      "https://docs.example.com"
    ]);
  });

  it("parses public OpenAPI URL while leaving key management to the database", () => {
    const config = parseRuntimeConfig({
      ...validEnv,
      PUBLIC_BASE_URL: "https://docs.example.com/kb/"
    });

    expect(config.publicApi).toEqual({
      baseUrl: "https://docs.example.com/kb"
    });
  });

  it("rejects deprecated env-based public OpenAPI key settings", () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        PUBLIC_API_AUTH_REQUIRED: "false"
      })
    ).toThrow(/PUBLIC_API_AUTH_REQUIRED/);

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        PUBLIC_API_KEY: "reader-secret"
      })
    ).toThrow(/PUBLIC_API_KEY/);
  });

  it("reports secret-safe validation errors for missing required settings", () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        ADMIN_USERNAME: "",
        S3_SECRET_ACCESS_KEY: ""
      })
    ).toThrow(/ADMIN_USERNAME/);

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        S3_ACCESS_KEY_ID: "visible-access-key"
      })
    ).not.toThrow(/visible-access-key/);
  });

  it("requires Redis for production admin state", () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        REDIS_URL: ""
      })
    ).toThrow(/REDIS_URL/);
  });

  it("validates Redis URLs", () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        REDIS_URL: "https://redis.example.com"
      })
    ).toThrow(/REDIS_URL/);
  });

  it("parses conservative security defaults for local deployments", () => {
    const config = parseRuntimeConfig(validEnv);
    const security = config.security;

    expect(security).toMatchObject({
      environment: "development",
      adminTrustedOrigins: [
        "http://localhost:43100",
        "http://127.0.0.1:43100"
      ],
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
          windowSeconds: 3600
        },
        publicOpenApi: {
          max: 1200,
          windowSeconds: 60
        }
      }
    });
    expect(security?.session.cookieSecure).toBe(false);
  });

  it("validates production security settings without echoing secret values", () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        APP_ENV: "production",
        ADMIN_PASSWORD: "change-me",
        ADMIN_PUBLIC_ORIGIN: "https://admin.example.com",
        ADMIN_API_PUBLIC_ORIGIN: "https://api.example.com",
        PUBLIC_OPENAPI_PUBLIC_ORIGIN: "https://openapi.example.com",
        ALLOWED_HOSTS: "admin.example.com,api.example.com,openapi.example.com"
      })
    ).toThrow(/ADMIN_PASSWORD/);

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        APP_ENV: "production",
        ADMIN_PASSWORD: "change-me",
        ADMIN_PUBLIC_ORIGIN: "https://admin.example.com",
        ADMIN_API_PUBLIC_ORIGIN: "https://api.example.com",
        PUBLIC_OPENAPI_PUBLIC_ORIGIN: "https://openapi.example.com",
        ALLOWED_HOSTS: "admin.example.com,api.example.com,openapi.example.com"
      })
    ).not.toThrow(/change-me/);
  });

  it("defaults log level by runtime environment and validates explicit values", () => {
    expect(parseRuntimeConfig(validEnv).logging).toEqual({
      level: "debug",
      file: {
        directory: resolve(process.cwd(), "logs"),
        maxBytes: 10_485_760,
        maxFiles: 5
      }
    });
    expect(
      parseRuntimeConfig({
        ...validEnv,
        APP_ENV: "production",
        ADMIN_PASSWORD: "production-admin-password",
        ADMIN_PUBLIC_ORIGIN: "https://admin.example.com",
        ADMIN_API_PUBLIC_ORIGIN: "https://api.example.com",
        PUBLIC_OPENAPI_PUBLIC_ORIGIN: "https://openapi.example.com",
        ALLOWED_HOSTS: "admin.example.com,api.example.com,openapi.example.com",
        S3_ACCESS_KEY_ID: "production-s3-access",
        S3_SECRET_ACCESS_KEY: "production-s3-secret"
      }).logging
    ).toEqual({
      level: "info",
      file: {
        directory: resolve(process.cwd(), "logs"),
        maxBytes: 10_485_760,
        maxFiles: 5
      }
    });
    expect(
      parseRuntimeConfig({
        ...validEnv,
        LOG_LEVEL: "warn"
      }).logging
    ).toEqual({
      level: "warn",
      file: {
        directory: resolve(process.cwd(), "logs"),
        maxBytes: 10_485_760,
        maxFiles: 5
      }
    });

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        LOG_LEVEL: "trace"
      })
    ).toThrow(/LOG_LEVEL/);
  });

  it("defaults, resolves, and validates file logging settings", () => {
    expect(parseRuntimeConfig(validEnv).logging?.file).toEqual({
      directory: resolve(process.cwd(), "logs"),
      maxBytes: 10_485_760,
      maxFiles: 5
    });

    expect(
      parseRuntimeConfig({
        ...validEnv,
        LOG_FILE_DIR: "runtime-logs",
        LOG_FILE_MAX_BYTES: "1024",
        LOG_FILE_MAX_FILES: "3"
      }).logging?.file
    ).toEqual({
      directory: resolve(process.cwd(), "runtime-logs"),
      maxBytes: 1_024,
      maxFiles: 3
    });

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        LOG_FILE_MAX_BYTES: "0"
      })
    ).toThrow(/LOG_FILE_MAX_BYTES/);
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        LOG_FILE_MAX_FILES: "-1"
      })
    ).toThrow(/LOG_FILE_MAX_FILES/);
  });

  it("validates trusted origins and CORS settings", () => {
    const config = parseRuntimeConfig({
      ...validEnv,
      ADMIN_TRUSTED_ORIGINS: "https://admin.example.com"
    });

    expect(config.security?.adminTrustedOrigins).toEqual(["https://admin.example.com"]);
    expect(config.security?.rateLimits.adminLogin).toEqual({
      max: 8,
      windowSeconds: 900
    });
    expect(config.security?.rateLimits.publicOpenApi).toEqual({
      max: 1200,
      windowSeconds: 60
    });

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        ADMIN_TRUSTED_ORIGINS: "not-a-url"
      })
    ).toThrow(/ADMIN_TRUSTED_ORIGINS/);

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        CORS_ORIGINS: "*"
      })
    ).toThrow(/CORS_ORIGINS/);

    expect(
      parseRuntimeConfig({
        ...validEnv,
        ADMIN_LOGIN_RATE_LIMIT_MAX: "0"
      }).security?.rateLimits.adminLogin
    ).toEqual({
      max: 8,
      windowSeconds: 900
    });
  });

  it("validates separated high ports", () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        ADMIN_API_PORT: "80"
      })
    ).toThrow(/ADMIN_API_PORT/);

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        ADMIN_API_PORT: "43000",
        ADMIN_UI_PORT: "43000"
      })
    ).toThrow(/distinct/);
  });

  it("defaults admin pagination configuration", () => {
    const config = parseRuntimeConfig(validEnv);

    expect(config.pagination).toEqual({
      defaultPageSize: 50,
      maxPageSize: 200,
      treeDefaultPageSize: 100,
      treeMaxPageSize: 500,
      cursorTtlSeconds: 900,
      generatedContentMaxBytes: 10_485_760
    });
  });

  it("parses bounded pagination and generated content read limits", () => {
    const config = parseRuntimeConfig({
      ...validEnv,
      ADMIN_LIST_DEFAULT_PAGE_SIZE: "75",
      ADMIN_LIST_MAX_PAGE_SIZE: "250",
      TREE_CHILD_DEFAULT_PAGE_SIZE: "120",
      TREE_CHILD_MAX_PAGE_SIZE: "600",
      PAGINATION_CURSOR_TTL_SECONDS: "1200",
      GENERATED_CONTENT_MAX_BYTES: "2097152"
    });

    expect(config.pagination).toEqual({
      defaultPageSize: 75,
      maxPageSize: 250,
      treeDefaultPageSize: 120,
      treeMaxPageSize: 600,
      cursorTtlSeconds: 1200,
      generatedContentMaxBytes: 2_097_152
    });
  });

  it("rejects pagination defaults larger than maximums", () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        ADMIN_LIST_DEFAULT_PAGE_SIZE: "201",
        ADMIN_LIST_MAX_PAGE_SIZE: "200"
      })
    ).toThrow(/ADMIN_LIST_DEFAULT_PAGE_SIZE/);

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        TREE_CHILD_DEFAULT_PAGE_SIZE: "501",
        TREE_CHILD_MAX_PAGE_SIZE: "500"
      })
    ).toThrow(/TREE_CHILD_DEFAULT_PAGE_SIZE/);
  });

  it("does not require upload-generation env fields and ignores invalid stale values", () => {
    expect(parseRuntimeConfig(validEnv).upload).toEqual({
      maxBytes: 1_048_576,
      maxFiles: 24,
      generationBatchSize: 50,
      fileProcessingConcurrency: 1,
      storageConcurrency: 4
    });
    expect(
      parseRuntimeConfig({
        ...validEnv,
        MAX_UPLOAD_BYTES: "0",
        MAX_UPLOAD_FILES: "-1",
        GENERATION_BATCH_SIZE: "invalid",
        UPLOAD_FILE_PROCESSING_CONCURRENCY: "-1",
        UPLOAD_STORAGE_CONCURRENCY: "0"
      }).upload
    ).toEqual({
      maxBytes: 1_048_576,
      maxFiles: 24,
      generationBatchSize: 50,
      fileProcessingConcurrency: 1,
      storageConcurrency: 4
    });
  });

  it("uses default OKF log limits managed by runtime settings", () => {
    expect(parseRuntimeConfig(validEnv).okf).toEqual({
      log: {
        maxEntries: 100,
        maxBytes: 65_536
      }
    });
    expect(
      parseRuntimeConfig({
        ...validEnv,
        OKF_LOG_MAX_ENTRIES: "50",
        OKF_LOG_MAX_BYTES: "32768"
      }).okf
    ).toEqual({
      log: {
        maxEntries: 100,
        maxBytes: 65_536
      }
    });
  });

  it("parses stale upload-generation env values for bootstrap and the startup-only worker database pool", () => {
    expect(parseRuntimeConfig(validEnv).upload).toMatchObject({
      fileProcessingConcurrency: 1,
      storageConcurrency: 4
    });
    expect(
      parseRuntimeConfig({
        ...validEnv,
        UPLOAD_FILE_PROCESSING_CONCURRENCY: "4",
        UPLOAD_STORAGE_CONCURRENCY: "6",
        MAX_UPLOAD_BYTES: "2097152",
        MAX_UPLOAD_FILES: "12",
        GENERATION_BATCH_SIZE: "80",
        DATABASE_POOL_MAX: "16",
        WORKER_DATABASE_POOL_MAX: "8",
        WORKER_SOURCE_FILE_CONCURRENCY: "3",
        WORKER_CLAIM_BATCH_SIZE: "12",
        WORKER_HEARTBEAT_INTERVAL_MS: "10000",
        WORKER_QUEUE_BACKPRESSURE_KB_LIMIT: "300",
        WORKER_QUEUE_BACKPRESSURE_MAX_AGE_SECONDS: "1800",
        WORKER_QUEUE_BACKPRESSURE_RETRY_AFTER_SECONDS: "30",
        WORKER_COMPLETED_JOB_RETENTION_DAYS: "3",
        WORKER_FAILED_JOB_RETENTION_DAYS: "14",
        WORKER_DEAD_LETTER_JOB_RETENTION_DAYS: "45",
        WORKER_RETENTION_CLEANUP_BATCH_SIZE: "500"
      })
    ).toMatchObject({
      database: {
        poolMax: 16
      },
      upload: {
        maxBytes: 2_097_152,
        maxFiles: 12,
        generationBatchSize: 80,
        fileProcessingConcurrency: 4,
        storageConcurrency: 6
      },
      worker: {
        databasePoolMax: 8,
        sourceFileConcurrency: 2,
        claimBatchSize: 10,
        heartbeatIntervalMs: 15_000,
        queueBackpressureKnowledgeBaseLimit: 2_000,
        queueBackpressureMaxAgeSeconds: 3_600,
        queueBackpressureRetryAfterSeconds: 60,
        completedJobRetentionDays: 7,
        failedJobRetentionDays: 30,
        deadLetterJobRetentionDays: 90,
        retentionCleanupBatchSize: 1_000
      }
    });

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        DATABASE_POOL_MAX: "0"
      })
    ).toThrow(/DATABASE_POOL_MAX/);
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        WORKER_DATABASE_POOL_MAX: "-1"
      })
    ).toThrow(/WORKER_DATABASE_POOL_MAX/);
  });

  it("uses default publication settings managed by runtime settings", () => {
    expect(parseRuntimeConfig(validEnv).publication).toEqual({
      mode: "batch",
      batchSize: 300,
      intervalSeconds: 300,
      indexShardSize: 1_000,
      linkIndexShardSize: 1_000,
      manifestShardSize: 1_000,
      graphEdgeShardSize: 5_000,
      graphCandidateLimit: 200,
      graphMaintenanceBatchSize: 500,
      rootSummaryLimit: 500
    });
    expect(
      parseRuntimeConfig({
        ...validEnv,
        PUBLICATION_MODE: "manual",
        PUBLICATION_BATCH_SIZE: "400",
        PUBLICATION_INTERVAL_SECONDS: "120",
        INDEX_SHARD_SIZE: "2000",
        LINK_INDEX_SHARD_SIZE: "3000",
        MANIFEST_SHARD_SIZE: "4000",
        GRAPH_EDGE_SHARD_SIZE: "6000",
        GRAPH_CANDIDATE_LIMIT: "150",
        GRAPH_MAINTENANCE_BATCH_SIZE: "350",
        ROOT_SUMMARY_LIMIT: "450"
      }).publication
    ).toEqual({
      mode: "batch",
      batchSize: 300,
      intervalSeconds: 300,
      indexShardSize: 1_000,
      linkIndexShardSize: 1_000,
      manifestShardSize: 1_000,
      graphEdgeShardSize: 5_000,
      graphCandidateLimit: 200,
      graphMaintenanceBatchSize: 500,
      rootSummaryLimit: 500
    });
  });

  it("keeps model assistance managed by Admin UI even when stale model env fields exist", () => {
    const config = parseRuntimeConfig({
      ...validEnv,
      MODEL_API_KEY: "model-secret",
      MODEL_NAME: "gpt-5.2",
      MODEL_BASE_URL: "https://models.example.com/v1",
      MODEL_CONTEXT_WINDOW_TOKENS: "200000",
      MODEL_REQUEST_MAX_TIMEOUT_MS: "600000",
      MODEL_REQUEST_IDLE_TIMEOUT_MS: "120000",
      MODEL_TRANSIENT_RETRY_DELAY_MS: "45000",
      MODEL_REQUEST_MIN_INTERVAL_MS: "3000",
      MODEL_SUGGESTION_CONCURRENCY: "4"
    });

    expect(config.model).toEqual({ enabled: false });
  });
});
