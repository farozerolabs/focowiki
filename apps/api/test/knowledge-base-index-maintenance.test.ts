import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerAdminKnowledgeBaseIndexMaintenanceRoutes } from "../src/admin/knowledge-base-index-maintenance-routes.js";
import type {
  KnowledgeBaseIndexMaintenanceClaim,
  KnowledgeBaseIndexMaintenanceRepository
} from "../src/application/ports/knowledge-base-index-maintenance-repository.js";
import type {
  MaintenanceProgressSummary
} from "../src/application/ports/maintenance-progress-repository.js";
import {
  createKnowledgeBaseIndexMaintenanceService,
  runKnowledgeBaseIndexMaintenanceSlice
} from "../src/maintenance/knowledge-base-index-maintenance.js";
import { DEFAULT_MAINTENANCE_SETTINGS } from "../src/runtime-settings/validation.js";

const NOW = "2026-07-27T00:00:00.000Z";

describe("knowledge-base index maintenance", () => {
  it("accepts manual requests independently from the scheduling mode", async () => {
    for (const mode of ["manual", "automatic"] as const) {
      const { repository, createOrGet } = createRepository();
      const service = createKnowledgeBaseIndexMaintenanceService({
        requests: repository,
        runtimeSettings: runtimeSettings(mode),
        now: () => new Date(NOW),
        requestId: () => `request-${mode}`
      });

      await service.requestManual({
        knowledgeBaseId: "kb-1",
        idempotencyKey: `idempotency-${mode}`,
        actor: "admin"
      });

      expect(createOrGet).toHaveBeenCalledWith(expect.objectContaining({
        requestId: `request-${mode}`,
        knowledgeBaseId: "kb-1",
        trigger: "manual",
        idempotencyKey: `idempotency-${mode}`,
        settingsRevision: 7,
        settingsSnapshot: expect.objectContaining({ mode })
      }));
    }
  });

  it("does not discover periodic work in manual mode and cancels unstarted automatic work", async () => {
    const { repository, discoverAutomaticDue, cancelQueuedAutomatic } = createRepository();

    const result = await runKnowledgeBaseIndexMaintenanceSlice({
      requests: repository,
      progress: progressRepository(healthyProgress()),
      runtimeSettings: runtimeSettings("manual"),
      workerId: "worker-1",
      leaseTtlSeconds: 60,
      schedule: vi.fn(),
      now: () => new Date(NOW)
    });

    expect(discoverAutomaticDue).not.toHaveBeenCalled();
    expect(cancelQueuedAutomatic).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ discovered: 0, canceledAutomatic: 0 });
  });

  it("uses bounded automatic discovery and the shared claim path in automatic mode", async () => {
    const fixture = createRepository({
      claims: [claim({ trigger: "automatic", state: "planning" })],
      discovered: 1
    });
    const schedule = vi.fn(async () => undefined);

    const result = await runKnowledgeBaseIndexMaintenanceSlice({
      requests: fixture.repository,
      progress: progressRepository(healthyProgress()),
      runtimeSettings: runtimeSettings("automatic"),
      workerId: "worker-1",
      leaseTtlSeconds: 60,
      schedule,
      now: () => new Date(NOW)
    });

    expect(fixture.discoverAutomaticDue).toHaveBeenCalledWith(expect.objectContaining({
      limit: 20,
      dueBefore: "2026-07-26T18:00:00.000Z"
    }));
    expect(fixture.start).toHaveBeenCalledWith(expect.objectContaining({
      plannedScopes: [
        "tree",
        "navigation",
        "search",
        "graph",
        "statistics",
        "manifest",
        "compaction"
      ]
    }));
    expect(schedule).toHaveBeenCalledOnce();
    expect(fixture.complete).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ discovered: 1, claimed: 1, completed: 1 });
  });

  it("schedules claimed knowledge bases concurrently within the configured bound", async () => {
    const fixture = createRepository({
      claims: [
        claim({ id: "request-1", knowledgeBaseId: "kb-1" }),
        claim({ id: "request-2", knowledgeBaseId: "kb-2" })
      ]
    });
    let active = 0;
    let maximumActive = 0;
    const schedule = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
    });

    await runKnowledgeBaseIndexMaintenanceSlice({
      requests: fixture.repository,
      progress: progressRepository(healthyProgress()),
      runtimeSettings: runtimeSettings("manual", 2),
      workerId: "worker-1",
      leaseTtlSeconds: 60,
      schedule,
      now: () => new Date(NOW)
    });

    expect(fixture.claimBatch).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
    expect(maximumActive).toBe(2);
    expect(fixture.complete).toHaveBeenCalledTimes(2);
  });

  it("keeps active child work running and records bounded progress", async () => {
    const fixture = createRepository({
      claims: [claim({ state: "running", plannedScopes: ["search"] })]
    });

    await runKnowledgeBaseIndexMaintenanceSlice({
      requests: fixture.repository,
      progress: progressRepository({
        ...healthyProgress(),
        lexicalRebuild: {
          state: "running",
          phase: "documents",
          searchSchemaVersion: "search-v1",
          tokenizerContractVersion: "tokenizer-v1",
          segmentationVersion: "segments-v1",
          contentProfileVersion: "profile-v1",
          graphLexicalProjectionVersion: "graph-v1",
          processedSourceCount: 30,
          pendingSourceCount: 70,
          runningSourceCount: 2,
          retrySourceCount: 0,
          failedSourceCount: 0,
          totalSourceCount: 100,
          activeWorkerCount: 1,
          sourceReadRetryCount: 0,
          databaseRetryCount: 0,
          filesPerSecond: 10,
          sourceReadLatencyMs: 5,
          databaseBatchLatencyMs: 5,
          lastProgressAt: NOW,
          lastWorkerHeartbeatAt: NOW,
          estimatedCompletionAt: null,
          attemptCount: 1,
          maxAttempts: 5,
          updatedAt: NOW,
          completedAt: null,
          safeErrorCode: null,
          safeErrorMessage: null
        }
      }),
      runtimeSettings: runtimeSettings("manual"),
      workerId: "worker-1",
      leaseTtlSeconds: 60,
      schedule: vi.fn(async () => undefined),
      now: () => new Date(NOW)
    });

    expect(fixture.heartbeat).toHaveBeenCalledWith(expect.objectContaining({
      stage: "search:documents",
      completedCount: 30,
      expectedCount: 100
    }));
    expect(fixture.complete).not.toHaveBeenCalled();
  });

  it("keeps maintenance active while the external search projection is indexing", async () => {
    const fixture = createRepository({
      claims: [claim({ state: "running", plannedScopes: ["search"] })]
    });

    await runKnowledgeBaseIndexMaintenanceSlice({
      requests: fixture.repository,
      progress: progressRepository({
        ...healthyProgress(),
        searchProjection: {
          routeState: "postgres_compatibility",
          maintenanceRequired: true,
          activeEpoch: 0,
          pendingEpoch: 1,
          generationId: "generation-1",
          queuedCount: 6,
          submittedCount: 2,
          retryCount: 0,
          succeededCount: 4,
          failedCount: 0,
          canceledCount: 0,
          recoveryActive: false,
          totalCount: 12,
          updatedAt: NOW,
          safeErrorCode: null,
          safeErrorMessage: null
        }
      }),
      runtimeSettings: runtimeSettings("manual"),
      workerId: "worker-1",
      leaseTtlSeconds: 60,
      schedule: vi.fn(async () => undefined),
      now: () => new Date(NOW)
    });

    expect(fixture.heartbeat).toHaveBeenCalledWith(expect.objectContaining({
      stage: "search:indexing",
      completedCount: 4,
      expectedCount: 12
    }));
    expect(fixture.complete).not.toHaveBeenCalled();
  });

  it("keeps maintenance active while failed search work is being cleaned", async () => {
    const fixture = createRepository({
      claims: [claim({ state: "running", plannedScopes: ["search"] })]
    });

    await runKnowledgeBaseIndexMaintenanceSlice({
      requests: fixture.repository,
      progress: progressRepository({
        ...healthyProgress(),
        searchProjection: {
          routeState: "postgres_compatibility",
          maintenanceRequired: true,
          activeEpoch: 0,
          pendingEpoch: 1,
          generationId: "generation-1",
          queuedCount: 0,
          submittedCount: 0,
          retryCount: 0,
          succeededCount: 0,
          failedCount: 1,
          canceledCount: 91,
          recoveryActive: true,
          totalCount: 92,
          updatedAt: NOW,
          safeErrorCode: "SEARCH_ENGINE_UNAVAILABLE",
          safeErrorMessage: "Search indexing is temporarily unavailable"
        }
      }),
      runtimeSettings: runtimeSettings("manual"),
      workerId: "worker-1",
      leaseTtlSeconds: 60,
      schedule: vi.fn(async () => undefined),
      now: () => new Date(NOW)
    });

    expect(fixture.heartbeat).toHaveBeenCalledWith(expect.objectContaining({
      stage: "search:indexing",
      completedCount: 0,
      expectedCount: 92
    }));
    expect(fixture.retryOrFail).not.toHaveBeenCalled();
    expect(fixture.complete).not.toHaveBeenCalled();
  });

  it("ignores terminal child failures that predate the current request", async () => {
    const fixture = createRepository({
      claims: [claim({
        state: "running",
        plannedScopes: ["tree"],
        startedAt: NOW
      })]
    });

    await runKnowledgeBaseIndexMaintenanceSlice({
      requests: fixture.repository,
      progress: progressRepository({
        ...healthyProgress(),
        projectionRepair: failedProjectionRepair("2026-07-26T23:59:59.000Z")
      }),
      runtimeSettings: runtimeSettings("manual"),
      workerId: "worker-1",
      leaseTtlSeconds: 60,
      schedule: vi.fn(async () => undefined),
      now: () => new Date(NOW)
    });

    expect(fixture.complete).toHaveBeenCalledOnce();
    expect(fixture.retryOrFail).not.toHaveBeenCalled();
  });

  it("retries a terminal child failure created by the current request", async () => {
    const fixture = createRepository({
      claims: [claim({
        state: "running",
        plannedScopes: ["tree"],
        startedAt: NOW
      })]
    });

    await runKnowledgeBaseIndexMaintenanceSlice({
      requests: fixture.repository,
      progress: progressRepository({
        ...healthyProgress(),
        projectionRepair: failedProjectionRepair(NOW)
      }),
      runtimeSettings: runtimeSettings("manual"),
      workerId: "worker-1",
      leaseTtlSeconds: 60,
      schedule: vi.fn(async () => undefined),
      now: () => new Date(NOW)
    });

    expect(fixture.retryOrFail).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "PROJECTION_REPAIR_FAILED",
      errorMessage: "Projection repair validation failed"
    }));
    expect(fixture.complete).not.toHaveBeenCalled();
  });

  it("keeps the request active while a superseded repair prepares its successor", async () => {
    const fixture = createRepository({
      claims: [claim({
        state: "running",
        plannedScopes: ["tree"],
        startedAt: NOW
      })]
    });

    await runKnowledgeBaseIndexMaintenanceSlice({
      requests: fixture.repository,
      progress: progressRepository({
        ...healthyProgress(),
        projectionRepair: {
          ...failedProjectionRepair(NOW),
          state: "superseded",
          phase: "superseded",
          safeErrorCode: null,
          safeErrorMessage: null
        }
      }),
      runtimeSettings: runtimeSettings("manual"),
      workerId: "worker-1",
      leaseTtlSeconds: 60,
      schedule: vi.fn(async () => undefined),
      now: () => new Date(NOW)
    });

    expect(fixture.heartbeat).toHaveBeenCalledWith(expect.objectContaining({
      stage: "projection:superseded"
    }));
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.retryOrFail).not.toHaveBeenCalled();
  });
});

