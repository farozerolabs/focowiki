import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

type RuntimeResourceController = {
  runSlice(input: {
    workClass: "foreground" | "background" | "maintenance" | "cleanup";
    batch: {
      itemCount: number;
      uncompressedBytes: number;
      compressedBytes: number;
      databaseConnections: number;
      searchTasks: number;
      objectRequests: number;
      memoryBytes: number;
    };
    timeoutMs: number;
    claim(signal: AbortSignal): Promise<unknown>;
    run(claim: unknown, signal: AbortSignal): Promise<unknown>;
    releaseLease?(claim: unknown): Promise<void>;
  }): Promise<Record<string, unknown>>;
  beginShutdown(): void;
  drain(): Promise<void>;
  snapshot(): Record<string, unknown>;
};

type ResourceControllerFactory = (input: Record<string, unknown>) =>
  RuntimeResourceController;
type GracefulShutdownFactory = (input: Record<string, unknown>) => {
  shutdown(): Promise<Record<string, unknown>>;
};

let createResourceController: ResourceControllerFactory | undefined;
let createGracefulShutdown: GracefulShutdownFactory | undefined;

beforeAll(async () => {
  const resourcePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/runtime/resource-controller.ts"
  );
  const shutdownPath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/runtime/graceful-role-shutdown.ts"
  );
  const [resourceModule, shutdownModule] = await Promise.all([
    import(/* @vite-ignore */ pathToFileURL(resourcePath).href).catch(() => ({})),
    import(/* @vite-ignore */ pathToFileURL(shutdownPath).href).catch(() => ({}))
  ]) as [Record<string, unknown>, Record<string, unknown>];
  createResourceController = resourceModule
    .createStorageVnextRuntimeResourceController as ResourceControllerFactory | undefined;
  createGracefulShutdown = shutdownModule
    .createStorageVnextGracefulRoleShutdown as GracefulShutdownFactory | undefined;
});

