import { createClient } from "redis";
import type { RuntimeConfig } from "../config.js";

type RedisRuntimeConfig = Pick<RuntimeConfig, "redis">;

export type RedisConnectionOptions = {
  url: string;
};

export type RedisCommandClient = {
  set: (key: string, value: string, options?: Record<string, unknown>) => Promise<string | null>;
  get: (key: string) => Promise<string | null>;
  del: (key: string) => Promise<number>;
};

export type RedisCoordinator = {
  buildKey: (scope: string, id: string) => string;
  setSession: (sessionId: string, value: unknown, ttlSeconds: number) => Promise<void>;
  getSession: <T = unknown>(sessionId: string) => Promise<T | null>;
  clearSession: (sessionId: string) => Promise<void>;
  acquireTaskLock: (taskId: string, ownerId: string, ttlSeconds: number) => Promise<boolean>;
  releaseTaskLock: (taskId: string, ownerId: string) => Promise<boolean>;
  recordTaskEvent: (taskId: string, value: unknown, ttlSeconds: number) => Promise<void>;
  setPaginationCursor: (
    scope: string,
    cursorId: string,
    value: unknown,
    ttlSeconds: number
  ) => Promise<void>;
  getPaginationCursor: <T = unknown>(scope: string, cursorId: string) => Promise<T | null>;
  setPageCache: (
    scope: string,
    pageId: string,
    value: unknown,
    ttlSeconds: number
  ) => Promise<void>;
  getPageCache: <T = unknown>(scope: string, pageId: string) => Promise<T | null>;
  markPaginationInvalid: (scope: string, reason: string, ttlSeconds: number) => Promise<void>;
};

export function createRedisConnectionOptions(
  config: RedisRuntimeConfig
): RedisConnectionOptions {
  return {
    url: config.redis.url
  };
}

export function createRedisClient(config: RedisRuntimeConfig) {
  return createClient(createRedisConnectionOptions(config));
}

export function createRedisKeyBuilder(keyPrefix = "focowiki") {
  const normalizedPrefix = normalizeKeyPart(keyPrefix);

  return (...parts: string[]) =>
    [normalizedPrefix, ...parts.map(normalizeKeyPart)].filter(Boolean).join(":");
}

export function createRedisCoordinator(
  client: RedisCommandClient,
  options: { keyPrefix?: string } = {}
): RedisCoordinator {
  const buildKey = createRedisKeyBuilder(options.keyPrefix ?? "focowiki");

  return {
    buildKey,
    async setSession(sessionId, value, ttlSeconds) {
      await client.set(buildKey("sessions", sessionId), JSON.stringify(value), {
        EX: ttlSeconds
      });
    },
    async getSession(sessionId) {
      const raw = await client.get(buildKey("sessions", sessionId));
      return raw ? (JSON.parse(raw) as never) : null;
    },
    async clearSession(sessionId) {
      await client.del(buildKey("sessions", sessionId));
    },
    async acquireTaskLock(taskId, ownerId, ttlSeconds) {
      const result = await client.set(buildKey("task-locks", taskId), ownerId, {
        EX: ttlSeconds,
        NX: true
      });
      return result === "OK";
    },
    async releaseTaskLock(taskId, ownerId) {
      const key = buildKey("task-locks", taskId);
      const currentOwner = await client.get(key);

      if (currentOwner !== ownerId) {
        return false;
      }

      await client.del(key);
      return true;
    },
    async recordTaskEvent(taskId, value, ttlSeconds) {
      await client.set(buildKey("task-events", taskId), JSON.stringify(value), {
        EX: ttlSeconds
      });
    },
    async setPaginationCursor(scope, cursorId, value, ttlSeconds) {
      await client.set(buildKey("pagination-cursors", scope, cursorId), JSON.stringify(value), {
        EX: ttlSeconds
      });
    },
    async getPaginationCursor(scope, cursorId) {
      const raw = await client.get(buildKey("pagination-cursors", scope, cursorId));
      return raw ? (JSON.parse(raw) as never) : null;
    },
    async setPageCache(scope, pageId, value, ttlSeconds) {
      await client.set(buildKey("page-cache", scope, pageId), JSON.stringify(value), {
        EX: ttlSeconds
      });
    },
    async getPageCache(scope, pageId) {
      const raw = await client.get(buildKey("page-cache", scope, pageId));
      return raw ? (JSON.parse(raw) as never) : null;
    },
    async markPaginationInvalid(scope, reason, ttlSeconds) {
      await client.set(buildKey("pagination-invalid", scope), reason, {
        EX: ttlSeconds
      });
    }
  };
}

function normalizeKeyPart(value: string): string {
  return value
    .trim()
    .replace(/^:+|:+$/g, "")
    .replace(/[^a-zA-Z0-9:._-]/g, "_");
}