describe("Admin knowledge-base index maintenance route", () => {
  it("requires Admin authentication before accepting maintenance", async () => {
    const app = createRouteApp({
      requireAuth: async (context) => context.json({
        error: { code: "UNAUTHORIZED" }
      }, 401)
    });

    const response = await app.request(
      "/admin/api/knowledge-bases/kb-1/index-maintenance",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "request-1" })
      }
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED" }
    });
  });

  it("returns the complete bounded request state without internal details", async () => {
    const request = claim({
      state: "completed",
      plannedScopes: ["tree"],
      completedScopes: ["tree"],
      completedCount: 1,
      expectedCount: 1,
      completedAt: NOW,
      lastProgressAt: NOW,
      leaseOwner: "",
      leaseToken: ""
    });
    const createOrGet = vi.fn(async () => ({
      outcome: "accepted" as const,
      request
    }));
    const app = createRouteApp({ createOrGet });

    const response = await app.request(
      "/admin/api/knowledge-bases/kb-1/index-maintenance",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "request-1"
        },
        body: "{}"
      }
    );

    expect(response.status).toBe(202);
    expect(createOrGet).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-1",
      idempotencyKey: "request-1"
    }));
    await expect(response.json()).resolves.toEqual({
      result: "accepted",
      maintenance: {
        requestId: "request-1",
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
      createOrGet: vi.fn(async () => ({ outcome: fixture.outcome }))
    });
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-1/index-maintenance",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "request-1"
        },
        body: "{}"
      }
    );

    expect(response.status).toBe(fixture.status);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: fixture.code,
        messageKey: fixture.messageKey
      }
    });
  });

  it("returns the server-authoritative active request for a duplicate submission", async () => {
    const app = createRouteApp({
      createOrGet: vi.fn(async () => ({
        outcome: "already_active" as const,
        request: claim({ state: "running", stage: "search:documents" })
      }))
    });
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-1/index-maintenance",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "request-duplicate"
        },
        body: "{}"
      }
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      result: "already_active",
      maintenance: {
        requestId: "request-1",
        state: "running",
        active: true,
        stage: "search:documents"
      }
    });
  });

  it("rejects a missing idempotency key with a stable safe error", async () => {
    const app = createRouteApp();
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-1/index-maintenance",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_INDEX_MAINTENANCE_REQUEST",
        messageKey: "errors.invalidIndexMaintenanceRequest"
      }
    });
  });

  it("returns bounded unavailable and unexpected failure envelopes", async () => {
    const unavailable = createRouteApp({ available: false });
    const unavailableResponse = await unavailable.request(
      "/admin/api/knowledge-bases/kb-1/index-maintenance",
      {
        method: "POST",
        headers: { "idempotency-key": "request-1" }
      }
    );
    expect(unavailableResponse.status).toBe(503);
    await expect(unavailableResponse.json()).resolves.toEqual({
      error: {
        code: "INDEX_MAINTENANCE_UNAVAILABLE",
        messageKey: "errors.indexMaintenanceUnavailable"
      }
    });

    const failed = createRouteApp({
      createOrGet: vi.fn(async () => {
        throw new Error("postgres://secret@internal/storage-key");
      })
    });
    const failedResponse = await failed.request(
      "/admin/api/knowledge-bases/kb-1/index-maintenance",
      {
        method: "POST",
        headers: { "idempotency-key": "request-2" }
      }
    );
    expect(failedResponse.status).toBe(500);
    await expect(failedResponse.json()).resolves.toEqual({
      error: {
        code: "INDEX_MAINTENANCE_REQUEST_FAILED",
        messageKey: "errors.indexMaintenanceRequestFailed"
      }
    });
  });
});

