import { describe, expect, it } from "vitest";
import { parseRuntimeConfig } from "../src/config.js";

const validEnv = {
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "admin-password",
  ADMIN_SESSION_SECRET: "session-secret-with-enough-entropy",
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
  MAX_UPLOAD_BYTES: "1048576",
  MAX_UPLOAD_FILES: "8",
  CORS_ORIGINS: "https://admin.example.com,https://docs.example.com"
};

describe("parseRuntimeConfig", () => {
  it("parses required runtime settings", () => {
    const config = parseRuntimeConfig(validEnv);

    expect(config.admin).toEqual({
      username: "admin",
      password: "admin-password",
      sessionSecret: "session-secret-with-enough-entropy"
    });
    expect(config.database.url).toBe("postgres://focowiki:focowiki@127.0.0.1:5432/focowiki");
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
      maxFiles: 8,
      generationBatchSize: 50,
      taskConcurrency: 1,
      fileProcessingConcurrency: 1
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
        ADMIN_SESSION_SECRET: "short",
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
        ADMIN_SESSION_SECRET: "short",
        ADMIN_PUBLIC_ORIGIN: "https://admin.example.com",
        ADMIN_API_PUBLIC_ORIGIN: "https://api.example.com",
        PUBLIC_OPENAPI_PUBLIC_ORIGIN: "https://openapi.example.com",
        ALLOWED_HOSTS: "admin.example.com,api.example.com,openapi.example.com"
      })
    ).not.toThrow(/change-me/);
  });

  it("validates trusted origins, CORS, and rate limit settings", () => {
    const config = parseRuntimeConfig({
      ...validEnv,
      ADMIN_TRUSTED_ORIGINS: "https://admin.example.com",
      ADMIN_LOGIN_RATE_LIMIT_MAX: "4",
      ADMIN_LOGIN_RATE_LIMIT_WINDOW_SECONDS: "300",
      PUBLIC_OPENAPI_RATE_LIMIT_MAX: "100",
      PUBLIC_OPENAPI_RATE_LIMIT_WINDOW_SECONDS: "60"
    });

    expect(config.security?.adminTrustedOrigins).toEqual(["https://admin.example.com"]);
    expect(config.security?.rateLimits.adminLogin).toEqual({
      max: 4,
      windowSeconds: 300
    });
    expect(config.security?.rateLimits.publicOpenApi).toEqual({
      max: 100,
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

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        ADMIN_LOGIN_RATE_LIMIT_MAX: "0"
      })
    ).toThrow(/ADMIN_LOGIN_RATE_LIMIT_MAX/);
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
      cursorTtlSeconds: 900
    });
  });

  it("validates admin pagination configuration", () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        ADMIN_LIST_PAGE_SIZE: "201",
        ADMIN_LIST_MAX_PAGE_SIZE: "200"
      })
    ).toThrow(/ADMIN_LIST_PAGE_SIZE/);

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        ADMIN_PAGINATION_CURSOR_TTL_SECONDS: "0"
      })
    ).toThrow(/ADMIN_PAGINATION_CURSOR_TTL_SECONDS/);
  });

  it("validates upload limits", () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        MAX_UPLOAD_BYTES: "0"
      })
    ).toThrow(/MAX_UPLOAD_BYTES/);

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        MAX_UPLOAD_FILES: "-1"
      })
    ).toThrow(/MAX_UPLOAD_FILES/);
  });

  it("defaults and validates OKF log limits", () => {
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
        maxEntries: 50,
        maxBytes: 32_768
      }
    });

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        OKF_LOG_MAX_ENTRIES: "0"
      })
    ).toThrow(/OKF_LOG_MAX_ENTRIES/);
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        OKF_LOG_MAX_BYTES: "-1"
      })
    ).toThrow(/OKF_LOG_MAX_BYTES/);
  });

  it("defaults and validates upload and model concurrency limits", () => {
    expect(parseRuntimeConfig(validEnv).upload).toMatchObject({
      taskConcurrency: 1,
      fileProcessingConcurrency: 1
    });
    expect(
      parseRuntimeConfig({
        ...validEnv,
        UPLOAD_TASK_CONCURRENCY: "2",
        UPLOAD_FILE_PROCESSING_CONCURRENCY: "4"
      }).upload
    ).toMatchObject({
      taskConcurrency: 2,
      fileProcessingConcurrency: 4
    });

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        UPLOAD_TASK_CONCURRENCY: "0"
      })
    ).toThrow(/UPLOAD_TASK_CONCURRENCY/);
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        UPLOAD_FILE_PROCESSING_CONCURRENCY: "-1"
      })
    ).toThrow(/UPLOAD_FILE_PROCESSING_CONCURRENCY/);
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        MODEL_API_KEY: "model-secret",
        MODEL_NAME: "gpt-5.2",
        MODEL_CONTEXT_WINDOW_TOKENS: "200000",
        MODEL_SUGGESTION_CONCURRENCY: "0"
      })
    ).toThrow(/MODEL_SUGGESTION_CONCURRENCY/);
  });

  it("enables model assistance when key and model are configured", () => {
    const config = parseRuntimeConfig({
      ...validEnv,
      MODEL_API_KEY: "model-secret",
      MODEL_NAME: "gpt-5.2",
      MODEL_BASE_URL: "https://models.example.com/v1",
      MODEL_CONTEXT_WINDOW_TOKENS: "200000",
      MODEL_REQUEST_MAX_TIMEOUT_MS: "120000",
      MODEL_REQUEST_IDLE_TIMEOUT_MS: "30000",
      MODEL_SUGGESTION_CONCURRENCY: "4"
    });

    expect(config.model).toEqual({
      enabled: true,
      apiKey: "model-secret",
      modelName: "gpt-5.2",
      baseUrl: "https://models.example.com/v1",
      contextWindowTokens: 200_000,
      requestMaxTimeoutMs: 120_000,
      requestIdleTimeoutMs: 30_000,
      suggestionConcurrency: 4
    });
  });

  it("defaults model base URL, receive timeouts, and suggestion concurrency when omitted", () => {
    const config = parseRuntimeConfig({
      ...validEnv,
      MODEL_API_KEY: "model-secret",
      MODEL_NAME: "gpt-5.2",
      MODEL_BASE_URL: "",
      MODEL_CONTEXT_WINDOW_TOKENS: "200000"
    });

    expect(config.model).toMatchObject({
      enabled: true,
      apiKey: "model-secret",
      modelName: "gpt-5.2",
      baseUrl: "https://api.openai.com/v1",
      contextWindowTokens: 200_000,
      suggestionConcurrency: 2
    });
    expect(config.model.enabled ? config.model.requestMaxTimeoutMs : 0).toBeGreaterThan(0);
    expect(config.model.enabled ? config.model.requestIdleTimeoutMs : 0).toBeGreaterThan(0);
  });

  it("requires and validates model context window and receive timeouts", () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        MODEL_API_KEY: "model-secret",
        MODEL_NAME: "gpt-5.2"
      })
    ).toThrow(/MODEL_CONTEXT_WINDOW_TOKENS/);

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        MODEL_API_KEY: "model-secret",
        MODEL_NAME: "gpt-5.2",
        MODEL_CONTEXT_WINDOW_TOKENS: "0"
      })
    ).toThrow(/MODEL_CONTEXT_WINDOW_TOKENS/);

    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        MODEL_API_KEY: "model-secret",
        MODEL_NAME: "gpt-5.2",
        MODEL_CONTEXT_WINDOW_TOKENS: "200000",
        MODEL_REQUEST_MAX_TIMEOUT_MS: "1000",
        MODEL_REQUEST_IDLE_TIMEOUT_MS: "2000"
      })
    ).toThrow(/MODEL_REQUEST_IDLE_TIMEOUT_MS/);
  });

  it("disables model assistance when either key or model is missing", () => {
    expect(
      parseRuntimeConfig({
        ...validEnv,
        MODEL_API_KEY: "model-secret",
        MODEL_NAME: ""
      }).model
    ).toEqual({ enabled: false });

    expect(
      parseRuntimeConfig({
        ...validEnv,
        MODEL_API_KEY: "",
        MODEL_NAME: "gpt-5.2"
      }).model
    ).toEqual({ enabled: false });
  });
});
