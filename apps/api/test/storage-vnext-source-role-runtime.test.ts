import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextSourceRoleRuntime
} from "../src/storage-vnext/source-processing/role-runtime.js";

describe("storage vNext source role runtime", () => {
  it("uses the latest settings for each bounded claim and stops without another poll", async () => {
    const controller = new AbortController();
    const snapshots = [
      settings({ claimBatchSize: 2, lockTtlSeconds: 30 }),
      settings({ sourceFileConcurrency: 1, claimBatchSize: 1, lockTtlSeconds: 60 })
    ];
    const getSettings = vi.fn(async () => snapshots.shift() ?? settings());
    const runOnce = vi.fn(async () => {
      if (runOnce.mock.calls.length === 2) controller.abort();
      return { claimed: 1, completed: 1, retried: 0, terminal: 0 };
    });
    const wait = vi.fn(async () => undefined);
    const runtime = createStorageVnextSourceRoleRuntime({
      owner: "source-worker-test",
      clock: () => "2026-08-02T00:00:00.000Z",
      getSettings,
      recoverStale: vi.fn(async () => 0),
      createWorker: vi.fn(() => ({ runOnce })),
      wait
    });

    await runtime.run(controller.signal);

    expect(getSettings).toHaveBeenCalledTimes(2);
    expect(runOnce).toHaveBeenNthCalledWith(1, {
      owner: "source-worker-test",
      limit: 2,
      leaseExpiresAt: "2026-08-02T00:00:30.000Z",
      signal: controller.signal
    });
    expect(runOnce).toHaveBeenNthCalledWith(2, {
      owner: "source-worker-test",
      limit: 1,
      leaseExpiresAt: "2026-08-02T00:01:00.000Z",
      signal: controller.signal
    });
    expect(wait).not.toHaveBeenCalled();
  });

  it("waits abortably after an idle claim and does not hide processing failures", async () => {
    const idleController = new AbortController();
    const idleWait = vi.fn(async (_milliseconds: number, signal: AbortSignal) => {
      idleController.abort();
      expect(signal).toBe(idleController.signal);
    });
    const idle = createStorageVnextSourceRoleRuntime({
      owner: "source-worker-idle",
      clock: () => "2026-08-02T00:00:00.000Z",
      getSettings: async () => settings({ pollIntervalMs: 250 }),
      recoverStale: vi.fn(async () => 0),
      createWorker: () => ({
        runOnce: async () => ({ claimed: 0, completed: 0, retried: 0, terminal: 0 })
      }),
      wait: idleWait
    });

    await idle.run(idleController.signal);
    expect(idleWait).toHaveBeenCalledWith(250, idleController.signal);

    const failed = createStorageVnextSourceRoleRuntime({
      owner: "source-worker-failed",
      clock: () => "2026-08-02T00:00:00.000Z",
      getSettings: async () => settings(),
      recoverStale: vi.fn(async () => 0),
      createWorker: () => ({ runOnce: async () => { throw new Error("database unavailable"); } })
    });
    await expect(failed.run(new AbortController().signal))
      .rejects.toThrow("database unavailable");
  });

  it("recovers expired source work before claiming the next bounded batch", async () => {
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
    const runtime = createStorageVnextSourceRoleRuntime({
      owner: "source-worker-recovery",
      clock: () => "2026-08-02T00:00:00.000Z",
      getSettings: async () => settings({ sourceFileConcurrency: 2, claimBatchSize: 3 }),
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
    sourceFileConcurrency: 2,
    claimBatchSize: 2,
    pollIntervalMs: 1_000,
    lockTtlSeconds: 30,
    jobMaxAttempts: 3,
    jobRetryDelayMs: 30_000,
    completedJobRetentionDays: 7
  };
}
