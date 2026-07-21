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
  incr: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<number | boolean>;
  ttl: (key: string) => Promise<number>;
  sAdd: (key: string, member: string | string[]) => Promise<number>;
  sRem: (key: string, member: string | string[]) => Promise<number>;
  scanIterator?: (options: { MATCH?: string; COUNT?: number }) => AsyncIterable<string | string[]>;
  sScanIterator: (
    key: string,
    options?: { COUNT?: number }
  ) => AsyncIterable<string[]>;
};

export type RedisCoordinator = {
  buildKey: (scope: string, id: string) => string;
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
  recordSourceFileEvent: (
    input: { knowledgeBaseId: string; sourceFileId: string },
    value: unknown,
    ttlSeconds: number
  ) => Promise<void>;
  recordSourceFileGraphState: (
    input: { knowledgeBaseId: string; sourceFileId: string },
    value: unknown,
    ttlSeconds: number
  ) => Promise<void>;
  acquireKnowledgeBasePublicationLock: (
    knowledgeBaseId: string,
    ownerId: string,
    ttlSeconds: number
  ) => Promise<boolean>;
  releaseKnowledgeBasePublicationLock: (
    knowledgeBaseId: string,
    ownerId: string
  ) => Promise<boolean>;
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
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: string;
};

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
      const key = buildKey("locks", scope, id);
      const currentOwner = await client.get(key);

      if (currentOwner !== ownerId) {
        return false;
      }

      await client.del(key);
      return true;
    },
    async acquireSourceFileLock(sourceFileId, ownerId, ttlSeconds) {
      const result = await client.set(buildKey("source-file-locks", sourceFileId), ownerId, {
        EX: ttlSeconds,
        NX: true
      });
      return result === "OK";
    },
    async releaseSourceFileLock(sourceFileId, ownerId) {
      const key = buildKey("source-file-locks", sourceFileId);
      const currentOwner = await client.get(key);

      if (currentOwner !== ownerId) {
        return false;
      }

      await client.del(key);
      return true;
    },
    async acquireSourceFileGraphLock(sourceFileId, ownerId, ttlSeconds) {
      const result = await client.set(buildKey("source-file-graph-locks", sourceFileId), ownerId, {
        EX: ttlSeconds,
        NX: true
      });
      return result === "OK";
    },
    async releaseSourceFileGraphLock(sourceFileId, ownerId) {
      const key = buildKey("source-file-graph-locks", sourceFileId);
      const currentOwner = await client.get(key);

      if (currentOwner !== ownerId) {
        return false;
      }

      await client.del(key);
      return true;
    },
    async recordSourceFileEvent(input, value, ttlSeconds) {
      await client.set(buildKey("source-file-events", input.sourceFileId), JSON.stringify(value), {
        EX: ttlSeconds
      });
      await trackSourceRuntimeKey(client, buildKey, input, ttlSeconds);
    },
    async recordSourceFileGraphState(input, value, ttlSeconds) {
      await client.set(buildKey("source-file-graph-state", input.sourceFileId), JSON.stringify(value), {
        EX: ttlSeconds
      });
      await trackSourceRuntimeKey(client, buildKey, input, ttlSeconds);
    },
    async acquireKnowledgeBasePublicationLock(knowledgeBaseId, ownerId, ttlSeconds) {
      const result = await client.set(
        buildKey("knowledge-base-publication-locks", knowledgeBaseId),
        ownerId,
        {
          EX: ttlSeconds,
          NX: true
        }
      );
      return result === "OK";
    },
    async releaseKnowledgeBasePublicationLock(knowledgeBaseId, ownerId) {
      const key = buildKey("knowledge-base-publication-locks", knowledgeBaseId);
      const currentOwner = await client.get(key);

      if (currentOwner !== ownerId) {
        return false;
      }

      await client.del(key);
      return true;
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
      await client.set(buildKey("runtime-settings", "version"), version);
    },
    async getRuntimeSettingsVersion() {
      return client.get(buildKey("runtime-settings", "version"));
    },
    async hitRateLimit(scope, id, limit) {
      const key = buildKey("rate-limits", scope, id);
      const nextCount = await incrementRateLimitCounter(client, key);

      if (nextCount === 1) {
        await client.expire(key, limit.windowSeconds);
      }

      const ttlSeconds = await client.ttl(key);
      const resetTtlSeconds = ttlSeconds > 0 ? ttlSeconds : limit.windowSeconds;
      const allowed = nextCount <= limit.max;

      return {
        allowed,
        remaining: Math.max(0, limit.max - nextCount),
        resetAt: new Date(Date.now() + resetTtlSeconds * 1_000).toISOString()
      };
    }
  };
}

async function incrementRateLimitCounter(
  client: RedisCommandClient,
  key: string
): Promise<number> {
  try {
    return await client.incr(key);
  } catch (error) {
    if (!String(error instanceof Error ? error.message : error).includes("integer")) {
      throw error;
    }
  }

  await client.del(key);
  return client.incr(key);
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
    buildKey("source-file-events", sourceFileId),
    buildKey("source-file-graph-state", sourceFileId),
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

  const runtimeIndexKey = buildKey("source-file-runtime-index", knowledgeBaseId);
  return (await deleteExactKeys(client, exactKeys))
    + (await deleteMatchingKeys(client, patterns))
    + await client.sRem(runtimeIndexKey, sourceFileId);
}

async function clearKnowledgeBaseRuntimeKeys(
  client: RedisCommandClient,
  buildKey: (...parts: string[]) => string,
  knowledgeBaseId: string
): Promise<number> {
  const normalizedKnowledgeBaseId = normalizeKeyPart(knowledgeBaseId);
  const exactKeys = [buildKey("knowledge-base-publication-locks", normalizedKnowledgeBaseId)];
  const patterns = [
    `${buildKey("pagination-cursors", "knowledge-bases")}:*`,
    `${buildKey("page-cache", "knowledge-bases")}:*`,
    `${buildKey("pagination-invalid")}:*${normalizedKnowledgeBaseId}*`,
    `${buildKey("pagination-cursors")}:*${normalizedKnowledgeBaseId}*`,
    `${buildKey("page-cache")}:*${normalizedKnowledgeBaseId}*`
  ];

  let deleted = (await deleteExactKeys(client, exactKeys))
    + (await deleteMatchingKeys(client, patterns));
  const runtimeIndexKey = buildKey("source-file-runtime-index", normalizedKnowledgeBaseId);
  for await (const batch of client.sScanIterator(runtimeIndexKey, { COUNT: 100 })) {
    for (const sourceFileId of uniqueStrings(batch)) {
      deleted += await deleteExactKeys(client, [
        buildKey("source-file-events", sourceFileId),
        buildKey("source-file-graph-state", sourceFileId),
        buildKey("source-file-locks", sourceFileId),
        buildKey("source-file-graph-locks", sourceFileId)
      ]);
    }
  }
  deleted += await client.del(runtimeIndexKey);
  return deleted;
}

async function trackSourceRuntimeKey(
  client: RedisCommandClient,
  buildKey: (...parts: string[]) => string,
  input: { knowledgeBaseId: string; sourceFileId: string },
  ttlSeconds: number
): Promise<void> {
  const indexKey = buildKey("source-file-runtime-index", input.knowledgeBaseId);
  await client.sAdd(indexKey, normalizeKeyPart(input.sourceFileId));
  const currentTtl = await client.ttl(indexKey);
  if (currentTtl < ttlSeconds) {
    await client.expire(indexKey, ttlSeconds);
  }
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
