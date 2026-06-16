import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CursorPage } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";

const RAW_KEY_PREFIX = "fwok_";
const KEY_RANDOM_BYTES = 32;
const KEY_PREFIX_LENGTH = 10;
const KEY_SUFFIX_LENGTH = 6;
const KEY_CACHE_TTL_SECONDS = 300;
const LAST_USED_WRITE_TTL_SECONDS = 300;
const MAX_KEY_LENGTH = 512;

export type PublicOpenApiKeyStatus = "active" | "revoked";

export type PublicOpenApiKeyRecord = {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  keySuffix: string;
  status: PublicOpenApiKeyStatus;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type PublicOpenApiKeyRepository = {
  countActivePublicOpenApiKeys: () => Promise<number>;
  listPublicOpenApiKeys: (request: {
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<PublicOpenApiKeyRecord>>;
  createPublicOpenApiKey: (input: {
    id: string;
    name: string;
    keyHash: string;
    keyPrefix: string;
    keySuffix: string;
    createdAt: string;
  }) => Promise<PublicOpenApiKeyRecord>;
  findActivePublicOpenApiKeyByHash: (keyHash: string) => Promise<PublicOpenApiKeyRecord | null>;
  revokePublicOpenApiKey: (input: {
    id: string;
    revokedAt: string;
  }) => Promise<PublicOpenApiKeyRecord | null>;
  updatePublicOpenApiKeyLastUsed: (input: {
    id: string;
    lastUsedAt: string;
  }) => Promise<void>;
};

export type PublicOpenApiKeyView = {
  id: string;
  name: string;
  fingerprint: string;
  status: PublicOpenApiKeyStatus;
  createdAt: string;
  lastUsedAt: string | null;
};

export type PublicOpenApiKeyService = ReturnType<typeof createPublicOpenApiKeyService>;

export function createPublicOpenApiKeyService(options: {
  repository: PublicOpenApiKeyRepository;
  redis: RedisCoordinator | null;
}) {
  const { repository, redis } = options;

  async function createKey(input: { name?: string | null }) {
    const rawKey = createRawPublicOpenApiKey();
    const record = await repository.createPublicOpenApiKey({
      id: createPublicOpenApiKeyId(),
      name: normalizeKeyName(input.name, "OpenAPI key"),
      keyHash: hashPublicOpenApiKey(rawKey),
      keyPrefix: rawKey.slice(0, KEY_PREFIX_LENGTH),
      keySuffix: rawKey.slice(-KEY_SUFFIX_LENGTH),
      createdAt: new Date().toISOString()
    });

    return {
      key: toPublicOpenApiKeyView(record),
      rawKey
    };
  }

  return {
    async listKeysWithBootstrap(input: { limit: number; cursor: string | null }) {
      let oneTimeKey: { id: string; rawKey: string } | null = null;

      if ((await repository.countActivePublicOpenApiKeys()) === 0) {
        const created = await createDefaultKey();
        oneTimeKey = {
          id: created.key.id,
          rawKey: created.rawKey
        };
      }

      const page = await repository.listPublicOpenApiKeys(input);

      return {
        items: page.items.map(toPublicOpenApiKeyView),
        nextCursor: page.nextCursor,
        oneTimeKey
      };
    },
    createKey,
    async deleteKey(id: string) {
      const revoked = await repository.revokePublicOpenApiKey({
        id,
        revokedAt: new Date().toISOString()
      });

      if (!revoked) {
        return false;
      }

      await redis?.clearPublicOpenApiKeyCache(revoked.keyHash);
      return true;
    },
    async authorize(rawKey: string) {
      if (!isPlausibleRawKey(rawKey)) {
        return { authorized: false as const };
      }

      const keyHash = hashPublicOpenApiKey(rawKey);
      const cached = await redis?.getPublicOpenApiKeyCache(keyHash);

      if (cached) {
        await touchLastUsed(cached.id);
        return { authorized: true as const };
      }

      const record = await repository.findActivePublicOpenApiKeyByHash(keyHash);

      if (!record) {
        return { authorized: false as const };
      }

      await redis?.setPublicOpenApiKeyCache(keyHash, { id: record.id }, KEY_CACHE_TTL_SECONDS);
      await touchLastUsed(record.id);

      return { authorized: true as const };
    }
  };

  async function createDefaultKey() {
    const rawKey = createRawPublicOpenApiKey();
    const record = await repository.createPublicOpenApiKey({
      id: createPublicOpenApiKeyId(),
      name: "Default key",
      keyHash: hashPublicOpenApiKey(rawKey),
      keyPrefix: rawKey.slice(0, KEY_PREFIX_LENGTH),
      keySuffix: rawKey.slice(-KEY_SUFFIX_LENGTH),
      createdAt: new Date().toISOString()
    });

    return {
      key: toPublicOpenApiKeyView(record),
      rawKey
    };
  }

  async function touchLastUsed(id: string) {
    if (redis && !(await redis.markPublicOpenApiKeyUsed(id, LAST_USED_WRITE_TTL_SECONDS))) {
      return;
    }

    await repository.updatePublicOpenApiKeyLastUsed({
      id,
      lastUsedAt: new Date().toISOString()
    });
  }
}

export function hashPublicOpenApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex");
}

export function toPublicOpenApiKeyView(record: PublicOpenApiKeyRecord): PublicOpenApiKeyView {
  return {
    id: record.id,
    name: record.name,
    fingerprint: `${record.keyPrefix}...${record.keySuffix}`,
    status: record.status,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt
  };
}

export function createPublicOpenApiKeyId(): string {
  return `openapi-key-${randomUUID()}`;
}

function createRawPublicOpenApiKey(): string {
  return `${RAW_KEY_PREFIX}${randomBytes(KEY_RANDOM_BYTES).toString("base64url")}`;
}

function normalizeKeyName(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 80) : fallback;
}

function isPlausibleRawKey(value: string): boolean {
  return value.startsWith(RAW_KEY_PREFIX) && value.length <= MAX_KEY_LENGTH;
}
