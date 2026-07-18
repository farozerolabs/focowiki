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

  it("falls back to bounded reads while an established Redis connection is interrupted", async () => {
    const client = createClient();
    const result = await connectApiRedis({
      config,
      logger: createLogger(),
      createClient: () => client
    });

    client.isReady = false;

    await expect(result?.getPaginationCursor("files", "cursor-1")).resolves.toBeNull();
    await expect(result?.getPublicOpenApiKeyCache("hash-1")).resolves.toBeNull();
    await expect(result?.getSession("session-1")).resolves.toBeNull();
    await expect(result?.acquireLock("scope", "id", "owner", 30)).resolves.toBe(false);
    await expect(
      result?.hitRateLimit("scope", "id", { max: 10, windowSeconds: 60 })
    ).resolves.toMatchObject({ allowed: true, remaining: 10 });
  });

  it("recovers Redis-backed behavior after the connection becomes ready again", async () => {
    const client = createClient();
    const result = await connectApiRedis({
      config,
      logger: createLogger(),
      createClient: () => client
    });

    client.isReady = false;
    await expect(result?.getPaginationCursor("files", "cursor-1")).resolves.toBeNull();

    client.isReady = true;
    client.emit("ready");
    client.get.mockResolvedValueOnce(JSON.stringify({ offset: 20 }) as never);

    await expect(result?.getPaginationCursor("files", "cursor-1")).resolves.toEqual({ offset: 20 });
  });
});

function createClient(options: { connectError?: Error; destroyError?: Error } = {}) {
  const listeners = new Map<string, (...arguments_: never[]) => void>();
  const client = {
    isReady: true,
    on: vi.fn((event: string, listener: (error: Error) => void) => {
      listeners.set(event, listener as (...arguments_: never[]) => void);
    }),
    emit(event: string) {
      listeners.get(event)?.();
    },
    connect: vi.fn(async () => {
      if (options.connectError) {
        (listeners.get("error") as ((error: Error) => void) | undefined)?.(options.connectError);
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
    ttl: vi.fn(async () => 60),
    sAdd: vi.fn(async () => 1),
    sRem: vi.fn(async () => 1),
    sScanIterator: async function* () {
      yield [];
    }
  };

  return client;
}

function createLogger(): RuntimeLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  };
}
