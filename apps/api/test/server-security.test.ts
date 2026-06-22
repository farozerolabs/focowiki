import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/server.js";
import type { RuntimeConfig } from "../src/config.js";
import { createTestRedisCoordinator } from "./support/session.js";

function createProductionConfig(): RuntimeConfig {
  return {
    admin: {
      username: "admin",
      password: "production-admin-password",
      sessionSecret: "production-session-secret-with-enough-entropy"
    },
    database: {
      url: "postgres://focowiki:focowiki@postgres:5432/focowiki"
    },
    redis: {
      url: "redis://redis:6379/0"
    },
    ports: {
      adminApi: 43_000,
      adminUi: 43_100,
      publicOpenApi: 43_200
    },
    publicApi: {
      baseUrl: "https://openapi.example.com"
    },
    storage: {
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "focowiki",
      accessKeyId: "production-s3-access",
      secretAccessKey: "production-s3-secret",
      prefix: "tenant/demo",
      forcePathStyle: true
    },
    upload: {
      maxBytes: 1_048_576,
      maxFiles: 8,
      generationBatchSize: 50,
      taskConcurrency: 1,
      fileProcessingConcurrency: 1,
      storageConcurrency: 4
    },
    publication: {
      mode: "batch",
      batchSize: 300,
      intervalSeconds: 300,
      indexShardSize: 1_000,
      graphEdgeShardSize: 5_000
    },
    pagination: {
      defaultPageSize: 50,
      maxPageSize: 200,
      cursorTtlSeconds: 900
    },
    model: {
      enabled: true,
      apiKey: "production-model-secret",
      modelName: "gpt-5.2",
      baseUrl: "https://models.example.com/v1",
      contextWindowTokens: 200_000,
      requestMaxTimeoutMs: 600_000,
      requestIdleTimeoutMs: 120_000,
      suggestionConcurrency: 2,
      transientRetryDelayMs: 60_000,
      requestMinIntervalMs: 2_000
    },
    corsOrigins: [],
    logging: {
      level: "info"
    },
    security: {
      environment: "production",
      adminTrustedOrigins: ["https://admin.example.com"],
      allowedHosts: ["admin.example.com", "openapi.example.com"],
      trustedProxy: true,
      origins: {
        adminUi: "https://admin.example.com",
        adminApi: "https://admin.example.com",
        publicOpenApi: "https://openapi.example.com"
      },
      session: {
        ttlSeconds: 28_800,
        secretMinLength: 32,
        cookieSecure: true,
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
        retentionDays: 30
      }
    }
  };
}

describe("production error responses", () => {
  it("does not expose internal diagnostic details from uncaught runtime errors", async () => {
    const app = createApiApp({
      config: createProductionConfig(),
      redis: createTestRedisCoordinator()
    });
    app.get("/internal-error", () => {
      throw new Error(
        "SQLSTATE 23505 at /srv/focowiki/app with S3_SECRET_ACCESS_KEY=production-s3-secret and MODEL_API_KEY=production-model-secret"
      );
    });

    const response = await app.request("https://admin.example.com/internal-error", {
      headers: {
        host: "admin.example.com"
      }
    });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toBe('{"error":{"code":"INTERNAL_ERROR"}}');
    expect(body).not.toContain("SQLSTATE");
    expect(body).not.toContain("/srv/");
    expect(body).not.toContain("production-s3-secret");
    expect(body).not.toContain("production-model-secret");
    expect(body).not.toContain("stack");
  });
});
