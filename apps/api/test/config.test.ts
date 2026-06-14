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
  PUBLIC_API_AUTH_REQUIRED: "true",
  PUBLIC_API_KEY: "public-secret",
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
    expect(config.publicApi.authRequired).toBe(true);
    expect(config.publicApi.apiKey).toBe("public-secret");
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
      generationBatchSize: 50
    });
    expect("i18n" in config).toBe(false);
    expect(config.corsOrigins).toEqual([
      "https://admin.example.com",
      "https://docs.example.com"
    ]);
  });

  it("parses public OpenAPI URL and bearer API key settings", () => {
    const config = parseRuntimeConfig({
      ...validEnv,
      PUBLIC_BASE_URL: "https://docs.example.com/kb/",
      PUBLIC_API_AUTH_REQUIRED: "true",
      PUBLIC_API_KEY: "reader-secret"
    });

    expect(config.publicApi).toEqual({
      baseUrl: "https://docs.example.com/kb",
      authRequired: true,
      apiKey: "reader-secret"
    });
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

  it("requires PUBLIC_API_KEY when public reads are private", () => {
    expect(() =>
      parseRuntimeConfig({
        ...validEnv,
        PUBLIC_API_AUTH_REQUIRED: "true",
        PUBLIC_API_KEY: ""
      })
    ).toThrow(/PUBLIC_API_KEY/);
  });

  it("allows anonymous public reads when configured", () => {
    const config = parseRuntimeConfig({
      ...validEnv,
      PUBLIC_API_AUTH_REQUIRED: "false",
      PUBLIC_API_KEY: ""
    });

    expect(config.publicApi.authRequired).toBe(false);
    expect(config.publicApi.apiKey).toBeNull();
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

  it("enables model assistance when key and model are configured", () => {
    const config = parseRuntimeConfig({
      ...validEnv,
      MODEL_API_KEY: "model-secret",
      MODEL_NAME: "gpt-5.2",
      MODEL_BASE_URL: "https://models.example.com/v1"
    });

    expect(config.model).toEqual({
      enabled: true,
      apiKey: "model-secret",
      modelName: "gpt-5.2",
      baseUrl: "https://models.example.com/v1"
    });
  });

  it("defaults MODEL_BASE_URL to the OpenAI API when omitted", () => {
    const config = parseRuntimeConfig({
      ...validEnv,
      MODEL_API_KEY: "model-secret",
      MODEL_NAME: "gpt-5.2",
      MODEL_BASE_URL: ""
    });

    expect(config.model).toEqual({
      enabled: true,
      apiKey: "model-secret",
      modelName: "gpt-5.2",
      baseUrl: "https://api.openai.com/v1"
    });
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
