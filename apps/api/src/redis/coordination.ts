import { createClient } from "redis";
import type { RuntimeConfig } from "../config.js";

type RedisRuntimeConfig = Pick<RuntimeConfig, "redis">;

export type RedisConnectionOptions = {
  url: string;
  socket?: {
    reconnectStrategy: false;
  };
};

export type RedisClientRuntimeOptions = {
  disableReconnect?: boolean;
};

export type RedisCommandClient = {
  set: (key: string, value: string, options?: Record<string, unknown>) => Promise<string | null>;
  get: (key: string) => Promise<string | null>;
  del: (key: string) => Promise<number>;
  eval: (
    script: string,
    options: { keys: string[]; arguments: string[] }
  ) => Promise<unknown>;
  publish?: (channel: string, message: string) => Promise<number>;
  scanIterator?: (options: { MATCH?: string; COUNT?: number }) => AsyncIterable<string | string[]>;
};

export type RedisCoordinator = {
  buildKey: (...parts: string[]) => string;
  setSession: (sessionId: string, value: unknown, ttlSeconds: number) => Promise<void>;
  getSession: <T = unknown>(sessionId: string) => Promise<T | null>;
  clearSession: (sessionId: string) => Promise<void>;
  acquireLock: (scope: string, id: string, ownerId: string, ttlSeconds: number) => Promise<boolean>;
  releaseLock: (scope: string, id: string, ownerId: string) => Promise<boolean>;
  acquireSourceFileLock: (
    sourceFileId: string,
    ownerId: string,
    ttlSeconds: number
  ) => Promise<boolean>;
  releaseSourceFileLock: (sourceFileId: string, ownerId: string) => Promise<boolean>;
  acquireSourceFileGraphLock: (
    sourceFileId: string,
    ownerId: string,
    ttlSeconds: number
  ) => Promise<boolean>;
  releaseSourceFileGraphLock: (sourceFileId: string, ownerId: string) => Promise<boolean>;
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
  getPaginationInvalid: (scope: string) => Promise<string | null>;
  clearSourceFileRuntimeKeys: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<number>;
  clearKnowledgeBaseRuntimeKeys: (input: {
    knowledgeBaseId: string;
    sourceFileIds?: string[];
  }) => Promise<number>;
  setPublicOpenApiKeyCache: (
    keyHash: string,
    value: { id: string },
    ttlSeconds: number
  ) => Promise<void>;
  getPublicOpenApiKeyCache: (keyHash: string) => Promise<{ id: string } | null>;
  clearPublicOpenApiKeyRuntimeKeys: (keyId: string, keyHash: string) => Promise<void>;
  markPublicOpenApiKeyUsed: (keyId: string, ttlSeconds: number) => Promise<boolean>;
  setRuntimeSettingsVersion: (version: string) => Promise<void>;
  getRuntimeSettingsVersion: () => Promise<string | null>;
  hitRateLimit: (
    scope: string,
    id: string,
    limit: { max: number; windowSeconds: number }
  ) => Promise<RateLimitResult>;
  notifyWorkerWork: (
    kind: "document" | "deletion" | "maintenance" | "cleanup"
  ) => Promise<boolean>;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: string;
};

const RUNTIME_SETTINGS_VERSION_TTL_SECONDS = 300;
const RELEASE_OWNED_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;
const INCREMENT_RATE_LIMIT_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current and (not string.match(current, "^%d+$") or tonumber(current) < 0) then
  redis.call("DEL", KEYS[1])
end
local next_count = redis.call("INCR", KEYS[1])
local current_ttl = redis.call("TTL", KEYS[1])
if next_count == 1 or current_ttl < 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
  current_ttl = tonumber(ARGV[1])
