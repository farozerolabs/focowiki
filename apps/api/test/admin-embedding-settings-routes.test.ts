import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { createApiApp } from "../src/server.js";
import {
  createTestRedisCoordinator,
  loginAndReadSessionCookie,
  withTrustedAdminOrigin
} from "./support/session.js";

describe("Admin embedding settings routes", () => {
  it("requires authentication and exposes only safe configuration DTOs", async () => {
    const service = embeddingService();
    const app = createApiApp({
      config: createConfig(),
      redis: createTestRedisCoordinator(),
      embeddingConfigurations: service
    } as never);

    const unauthorized = await app.request("/admin/api/settings/embeddings");
    expect(unauthorized.status).toBe(401);

    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request("/admin/api/settings/embeddings", {
      headers: { cookie }
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ configurations: [configuration()] });
    expect(JSON.stringify(body)).not.toContain("embedding-secret");
    expect(JSON.stringify(body)).not.toContain("encryptedApiKey");
  });

  it("routes create, update, test, lifecycle, and delete through the application service", async () => {
    const service = embeddingService();
    const app = createApiApp({
      config: createConfig(),
      redis: createTestRedisCoordinator(),
      embeddingConfigurations: service
    } as never);
    const cookie = await loginAndReadSessionCookie(app);
    const headers = withTrustedAdminOrigin({
      cookie,
      "content-type": "application/json"
    });
    const draft = configurationDraft();

    const requests = [
      app.request("/admin/api/settings/embeddings", {
        method: "POST", headers, body: JSON.stringify(draft)
      }),
      app.request("/admin/api/settings/embeddings/embedding-config-a", {
        method: "PUT", headers,
        body: JSON.stringify({ expectedRevision: 2, configuration: draft })
      }),
      app.request("/admin/api/settings/embeddings/embedding-config-a/test", {
        method: "POST", headers
      }),
      ...(["activate", "pause", "resume"] as const).map((action) =>
        app.request(`/admin/api/settings/embeddings/embedding-config-a/${action}`, {
          method: "POST", headers, body: JSON.stringify({ expectedRevision: 2 })
        })
      ),
      app.request("/admin/api/settings/embeddings/embedding-config-a", {
        method: "DELETE", headers, body: JSON.stringify({ expectedRevision: 2 })
      })
    ];
    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.status)).toEqual([
      201, 200, 200, 200, 200, 200, 200
    ]);
    expect(service.create).toHaveBeenCalledWith(draft, "admin");
    expect(service.update).toHaveBeenCalledWith("embedding-config-a", 2, draft, "admin");
    expect(service.test).toHaveBeenCalledWith("embedding-config-a", "admin");
    expect(service.activate).toHaveBeenCalledWith("embedding-config-a", 2, "admin");
    expect(service.pause).toHaveBeenCalledWith("embedding-config-a", 2, "admin");
    expect(service.resume).toHaveBeenCalledWith("embedding-config-a", 2, "admin");
    expect(service.delete).toHaveBeenCalledWith("embedding-config-a", 2, "admin");
  });

  it("returns stable safe errors without provider payloads", async () => {
    const service = embeddingService();
    service.test.mockRejectedValueOnce(Object.assign(new Error("provider body secret"), {
      code: "authentication_failed"
    }));
    const app = createApiApp({
      config: createConfig(),
      redis: createTestRedisCoordinator(),
      embeddingConfigurations: service
    } as never);
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request(
      "/admin/api/settings/embeddings/embedding-config-a/test",
      { method: "POST", headers: withTrustedAdminOrigin({ cookie }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "EMBEDDING_CONFIGURATION_AUTHENTICATION_FAILED",
        messageKey: "errors.embeddingConfigurationAuthenticationFailed"
      }
    });
  });
});

function embeddingService() {
  const value = configuration();
  return {
    list: vi.fn(async () => [value]),
    get: vi.fn(async () => value),
    create: vi.fn(async () => value),
    update: vi.fn(async () => value),
    test: vi.fn(async () => value),
    activate: vi.fn(async () => value),
    pause: vi.fn(async () => value),
    resume: vi.fn(async () => value),
    delete: vi.fn(async () => true)
  };
}

function configuration() {
  return {
    publicId: "embedding-config-a",
    revisionPublicId: "embedding-revision-a",
    revision: 2,
    displayName: "Primary embedding",
    authenticationMode: "api_key" as const,
    baseUrl: "https://embedding.example/v1",
    apiKeyConfigured: true,
    modelName: "embedding-model",
    requestedDimension: 1_536,
    resolvedDimension: 1_536,
    normalization: "l2" as const,
    maximumInputTokens: 8_192,
    batchSize: 32,
    timeoutMs: 30_000,
    retryCount: 2,
    minimumIntervalMs: 0,
    concurrency: 4,
    maximumResponseBytes: 8_388_608,
    minimumVectorRelevance: 0.7,
    vectorProducingRevisionPublicId: "embedding-revision-a",
    queryPolicyRevisionPublicId: "embedding-revision-a",
    validationStatus: "valid" as const,
    validationFingerprintSha256: "a".repeat(64),
    safeValidationErrorCode: null,
    lifecycleStatus: "active" as const,
    createdAt: "2026-08-08T00:00:00.000Z"
  };
}

function configurationDraft() {
  const { publicId: _publicId, revisionPublicId: _revisionPublicId,
    revision: _revision, apiKeyConfigured: _apiKeyConfigured,
    resolvedDimension: _resolvedDimension, validationStatus: _validationStatus,
    validationFingerprintSha256: _validationFingerprintSha256,
    safeValidationErrorCode: _safeValidationErrorCode,
    lifecycleStatus: _lifecycleStatus, createdAt: _createdAt,
    ...draft } = configuration();
  return { ...draft, apiKey: "embedding-secret" };
}

function createConfig(): RuntimeConfig {
  return {
    admin: { username: "admin", password: "admin-secret" },
    database: { url: "postgres://focowiki:focowiki@127.0.0.1:5432/focowiki" },
    redis: { url: "redis://127.0.0.1:6379/0" },
    ports: { adminApi: 43_000, adminUi: 43_100, publicOpenApi: 43_200 },
    publicApi: { baseUrl: "https://kb.example.com" },
    storage: {
      endpoint: "https://s3.example.com", region: "us-east-1", bucket: "focowiki",
      accessKeyId: "s3-access", secretAccessKey: "s3-secret",
      prefix: "tenant/demo", forcePathStyle: true
    },
    publication: {
      mode: "batch", batchSize: 300, intervalSeconds: 300,
      indexShardSize: 1_000, linkIndexShardSize: 1_000,
      manifestShardSize: 1_000, graphEdgeShardSize: 5_000,
      graphCandidateLimit: 200, graphMaintenanceBatchSize: 500,
      rootSummaryLimit: 500
    },
    pagination: {
      defaultPageSize: 50, maxPageSize: 200, treeDefaultPageSize: 100,
      treeMaxPageSize: 500, cursorTtlSeconds: 900,
      generatedContentMaxBytes: 10_485_760
    },
    model: { enabled: false },
    corsOrigins: []
  };
}
