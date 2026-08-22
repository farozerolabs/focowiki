import { describe, expect, it, vi } from "vitest";
import {
  createDocumentFixedDagScheduler
} from "../src/document-indexing/application/document-fixed-dag-scheduler.js";
import {
  createAdaptiveResourceController
} from "../src/document-indexing/application/adaptive-resource-controller.js";
import {
  createWeightedGenerationQueue
} from "../src/document-indexing/application/weighted-generation-queue.js";
import {
  createWeightedGenerationTaskRunner
} from "../src/document-indexing/application/weighted-generation-task-runner.js";
import {
  createDocumentResourceLanes
} from "../src/document-indexing/application/document-resource-lanes.js";

describe("fixed DAG scheduler", () => {
  it("reports lane saturation as a typed retry-safe diagnostic", async () => {
    const lanes = createDocumentResourceLanes({
      capacities: Object.fromEntries([
        "postgres_s3", "coordination", "generation_model", "graphrag_adapter",
        "embedding", "search_transport", "projection", "activation", "cleanup"
      ].map((lane) => [lane, 1])) as never,
      maximumWaitersPerLane: 0
    });
    const release = await lanes.acquire("search_transport");
    await expect(lanes.acquire("search_transport")).rejects.toMatchObject({
      code: "DOCUMENT_RESOURCE_LANE_SATURATED",
      resourceLane: "search_transport"
    });
    release();
  });

  it("admits lane capacity before claiming durable work", async () => {
    const events: string[] = [];
    const release = vi.fn();
    const scheduler = createDocumentFixedDagScheduler({
      work: {
        async claim({ kind, limit }) {
          events.push("claim:" + kind);
          return limit === 1 ? [{
            publicId: "work-1",
            kind,
            resourceLane: "generation_model"
          }] : [];
        }
      },
      lanes: {
        async acquire(lane) {
          events.push("admit:" + lane);
          return release;
        }
      }
    });

    await expect(scheduler.claimOne({
      kind: "first_layer",
      resourceLane: "generation_model",
      workerId: "worker-1",
      now: "2026-08-15T00:00:00.000Z",
      leaseDurationMs: 30_000
    })).resolves.toMatchObject({ publicId: "work-1", kind: "first_layer" });
    expect(events).toEqual(["admit:generation_model", "claim:first_layer"]);
    scheduler.release("work-1");
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases unused admission when no work is claimable", async () => {
    const release = vi.fn();
    const scheduler = createDocumentFixedDagScheduler({
      work: { async claim() { return []; } },
      lanes: { async acquire() { return release; } }
    });
    await expect(scheduler.claimOne({
      kind: "content_projection",
      resourceLane: "postgres_s3",
      workerId: "worker-1",
      now: "2026-08-15T00:00:00.000Z",
      leaseDurationMs: 30_000
    })).resolves.toBeNull();
    expect(release).toHaveBeenCalledOnce();
  });

  it("feeds actual lane service outcome and pressure into adaptive admission", async () => {
    const observe = vi.fn();
    const scheduler = createDocumentFixedDagScheduler({
      work: {
        async claim({ kind, resourceLane }) {
          return [{ publicId: "work-adaptive", kind, resourceLane }];
        }
      },
      lanes: {
        async acquire() { return () => undefined; },
        observe
      },
      clockMs: () => 25,
      pressure: () => ({ cpuPressure: 0.7, memoryPressure: 0.8 })
    });
    await scheduler.claimOne({
      kind: "content_projection",
      resourceLane: "postgres_s3",
      workerId: "worker-1",
      now: "2026-08-15T00:00:00.000Z",
      leaseDurationMs: 30_000
    });
    scheduler.release("work-adaptive", "timeout");
    expect(observe).toHaveBeenCalledWith("postgres_s3", {
      outcome: "timeout",
      latencyMs: 0,
      cpuPressure: 0.7,
      memoryPressure: 0.8
    });
  });

  it("claims one indexed transport batch up to currently admitted capacity", async () => {
    const releases = Array.from({ length: 4 }, () => vi.fn());
    let admitted = 0;
    const claim = vi.fn(async ({ kind, limit, resourceLane }) =>
      Array.from({ length: limit }, (_, index) => ({
        publicId: `work-${index + 1}`,
        kind,
        resourceLane
      })));
    const scheduler = createDocumentFixedDagScheduler({
      claimLimit: 4,
      work: { claim },
      lanes: {
        async acquire() { throw new Error("unexpected blocking admission"); },
        tryAcquire() {
          const release = releases[admitted];
          admitted += 1;
          return release ?? null;
        }
      }
    });

    const claimed = await scheduler.claimAvailable({
      kind: "prepare",
      resourceLane: "postgres_s3",
      workerId: "worker-1",
      now: "2026-08-15T00:00:00.000Z",
      leaseDurationMs: 30_000
    });

    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ limit: 4 }));
    expect(claimed).toHaveLength(4);
    for (const work of claimed) scheduler.release(work.publicId);
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it("claims exactly one durable work item through the single-item API", async () => {
    const releases = Array.from({ length: 4 }, () => vi.fn());
    let admitted = 0;
    const claim = vi.fn(async ({ kind, limit, resourceLane }) =>
      Array.from({ length: limit }, (_, index) => ({
        publicId: `single-work-${index + 1}`,
        kind,
        resourceLane
      })));
    const scheduler = createDocumentFixedDagScheduler({
      claimLimit: 4,
      work: { claim },
      lanes: {
        async acquire() { throw new Error("unexpected blocking admission"); },
        tryAcquire() {
          const release = releases[admitted];
          admitted += 1;
          return release ?? null;
        }
      }
    });

    const claimed = await scheduler.claimOne({
      kind: "prepare",
      resourceLane: "postgres_s3",
      workerId: "worker-1",
      now: "2026-08-15T00:00:00.000Z",
      leaseDurationMs: 30_000
    });

    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
    expect(claimed).toMatchObject({ publicId: "single-work-1" });
    scheduler.release(claimed!.publicId);
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases.slice(1).every((release) => release.mock.calls.length === 0)).toBe(true);
  });
});