function createRepository(options?: {
  claims?: KnowledgeBaseIndexMaintenanceClaim[];
  discovered?: number;
}) {
  const createOrGet = vi.fn(async (input: { requestId: string }) => ({
    outcome: "accepted" as const,
    request: claim({ id: input.requestId })
  }));
  const discoverAutomaticDue = vi.fn(async () => options?.discovered ?? 0);
  const cancelQueuedAutomatic = vi.fn(async () => 0);
  const claimBatch = vi.fn(async () => options?.claims ?? []);
  const start = vi.fn(async () => true);
  const heartbeat = vi.fn(async () => true);
  const complete = vi.fn(async () => true);
  const retryOrFail = vi.fn(async () => "retry" as const);
  const repository = {
    createOrGet,
    discoverAutomaticDue,
    cancelQueuedAutomatic,
    claimBatch,
    start,
    heartbeat,
    complete,
    retryOrFail,
    cancelForKnowledgeBase: vi.fn(async () => 0),
    getSummary: vi.fn(),
    listActiveKnowledgeBaseIds: vi.fn(async () => [])
  } as unknown as KnowledgeBaseIndexMaintenanceRepository;
  return {
    repository,
    createOrGet,
    discoverAutomaticDue,
    cancelQueuedAutomatic,
    claimBatch,
    start,
    heartbeat,
    complete,
    retryOrFail
  };
}

