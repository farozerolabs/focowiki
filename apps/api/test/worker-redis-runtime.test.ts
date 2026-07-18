import { describe, expect, it, vi } from "vitest";
import type { RuntimeLogger } from "../src/logger.js";
import { registerWorkerRedisRuntimeEvents } from "../src/redis/worker-runtime.js";

describe("worker Redis runtime events", () => {
  it("reports one interruption and one recovery per outage", () => {
    const listeners = new Map<string, (...arguments_: never[]) => void>();
    const client = {
      on: vi.fn((event: string, listener: (...arguments_: never[]) => void) => {
        listeners.set(event, listener);
      })
    };
    const logger = createLogger();

    registerWorkerRedisRuntimeEvents({ client, logger, role: "source" });
    listeners.get("error")?.();
    listeners.get("error")?.();
    listeners.get("ready")?.();
    listeners.get("error")?.();

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      "Worker Redis connection interrupted; processing will resume after recovery",
      { role: "source" }
    );
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith("Worker Redis connection restored", {
      role: "source"
    });
  });
});

function createLogger(): RuntimeLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  };
}
