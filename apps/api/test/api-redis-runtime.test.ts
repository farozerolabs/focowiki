import { describe, expect, it, vi } from "vitest";
import { connectApiRedis } from "../src/redis/api-runtime.js";
import type { RuntimeConfig } from "../src/config.js";
import type { RuntimeLogger } from "../src/logger.js";

const config = {
  redis: {
    url: "redis://127.0.0.1:6379/0"
  }
} as RuntimeConfig;

describe("API Redis runtime", () => {
  it("returns a coordinator after Redis connects", async () => {
    const client = createClient();
    const result = await connectApiRedis({
      config,
      logger: createLogger(),
      createClient: () => client
    });

    expect(client.connect).toHaveBeenCalledOnce();
    expect(result?.buildKey("scope", "id")).toBe("focowiki:scope:id");
  });

  it("continues without Redis when the API connection is unavailable", async () => {
    const client = createClient({
      connectError: new Error("connect ECONNREFUSED 127.0.0.1:1"),
      destroyError: new Error("The client is closed")
    });
    const logger = createLogger();
    const result = await connectApiRedis({
      config,
      logger,
      createClient: () => client
    });

    expect(result).toBeNull();
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      "API Redis unavailable; continuing with bounded database reads"
    );
  });
});

function createClient(options: { connectError?: Error; destroyError?: Error } = {}) {
  const listeners = new Map<string, (error: Error) => void>();
  return {
    on: vi.fn((event: string, listener: (error: Error) => void) => {
      listeners.set(event, listener);
    }),
    connect: vi.fn(async () => {
      if (options.connectError) {
        listeners.get("error")?.(options.connectError);
        throw options.connectError;
      }
    }),
    destroy: vi.fn(() => {
      if (options.destroyError) throw options.destroyError;
    }),
    set: vi.fn(async () => "OK"),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 0),
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    ttl: vi.fn(async () => 60)
  };
}

function createLogger(): RuntimeLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  };
}
