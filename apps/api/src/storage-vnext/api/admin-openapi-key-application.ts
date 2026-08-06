import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../../config.js";
import {
  createPublicOpenApiKeyService,
  type PublicOpenApiKeyRepository
} from "../../public-openapi/keys.js";
import type { RedisCoordinator } from "../../redis/coordination.js";

type AdminOpenApiKeyApplicationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "DATABASE_REPOSITORY_UNAVAILABLE" | "INVALID_PAGINATION" | "NOT_FOUND" };

export function createStorageVnextAdminOpenApiKeyApplication(input: {
  config: RuntimeConfig;
  repository: PublicOpenApiKeyRepository | null;
  redis: RedisCoordinator | null;
}) {
  const requireService = () => {
    if (!input.repository || !input.redis) return null;
    return createPublicOpenApiKeyService({
      repository: input.repository,
      redis: input.redis
    });
  };

  return {
    async listKeys(request: { limit: number; cursor: string | null }) {
      const service = requireService();
      if (!service || !input.redis) return unavailable();
      const scope = "public-openapi-keys";
      const repositoryCursor = request.cursor
        ? await input.redis.getPaginationCursor<string>(scope, request.cursor)
        : null;
      if (request.cursor && !repositoryCursor) return invalidPagination();
      const page = await service.listKeysWithBootstrap({
        limit: request.limit,
        cursor: repositoryCursor
      });
      return success({
        items: page.items,
        nextCursor: await writeCursor({
          redis: input.redis,
          scope,
          cursor: page.nextCursor,
          ttlSeconds: input.config.pagination.cursorTtlSeconds
        }),
        oneTimeKey: page.oneTimeKey
      });
    },

    async createKey(request: { name?: string }) {
      const service = requireService();
      if (!service) return unavailable();
      return success(await service.createKey(request));
    },

    async deleteKey(request: { keyId: string }) {
      const service = requireService();
      if (!service) return unavailable();
      return await service.deleteKey(request.keyId) ? success(true) : notFound();
    }
  };
}

export type StorageVnextAdminOpenApiKeyApplication = ReturnType<
  typeof createStorageVnextAdminOpenApiKeyApplication
>;

function success<T>(value: T): AdminOpenApiKeyApplicationResult<T> {
  return { ok: true, value };
}

function unavailable(): AdminOpenApiKeyApplicationResult<never> {
  return { ok: false, code: "DATABASE_REPOSITORY_UNAVAILABLE" };
}

function invalidPagination(): AdminOpenApiKeyApplicationResult<never> {
  return { ok: false, code: "INVALID_PAGINATION" };
}

function notFound(): AdminOpenApiKeyApplicationResult<never> {
  return { ok: false, code: "NOT_FOUND" };
}

async function writeCursor(input: {
  redis: RedisCoordinator;
  scope: string;
  cursor: string | null;
  ttlSeconds: number;
}): Promise<string | null> {
  if (!input.cursor) return null;
  const cursorId = `cursor-${randomUUID()}`;
  await input.redis.setPaginationCursor(
    input.scope,
    cursorId,
    input.cursor,
    input.ttlSeconds
  );
  return cursorId;
}