describe("weighted generation queue", () => {
  it("reserves first-layer progress and remains work-conserving", () => {
    const queue = createWeightedGenerationQueue({
      weights: { first_layer: 4, graphrag: 2, candidate_delta: 1, slow_retry: 1 }
    });
    for (let index = 0; index < 8; index += 1) {
      queue.enqueue("first_layer", { publicId: "first-" + index });
      queue.enqueue("graphrag", { publicId: "graph-" + index });
    }
    const firstEight = Array.from({ length: 8 }, () => queue.dequeue()!.workClass);
    expect(firstEight.filter((kind) => kind === "first_layer").length).toBeGreaterThanOrEqual(4);
    expect(firstEight).toContain("graphrag");

    const graphOnly = createWeightedGenerationQueue({
      weights: { first_layer: 4, graphrag: 2, candidate_delta: 1, slow_retry: 1 }
    });
    graphOnly.enqueue("graphrag", { publicId: "graph-only" });
    expect(graphOnly.dequeue()).toMatchObject({
      workClass: "graphrag",
      item: { publicId: "graph-only" }
    });
  });
});

describe("revision-scoped generation admission", () => {
  it("keeps another model revision work-conserving after one revision is rate limited", async () => {
    const runner = createWeightedGenerationTaskRunner({
      configuredMaximum: 2,
      maximumWaiters: 8,
      weights: { first_layer: 4, graphrag: 2, candidate_delta: 1, slow_retry: 1 },
      pressure: () => ({ cpuPressure: 0.1, memoryPressure: 0.1 })
    });
    const releases: Array<() => void> = [];
    const starts: string[] = [];
    const first = runner.run("first_layer", async () => {
      starts.push("revision-a-rate-limit");
      throw Object.assign(new Error("rate limited"), { code: "HTTP_429" });
    }, { ownerKey: "model-a:1" });
    const second = runner.run("first_layer", async () => {
      starts.push("revision-a-running");
      await new Promise<void>((resolve) => releases.push(resolve));
    }, { ownerKey: "model-a:1" });
    await expect(first).rejects.toMatchObject({ code: "HTTP_429" });
    const blockedSameRevision = runner.run("first_layer", async () => {
      starts.push("revision-a-blocked");
    }, { ownerKey: "model-a:1" });
    const independentRevision = runner.run("first_layer", async () => {
      starts.push("revision-b-started");
    }, { ownerKey: "model-b:1" });

    await vi.waitFor(() => expect(starts).toContain("revision-b-started"));
    expect(starts).not.toContain("revision-a-blocked");
    releases.forEach((release) => release());
    await Promise.all([second, blockedSameRevision, independentRevision]);
  });
});

