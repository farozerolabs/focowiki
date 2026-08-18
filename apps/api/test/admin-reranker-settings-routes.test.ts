import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { createApiApp } from "../src/server.js";
import {
  createTestRedisCoordinator,
  loginAndReadSessionCookie,
  withTrustedAdminOrigin
} from "./support/session.js";

describe("Admin reranker settings routes", () => {
  it("requires authentication and exposes only safe configuration DTOs", async () => {
    const service = rerankerService();
    const app = createApiApp({
      config: createConfig(),
      redis: createTestRedisCoordinator(),
      rerankerConfigurations: service
    } as never);

    const unauthorized = await app.request("/admin/api/settings/rerankers");
    expect(unauthorized.status).toBe(401);

    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request("/admin/api/settings/rerankers", {
      headers: { cookie }
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ configurations: [configuration()] });
    expect(JSON.stringify(body)).not.toContain("reranker-secret");
    expect(JSON.stringify(body)).not.toContain("encryptedApiKey");
  });

  it("routes create, update, test, lifecycle, and delete through the application service", async () => {
    const service = rerankerService();
    const app = createApiApp({
      config: createConfig(),
      redis: createTestRedisCoordinator(),
      rerankerConfigurations: service
    } as never);
    const cookie = await loginAndReadSessionCookie(app);
    const headers = withTrustedAdminOrigin({
      cookie,
      "content-type": "application/json"
    });
    const draft = configurationDraft();

    const requests = [
      app.request("/admin/api/settings/rerankers", {
        method: "POST", headers, body: JSON.stringify(draft)
      }),
      app.request("/admin/api/settings/rerankers/reranker-config-a", {
        method: "PUT", headers,
        body: JSON.stringify({ expectedRevision: 2, configuration: draft })
      }),
      app.request("/admin/api/settings/rerankers/reranker-config-a/test", {
        method: "POST", headers
      }),
      ...(["activate", "pause", "resume"] as const).map((action) =>
        app.request(`/admin/api/settings/rerankers/reranker-config-a/${action}`, {
          method: "POST", headers, body: JSON.stringify({ expectedRevision: 2 })
        })
      ),
      app.request("/admin/api/settings/rerankers/reranker-config-a", {
        method: "DELETE", headers, body: JSON.stringify({ expectedRevision: 2 })
      })
    ];
    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.status)).toEqual([
      201, 200, 200, 200, 200, 200, 200
    ]);
    expect(service.create).toHaveBeenCalledWith(draft, "admin");
    expect(service.update).toHaveBeenCalledWith("reranker-config-a", 2, draft, "admin");
    expect(service.test).toHaveBeenCalledWith("reranker-config-a", "admin");
    expect(service.activate).toHaveBeenCalledWith("reranker-config-a", 2, "admin");
    expect(service.pause).toHaveBeenCalledWith("reranker-config-a", 2, "admin");
    expect(service.resume).toHaveBeenCalledWith("reranker-config-a", 2, "admin");
    expect(service.delete).toHaveBeenCalledWith("reranker-config-a", 2, "admin");
  });

  it("returns stable safe errors without provider payloads", async () => {
    const service = rerankerService();
    service.test.mockRejectedValueOnce(Object.assign(
      new Error("provider body secret"),
      { code: "authentication_failed" }
    ));
    const app = createApiApp({
      config: createConfig(),
      redis: createTestRedisCoordinator(),
      rerankerConfigurations: service
    } as never);
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request(
      "/admin/api/settings/rerankers/reranker-config-a/test",
      { method: "POST", headers: withTrustedAdminOrigin({ cookie }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "RERANKER_CONFIGURATION_AUTHENTICATION_FAILED",
        messageKey: "errors.rerankerConfigurationAuthenticationFailed"
      }
    });
  });
});

function rerankerService() {
  const value = configuration();
  return {
    list: vi.fn(async () => [value]),
    get: vi.fn(async () => value),
    getActive: vi.fn(async () => value),
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
    publicId: "reranker-config-a",
    revisionPublicId: "reranker-revision-a",
    revision: 2,
    displayName: "Primary reranker",
    authenticationMode: "api_key" as const,
    baseUrl: "https://reranker.example/v1",
    apiKeyConfigured: true,
    modelName: "reranker-model",
    timeoutMs: 30_000,
    retryCount: 2,
    minimumIntervalMs: 0,
    concurrency: 4,
    validationStatus: "valid" as const,
    validationFingerprintSha256: "a".repeat(64),
    safeValidationErrorCode: null,
    lifecycleStatus: "active" as const,
    createdAt: "2026-08-09T00:00:00.000Z"
  };
}

function configurationDraft() {
  const {
    publicId: _publicId,
    revisionPublicId: _revisionPublicId,
    revision: _revision,
    apiKeyConfigured: _apiKeyConfigured,
    validationStatus: _validationStatus,
    validationFingerprintSha256: _validationFingerprintSha256,
    safeValidationErrorCode: _safeValidationErrorCode,
    lifecycleStatus: _lifecycleStatus,
    createdAt: _createdAt,
    ...draft
  } = configuration();
  return { ...draft, apiKey: "reranker-secret" };
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
    generated: {
      directoryIndexMaxEntries: 200,
      directoryIndexMaxBytes: 65_536,
      rootSummaryLimit: 500,
      okfLogMaxEntries: 100,
      okfLogMaxBytes: 65_536
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
