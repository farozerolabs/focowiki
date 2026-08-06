import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextPublicationRoleRuntime
} from "../src/storage-vnext/publication/role-runtime.js";

describe("storage vNext publication role runtime", () => {
  it("does not claim publication work while the latest mode is manual", async () => {
    const controller = new AbortController();
    const createWorker = vi.fn();
    const wait = vi.fn(async () => { controller.abort(); });
    const runtime = createStorageVnextPublicationRoleRuntime({
      owner: "publication-worker-one",
      clock: () => "2026-08-02T00:00:00.000Z",
      getSettings: async () => settings({ mode: "manual" }),
      recoverStale: vi.fn(async () => 0),
      createWorker,
      wait
    });

    await runtime.run(controller.signal);

    expect(createWorker).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledWith(1_000, controller.signal);
  });

  it("uses a fresh settings snapshot for every bounded publication claim", async () => {
    const controller = new AbortController();
    const snapshots = [
      settings({ roleConcurrency: 2, claimBatchSize: 3, lockTtlSeconds: 30 }),
      settings({ roleConcurrency: 1, claimBatchSize: 1, lockTtlSeconds: 60 })
    ];
    const runOnce = vi.fn(async () => {
      if (runOnce.mock.calls.length === 2) controller.abort();
      return { claimed: 1, completed: 1, retried: 0, terminal: 0 };
    });
    const runtime = createStorageVnextPublicationRoleRuntime({
      owner: "publication-worker-one",
      clock: () => "2026-08-02T00:00:00.000Z",
      getSettings: vi.fn(async () => snapshots.shift() ?? settings()),
      recoverStale: vi.fn(async () => 0),
      createWorker: vi.fn(() => ({ runOnce })),
      wait: vi.fn(async () => undefined)
    });

    await runtime.run(controller.signal);

    expect(runOnce).toHaveBeenNthCalledWith(1, {
      owner: "publication-worker-one",
      limit: 2,
      leaseExpiresAt: "2026-08-02T00:00:30.000Z",
      signal: controller.signal
    });
    expect(runOnce).toHaveBeenNthCalledWith(2, {
      owner: "publication-worker-one",
      limit: 1,
      leaseExpiresAt: "2026-08-02T00:01:00.000Z",
      signal: controller.signal
    });
  });

  it("recovers expired publication work before claiming the next bounded batch", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const recoverStale = vi.fn(async () => {
      order.push("recover");
      return 1;
    });
    const runOnce = vi.fn(async () => {
      order.push("claim");
      controller.abort();
      return { claimed: 1, completed: 1, retried: 0, terminal: 0 };
    });
    const runtime = createStorageVnextPublicationRoleRuntime({
      owner: "publication-worker-recovery",
      clock: () => "2026-08-02T00:00:00.000Z",
      getSettings: async () => settings({ roleConcurrency: 2, claimBatchSize: 3 }),
      recoverStale,
      createWorker: vi.fn(() => ({ runOnce })),
      wait: vi.fn(async () => undefined)
    });

    await runtime.run(controller.signal);

    expect(recoverStale).toHaveBeenCalledWith({
      expiredBefore: "2026-08-02T00:00:00.000Z",
      retryAt: "2026-08-02T00:00:00.000Z",
      limit: 2
    });
    expect(order).toEqual(["recover", "claim"]);
  });
});

function settings(overrides: Partial<ReturnType<typeof settingsShape>> = {}) {
  return { ...settingsShape(), ...overrides };
}

function settingsShape() {
  return {
    mode: "per_file" as "batch" | "manual" | "per_file",
    roleConcurrency: 2,
    claimBatchSize: 2,
    pollIntervalMs: 1_000,
    lockTtlSeconds: 30,
    jobMaxAttempts: 3,
    jobRetryDelayMs: 30_000,
    completedJobRetentionDays: 7
  };
}
