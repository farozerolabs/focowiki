import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { parseRuntimeConfig } from "../src/config.js";
import { createStorageVnextOwnedScopeProof } from "../src/storage-vnext/bootstrap/owned-scope.js";

const validEnv = {
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "admin-password",
  DATABASE_URL: "postgres://focowiki:focowiki@127.0.0.1:5432/focowiki",
  REDIS_URL: "redis://127.0.0.1:6379/0",
  SEARCH_PROVIDER: "meilisearch",
  SEARCH_INDEX_PREFIX: "focowiki_test",
  MEILI_HOST: "http://127.0.0.1:7700",
  MEILI_API_KEY: "development-search-key",
  MEILI_METRICS_API_KEY: "development-search-metrics-key",
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
  describe("search provider startup configuration", () => {
    it("requires an explicit supported provider and common index prefix", () => {
      expect(() =>
        parseRuntimeConfig({
          ...validEnv,
          SEARCH_PROVIDER: ""
        })
      ).toThrow(/SEARCH_PROVIDER/);

      expect(() =>
        parseRuntimeConfig({
          ...validEnv,
          SEARCH_PROVIDER: "elasticsearch"
        })
      ).toThrow(/SEARCH_PROVIDER/);

      expect(() =>
        parseRuntimeConfig({
          ...validEnv,
          SEARCH_INDEX_PREFIX: ""
        })
      ).toThrow(/SEARCH_INDEX_PREFIX/);

      expect(() =>
        parseRuntimeConfig({
          ...validEnv,
          SEARCH_INDEX_PREFIX: "Invalid Prefix"
        })
      ).toThrow(/SEARCH_INDEX_PREFIX/);
    });

    it("validates and exposes only the selected Meilisearch configuration", () => {
      const config = parseRuntimeConfig({
        ...validEnv,
        SEARCH_PROVIDER: "meilisearch",
        SEARCH_INDEX_PREFIX: "shared_search",
        MEILI_INDEX_PREFIX: undefined,
        OPENSEARCH_URL: "not-a-url",
        OPENSEARCH_AUTH_MODE: "invalid"
      });

      expect(config.search).toEqual({
        provider: "meilisearch",
        endpoint: "http://127.0.0.1:7700",
        apiKey: "development-search-key",
        metricsApiKey: "development-search-metrics-key",
        indexPrefix: "shared_search"
      });
    });

    it("validates and exposes only the selected OpenSearch configuration", () => {
      const config = parseRuntimeConfig({
        ...validEnv,
        SEARCH_PROVIDER: "opensearch",
        SEARCH_INDEX_PREFIX: "shared_search",
        MEILI_HOST: undefined,
        MEILI_API_KEY: undefined,
        MEILI_METRICS_API_KEY: undefined,
        MEILI_INDEX_PREFIX: undefined,
        OPENSEARCH_URL: "http://127.0.0.1:9200",
        OPENSEARCH_AUTH_MODE: "none"
      });

      expect(config.search).toEqual({
        provider: "opensearch",
        endpoint: "http://127.0.0.1:9200",
        indexPrefix: "shared_search",
        auth: {
          mode: "none"
        },
        tls: {}
      });
    });

    it("rejects unauthenticated OpenSearch in production", () => {
      expect(() =>
        parseRuntimeConfig({
          ...validEnv,
          APP_ENV: "production",
          ADMIN_PASSWORD: "production-admin-password",
          ADMIN_PUBLIC_ORIGIN: "https://admin.example.com",
          ADMIN_API_PUBLIC_ORIGIN: "https://api.example.com",
          PUBLIC_OPENAPI_PUBLIC_ORIGIN: "https://openapi.example.com",
          ALLOWED_HOSTS: "admin.example.com,api.example.com,openapi.example.com",
          S3_ACCESS_KEY_ID: "production-storage-access",
          S3_SECRET_ACCESS_KEY: "production-storage-secret",
          SEARCH_PROVIDER: "opensearch",
          OPENSEARCH_URL: "https://search.example.com",
          OPENSEARCH_AUTH_MODE: "none"
        })
      ).toThrow(/OPENSEARCH_AUTH_MODE/);
    });

    it("loads OpenSearch basic auth and private CA with secret-file precedence", () => {
      const directory = mkdtempSync(join(tmpdir(), "focowiki-opensearch-secrets-"));
      const passwordFile = join(directory, "runtime-password");
      const caFile = join(directory, "root-ca.pem");
      writeFileSync(passwordFile, "file-password\n", { mode: 0o600 });
      writeFileSync(caFile, "test-ca\n", { mode: 0o600 });

      const config = parseRuntimeConfig({
        ...validEnv,
        SEARCH_PROVIDER: "opensearch",
        OPENSEARCH_URL: "https://search.example.com",
        OPENSEARCH_AUTH_MODE: "basic",
        OPENSEARCH_USERNAME: "runtime-user",
        OPENSEARCH_PASSWORD: "ignored-direct-password",
        OPENSEARCH_PASSWORD_FILE: passwordFile,
        OPENSEARCH_CA_FILE: caFile
      });

      expect(config.search).toEqual({
        provider: "opensearch",
        endpoint: "https://search.example.com",
        indexPrefix: "focowiki_test",
        auth: {
          mode: "basic",
          username: "runtime-user",
          password: "file-password"
        },
        tls: { caFile }
      });
      expect(config.search).not.toHaveProperty("bootstrap");

      writeFileSync(passwordFile, "rotated-file-password\n", { mode: 0o600 });
      const rotated = parseRuntimeConfig({
        ...validEnv,
        SEARCH_PROVIDER: "opensearch",
        OPENSEARCH_URL: "https://search.example.com",
        OPENSEARCH_AUTH_MODE: "basic",
        OPENSEARCH_USERNAME: "runtime-user",
        OPENSEARCH_PASSWORD_FILE: passwordFile,
        OPENSEARCH_CA_FILE: caFile
      });
      expect(rotated.search).toMatchObject({
        auth: {
          mode: "basic",
          username: "runtime-user",
          password: "rotated-file-password"
        }
      });
    });

    it.each(["es", "aoss"] as const)(
      "loads renewable AWS SigV4 metadata for %s",
      (service) => {
        const config = parseRuntimeConfig({
          ...validEnv,
          SEARCH_PROVIDER: "opensearch",
          OPENSEARCH_URL: "https://search.us-east-1.amazonaws.com",
          OPENSEARCH_AUTH_MODE: "aws_sigv4",
          OPENSEARCH_AWS_REGION: "us-east-1",
          OPENSEARCH_AWS_SERVICE: service
        });

        expect(config.search).toMatchObject({
          provider: "opensearch",
          auth: {
            mode: "aws_sigv4",
            region: "us-east-1",
            service
          }
        });
      }
    );

    it("validates only fields required by the selected OpenSearch auth mode", () => {
      expect(() => parseRuntimeConfig({
        ...validEnv,
        SEARCH_PROVIDER: "opensearch",
        OPENSEARCH_URL: "",
        OPENSEARCH_AUTH_MODE: "basic",
        OPENSEARCH_USERNAME: "",
        OPENSEARCH_PASSWORD: ""
      })).toThrow(/OPENSEARCH_URL.*OPENSEARCH_USERNAME.*OPENSEARCH_PASSWORD/su);

      expect(() => parseRuntimeConfig({
        ...validEnv,
        SEARCH_PROVIDER: "opensearch",
        OPENSEARCH_URL: "https://search.example.com",
        OPENSEARCH_AUTH_MODE: "aws_sigv4",
        OPENSEARCH_AWS_REGION: "",
        OPENSEARCH_AWS_SERVICE: "execute-api"
      })).toThrow(/OPENSEARCH_AWS_REGION.*OPENSEARCH_AWS_SERVICE/su);

      expect(() => parseRuntimeConfig({
        ...validEnv,
        SEARCH_PROVIDER: "opensearch",
        OPENSEARCH_URL: "https://runtime-user:runtime-password@search.example.com",
        OPENSEARCH_AUTH_MODE: "none"
      })).toThrow(/OPENSEARCH_URL/);
    });

    it("resolves an identical provider descriptor for every runtime role", () => {
      const roles = [
        "api",
        "source-worker",
        "publication-worker",
        "maintenance-worker",
        "migration",
        "validation"
      ];
      const descriptors = roles.map((role) =>
        parseRuntimeConfig({
          ...validEnv,
          FOCOWIKI_RUNTIME_ROLE: role
        }).search
      );

      expect(descriptors).toEqual(roles.map(() => descriptors[0]));
      expect(descriptors[0]).toMatchObject({
        provider: "meilisearch",
        indexPrefix: "focowiki_test"
      });
    });
  });

  it("parses required runtime settings", () => {
    const config = parseRuntimeConfig(validEnv);

    expect(config.admin).toEqual({
      username: "admin",
      password: "admin-password"
    });
    expect(config.database).toEqual({
      url: "postgres://focowiki:focowiki@127.0.0.1:5432/focowiki",
      poolMax: 10,
      sourceWorkerPoolMax: 6,
      publicationWorkerPoolMax: 4,
      maintenanceWorkerPoolMax: 2
    });
    expect(config.redis).toEqual({
      url: "redis://127.0.0.1:6379/0",
      keyPrefix: "focowiki"
    });
    expect(config.search).toEqual({
      provider: "meilisearch",
      endpoint: "http://127.0.0.1:7700",
      apiKey: "development-search-key",
      metricsApiKey: "development-search-metrics-key",
      indexPrefix: "focowiki_test"
    });
    expect(config).not.toHaveProperty("meiliMasterKey");
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
    expect(config).not.toHaveProperty("upload");
    expect(config.publication).toEqual({
      mode: "batch",
      batchSize: 300,
      intervalSeconds: 300,
      roleConcurrency: 1,
      claimBatchSize: 1,
      impactBatchSize: 100,
      impactConcurrency: 8,
      dirtyFileHardCount: 2_000,
      dirtyFileResumeCount: 1_000,
      dirtyAgeHardSeconds: 900,
      dirtyAgeResumeSeconds: 300,
      pendingImpactHardCount: 20_000,
      pendingImpactResumeCount: 10_000,
      indexShardSize: 1_000,
      linkIndexShardSize: 1_000,
      manifestShardSize: 1_000,
      directoryIndexMaxEntries: 200,
      directoryIndexMaxBytes: 65_536,
      graphMaintenanceBatchSize: 500,
      rootSummaryLimit: 500
    });
    expect(config.graph).toEqual({
      candidateLimit: 200,
      acceptedEdgeLimit: 50,
      searchDefaultDepth: 1,
      searchMaxDepth: 2,
      searchDefaultFanout: 10,
      searchMaxFanout: 25,
      modelReviewEnabled: true,
      publicationShardSize: 5_000,
      cacheTtlSeconds: 5,
      genericPhraseThreshold: 4
    });
    expect(config.worker).toEqual({
      sourceFileConcurrency: 2,
      claimBatchSize: 10,
      pollIntervalMs: 1_000,
      lockTtlSeconds: 900,
      jobMaxAttempts: 3,
      jobRetryDelayMs: 30_000,
      sourceQueueHardDepth: 5_000,
      sourceQueueResumeDepth: 3_000,
      sourceQueueHardAgeSeconds: 3_600,
      sourceQueueResumeAgeSeconds: 1_800,
      heartbeatIntervalMs: 15_000,
      shutdownGraceMs: 30_000,
      completedJobRetentionDays: 7,
      failedJobRetentionDays: 30,
      deadLetterJobRetentionDays: 90,
      retentionCleanupBatchSize: 1_000,
      hardDeleteConcurrency: 1,
      hardDeleteDatabaseBatchSize: 1_000,
      hardDeleteObjectBatchSize: 1_000,
      hardDeleteMaxAttempts: 3,
      hardDeleteRetryDelayMs: 60_000,
      hardDeleteFailedRetentionDays: 30
    });
    expect(config.logging).toEqual({
      level: "debug",
      file: {
        directory: resolve(process.cwd(), "logs"),
        maxBytes: 10_485_760,
        maxFiles: 5,
        maxTotalBytes: 1_073_741_824,
        retentionDays: 7
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

  it("accepts an isolated Redis key prefix", () => {
    const config = parseRuntimeConfig({
      ...validEnv,
      REDIS_KEY_PREFIX: "focowiki:validation:svnext-owned"
    });

    expect(config.redis.keyPrefix).toBe("focowiki:validation:svnext-owned");
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

  it("validates search endpoint and production scoped credentials", () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        MEILI_HOST: "file:///tmp/search"
      })
    ).toThrow(/MEILI_HOST/);

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        APP_ENV: "production",
        ADMIN_PASSWORD: "production-admin-password",
        ADMIN_PUBLIC_ORIGIN: "https://admin.example.com",
        ADMIN_API_PUBLIC_ORIGIN: "https://api.example.com",
        PUBLIC_OPENAPI_PUBLIC_ORIGIN: "https://openapi.example.com",
        ALLOWED_HOSTS: "admin.example.com,api.example.com,openapi.example.com",
        MEILI_API_KEY: ""
      })
    ).toThrow(/MEILI_API_KEY/);

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        APP_ENV: "production",
        ADMIN_PASSWORD: "production-admin-password",
        ADMIN_PUBLIC_ORIGIN: "https://admin.example.com",
        ADMIN_API_PUBLIC_ORIGIN: "https://api.example.com",
        PUBLIC_OPENAPI_PUBLIC_ORIGIN: "https://openapi.example.com",
        ALLOWED_HOSTS: "admin.example.com,api.example.com,openapi.example.com",
        MEILI_METRICS_API_KEY: ""
      })
    ).toThrow(/MEILI_METRICS_API_KEY/);
  });

  it("accepts the canonical run-owned Meilisearch namespace", () => {
    const proof = createStorageVnextOwnedScopeProof({
      runId: "svnext-20260802T101443Z-7aa18b22cafe",
      nonceHash: "a".repeat(64),
      createdAt: "2026-08-02T02:14:43.000Z",
      filesystemScope: join(
        tmpdir(),
        "svnext-20260802T101443Z-7aa18b22cafe"
      )
    });

    expect(() => parseRuntimeConfig({
      ...validEnv,
      SEARCH_INDEX_PREFIX: proof.searchScope
    })).not.toThrow();
  });

  it("loads production search credentials from runtime secret files", () => {
    const directory = mkdtempSync(join(tmpdir(), "focowiki-search-secrets-"));
    const apiKeyFile = join(directory, "meilisearch-api-key");
    const metricsKeyFile = join(directory, "meilisearch-metrics-key");
    writeFileSync(apiKeyFile, "runtime-search-key\n", { mode: 0o600 });
    writeFileSync(metricsKeyFile, "runtime-metrics-key\n", { mode: 0o600 });

    const config = parseRuntimeConfig({
      ...validEnv,
      APP_ENV: "production",
      ADMIN_PASSWORD: "production-admin-password",
      ADMIN_PUBLIC_ORIGIN: "https://admin.example.com",
      ADMIN_API_PUBLIC_ORIGIN: "https://api.example.com",
      PUBLIC_OPENAPI_PUBLIC_ORIGIN: "https://openapi.example.com",
      ALLOWED_HOSTS: "admin.example.com,api.example.com,openapi.example.com",
      S3_ACCESS_KEY_ID: "production-storage-access",
      S3_SECRET_ACCESS_KEY: "production-storage-secret",
      MEILI_API_KEY: "",
      MEILI_METRICS_API_KEY: "",
      MEILI_API_KEY_FILE: apiKeyFile,
      MEILI_METRICS_API_KEY_FILE: metricsKeyFile
    });

    expect(config.search).toMatchObject({
      apiKey: "runtime-search-key",
      metricsApiKey: "runtime-metrics-key"
    });
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
        maxFiles: 5,
        maxTotalBytes: 1_073_741_824,
        retentionDays: 7
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
        maxFiles: 5,
        maxTotalBytes: 1_073_741_824,
        retentionDays: 7
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
        maxFiles: 5,
        maxTotalBytes: 1_073_741_824,
        retentionDays: 7
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
      maxFiles: 5,
      maxTotalBytes: 1_073_741_824,
      retentionDays: 7
    });

    expect(
      parseRuntimeConfig({
        ...validEnv,
        LOG_FILE_DIR: "runtime-logs",
        LOG_FILE_MAX_BYTES: "1024",
        LOG_FILE_MAX_FILES: "3",
        LOG_FILE_MAX_TOTAL_BYTES: "4096",
        LOG_FILE_RETENTION_DAYS: "2"
      }).logging?.file
    ).toEqual({
      directory: resolve(process.cwd(), "runtime-logs"),
      maxBytes: 1_024,
      maxFiles: 3,
      maxTotalBytes: 4_096,
      retentionDays: 2
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
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        LOG_FILE_MAX_BYTES: "1024",
        LOG_FILE_MAX_TOTAL_BYTES: "512"
      })
    ).toThrow(/LOG_FILE_MAX_TOTAL_BYTES/);
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        LOG_FILE_RETENTION_DAYS: "0"
      })
    ).toThrow(/LOG_FILE_RETENTION_DAYS/);
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

  it("does not expose upload admission settings", () => {
    expect(parseRuntimeConfig(validEnv)).not.toHaveProperty("upload");
    expect(parseRuntimeConfig(validEnv).security?.rateLimits).not.toHaveProperty("upload");
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

  it("parses startup-only database pools independently from runtime worker settings", () => {
    expect(
      parseRuntimeConfig({
        ...validEnv,
        DATABASE_POOL_MAX: "16",
        SOURCE_WORKER_DATABASE_POOL_MAX: "9",
        PUBLICATION_WORKER_DATABASE_POOL_MAX: "7",
        MAINTENANCE_WORKER_DATABASE_POOL_MAX: "5",
        WORKER_SOURCE_FILE_CONCURRENCY: "3",
        WORKER_CLAIM_BATCH_SIZE: "12",
        WORKER_HEARTBEAT_INTERVAL_MS: "10000",
        WORKER_COMPLETED_JOB_RETENTION_DAYS: "3",
        WORKER_FAILED_JOB_RETENTION_DAYS: "14",
        WORKER_DEAD_LETTER_JOB_RETENTION_DAYS: "45",
        WORKER_RETENTION_CLEANUP_BATCH_SIZE: "500"
      })
    ).toMatchObject({
      database: {
      poolMax: 16,
      sourceWorkerPoolMax: 9,
      publicationWorkerPoolMax: 7,
      maintenanceWorkerPoolMax: 5
      },
      worker: {
        sourceFileConcurrency: 2,
        claimBatchSize: 10,
        heartbeatIntervalMs: 15_000,
        sourceQueueHardDepth: 5_000,
        sourceQueueResumeDepth: 3_000,
        sourceQueueHardAgeSeconds: 3_600,
        sourceQueueResumeAgeSeconds: 1_800,
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
    expect(parseRuntimeConfig({ ...validEnv, WORKER_DATABASE_POOL_MAX: "-1" }).database).toEqual({
      url: validEnv.DATABASE_URL,
      poolMax: 10,
      sourceWorkerPoolMax: 6,
      publicationWorkerPoolMax: 4,
      maintenanceWorkerPoolMax: 2
    });
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        PUBLICATION_WORKER_DATABASE_POOL_MAX: "-1"
      })
    ).toThrow(/PUBLICATION_WORKER_DATABASE_POOL_MAX/);
  });

  it("uses default publication settings managed by runtime settings", () => {
    expect(parseRuntimeConfig(validEnv).publication).toEqual({
      mode: "batch",
      batchSize: 300,
      intervalSeconds: 300,
      roleConcurrency: 1,
      claimBatchSize: 1,
      impactBatchSize: 100,
      impactConcurrency: 8,
      dirtyFileHardCount: 2_000,
      dirtyFileResumeCount: 1_000,
      dirtyAgeHardSeconds: 900,
      dirtyAgeResumeSeconds: 300,
      pendingImpactHardCount: 20_000,
      pendingImpactResumeCount: 10_000,
      indexShardSize: 1_000,
      linkIndexShardSize: 1_000,
      manifestShardSize: 1_000,
      directoryIndexMaxEntries: 200,
      directoryIndexMaxBytes: 65_536,
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
      roleConcurrency: 1,
      claimBatchSize: 1,
      impactBatchSize: 100,
      impactConcurrency: 8,
      dirtyFileHardCount: 2_000,
      dirtyFileResumeCount: 1_000,
      dirtyAgeHardSeconds: 900,
      dirtyAgeResumeSeconds: 300,
      pendingImpactHardCount: 20_000,
      pendingImpactResumeCount: 10_000,
      indexShardSize: 1_000,
      linkIndexShardSize: 1_000,
      manifestShardSize: 1_000,
      directoryIndexMaxEntries: 200,
      directoryIndexMaxBytes: 65_536,
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
