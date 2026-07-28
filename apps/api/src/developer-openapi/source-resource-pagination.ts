import { randomUUID } from "node:crypto";
import type { RedisCoordinator } from "../redis/coordination.js";
import { validationError } from "./errors.js";

export async function readSourceResourceCursor<T>(
  redis: RedisCoordinator | null,
  scope: string,
  cursor: string | null
): Promise<T | null> {
  if (!cursor) return null;
  if (!redis) {
    throw validationError(
      "Pagination cursor is unavailable while the cache service is offline.",
      { field: "cursor" }
    );
  }
  const value = await redis.getPaginationCursor<T>(scope, cursor);
  if (!value) {
    throw validationError("Pagination cursor is invalid or expired.", {
      field: "cursor"
    });
  }
  return value;
}

export async function writeSourceResourceCursor<T>(
  redis: RedisCoordinator | null,
  scope: string,
  cursor: T | null,
  ttlSeconds: number
): Promise<string | null> {
  if (!cursor || !redis) return null;
  const cursorId = `cursor-${randomUUID()}`;
  await redis.setPaginationCursor(scope, cursorId, cursor, ttlSeconds);
  return cursorId;
}

export function sourceResourceCursorScope(
  family: "directories" | "files" | "operations",
  knowledgeBaseId: string,
  query: unknown
): string {
  const suffix = Buffer.from(
    JSON.stringify(query ?? null),
    "utf8"
  ).toString("base64url");
  return `developer-openapi:source-resources:${family}:${knowledgeBaseId}:${suffix}`;
}