function claim(
  overrides: Partial<KnowledgeBaseIndexMaintenanceClaim> = {}
): KnowledgeBaseIndexMaintenanceClaim {
  return {
    id: "request-1",
    knowledgeBaseId: "kb-1",
    trigger: "manual",
    state: "planning",
    baseGenerationId: "generation-1",
    sourceWatermark: 1,
    settingsRevision: 1,
    plannedScopes: [],
    completedScopes: [],
    stage: "planning",
    completedCount: 0,
    expectedCount: 0,
    retryCount: 0,
    maxAttempts: 5,
    lastProgressAt: NOW,
    lastErrorCode: null,
    lastErrorMessage: null,
    startedAt: NOW,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    leaseOwner: "worker-1",
    leaseToken: "lease-1",
    ...overrides
  };
}

function runtimeSettings(mode: "manual" | "automatic", concurrency = 1) {
  return {
    getSnapshot: vi.fn(async () => ({
      maintenance: {
        ...DEFAULT_MAINTENANCE_SETTINGS,
        knowledgeBaseMaintenanceMode: mode,
        knowledgeBaseMaintenanceConcurrency: concurrency
      }
    })),
    getMaintenanceRevision: vi.fn(async () => 7)
  } as never;
}

function progressRepository(summary: MaintenanceProgressSummary) {
  return {
    getSummary: vi.fn(async () => summary)
  };
}

