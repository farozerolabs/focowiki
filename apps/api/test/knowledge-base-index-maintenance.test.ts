import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerAdminKnowledgeBaseIndexMaintenanceRoutes } from
  "../src/admin/knowledge-base-index-maintenance-routes.js";
import type { StorageVnextAdminMaintenanceApplication } from
  "../src/storage-vnext/api/admin-maintenance-application.js";

const NOW = "2026-08-02T00:00:00.000Z";

describe("Admin knowledge-base index maintenance route", () => {
  it("requires Admin authentication before accepting maintenance", async () => {
    const app = createRouteApp({
      requireAuth: async (context) => context.json({
        error: { code: "UNAUTHORIZED" }
      }, 401)
    });

    const response = await requestMaintenance(app, "request-1");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED" }
    });
  });

  it("returns the complete bounded request state without internal details", async () => {
    const request = vi.fn(async () => acceptedResult({
      state: "completed",
      completedCount: 1,
      expectedCount: 1,
      completedAt: NOW,
      lastProgressAt: NOW
    }));
    const app = createRouteApp({ request });

    const response = await requestMaintenance(app, "request-1");

    expect(response.status).toBe(202);
    expect(request).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-1",
      idempotencyKey: "request-1"
    });
    await expect(response.json()).resolves.toEqual({
      result: "accepted",
      maintenance: {
        requestId: "maintenance-1",
        state: "completed",
        trigger: "manual",
        active: false,
        stage: "planning",
        completedCount: 1,
        expectedCount: 1,
        retryCount: 0,
        lastProgressAt: NOW,
        lastCompletedAt: NOW,
        maintenanceRequired: false,
        safeErrorCode: null,
        safeErrorMessage: null
      }
    });
  });

  it.each([
    {
      outcome: "not_found",
      status: 404,
      code: "NOT_FOUND",
      messageKey: "errors.knowledgeBaseNotFound"
    },
    {
      outcome: "deleted",
      status: 409,
      code: "KNOWLEDGE_BASE_UNAVAILABLE",
      messageKey: "errors.knowledgeBaseUnavailable"
    }
  ] as const)("returns a safe $outcome response", async (fixture) => {
    const app = createRouteApp({
      request: vi.fn(async () => ({
        available: true as const,
        result: { outcome: fixture.outcome }
      }))
    });

    const response = await requestMaintenance(app, "request-1");

    expect(response.status).toBe(fixture.status);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: fixture.code,
        messageKey: fixture.messageKey
      }
    });
  });

  it("returns a safe conflict when semantic model configuration is incomplete", async () => {
    const app = createRouteApp({
      request: vi.fn(async () => ({
        available: true as const,
        result: {
          outcome: "configuration_required" as const,
          safeCode: "semantic_embedding_model_required"
        }
      }))
    });

    const response = await requestMaintenance(app, "request-semantic");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "SEMANTIC_CONFIGURATION_REQUIRED",
        messageKey: "errors.semanticConfigurationRequired",
        safeCode: "semantic_embedding_model_required"
      }
    });
  });

  it("returns the server-authoritative active request for a duplicate submission", async () => {
    const app = createRouteApp({
      request: vi.fn(async () => acceptedResult({
        outcome: "already_active",
        state: "running",
        stage: "search:documents"
      }))
    });

    const response = await requestMaintenance(app, "request-duplicate");

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      result: "already_active",
      maintenance: {
        requestId: "maintenance-1",
        state: "running",
        active: true,
        stage: "search:documents"
      }
    });
  });

  it("rejects missing and oversized idempotency keys with a stable safe error", async () => {
    for (const idempotencyKey of [null, "x".repeat(201)]) {
      const app = createRouteApp();
      const response = await requestMaintenance(app, idempotencyKey);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "INVALID_INDEX_MAINTENANCE_REQUEST",
          messageKey: "errors.invalidIndexMaintenanceRequest"
        }
      });
    }
  });

  it("returns bounded unavailable and unexpected failure envelopes", async () => {
    const unavailable = createRouteApp({
      request: vi.fn(async () => ({ available: false as const }))
    });
    const unavailableResponse = await requestMaintenance(unavailable, "request-1");
    expect(unavailableResponse.status).toBe(503);
    await expect(unavailableResponse.json()).resolves.toEqual({
      error: {
        code: "INDEX_MAINTENANCE_UNAVAILABLE",
        messageKey: "errors.indexMaintenanceUnavailable"
      }
    });

    const failed = createRouteApp({
      request: vi.fn(async () => {
        throw new Error("postgres://secret@internal/storage-key");
      })
    });
    const failedResponse = await requestMaintenance(failed, "request-2");
    expect(failedResponse.status).toBe(500);
    await expect(failedResponse.json()).resolves.toEqual({
      error: {
        code: "INDEX_MAINTENANCE_REQUEST_FAILED",
        messageKey: "errors.indexMaintenanceRequestFailed"
      }
    });
  });

  it("cancels active maintenance through authenticated write protection", async () => {
    const cancel = vi.fn(async () => ({
      available: true as const,
      outcome: "cancelled" as const
    }));
    const app = createRouteApp({ cancel });

    const response = await app.request(
      "/admin/api/knowledge-bases/kb-1/index-maintenance/cancel",
      { method: "POST" }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: "cancelled" });
    expect(cancel).toHaveBeenCalledWith({ knowledgeBaseId: "kb-1" });
  });
});

function createRouteApp(options: {
  request?: StorageVnextAdminMaintenanceApplication["requestMaintenance"];
  cancel?: StorageVnextAdminMaintenanceApplication["cancelMaintenance"];
  requireAuth?: Parameters<
    typeof registerAdminKnowledgeBaseIndexMaintenanceRoutes
  >[2]["requireAuth"];
} = {}) {
  const app = new Hono();
  registerAdminKnowledgeBaseIndexMaintenanceRoutes(
    app,
    {
      application: {
        requestMaintenance: options.request ?? (async () => acceptedResult()),
        cancelMaintenance: options.cancel ?? (async () => ({
          available: true as const,
          outcome: "cancelled" as const
        }))
      },
      audit: { record: vi.fn(async () => undefined) }
    },
    {
      requireAuth: options.requireAuth ?? (async (_context, next) => next()),
      requireWriteProtection: async (_context, next) => next()
    }
  );
  return app;
}

function acceptedResult(overrides: {
  outcome?: "accepted" | "already_active";
  state?: string;
  stage?: string | null;
  completedCount?: number;
  expectedCount?: number;
  completedAt?: string | null;
  lastProgressAt?: string | null;
} = {}) {
  return {
    available: true as const,
    result: {
      outcome: overrides.outcome ?? "accepted" as const,
      request: {
        id: "maintenance-1",
        state: overrides.state ?? "planning",
        trigger: "manual" as const,
        stage: overrides.stage ?? "planning",
        completedCount: overrides.completedCount ?? 0,
        expectedCount: overrides.expectedCount ?? 0,
        retryCount: 0,
        lastProgressAt: overrides.lastProgressAt ?? NOW,
        completedAt: overrides.completedAt ?? null,
        lastErrorCode: null,
        lastErrorMessage: null
      }
    }
  };
}

async function requestMaintenance(
  app: Hono,
  idempotencyKey: string | null
): Promise<Response> {
  return await app.request(
    "/admin/api/knowledge-bases/kb-1/index-maintenance",
    {
      method: "POST",
      headers: idempotencyKey
        ? { "content-type": "application/json", "idempotency-key": idempotencyKey }
        : { "content-type": "application/json" },
      body: "{}"
    }
  );
}
