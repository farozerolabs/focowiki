import { describe, expect, it } from "vitest";
import {
  createRedisConnectionOptions,
  createRedisCoordinator,
  createRedisKeyBuilder
} from "../src/redis/coordination.js";
import { readPageResponseCache, writePageResponseCache } from "../src/page-response-cache.js";

class FakeRedisClient {
  public readonly values = new Map<string, string>();
  public readonly expirations = new Map<string, number>();
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
    this.expirations.delete(key);
    return existed ? 1 : 0;
  }

  public async incr(key: string): Promise<number> {
    this.calls.push({ method: "incr", args: [key] });
    const parsed = Number(this.values.get(key) ?? "0");

    if (!Number.isInteger(parsed)) {
      throw new Error("ERR value is not an integer or out of range");
    }

    const next = parsed + 1;
    this.values.set(key, String(next));
    return next;
  }

  public async expire(key: string, seconds: number): Promise<number> {
    this.calls.push({ method: "expire", args: [key, seconds] });

    if (!this.values.has(key)) {
      return 0;
    }

    this.expirations.set(key, Date.now() + seconds * 1_000);
    return 1;
  }

  public async ttl(key: string): Promise<number> {
    this.calls.push({ method: "ttl", args: [key] });
    const expiresAt = this.expirations.get(key);

    if (!this.values.has(key)) {
      return -2;
    }

    if (!expiresAt) {
      return -1;
    }

    return Math.max(1, Math.ceil((expiresAt - Date.now()) / 1_000));
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
    expect(buildKey("source-file-locks", "source-1")).toBe(
      "focowiki:test:source-file-locks:source-1"
    );
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

  it("uses Redis NX locks for source-file coordination", async () => {
    const client = new FakeRedisClient();
    const coordinator = createRedisCoordinator(client, { keyPrefix: "focowiki:test" });

    await expect(coordinator.acquireSourceFileLock("source-1", "worker-1", 60)).resolves.toBe(
      true
    );
    await expect(coordinator.acquireSourceFileLock("source-1", "worker-2", 60)).resolves.toBe(
      false
    );
    await expect(coordinator.releaseSourceFileLock("source-1", "worker-2")).resolves.toBe(false);
    await expect(coordinator.releaseSourceFileLock("source-1", "worker-1")).resolves.toBe(true);
  });

  it("stores short-lived source-file event markers in Redis", async () => {
    const client = new FakeRedisClient();
    const coordinator = createRedisCoordinator(client, { keyPrefix: "focowiki:test" });

    await coordinator.recordSourceFileEvent("source-1", { event: "changed" }, 30);

    expect(await client.get("focowiki:test:source-file-events:source-1")).toBe(
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

    await expect(coordinator.getPaginationInvalid("kb-list")).resolves.toBe("changed");
    expect(await client.get("focowiki:test:pagination-invalid:kb-list")).toBe("changed");
  });

  it("skips page cache reads when exact or base scopes are invalidated", async () => {
    const client = new FakeRedisClient();
    const coordinator = createRedisCoordinator(client, { keyPrefix: "focowiki:test" });

    await writePageResponseCache({
      redis: coordinator,
      scope: "source-files:kb-001:processingStatus=running",
      cacheId: "page-1",
      value: [{ id: "source-001" }]
    });

    await expect(
      readPageResponseCache({
        redis: coordinator,
        scope: "source-files:kb-001:processingStatus=running",
        cacheId: "page-1"
      })
    ).resolves.toEqual([{ id: "source-001" }]);

    await coordinator.markPaginationInvalid("source-files:kb-001", "changed", 900);

    await expect(
      readPageResponseCache({
        redis: coordinator,
        scope: "source-files:kb-001:processingStatus=running",
        cacheId: "page-1",
        invalidationScopes: ["source-files:kb-001"]
      })
    ).resolves.toBeNull();
  });

  it("stores rate-limit counters in Redis-backed state", async () => {
    const client = new FakeRedisClient();
    const coordinator = createRedisCoordinator(client, { keyPrefix: "focowiki:test" });

    await expect(
      coordinator.hitRateLimit("admin-login", "client-1", {
        max: 2,
        windowSeconds: 60
      })
    ).resolves.toMatchObject({
      allowed: true,
      remaining: 1
    });
    await expect(
      coordinator.hitRateLimit("admin-login", "client-1", {
        max: 2,
        windowSeconds: 60
      })
    ).resolves.toMatchObject({
      allowed: true,
      remaining: 0
    });
    await expect(
      coordinator.hitRateLimit("admin-login", "client-1", {
        max: 2,
        windowSeconds: 60
      })
    ).resolves.toMatchObject({
      allowed: false,
      remaining: 0
    });

    expect(client.values.has("focowiki:test:rate-limits:admin-login:client-1")).toBe(true);
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