function healthyProgress(): MaintenanceProgressSummary {
  return {
    migration: null,
    lexicalRebuild: null,
    searchProjection: null,
    projectionRepair: null,
    compaction: {
      active: null,
      latestCompleted: null
    }
  };
}

function createRouteApp(options: {
  createOrGet?: ReturnType<typeof vi.fn>;
  requireAuth?: Parameters<
    typeof registerAdminKnowledgeBaseIndexMaintenanceRoutes
  >[2]["requireAuth"];
  available?: boolean;
} = {}) {
  const app = new Hono();
  const repository = createRepository().repository;
  if (options.createOrGet) {
    repository.createOrGet = options.createOrGet as never;
  }
  registerAdminKnowledgeBaseIndexMaintenanceRoutes(
    app,
    {
      config: {} as never,
      repositories: null,
      requests: options.available === false ? null : repository,
      runtimeSettings: options.available === false ? null : runtimeSettings("manual")
    },
    {
      requireAuth: options.requireAuth ?? (async (_context, next) => next()),
      requireWriteProtection: async (_context, next) => next()
    }
  );
  return app;
}

function failedProjectionRepair(updatedAt: string) {
  return {
    repairVersion: 3,
    state: "failed",
    phase: "validation",
    attemptCount: 5,
    requiredProjectionKinds: ["tree", "directory", "graph"],
    completedProjectionKinds: [],
    completedSubtaskCount: 0,
    totalSubtaskCount: 1,
    completedRecordCount: 0,
    totalRecordCount: 1,
    completedDirectoryCount: 0,
    totalDirectoryCount: 1,
    objectWriteCount: 0,
    objectReuseCount: 0,
    retryCount: 5,
    recordsPerSecond: null,
    rollingBatchLatencyMs: null,
    lastProgressAt: updatedAt,
    lastHeartbeatAt: updatedAt,
    estimatedCompletionAt: null,
    updatedAt,
    completedAt: updatedAt,
    safeErrorCode: "PROJECTION_REPAIR_FAILED",
    safeErrorMessage: "Projection repair validation failed"
  };
}
