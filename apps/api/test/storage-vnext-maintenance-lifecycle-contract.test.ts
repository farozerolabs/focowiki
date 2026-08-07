import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

type MaintenanceTrigger = "manual" | "automatic";
type MaintenancePhase =
  | "planning"
  | "search_rebuild"
  | "projection_repair"
  | "object_reconciliation"
  | "catch_up"
  | "validation"
  | "activation"
  | "cleanup";

type MaintenanceRequest = {
  knowledgeBaseId: string;
  operationPublicId: string;
  trigger: MaintenanceTrigger;
  idempotencyKey: string;
  expectedResourceRevision: number;
  settingsRevisionPublicId: string;
  requestedAt: string;
  expiresAt: string;
  maxAttempts: number;
};

type MaintenanceCheckpoint = {
  version: 1;
  phase: MaintenancePhase;
  cursor: string | null;
  batchOrdinal: number;
  baseResourceRevision: number;
  completedCount: number;
  expectedCount: number;
  processedBytes: number;
  startedAt: string;
  lastProgressAt: string;
  elapsedActiveMs: number;
  throughputPerSecond?: number;
  estimatedCompletionAt?: string | null;
};

type MaintenanceAcceptance = {
  outcome: "queued" | "replayed" | "already_active" | "deferred";
  operationPublicId: string | null;
  state: "queued" | "active" | "deferred";
  reasonCode: string | null;
};

type MaintenancePhaseResult =
  | {
      outcome: "progress";
      cursor: string;
      completedDelta: number;
      expectedCount: number;
      processedBytesDelta: number;
    }
  | {
      outcome: "phase_completed";
      completedDelta: number;
      expectedCount: number;
      processedBytesDelta: number;
    };

type MaintenanceCoordinator = {
  requestMaintenance(request: MaintenanceRequest): Promise<MaintenanceAcceptance>;
  runOne(input: { workerId: string; leaseExpiresAt: string }): Promise<{
    outcome: "idle" | "backpressured" | "progress" | "phase_completed" | "completed" | "retry" | "failed" | "superseded";
    operationPublicId: string | null;
    reasonCode?: string;
  }>;
  recoverStale(input: {
    expiredBefore: string;
    retryAt: string;
    limit: number;
  }): Promise<number>;
};

type MaintenanceCoordinatorFactory = (input: {
  repository: ReturnType<typeof createFixture>["repository"];
  searchProviderKind: "meilisearch" | "opensearch";
  phaseRunner: ReturnType<typeof createFixture>["phaseRunner"];
  cleanup: ReturnType<typeof createFixture>["cleanup"];
  resourceGate: ReturnType<typeof createFixture>["resourceGate"];
  now: () => Date;
  phaseTimeoutMs: number;
  onFailure?: (failure: {
    operationPublicId: string;
    knowledgeBaseId: string;
    attempt: number;
    code: string;
    error: unknown;
  }) => void;
}) => MaintenanceCoordinator;

let factory: MaintenanceCoordinatorFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/maintenance/maintenance-coordinator.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      createStorageVnextMaintenanceCoordinator?: MaintenanceCoordinatorFactory;
    };
  factory = loaded.createStorageVnextMaintenanceCoordinator;
});