end
return {next_count, current_ttl}
`;

export function createRedisConnectionOptions(
  config: RedisRuntimeConfig,
  options: RedisClientRuntimeOptions = {}
): RedisConnectionOptions {
  return {
    url: config.redis.url,
    ...(options.disableReconnect
      ? {
          socket: {
            reconnectStrategy: false as const
          }
        }
      : {})
  };
}

export function createRedisClient(
  config: RedisRuntimeConfig,
  options: RedisClientRuntimeOptions = {}
) {
  return createClient(createRedisConnectionOptions(config, options));
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
    async acquireLock(scope, id, ownerId, ttlSeconds) {
      const result = await client.set(buildKey("locks", scope, id), ownerId, {
        EX: ttlSeconds,
        NX: true
      });
      return result === "OK";
    },
    async releaseLock(scope, id, ownerId) {
      return releaseOwnedLock(client, buildKey("locks", scope, id), ownerId);
    },
    async acquireSourceFileLock(sourceFileId, ownerId, ttlSeconds) {
      const result = await client.set(buildKey("source-file-locks", sourceFileId), ownerId, {
        EX: ttlSeconds,
        NX: true
      });
      return result === "OK";
    },
    async releaseSourceFileLock(sourceFileId, ownerId) {
      return releaseOwnedLock(client, buildKey("source-file-locks", sourceFileId), ownerId);
    },
    async acquireSourceFileGraphLock(sourceFileId, ownerId, ttlSeconds) {
      const result = await client.set(buildKey("source-file-graph-locks", sourceFileId), ownerId, {
        EX: ttlSeconds,
        NX: true
      });
      return result === "OK";
    },
    async releaseSourceFileGraphLock(sourceFileId, ownerId) {
      return releaseOwnedLock(client, buildKey("source-file-graph-locks", sourceFileId), ownerId);
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
    },
    async getPaginationInvalid(scope) {
      return client.get(buildKey("pagination-invalid", scope));
    },
    async clearSourceFileRuntimeKeys(input) {
      return clearSourceFileRuntimeKeys(client, buildKey, input);
    },
    async clearKnowledgeBaseRuntimeKeys(input) {
      let deleted = await clearKnowledgeBaseRuntimeKeys(client, buildKey, input.knowledgeBaseId);

      for (const sourceFileId of uniqueStrings(input.sourceFileIds ?? [])) {
        deleted += await clearSourceFileRuntimeKeys(client, buildKey, {
          knowledgeBaseId: input.knowledgeBaseId,
          sourceFileId
        });
      }

      return deleted;
    },
    async setPublicOpenApiKeyCache(keyHash, value, ttlSeconds) {
      await client.set(buildKey("public-openapi-key-cache", keyHash), JSON.stringify(value), {
        EX: ttlSeconds
      });
    },
    async getPublicOpenApiKeyCache(keyHash) {
      const raw = await client.get(buildKey("public-openapi-key-cache", keyHash));
      return raw ? (JSON.parse(raw) as { id: string }) : null;
    },
    async clearPublicOpenApiKeyRuntimeKeys(keyId, keyHash) {
      await client.del(buildKey("public-openapi-key-cache", keyHash));
      await client.del(buildKey("public-openapi-key-used", keyId));
    },
    async markPublicOpenApiKeyUsed(keyId, ttlSeconds) {
      const result = await client.set(buildKey("public-openapi-key-used", keyId), "1", {
        EX: ttlSeconds,
        NX: true
      });
      return result === "OK";
    },
    async setRuntimeSettingsVersion(version) {
      await client.set(buildKey("runtime-settings", "version"), version, {
        EX: RUNTIME_SETTINGS_VERSION_TTL_SECONDS
      });
    },
    async getRuntimeSettingsVersion() {
      return client.get(buildKey("runtime-settings", "version"));
    },
    async notifyWorkerWork(kind) {
      if (!client.publish) return false;
      return (await client.publish(buildKey("worker", "wakeup"), kind)) > 0;
    },
    async hitRateLimit(scope, id, limit) {
      const key = buildKey("rate-limits", scope, id);
      const { count: nextCount, ttlSeconds } = await incrementRateLimitCounter(
        client,
        key,
        limit.windowSeconds
      );
      const allowed = nextCount <= limit.max;

      return {
        allowed,
        remaining: Math.max(0, limit.max - nextCount),
        resetAt: new Date(Date.now() + ttlSeconds * 1_000).toISOString()
      };
    }
  };
}

async function incrementRateLimitCounter(
  client: RedisCommandClient,
  key: string,
  windowSeconds: number
): Promise<{ count: number; ttlSeconds: number }> {
  const result = await client.eval(INCREMENT_RATE_LIMIT_SCRIPT, {
    keys: [key],
    arguments: [String(windowSeconds)]
  });

  if (!Array.isArray(result) || result.length !== 2) {
    throw new Error("Redis rate-limit script returned an invalid result");
  }

  const count = Number(result[0]);
  const ttlSeconds = Number(result[1]);
  if (
    !Number.isSafeInteger(count)
    || count < 1
    || !Number.isSafeInteger(ttlSeconds)
    || ttlSeconds < 1
  ) {
    throw new Error("Redis rate-limit script returned an invalid counter state");
  }

  return { count, ttlSeconds };
}

async function releaseOwnedLock(
  client: RedisCommandClient,
  key: string,
  ownerId: string
): Promise<boolean> {
  const result = await client.eval(RELEASE_OWNED_LOCK_SCRIPT, {
    keys: [key],
    arguments: [ownerId]
  });
  return Number(result) === 1;
}

function normalizeKeyPart(value: string): string {
  return value
    .trim()
    .replace(/^:+|:+$/g, "")
    .replace(/[^a-zA-Z0-9:._-]/g, "_");
}

async function clearSourceFileRuntimeKeys(
  client: RedisCommandClient,
  buildKey: (...parts: string[]) => string,
  input: { knowledgeBaseId: string; sourceFileId: string }
): Promise<number> {
  const sourceFileId = normalizeKeyPart(input.sourceFileId);
  const knowledgeBaseId = normalizeKeyPart(input.knowledgeBaseId);
  const exactKeys = [
    buildKey("source-file-locks", sourceFileId),
    buildKey("source-file-graph-locks", sourceFileId)
  ];
  const patterns = [
    `${buildKey("pagination-invalid")}:*${sourceFileId}*`,
    `${buildKey("pagination-cursors")}:*${sourceFileId}*`,
    `${buildKey("page-cache")}:*${sourceFileId}*`,
    `${buildKey("pagination-invalid")}:*${knowledgeBaseId}*${sourceFileId}*`,
    `${buildKey("pagination-cursors")}:*${knowledgeBaseId}*${sourceFileId}*`,
    `${buildKey("page-cache")}:*${knowledgeBaseId}*${sourceFileId}*`
  ];
  return (await deleteExactKeys(client, exactKeys))
    + await deleteMatchingKeys(client, patterns);
}

async function clearKnowledgeBaseRuntimeKeys(
  client: RedisCommandClient,
  buildKey: (...parts: string[]) => string,
  knowledgeBaseId: string
): Promise<number> {
  const normalizedKnowledgeBaseId = normalizeKeyPart(knowledgeBaseId);
  const patterns = [
    `${buildKey("pagination-cursors", "knowledge-bases")}:*`,
    `${buildKey("page-cache", "knowledge-bases")}:*`,
    `${buildKey("pagination-invalid")}:*${normalizedKnowledgeBaseId}*`,
    `${buildKey("pagination-cursors")}:*${normalizedKnowledgeBaseId}*`,
    `${buildKey("page-cache")}:*${normalizedKnowledgeBaseId}*`
  ];

  return deleteMatchingKeys(client, patterns);
}

async function deleteExactKeys(client: RedisCommandClient, keys: string[]): Promise<number> {
  let deleted = 0;

  for (const key of uniqueStrings(keys)) {
    deleted += await client.del(key);
  }

  return deleted;
}

async function deleteMatchingKeys(
  client: RedisCommandClient,
  patterns: string[]
): Promise<number> {
  if (!client.scanIterator) {
    return 0;
  }

  let deleted = 0;

  for (const pattern of uniqueStrings(patterns)) {
    for await (const entry of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      const keys = Array.isArray(entry) ? entry : [entry];
      deleted += await deleteExactKeys(client, keys);
    }
  }

  return deleted;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