describe("adaptive resource controller", () => {
  it("applies an operator concurrency change immediately", () => {
    const controller = createAdaptiveResourceController({
      configuredMaximum: 2
    });

    expect(controller.updateConfiguredMaximum(18)).toBe(18);
    expect(controller.capacity()).toBe(18);
    expect(controller.configuredMaximum()).toBe(18);
    expect(controller.updateConfiguredMaximum(3)).toBe(3);
    expect(controller.capacity()).toBe(3);
  });

  it("preserves adaptive pressure reductions during an unchanged runtime refresh", () => {
    const controller = createAdaptiveResourceController({
      configuredMaximum: 8
    });
    controller.observe({
      outcome: "rate_limited",
      latencyMs: 1_000,
      cpuPressure: 0.1,
      memoryPressure: 0.1
    });

    expect(controller.capacity()).toBe(4);
    expect(controller.updateConfiguredMaximum(8)).toBe(4);
    expect(controller.capacity()).toBe(4);
  });

  it("never exceeds the configured limit and reacts only to sustained pressure", () => {
    const controller = createAdaptiveResourceController({
      configuredMaximum: 8,
      initialCapacity: 6,
      stableSuccessesBeforeIncrease: 3
    });
    controller.observe({ outcome: "rate_limited", latencyMs: 1_000, cpuPressure: 0.2, memoryPressure: 0.2 });
    expect(controller.capacity()).toBe(3);
    controller.observe({ outcome: "success", latencyMs: 100, cpuPressure: 0.1, memoryPressure: 0.1 });
    controller.observe({ outcome: "success", latencyMs: 100, cpuPressure: 0.1, memoryPressure: 0.1 });
    controller.observe({ outcome: "success", latencyMs: 100, cpuPressure: 0.1, memoryPressure: 0.1 });
    expect(controller.capacity()).toBe(4);
    for (let index = 0; index < 30; index += 1) {
      controller.observe({ outcome: "success", latencyMs: 100, cpuPressure: 0.1, memoryPressure: 0.1 });
    }
    expect(controller.capacity()).toBe(8);
    controller.observe({ outcome: "success", latencyMs: 100, cpuPressure: 0.95, memoryPressure: 0.2 });
    expect(controller.capacity()).toBe(8);
    controller.observe({ outcome: "success", latencyMs: 100, cpuPressure: 0.95, memoryPressure: 0.2 });
    expect(controller.capacity()).toBe(8);
    controller.observe({ outcome: "success", latencyMs: 100, cpuPressure: 0.95, memoryPressure: 0.2 });
    expect(controller.capacity()).toBe(4);
  });

  it("does not reduce provider capacity for business failures", () => {
    const controller = createAdaptiveResourceController({
      configuredMaximum: 4
    });

    for (let index = 0; index < 4; index += 1) {
      controller.observe({
        outcome: "failure",
        latencyMs: 100,
        cpuPressure: 0.1,
        memoryPressure: 0.1
      });
    }

    expect(controller.capacity()).toBe(4);
  });
});