describe("storage vNext maintenance lifecycle contract", () => {
  it.each(["manual", "automatic"] as const)(
    "accepts one %s maintenance owner for a knowledge base",
    async (trigger) => {
      const fixture = createFixture();
      const coordinator = createCoordinator(fixture);

      await expect(coordinator.requestMaintenance(request({ trigger }))).resolves.toEqual({
        outcome: "queued",
        operationPublicId: "operation-maintenance-contract",
        state: "queued",
        reasonCode: null
      });
      expect(fixture.liveOperations).toHaveLength(1);
      expect(fixture.repository.acceptMaintenance).toHaveBeenCalledWith(
        expect.objectContaining({
          requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
          workKind: "maintenance"
        })
      );
    }
  );

  it("replays the same request and returns the one active owner for another request", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await coordinator.requestMaintenance(request());
    await expect(coordinator.requestMaintenance(request())).resolves.toMatchObject({
      outcome: "replayed",
      operationPublicId: "operation-maintenance-contract"
    });
    await expect(coordinator.requestMaintenance(request({
      operationPublicId: "operation-maintenance-duplicate",
      idempotencyKey: "maintenance-duplicate"
    }))).resolves.toMatchObject({
      outcome: "already_active",
      operationPublicId: "operation-maintenance-contract"
    });
    expect(fixture.liveOperations).toHaveLength(1);
  });

  it("replays an idempotency key when server snapshot fields advance", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await coordinator.requestMaintenance(request());
    await expect(coordinator.requestMaintenance(request({
      expectedResourceRevision: 8,
      settingsRevisionPublicId: "settings-revision-next",
      requestedAt: "2026-08-02T01:00:00.000Z",
      expiresAt: "2026-08-03T01:00:00.000Z",
      maxAttempts: 8
    }))).resolves.toMatchObject({
      outcome: "replayed",
      operationPublicId: "operation-maintenance-contract"
    });
    expect(fixture.liveOperations).toHaveLength(1);
  });

  it("rejects a trigger collision without creating another plan", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await coordinator.requestMaintenance(request());
    await expect(coordinator.requestMaintenance(request({
      trigger: "automatic"
    }))).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(fixture.liveOperations).toHaveLength(1);
  });

  it.each(["upload", "mutation", "publication"] as const)(
    "defers maintenance while foreground %s work owns the knowledge base",
    async (ownerKind) => {
      const fixture = createFixture({ liveForegroundOwner: ownerKind });
      const coordinator = createCoordinator(fixture);

      await expect(coordinator.requestMaintenance(request())).resolves.toEqual({
        outcome: "deferred",
        operationPublicId: null,
        state: "deferred",
        reasonCode: "FOREGROUND_WORK_ACTIVE"
      });
      expect(fixture.liveOperations).toHaveLength(0);
    }
  );

  it("does not admit maintenance after knowledge-base deletion owns the scope", async () => {
    const fixture = createFixture({ liveForegroundOwner: "deletion" });
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.requestMaintenance(request()))
      .rejects.toMatchObject({ code: "knowledge_base_deleting" });
    expect(fixture.liveOperations).toHaveLength(0);
  });

  it("resumes the same bounded checkpoint after a worker restart", async () => {
    const fixture = createFixture();
    fixture.phaseResults.push({
      outcome: "progress",
      cursor: "source-cursor-100",
      completedDelta: 100,
      expectedCount: 250,
      processedBytesDelta: 4_096
    });
    fixture.phaseResults.push({
      outcome: "phase_completed",
      completedDelta: 150,
      expectedCount: 250,
      processedBytesDelta: 8_192
    });
    const coordinator = createCoordinator(fixture);
    await coordinator.requestMaintenance(request());

    await expect(coordinator.runOne(workerClaim("worker-a"))).resolves.toMatchObject({
      outcome: "progress"
    });
    fixture.expireLease();
    await expect(coordinator.recoverStale(staleRecovery())).resolves.toBe(1);
    await expect(coordinator.runOne(workerClaim("worker-b"))).resolves.toMatchObject({
      outcome: "phase_completed"
    });

    expect(fixture.phaseRunner.runPhase).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        checkpoint: expect.objectContaining({
          cursor: "source-cursor-100",
          completedCount: 100,
          batchOrdinal: 1
        })
      })
    );
    expect(fixture.liveOperations).toHaveLength(1);
    expect(fixture.terminalResults).toHaveLength(0);
  });

  it("persists a bounded opaque cursor larger than a durable public id", async () => {
    const fixture = createFixture();
    const cursor = "c".repeat(618);
    fixture.phaseResults.push({
      outcome: "progress",
      cursor,
      completedDelta: 1_000,
      expectedCount: 1_001,
      processedBytesDelta: 4_096
    });
    const coordinator = createCoordinator(fixture);
    await coordinator.requestMaintenance(request());

    await expect(coordinator.runOne(workerClaim("worker-opaque-cursor")))
      .resolves.toMatchObject({ outcome: "progress" });
    expect(fixture.liveOperations[0]?.checkpoint.cursor).toBe(cursor);
    expect(fixture.repository.releaseForRetry).not.toHaveBeenCalled();
  });

  it("retries a timed-out phase with a safe code and the same operation identity", async () => {
    const fixture = createFixture();
    fixture.phaseRunner.runPhase.mockRejectedValueOnce(
      Object.assign(new Error("provider host and credentials"), { code: "provider_timeout" })
    );
    const coordinator = createCoordinator(fixture, { phaseTimeoutMs: 1 });
    await coordinator.requestMaintenance(request());

    await expect(coordinator.runOne(workerClaim("worker-timeout"))).resolves.toEqual({
      outcome: "retry",
      operationPublicId: "operation-maintenance-contract"
    });
    expect(fixture.liveOperations[0]).toMatchObject({
      attempt: 1,
      state: "retry",
      safeErrorCode: "MAINTENANCE_PHASE_TIMEOUT"
    });
    expect(JSON.stringify(fixture.liveOperations[0])).not.toContain("credentials");
  });

  it("resets retry pressure after progress and persists deterministic throughput and ETA", async () => {
    const fixture = createFixture();
    fixture.phaseRunner.runPhase
      .mockRejectedValueOnce(Object.assign(new Error("temporary"), {
        code: "provider_timeout"
      }));
    fixture.phaseResults.push({
      outcome: "progress",
      cursor: "source-cursor-25",
      completedDelta: 25,
      expectedCount: 100,
      processedBytesDelta: 1_024
    });
    const coordinator = createCoordinator(fixture);
    await coordinator.requestMaintenance(request());

    await coordinator.runOne(workerClaim("worker-retry"));
    await coordinator.runOne(workerClaim("worker-progress"));

    expect(fixture.liveOperations[0]).toMatchObject({
      attempt: 0,
      safeErrorCode: null,
      checkpoint: {
        completedCount: 25,
        expectedCount: 100,
        lastProgressAt: "2026-08-01T10:00:00.000Z",
        throughputPerSecond: 25 / 3_600,
        estimatedCompletionAt: "2026-08-01T13:00:00.000Z"
      }
    });
  });

  it("converges retry exhaustion into one bounded failure result", async () => {
    const fixture = createFixture();
    fixture.phaseRunner.runPhase.mockRejectedValue(new Error("raw provider failure"));
    const onFailure = vi.fn();
    const coordinator = createCoordinator(fixture, { onFailure });
    await coordinator.requestMaintenance(request({ maxAttempts: 2 }));

    await coordinator.runOne(workerClaim("worker-fail-a"));
    await coordinator.runOne(workerClaim("worker-fail-b"));

    expect(fixture.liveOperations).toHaveLength(0);
    expect(fixture.terminalResults).toEqual([
      expect.objectContaining({
        state: "failed",
        resultCode: "MAINTENANCE_RETRY_EXHAUSTED"
      })
    ]);
    expect(JSON.stringify(fixture.terminalResults)).not.toContain("raw provider failure");
    expect(fixture.cleanup.terminate).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenNthCalledWith(1, {
      operationPublicId: "operation-maintenance-contract",
      knowledgeBaseId: "kb-maintenance-contract",
      attempt: 1,
      code: "MAINTENANCE_PHASE_FAILED",
      error: expect.objectContaining({ message: "raw provider failure" })
    });
    expect(onFailure).toHaveBeenCalledTimes(2);
  });

  it("lets deletion supersede maintenance and removes its stale partial plan", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);
    await coordinator.requestMaintenance(request());
    fixture.markSuperseded("operation-maintenance-contract");

    await expect(coordinator.runOne(workerClaim("worker-superseded"))).resolves.toEqual({
      outcome: "superseded",
      operationPublicId: "operation-maintenance-contract"
    });
    expect(fixture.phaseRunner.runPhase).not.toHaveBeenCalled();
    expect(fixture.cleanup.terminate).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-maintenance-contract",
      operationPublicId: "operation-maintenance-contract",
      outcome: "superseded"
    }));
    expect(fixture.liveUnifiedCandidates).toBe(0);
    expect(fixture.liveCandidateRoots).toBe(0);
  });

  it("terminates a stale plan without retrying or retaining its candidate", async () => {
    const fixture = createFixture();
    fixture.phaseRunner.runPhase.mockRejectedValueOnce(
      Object.assign(new Error("revision detail"), { code: "stale_plan" })
    );
    const coordinator = createCoordinator(fixture);
    await coordinator.requestMaintenance(request());

    await expect(coordinator.runOne(workerClaim("worker-stale-plan"))).resolves.toEqual({
      outcome: "superseded",
      operationPublicId: "operation-maintenance-contract"
    });
    expect(fixture.repository.releaseForRetry).not.toHaveBeenCalled();
    expect(fixture.cleanup.terminate).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "superseded"
    }));
    expect(fixture.terminalResults).toEqual([
      expect.objectContaining({
        state: "superseded",
        resultCode: "MAINTENANCE_STALE_PLAN"
      })
    ]);
    expect(JSON.stringify(fixture.terminalResults)).not.toContain("revision detail");
  });

  it("passes one unified candidate identity to content and graph-seed rebuild work", async () => {
    const fixture = createFixture();
    fixture.phaseResults.push({
      outcome: "progress",
      cursor: "source-cursor-1",
      completedDelta: 1,
      expectedCount: 2,
      processedBytesDelta: 512
    });
    const coordinator = createCoordinator(fixture);
    await coordinator.requestMaintenance(request());
    await coordinator.runOne(workerClaim("worker-unified"));

    expect(fixture.phaseRunner.runPhase).toHaveBeenCalledWith(expect.objectContaining({
      searchProjection: {
        activeRole: "active",
        candidateRole: "candidate",
        documentKinds: ["content", "graph_seed"]
      }
    }));
    expect(fixture.liveUnifiedCandidates).toBe(1);
    expect(fixture.splitSearchIndexes).toBe(0);
  });

  it("keeps unrelated knowledge-base maintenance independently claimable", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);
    await coordinator.requestMaintenance(request());
    await coordinator.requestMaintenance(request({
      knowledgeBaseId: "kb-maintenance-sibling",
      operationPublicId: "operation-maintenance-sibling",
      idempotencyKey: "maintenance-sibling"
    }));

    expect(fixture.liveOperations).toHaveLength(2);
    expect(new Set(fixture.liveOperations.map((item) => item.knowledgeBaseId)))
      .toEqual(new Set(["kb-maintenance-contract", "kb-maintenance-sibling"]));
  });

  it("does not claim durable work while maintenance capacity is backpressured", async () => {
    const fixture = createFixture({
      resourcePressureCode: "MAINTENANCE_DATABASE_PRESSURE"
    });
    const coordinator = createCoordinator(fixture);
    await coordinator.requestMaintenance(request());

    await expect(coordinator.runOne(workerClaim("worker-backpressured"))).resolves.toEqual({
      outcome: "backpressured",
      operationPublicId: null,
      reasonCode: "MAINTENANCE_DATABASE_PRESSURE"
    });
    expect(fixture.repository.claimOne).not.toHaveBeenCalled();
    expect(fixture.liveOperations).toHaveLength(1);
    expect(fixture.liveOperations[0]).toMatchObject({ state: "queued", attempt: 0 });
  });

  it("releases maintenance capacity after idle and completed phase slices", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);
    await expect(coordinator.runOne(workerClaim("worker-idle"))).resolves.toEqual({
      outcome: "idle",
      operationPublicId: null
    });
    expect(fixture.repository.claimOne).toHaveBeenLastCalledWith({
      ...workerClaim("worker-idle"),
      searchProviderKind: "meilisearch"
    });
    await coordinator.requestMaintenance(request());
    await expect(coordinator.runOne(workerClaim("worker-phase"))).resolves.toMatchObject({
      outcome: "phase_completed"
    });
    expect(fixture.permitRelease).toHaveBeenCalledTimes(2);
  });
});

