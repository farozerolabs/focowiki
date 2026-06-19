import type { SourceFileProcessingStage } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";

export async function waitForPublicationLock(input: {
  redis: RedisCoordinator;
  knowledgeBaseId: string;
  ownerId: string;
  ttlSeconds: number;
  maxWaitMs?: number;
  retryIntervalMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + Math.min(input.ttlSeconds * 1_000, input.maxWaitMs ?? 300_000);
  const retryIntervalMs = input.retryIntervalMs ?? 1_000;

  while (Date.now() <= deadline) {
    const acquired = await input.redis.acquireKnowledgeBasePublicationLock(
      input.knowledgeBaseId,
      input.ownerId,
      input.ttlSeconds
    );

    if (acquired) {
      return true;
    }

    await sleep(retryIntervalMs);
  }

  return false;
}

export function sourceFileStageMessageKey(stage: SourceFileProcessingStage): string {
  return `sourceFiles.stage.${stage.replace(/_([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase()
  )}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