describe("storage vNext runtime resource isolation", () => {
  it("rejects aggregate database pools above non-reserved capacity", () => {
    expect(createResourceController).toBeTypeOf("function");
    if (!createResourceController) return;
    const factory = createResourceController;
    expect(() => factory(config({
      database: {
        connectionLimit: 40,
        reservedConnections: 4,
        pools: {
          api: 10,
          source: 6,
          publication: 4,
          projectionRepair: 8,
          searchRebuild: 8,
          maintenance: 2
        }
      }
    }))).rejectsConfiguration("aggregate_database_pool_exceeded");
  });

  it("rejects worker concurrency that exceeds its database pool", () => {
    expect(createResourceController).toBeTypeOf("function");
    if (!createResourceController) return;
    const factory = createResourceController;
    expect(() => factory(config({
      workerConcurrency: {
        foreground: 5,
        background: 5,
        maintenance: 1,
        cleanup: 1
      },
      database: {
        connectionLimit: 64,
        reservedConnections: 4,
        pools: {
          api: 10,
          source: 4,
          publication: 4,
          projectionRepair: 4,
          searchRebuild: 4,
          maintenance: 2
        }
      }
    }))).rejectsConfiguration("worker_database_capacity_exceeded");
  });

  it("does not claim durable work when the worker class is backpressured", async () => {
    expect(createResourceController).toBeTypeOf("function");
    if (!createResourceController) return;
    const controller = createResourceController(config({
      workerConcurrency: {
        foreground: 1,
        background: 1,
        maintenance: 1,
        cleanup: 1
      }
    }));
    const firstGate = deferred<void>();
    const first = controller.runSlice(slice({
      claim: vi.fn(async () => ({ publicId: "work-one" })),
      run: vi.fn(async () => { await firstGate.promise; })
    }));
    await vi.waitFor(() => {
      expect(controller.snapshot()).toMatchObject({ backgroundActive: 1 });
    });
    const secondClaim = vi.fn(async () => ({ publicId: "work-two" }));

    await expect(controller.runSlice(slice({ claim: secondClaim }))).resolves
      .toMatchObject({ outcome: "backpressured" });
    expect(secondClaim).not.toHaveBeenCalled();
    firstGate.resolve();
    await first;
  });

  it.each([
    ["itemCount", 101, "batch_item_limit_exceeded"],
    ["uncompressedBytes", 1_001, "batch_byte_limit_exceeded"],
    ["compressedBytes", 501, "compressed_batch_limit_exceeded"]
  ] as const)("rejects %s before a queue claim", async (field, value, code) => {
    expect(createResourceController).toBeTypeOf("function");
    if (!createResourceController) return;
    const controller = createResourceController(config());
    const claim = vi.fn(async () => ({ publicId: "work-batch" }));

    await expect(controller.runSlice(slice({
      batch: { ...batch(), [field]: value },
      claim
    }))).resolves.toMatchObject({ outcome: "backpressured", reasonCode: code });
    expect(claim).not.toHaveBeenCalled();
  });

  it("reserves search tasks, object requests, memory, and foreground capacity", async () => {
    expect(createResourceController).toBeTypeOf("function");
    if (!createResourceController) return;
    const controller = createResourceController(config({
      workerConcurrency: {
        foreground: 1,
        background: 1,
        maintenance: 1,
        cleanup: 1
      },
      resources: {
        databaseConnections: 6,
        reservedForegroundDatabaseConnections: 2,
        searchTasks: 2,
        reservedForegroundSearchTasks: 1,
        objectRequests: 2,
        reservedForegroundObjectRequests: 1,
        memoryBytes: 2_000,
        reservedForegroundMemoryBytes: 500
      }
    }));
    const held = deferred<void>();
    const background = controller.runSlice(slice({
      batch: {
        ...batch(),
        databaseConnections: 4,
        searchTasks: 1,
        objectRequests: 1,
        memoryBytes: 1_500
      },
      run: vi.fn(async () => { await held.promise; })
    }));
    await vi.waitFor(() => {
      expect(controller.snapshot()).toMatchObject({ backgroundActive: 1 });
    });

    await expect(controller.runSlice(slice({
      workClass: "maintenance",
      claim: vi.fn(async () => ({ publicId: "maintenance-work" }))
    }))).resolves.toMatchObject({ outcome: "backpressured" });
    await expect(controller.runSlice(slice({
      workClass: "foreground",
      batch: {
        ...batch(),
        databaseConnections: 2,
        searchTasks: 1,
        objectRequests: 1,
        memoryBytes: 500
      }
    }))).resolves.toMatchObject({ outcome: "completed" });
    held.resolve();
    await background;
  });

  it("aborts a timed-out slice and releases its durable lease and permits", async () => {
    expect(createResourceController).toBeTypeOf("function");
    if (!createResourceController) return;
    const controller = createResourceController(config());
    const releaseLease = vi.fn(async () => undefined);
    const run = vi.fn(async (_claim: unknown, signal: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    await expect(controller.runSlice(slice({
      timeoutMs: 10,
      run,
      releaseLease
    }))).resolves.toMatchObject({ outcome: "timed_out" });
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toMatchObject({
      backgroundActive: 0,
      searchTasksInFlight: 0,
      objectRequestsInFlight: 0,
      memoryBytesReserved: 0
    });
  });

  it("stops new claims after shutdown begins and drains active work", async () => {
    expect(createResourceController).toBeTypeOf("function");
    if (!createResourceController) return;
    const controller = createResourceController(config());
    const held = deferred<void>();
    const active = controller.runSlice(slice({
      run: vi.fn(async () => { await held.promise; })
    }));
    await vi.waitFor(() => {
      expect(controller.snapshot()).toMatchObject({ backgroundActive: 1 });
    });
    controller.beginShutdown();
    const laterClaim = vi.fn(async () => ({ publicId: "work-after-shutdown" }));

    await expect(controller.runSlice(slice({ claim: laterClaim }))).resolves
      .toMatchObject({ outcome: "shutting_down" });
    expect(laterClaim).not.toHaveBeenCalled();
    const drained = controller.drain();
    held.resolve();
    await expect(Promise.all([active, drained])).resolves.toBeDefined();
  });
});

describe("storage vNext graceful role shutdown", () => {
  it("stops readiness and claims before draining and closing resources", async () => {
    expect(createGracefulShutdown).toBeTypeOf("function");
    if (!createGracefulShutdown) return;
    const order: string[] = [];
    const shutdown = createGracefulShutdown({
      deadlineMs: 100,
      readiness: { stop: vi.fn(async () => { order.push("readiness"); }) },
      claims: { stop: vi.fn(async () => { order.push("claims"); }) },
      controller: {
        beginShutdown: vi.fn(() => { order.push("begin-shutdown"); }),
        drain: vi.fn(async () => { order.push("drain"); })
      },
      requests: { abortAll: vi.fn(() => { order.push("abort"); }) },
      leases: { releaseOwned: vi.fn(async () => { order.push("leases"); }) },
      resources: {
        closeAll: vi.fn(async () => { order.push("resources"); }),
        assertIdle: vi.fn(() => { order.push("idle"); })
      }
    });

    await expect(shutdown.shutdown()).resolves.toEqual({ outcome: "closed" });
    expect(order).toEqual([
      "readiness",
      "claims",
      "begin-shutdown",
      "drain",
      "abort",
      "leases",
      "resources",
      "idle"
    ]);
  });

  it("aborts and releases owned state when the drain deadline expires", async () => {
    expect(createGracefulShutdown).toBeTypeOf("function");
    if (!createGracefulShutdown) return;
    const abortAll = vi.fn();
    const releaseOwned = vi.fn(async () => undefined);
    const closeAll = vi.fn(async () => undefined);
    const assertIdle = vi.fn();
    const shutdown = createGracefulShutdown({
      deadlineMs: 10,
      readiness: { stop: vi.fn(async () => undefined) },
      claims: { stop: vi.fn(async () => undefined) },
      controller: {
        beginShutdown: vi.fn(),
        drain: vi.fn(async () => await new Promise<void>(() => undefined))
      },
      requests: { abortAll },
      leases: { releaseOwned },
      resources: { closeAll, assertIdle }
    });

    await expect(shutdown.shutdown()).resolves.toEqual({
      outcome: "deadline_exceeded"
    });
    expect(abortAll).toHaveBeenCalledOnce();
    expect(releaseOwned).toHaveBeenCalledOnce();
    expect(closeAll).toHaveBeenCalledOnce();
    expect(assertIdle).toHaveBeenCalledOnce();
  });

  it("converges repeated shutdown signals through one close execution", async () => {
    expect(createGracefulShutdown).toBeTypeOf("function");
    if (!createGracefulShutdown) return;
    const stopReadiness = vi.fn(async () => undefined);
    const stopClaims = vi.fn(async () => undefined);
    const closeAll = vi.fn(async () => undefined);
    const shutdown = createGracefulShutdown({
      deadlineMs: 100,
      readiness: { stop: stopReadiness },
      claims: { stop: stopClaims },
      controller: { beginShutdown: vi.fn(), drain: vi.fn(async () => undefined) },
      requests: { abortAll: vi.fn() },
      leases: { releaseOwned: vi.fn(async () => undefined) },
      resources: { closeAll, assertIdle: vi.fn() }
    });

    await expect(Promise.all([
      shutdown.shutdown(), shutdown.shutdown(), shutdown.shutdown()
    ])).resolves.toEqual([
      { outcome: "closed" }, { outcome: "closed" }, { outcome: "closed" }
    ]);
    expect(stopReadiness).toHaveBeenCalledOnce();
    expect(stopClaims).toHaveBeenCalledOnce();
    expect(closeAll).toHaveBeenCalledOnce();
  });
});

function config(overrides: Record<string, unknown> = {}) {
  return merge({
    database: {
      connectionLimit: 64,
      reservedConnections: 4,
      pools: {
        api: 10,
        source: 6,
        publication: 4,
        projectionRepair: 8,
        searchRebuild: 8,
        maintenance: 2
      }
    },
    workerConcurrency: {
      foreground: 2,
      background: 2,
      maintenance: 1,
      cleanup: 1
    },
    batchLimits: {
      maximumItems: 100,
      maximumUncompressedBytes: 1_000,
      maximumCompressedBytes: 500
    },
    resources: {
      databaseConnections: 16,
      reservedForegroundDatabaseConnections: 4,
      searchTasks: 4,
      reservedForegroundSearchTasks: 1,
      objectRequests: 4,
      reservedForegroundObjectRequests: 1,
      memoryBytes: 10_000,
      reservedForegroundMemoryBytes: 1_000
    }
  }, overrides);
}

function slice(overrides: Partial<Parameters<RuntimeResourceController["runSlice"]>[0]> = {}) {
  return {
    workClass: "background" as const,
    batch: batch(),
    timeoutMs: 1_000,
    claim: vi.fn(async () => ({ publicId: "work-default" })),
    run: vi.fn(async () => ({ completed: true })),
    ...overrides
  };
}

function batch() {
  return {
    itemCount: 1,
    uncompressedBytes: 100,
    compressedBytes: 50,
    databaseConnections: 1,
    searchTasks: 1,
    objectRequests: 1,
    memoryBytes: 100
  };
}

function merge(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = isRecord(result[key]) && isRecord(value)
      ? merge(result[key], value)
      : value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

declare module "vitest" {
  interface Assertion<T = any> {
    rejectsConfiguration(code: string): T;
  }
}

expect.extend({
  rejectsConfiguration(received: () => unknown, code: string) {
    try {
      received();
      return {
        pass: false,
        message: () => `expected configuration error ${code}`
      };
    } catch (error) {
      const actual = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      return {
        pass: actual === code,
        message: () => `expected configuration error ${code}, received ${String(actual)}`
      };
    }
  }
});