function createCoordinator(
  fixture: ReturnType<typeof createFixture>,
  overrides: {
    phaseTimeoutMs?: number;
    onFailure?: NonNullable<Parameters<MaintenanceCoordinatorFactory>[0]["onFailure"]>;
  } = {}
): MaintenanceCoordinator {
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("Storage vNext maintenance coordinator is unavailable");
  return factory({
    repository: fixture.repository,
    searchProviderKind: "meilisearch",
    phaseRunner: fixture.phaseRunner,
    cleanup: fixture.cleanup,
    resourceGate: fixture.resourceGate,
    now: () => new Date("2026-08-01T10:00:00.000Z"),
    phaseTimeoutMs: overrides.phaseTimeoutMs ?? 1_000,
    ...(overrides.onFailure ? { onFailure: overrides.onFailure } : {})
  });
}

function createFixture(input: {
  liveForegroundOwner?: "upload" | "mutation" | "publication" | "deletion";
  resourcePressureCode?: string;
} = {}) {
  type LiveOperation = {
    knowledgeBaseId: string;
    operationPublicId: string;
    requestHash: string;
    idempotencyKey: string;
    state: "queued" | "running" | "retry" | "superseded";
    attempt: number;
    maxAttempts: number;
    leaseOwner: string | null;
    safeErrorCode: string | null;
    checkpoint: MaintenanceCheckpoint;
  };
  const liveOperations: LiveOperation[] = [];
  const terminalResults: Array<{
    operationPublicId: string;
    state: "completed" | "failed" | "superseded";
    resultCode: string;
  }> = [];
  const phaseResults: MaintenancePhaseResult[] = [];
  let liveUnifiedCandidates = 0;
  let liveCandidateRoots = 0;
  const splitSearchIndexes = 0;

  const repository = {
    acceptMaintenance: vi.fn(async (requestInput: MaintenanceRequest & {
      requestHash: string;
      workKind: "maintenance";
      initialCheckpoint: MaintenanceCheckpoint;
    }): Promise<MaintenanceAcceptance> => {
      if (input.liveForegroundOwner === "deletion") {
        throw errorWithCode("knowledge_base_deleting");
      }
      if (input.liveForegroundOwner) {
        return {
          outcome: "deferred",
          operationPublicId: null,
          state: "deferred",
          reasonCode: "FOREGROUND_WORK_ACTIVE"
        };
      }
      const idempotent = liveOperations.find((item) =>
        item.knowledgeBaseId === requestInput.knowledgeBaseId
        && item.idempotencyKey === requestInput.idempotencyKey
      );
      if (idempotent) {
        if (idempotent.requestHash !== requestInput.requestHash) {
          throw errorWithCode("idempotency_conflict");
        }
        return {
          outcome: "replayed",
          operationPublicId: idempotent.operationPublicId,
          state: "active",
          reasonCode: null
        };
      }
      const active = liveOperations.find((item) =>
        item.knowledgeBaseId === requestInput.knowledgeBaseId
      );
      if (active) {
        return {
          outcome: "already_active",
          operationPublicId: active.operationPublicId,
          state: "active",
          reasonCode: null
        };
      }
      liveOperations.push({
        knowledgeBaseId: requestInput.knowledgeBaseId,
        operationPublicId: requestInput.operationPublicId,
        requestHash: requestInput.requestHash,
        idempotencyKey: requestInput.idempotencyKey,
        state: "queued",
        attempt: 0,
        maxAttempts: requestInput.maxAttempts,
        leaseOwner: null,
        safeErrorCode: null,
        checkpoint: requestInput.initialCheckpoint
      });
      liveUnifiedCandidates += 1;
      liveCandidateRoots += 1;
      return {
        outcome: "queued",
        operationPublicId: requestInput.operationPublicId,
        state: "queued",
        reasonCode: null
      };
    }),
    claimOne: vi.fn(async (claimInput: {
      workerId: string;
      leaseExpiresAt: string;
    }) => {
      const operation = liveOperations.find((item) =>
        item.state === "queued" || item.state === "retry" || item.state === "superseded"
      );
      if (!operation) return null;
      operation.leaseOwner = claimInput.workerId;
      if (operation.state !== "superseded") operation.state = "running";
      return structuredClone(operation);
    }),
    saveProgress: vi.fn(async (saveInput: {
      operationPublicId: string;
      checkpoint: MaintenanceCheckpoint;
    }) => {
      const operation = requireOperation(saveInput.operationPublicId);
      operation.checkpoint = structuredClone(saveInput.checkpoint);
      operation.state = "queued";
      operation.attempt = 0;
      operation.safeErrorCode = null;
      operation.leaseOwner = null;
    }),
    releaseForRetry: vi.fn(async (retryInput: {
      operationPublicId: string;
      safeErrorCode: string;
    }) => {
      const operation = requireOperation(retryInput.operationPublicId);
      operation.attempt += 1;
      operation.safeErrorCode = retryInput.safeErrorCode;
      operation.state = "retry";
      operation.leaseOwner = null;
      return operation.attempt >= operation.maxAttempts ? "exhausted" as const : "retry" as const;
    }),
    complete: vi.fn(async (completeInput: {
      operationPublicId: string;
      state: "completed" | "failed" | "superseded";
      resultCode: string;
    }) => {
      const index = liveOperations.findIndex((item) =>
        item.operationPublicId === completeInput.operationPublicId
      );
      if (index >= 0) liveOperations.splice(index, 1);
      terminalResults.push({ ...completeInput });
      liveUnifiedCandidates = 0;
      liveCandidateRoots = 0;
    }),
    recoverStale: vi.fn(async () => {
      let recovered = 0;
      for (const operation of liveOperations) {
        if (operation.state === "running") {
          operation.state = "retry";
          operation.leaseOwner = null;
          recovered += 1;
        }
      }
      return recovered;
    })
  };

  const phaseRunner = {
    runPhase: vi.fn(async (): Promise<MaintenancePhaseResult> =>
      phaseResults.shift() ?? {
        outcome: "phase_completed",
        completedDelta: 0,
        expectedCount: 0,
        processedBytesDelta: 0
      })
  };
  const cleanup = {
    terminate: vi.fn(async (cleanupInput: {
      operationPublicId: string;
      outcome: "completed" | "failed" | "superseded";
    }) => {
      liveUnifiedCandidates = 0;
      liveCandidateRoots = 0;
      return cleanupInput;
    })
  };
  const permitRelease = vi.fn();
  const resourceGate = {
    tryAcquire: vi.fn(async () => input.resourcePressureCode
      ? {
          outcome: "backpressured" as const,
          reasonCode: input.resourcePressureCode
        }
      : {
          outcome: "acquired" as const,
          release: permitRelease
        })
  };

  function requireOperation(operationPublicId: string): LiveOperation {
    const operation = liveOperations.find((item) =>
      item.operationPublicId === operationPublicId
    );
    if (!operation) throw new Error("Maintenance operation is missing");
    return operation;
  }

  return {
    repository,
    phaseRunner,
    cleanup,
    resourceGate,
    permitRelease,
    phaseResults,
    liveOperations,
    terminalResults,
    expireLease() {
      const operation = liveOperations[0];
      if (operation) operation.state = "running";
    },
    markSuperseded(operationPublicId: string) {
      requireOperation(operationPublicId).state = "superseded";
    },
    get liveUnifiedCandidates() {
      return liveUnifiedCandidates;
    },
    get liveCandidateRoots() {
      return liveCandidateRoots;
    },
    splitSearchIndexes
  };
}

function request(overrides: Partial<MaintenanceRequest> = {}): MaintenanceRequest {
  return {
    knowledgeBaseId: "kb-maintenance-contract",
    operationPublicId: "operation-maintenance-contract",
    trigger: "manual",
    idempotencyKey: "maintenance-contract",
    expectedResourceRevision: 7,
    settingsRevisionPublicId: "settings-maintenance-contract",
    requestedAt: "2026-08-01T09:00:00.000Z",
    expiresAt: "2026-08-02T09:00:00.000Z",
    maxAttempts: 3,
    ...overrides
  };
}

function workerClaim(workerId: string) {
  return {
    workerId,
    leaseExpiresAt: "2026-08-01T10:01:00.000Z"
  };
}

function staleRecovery() {
  return {
    expiredBefore: "2026-08-01T10:00:00.000Z",
    retryAt: "2026-08-01T10:00:01.000Z",
    limit: 10
  };
}

function errorWithCode(code: string): Error {
  return Object.assign(new Error(`Storage vNext maintenance error: ${code}`), { code });
}
