import { randomUUID } from "node:crypto";
import type { RedisCoordinator } from "../redis/coordination.js";

export type GenerationCursorEnvelope<T> = {
  generationId: string;
  value: T;
};

export async function readGenerationCursor<T>(input: {
  redis: RedisCoordinator;
  scope: string;
  token: string | null;
}): Promise<GenerationCursorEnvelope<T> | null | undefined> {
  if (!input.token) return null;
  return (await input.redis.getPaginationCursor<GenerationCursorEnvelope<T>>(
    input.scope,
    input.token
  )) ?? undefined;
}

export async function writeGenerationCursor<T>(input: {
  redis: RedisCoordinator;
  scope: string;
  generationId: string;
  value: T | null;
  ttlSeconds: number;
}): Promise<string | null> {
  if (!input.value) return null;
  const token = `cursor-${randomUUID()}`;
  await input.redis.setPaginationCursor(
    input.scope,
    token,
    { generationId: input.generationId, value: input.value },
    input.ttlSeconds
  );
  return token;
}
