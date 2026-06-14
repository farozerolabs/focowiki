import { describe, expect, it } from "vitest";
import {
  createRedisConnectionOptions,
  createRedisCoordinator,
  createRedisKeyBuilder
} from "../src/redis/coordination.js";

class FakeRedisClient {
  public readonly values = new Map<string, string>();
  public readonly calls: Array<{ method: string; args: unknown[] }> = [];

  public async set(key: string, value: string, options?: unknown): Promise<string | null> {
    this.calls.push({ method: "set", args: [key, value, options] });

    if (
      options &&
      typeof options === "object" &&
      "NX" in options &&
      (options as { NX?: boolean }).NX &&
      this.values.has(key)
    ) {
      return null;
    }

    this.values.set(key, value);
    return "OK";
  }

  public async get(key: string): Promise<string | null> {
    this.calls.push({ method: "get", args: [key] });
    return this.values.get(key) ?? null;
  }

  public async del(key: string): Promise<number> {
    this.calls.push({ method: "del", args: [key] });
    const existed = this.values.delete(key);
    return existed ? 1 : 0;
  }
}

describe("Redis coordination helpers", () => {
  it("creates connection options from runtime config", () => {
    expect(
      createRedisConnectionOptions({
        redis: {
          url: "redis://127.0.0.1:6379/0"
        }
      })
    ).toEqual({
      url: "redis://127.0.0.1:6379/0"
    });
  });

  it("prefixes Redis keys consistently", () => {
    const buildKey = createRedisKeyBuilder("focowiki:test");

    expect(buildKey("sessions", "session-1")).toBe("focowiki:test:sessions:session-1");
    expect(buildKey("task-locks", "task-1")).toBe("focowiki:test:task-locks:task-1");
  });

  it("stores sessions through Redis with TTL", async () => {
    const client = new FakeRedisClient();
    const coordinator = createRedisCoordinator(client, { keyPrefix: "focowiki:test" });

    await coordinator.setSession("session-1", { adminUsername: "admin" }, 900);

    expect(await coordinator.getSession("session-1")).toEqual({ adminUsername: "admin" });
    expect(client.calls[0]).toEqual({
      method: "set",
      args: [
        "focowiki:test:sessions:session-1",
        JSON.stringify({ adminUsername: "admin" }),
        { EX: 900 }
      ]
    });
  });

  it("uses Redis NX locks for upload task coordination", async () => {
    const client = new FakeRedisClient();
    const coordinator = createRedisCoordinator(client, { keyPrefix: "focowiki:test" });

    await expect(coordinator.acquireTaskLock("task-1", "worker-1", 60)).resolves.toBe(true);
    await expect(coordinator.acquireTaskLock("task-1", "worker-2", 60)).resolves.toBe(false);
    await expect(coordinator.releaseTaskLock("task-1", "worker-2")).resolves.toBe(false);
    await expect(coordinator.releaseTaskLock("task-1", "worker-1")).resolves.toBe(true);
  });

  it("stores short-lived task event markers in Redis", async () => {
    const client = new FakeRedisClient();
    const coordinator = createRedisCoordinator(client, { keyPrefix: "focowiki:test" });

    await coordinator.recordTaskEvent("task-1", { event: "changed" }, 30);

    expect(await client.get("focowiki:test:task-events:task-1")).toBe(
      JSON.stringify({ event: "changed" })
    );
  });

  it("stores opaque pagination cursors and page cache values in Redis", async () => {
    const client = new FakeRedisClient();
    const coordinator = createRedisCoordinator(client, { keyPrefix: "focowiki:test" });

    await coordinator.setPaginationCursor("kb-list", "cursor-1", { after: "kb_1" }, 900);
    await coordinator.setPageCache("kb-list", "page-1", [{ id: "kb_1" }], 60);

    await expect(coordinator.getPaginationCursor("kb-list", "cursor-1")).resolves.toEqual({
      after: "kb_1"
    });
    await expect(coordinator.getPageCache("kb-list", "page-1")).resolves.toEqual([
      { id: "kb_1" }
    ]);
  });

  it("records pagination invalidation markers in Redis", async () => {
    const client = new FakeRedisClient();
    const coordinator = createRedisCoordinator(client, { keyPrefix: "focowiki:test" });

    await coordinator.markPaginationInvalid("kb-list", "changed", 900);

    expect(await client.get("focowiki:test:pagination-invalid:kb-list")).toBe("changed");
  });

  it("does not keep session state in coordinator memory", async () => {
    const client = new FakeRedisClient();
    const firstCoordinator = createRedisCoordinator(client, { keyPrefix: "focowiki:test" });

    await firstCoordinator.setSession("session-1", { adminUsername: "admin" }, 900);

    const secondCoordinator = createRedisCoordinator(client, { keyPrefix: "focowiki:test" });
    await expect(secondCoordinator.getSession("session-1")).resolves.toEqual({
      adminUsername: "admin"
    });
  });
});
