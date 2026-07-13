import { randomUUID } from "node:crypto";
import type { RedisCoordinator } from "../redis/coordination.js";

export type ReleaseSnapshotCursor = {
  releaseId: string;
  repositoryCursor: string;
};

export async function resolveReleaseSnapshotPage(input: {
  redis: RedisCoordinator;
  scope: string;
  cursorToken: string | null;
  activeReleaseId: string | null;
}): Promise<{ releaseId: string; repositoryCursor: string | null } | null> {
  if (!input.cursorToken) {
    return input.activeReleaseId
      ? { releaseId: input.activeReleaseId, repositoryCursor: null }
      : null;
  }

  const cursor = await input.redis.getPaginationCursor<unknown>(
    input.scope,
    input.cursorToken
  );

  return isReleaseSnapshotCursor(cursor) ? cursor : null;
}

export async function writeReleaseSnapshotCursor(input: {
  redis: RedisCoordinator;
  scope: string;
  releaseId: string;
  repositoryCursor: string | null;
  ttlSeconds: number;
}): Promise<string | null> {
  if (!input.repositoryCursor) {
    return null;
  }

  const cursorId = `cursor-${randomUUID()}`;
  await input.redis.setPaginationCursor(
    input.scope,
    cursorId,
    {
      releaseId: input.releaseId,
      repositoryCursor: input.repositoryCursor
    } satisfies ReleaseSnapshotCursor,
    input.ttlSeconds
  );
  return cursorId;
}

function isReleaseSnapshotCursor(value: unknown): value is ReleaseSnapshotCursor {
  if (!value || typeof value !== "object") {
    return false;
  }

  const cursor = value as Partial<ReleaseSnapshotCursor>;
  return Boolean(
    typeof cursor.releaseId === "string" &&
      cursor.releaseId.trim() &&
      typeof cursor.repositoryCursor === "string" &&
      cursor.repositoryCursor.trim()
  );
}
