import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRedisCoordinator,
  type RedisCommandClient
} from "../src/redis/coordination.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const coordinationPath = "apps/api/src/redis/coordination.ts";
const workflowPortPath = "apps/api/src/storage-vnext/workflow/ports.ts";
const workflowRepositoryPath =
  "apps/api/src/storage-vnext/workflow/postgres-repository.ts";
const redisRuntimePaths = [
  "apps/api/src/redis/api-runtime.ts",
  "apps/api/src/storage-vnext/source-processing/production-runtime.ts",
  "apps/api/src/storage-vnext/publication/production-runtime.ts",
  "apps/api/src/storage-vnext/maintenance/production-runtime.ts"
];

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

describe("storage vNext Redis and durable-authority Red contract", () => {
  it("expires the bounded current-settings signal instead of leaving a persistent key", () => {
    const source = read(coordinationPath);
    const method = source.match(
      /async setRuntimeSettingsVersion\(version\)[\s\S]*?\n\s*\},/u
    )?.[0] ?? "";

    expect(method).toContain('buildKey("runtime-settings", "version")');
    expect(method).toMatch(/\{\s*EX:\s*[^}\s]+\s*\}/u);
  });

  it("applies the configured Redis namespace in every runtime role", () => {
    for (const path of redisRuntimePaths) {
      expect(read(path), path).toMatch(
        /createRedisCoordinator\(\s*(?:client|redisClient),\s*\{\s*keyPrefix:\s*(?:input\.)?config\.redis\.keyPrefix\s*\?\?\s*"focowiki"\s*\}\s*\)/u
      );
    }
  });

  it("does not keep write-only source status duplicates in Redis", () => {
    const source = read(coordinationPath);

    for (const obsoleteFamily of [
      "source-file-events",
      "source-file-graph-state",
      "source-file-runtime-index"
    ]) {
      expect(source, obsoleteFamily).not.toContain(`"${obsoleteFamily}"`);
    }
  });

  it("attaches the rate-counter expiry atomically", () => {
    const source = read(coordinationPath);
    const helper = source.match(
      /async function incrementRateLimitCounter\([\s\S]*?\n\}\n/u
    )?.[0] ?? "";

    expect(helper).toMatch(/client\.(?:eval|sendCommand)\(/u);
    expect(helper).not.toMatch(/await client\.incr\([\s\S]*await client\.expire\(/u);
  });

  it("cannot delete a successor lock after the original owner expires", async () => {
    const client = new LockRaceRedisClient();
    const redis = createRedisCoordinator(client, { keyPrefix: "storage-vnext-red" });
    const key = redis.buildKey("locks", "workflow", "operation-one");
    client.values.set(key, "owner-one");
    client.replaceAfterRead = { key, value: "owner-two" };

    await expect(
      redis.releaseLock("workflow", "operation-one", "owner-one")
    ).resolves.toBe(false);
    expect(client.values.get(key)).toBe("owner-two");
  });

  it("persists live workflow, idempotency, and bounded results in PostgreSQL", () => {
    expect(
      existsSync(resolve(workspaceRoot, workflowRepositoryPath)),
      workflowRepositoryPath
    ).toBe(true);
    if (!existsSync(resolve(workspaceRoot, workflowRepositoryPath))) return;

    const source = read(workflowRepositoryPath);
    for (const relation of [
      "operation_work_items",
      "operation_idempotency",
      "operation_results"
    ]) {
      expect(source, relation).toContain(`focowiki.${relation}`);
    }
    expect(source).not.toMatch(/new\s+(?:Map|Set)\b|from\s+["'][^"']*redis/u);
  });

  it("keeps workflow authority ports independent from Redis and process memory", () => {
    const source = read(workflowPortPath);

    expect(source).toContain("StorageVnextWorkflowClaimPort");
    expect(source).toContain("StorageVnextWorkflowWritePort");
    expect(source).toContain("StorageVnextBoundedResult");
    expect(source).not.toMatch(/from\s+["'][^"']*redis|RedisCoordinator|new\s+(?:Map|Set)\b/u);
  });
});

class LockRaceRedisClient implements RedisCommandClient {
  public readonly values = new Map<string, string>();
  public replaceAfterRead: { key: string; value: string } | null = null;

  public async set(
    key: string,
    value: string,
    options?: Record<string, unknown>
  ): Promise<string | null> {
    if (options?.NX === true && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  public async get(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null;
    if (this.replaceAfterRead?.key === key) {
      this.values.set(key, this.replaceAfterRead.value);
      this.replaceAfterRead = null;
    }
    return value;
  }

  public async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }

  public async incr(): Promise<number> {
    return 1;
  }

  public async expire(): Promise<number> {
    return 1;
  }

  public async ttl(): Promise<number> {
    return 60;
  }

  public async sAdd(): Promise<number> {
    return 0;
  }

  public async sRem(): Promise<number> {
    return 0;
  }

  public async *sScanIterator(): AsyncIterable<string[]> {
    return;
  }

  public async eval(
    script: string,
    options: { keys: string[]; arguments: string[] }
  ): Promise<number> {
    const key = options.keys[0];
    if (!key || !script.includes("redis.call")) return 0;
    if (this.replaceAfterRead?.key === key) {
      this.values.set(key, this.replaceAfterRead.value);
      this.replaceAfterRead = null;
    }
    const expectedOwner = options.arguments[0];
    if (this.values.get(key) !== expectedOwner) return 0;
    this.values.delete(key);
    return 1;
  }
}