describe("independent document resource lanes", () => {
  it("hot-applies resource capacities to newly admitted work", () => {
    const lanes = createDocumentResourceLanes({
      capacities: {
        postgres_s3: 2,
        coordination: 2,
        generation_model: 2,
        graphrag_adapter: 2,
        embedding: 2,
        search_transport: 2,
        projection: 2,
        activation: 2,
        cleanup: 1
      },
      maximumWaitersPerLane: 16
    });

    lanes.updateCapacities({
      postgres_s3: 8,
      coordination: 18,
      generation_model: 12,
      graphrag_adapter: 3,
      embedding: 10,
      search_transport: 8,
      projection: 18,
      activation: 7,
      cleanup: 1
    });

    expect(lanes.snapshot()).toMatchObject({
      postgres_s3: { capacity: 8, configuredMaximum: 8 },
      coordination: { capacity: 18, configuredMaximum: 18 },
      graphrag_adapter: { capacity: 3, configuredMaximum: 3 },
      projection: { capacity: 18, configuredMaximum: 18 }
    });
  });

  it("fills and releases each lane independently", async () => {
    const lanes = createDocumentResourceLanes({
      capacities: {
        postgres_s3: 2,
        coordination: 2,
        generation_model: 1,
        graphrag_adapter: 1,
        embedding: 2,
        search_transport: 2,
        projection: 2,
        activation: 2,
        cleanup: 1
      },
      maximumWaitersPerLane: 8
    });
    const releaseDatabase = await lanes.acquire("postgres_s3");
    const releaseModel = await lanes.acquire("generation_model");
    expect(lanes.snapshot()).toMatchObject({
      postgres_s3: { active: 1, capacity: 2 },
      generation_model: { active: 1, capacity: 1 },
      embedding: { active: 0, capacity: 2 }
    });
    releaseDatabase();
    releaseModel();
    expect(lanes.snapshot().generation_model.active).toBe(0);
  });

  it("observes nested lane service and reduces capacity after rate limiting", async () => {
    const times = [1_000, 1_025];
    const lanes = createDocumentResourceLanes({
      capacities: {
        postgres_s3: 2,
        coordination: 2,
        generation_model: 2,
        graphrag_adapter: 2,
        embedding: 4,
        search_transport: 2,
        projection: 4,
        activation: 2,
        cleanup: 2
      },
      maximumWaitersPerLane: 8,
      clockMs: () => times.shift()!,
      pressure: () => ({ cpuPressure: 0.1, memoryPressure: 0.2 })
    });

    await expect(lanes.run("embedding", async () => {
      throw Object.assign(new Error("provider rejected request"), {
        code: "HTTP_429"
      });
    })).rejects.toMatchObject({ code: "HTTP_429" });

    expect(lanes.snapshot().embedding).toEqual({
      active: 0,
      waiting: 0,
      capacity: 2,
      configuredMaximum: 4,
      pressure: {
        cpuPressure: 0.1,
        memoryPressure: 0.2,
        pressureSource: null
      }
    });
  });

  it("allows projection preparation to overlap without consuming activation", async () => {
    const lanes = createDocumentResourceLanes({
      capacities: {
        postgres_s3: 2,
        coordination: 2,
        generation_model: 1,
        graphrag_adapter: 1,
        embedding: 2,
        search_transport: 2,
        projection: 2,
        activation: 2,
        cleanup: 1
      },
      maximumWaitersPerLane: 8
    });

    const releaseFirstProjection = await lanes.acquire("projection");
    const releaseSecondProjection = await lanes.acquire("projection");
    const releaseActivation = await lanes.acquire("activation");

    expect(lanes.snapshot()).toMatchObject({
      projection: { active: 2, capacity: 2 },
      activation: { active: 1, capacity: 2 }
    });

    releaseActivation();
    releaseSecondProjection();
    releaseFirstProjection();
  });
});
