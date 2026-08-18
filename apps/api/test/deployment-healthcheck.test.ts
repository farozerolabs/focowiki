import { describe, expect, it, vi } from "vitest";
import {
  runDeploymentDependencyHealthcheck,
  runWorkerRuntimeHealthcheck
} from "../src/runtime/deployment-healthcheck.js";

describe("deployment dependency healthcheck", () => {
  it("checks the worker engine without requiring user model settings", async () => {
    const events: string[] = [];

    await runWorkerRuntimeHealthcheck(() => ({
      async start() {
        events.push("start");
      },
      async close() {
        events.push("close");
      }
    }));

    expect(events).toEqual(["start", "close"]);
  });

  it("checks usable dependencies in deterministic order and closes connections", async () => {
    const events: string[] = [];

    await runDeploymentDependencyHealthcheck({
      assertDeploymentSecret() {
        events.push("deployment-secret");
      },
      assertTokenizer() {
        events.push("tokenizer");
      },
      database: {
        async check() {
          events.push("database");
        },
        async close() {
          events.push("database-close");
        }
      },
      redis: {
        async connect() {
          events.push("redis-connect");
        },
        async ping() {
          events.push("redis-ping");
        },
        async close() {
          events.push("redis-close");
        }
      },
      async checkStorage() {
        events.push("storage");
      },
      async checkSearch() {
        events.push("search");
      },
      async checkWorkerRuntime() {
        events.push("worker-runtime");
      },
      async checkRole() {
        events.push("role");
      }
    });

    expect(events).toEqual([
      "deployment-secret",
      "tokenizer",
      "database",
      "redis-connect",
      "redis-ping",
      "storage",
      "search",
      "worker-runtime",
      "role",
      "redis-close",
      "database-close"
    ]);
  });

  it("stops on an incompatible schema and still closes the database", async () => {
    const redisConnect = vi.fn();
    const databaseClose = vi.fn();

    await expect(runDeploymentDependencyHealthcheck({
      assertDeploymentSecret() {},
      database: {
        async check() {
          throw new Error("Runtime schema generation is incompatible");
        },
        close: databaseClose
      },
      redis: {
        connect: redisConnect,
        ping: vi.fn(),
        close: vi.fn()
      },
      checkStorage: vi.fn(),
      checkSearch: vi.fn()
    })).rejects.toThrow("Runtime schema generation is incompatible");

    expect(redisConnect).not.toHaveBeenCalled();
    expect(databaseClose).toHaveBeenCalledOnce();
  });

  it("closes connected clients when a provider is unusable", async () => {
    const redisClose = vi.fn();
    const databaseClose = vi.fn();
    const checkSearch = vi.fn();

    await expect(runDeploymentDependencyHealthcheck({
      assertDeploymentSecret() {},
      database: { check: vi.fn(), close: databaseClose },
      redis: { connect: vi.fn(), ping: vi.fn(), close: redisClose },
      async checkStorage() {
        throw new Error("Object storage health check failed");
      },
      checkSearch
    })).rejects.toThrow("Object storage health check failed");

    expect(checkSearch).not.toHaveBeenCalled();
    expect(redisClose).toHaveBeenCalledOnce();
    expect(databaseClose).toHaveBeenCalledOnce();
  });

  it("still closes the database when Redis cleanup fails", async () => {
    const databaseClose = vi.fn();

    await expect(runDeploymentDependencyHealthcheck({
      assertDeploymentSecret() {},
      database: { check: vi.fn(), close: databaseClose },
      redis: {
        connect: vi.fn(),
        ping: vi.fn(),
        async close() {
          throw new Error("Redis close failed");
        }
      },
      checkStorage: vi.fn(),
      checkSearch: vi.fn()
    })).rejects.toThrow("Redis close failed");

    expect(databaseClose).toHaveBeenCalledOnce();
  });
});
