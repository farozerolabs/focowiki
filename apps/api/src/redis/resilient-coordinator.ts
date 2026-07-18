import type { RedisCoordinator } from "./coordination.js";

export type RedisAvailabilityClient = {
  isReady: boolean;
};

export function createResilientRedisCoordinator(input: {
  client: RedisAvailabilityClient;
  coordinator: RedisCoordinator;
  sessionWrites: "required" | "best_effort";
}): RedisCoordinator {
  const { client, coordinator } = input;
  const run = async <T>(operation: () => Promise<T>, fallback: T): Promise<T> => {
    if (!client.isReady) {
      return fallback;
    }

    try {
      return await operation();
    } catch {
      return fallback;
    }
  };
  const runVoid = async (operation: () => Promise<void>): Promise<void> => {
    await run(operation, undefined);
  };
  const setSession: RedisCoordinator["setSession"] = (...arguments_) => {
    if (input.sessionWrites === "best_effort") {
      return runVoid(() => coordinator.setSession(...arguments_));
    }
    if (!client.isReady) {
      throw new Error("Redis session storage is unavailable");
    }
    return coordinator.setSession(...arguments_);
  };

  return {
    buildKey: coordinator.buildKey,
    setSession,
    getSession: (...arguments_) => run(() => coordinator.getSession(...arguments_), null),
    clearSession: (...arguments_) => runVoid(() => coordinator.clearSession(...arguments_)),
    acquireLock: (...arguments_) => run(() => coordinator.acquireLock(...arguments_), false),
    releaseLock: (...arguments_) => run(() => coordinator.releaseLock(...arguments_), false),
    acquireSourceFileLock: (...arguments_) =>
      run(() => coordinator.acquireSourceFileLock(...arguments_), false),
    releaseSourceFileLock: (...arguments_) =>
      run(() => coordinator.releaseSourceFileLock(...arguments_), false),
    acquireSourceFileGraphLock: (...arguments_) =>
      run(() => coordinator.acquireSourceFileGraphLock(...arguments_), false),
    releaseSourceFileGraphLock: (...arguments_) =>
      run(() => coordinator.releaseSourceFileGraphLock(...arguments_), false),
    recordSourceFileEvent: (...arguments_) =>
      runVoid(() => coordinator.recordSourceFileEvent(...arguments_)),
    recordSourceFileGraphState: (...arguments_) =>
      runVoid(() => coordinator.recordSourceFileGraphState(...arguments_)),
    acquireKnowledgeBasePublicationLock: (...arguments_) =>
      run(() => coordinator.acquireKnowledgeBasePublicationLock(...arguments_), false),
    releaseKnowledgeBasePublicationLock: (...arguments_) =>
      run(() => coordinator.releaseKnowledgeBasePublicationLock(...arguments_), false),
    setPaginationCursor: (...arguments_) =>
      runVoid(() => coordinator.setPaginationCursor(...arguments_)),
    getPaginationCursor: (...arguments_) =>
      run(() => coordinator.getPaginationCursor(...arguments_), null),
    setPageCache: (...arguments_) => runVoid(() => coordinator.setPageCache(...arguments_)),
    getPageCache: (...arguments_) => run(() => coordinator.getPageCache(...arguments_), null),
    markPaginationInvalid: (...arguments_) =>
      runVoid(() => coordinator.markPaginationInvalid(...arguments_)),
    getPaginationInvalid: (...arguments_) =>
      run(() => coordinator.getPaginationInvalid(...arguments_), null),
    clearSourceFileRuntimeKeys: (...arguments_) =>
      run(() => coordinator.clearSourceFileRuntimeKeys(...arguments_), 0),
    clearKnowledgeBaseRuntimeKeys: (...arguments_) =>
      run(() => coordinator.clearKnowledgeBaseRuntimeKeys(...arguments_), 0),
    setPublicOpenApiKeyCache: (...arguments_) =>
      runVoid(() => coordinator.setPublicOpenApiKeyCache(...arguments_)),
    getPublicOpenApiKeyCache: (...arguments_) =>
      run(() => coordinator.getPublicOpenApiKeyCache(...arguments_), null),
    clearPublicOpenApiKeyRuntimeKeys: (...arguments_) =>
      runVoid(() => coordinator.clearPublicOpenApiKeyRuntimeKeys(...arguments_)),
    markPublicOpenApiKeyUsed: (...arguments_) =>
      run(() => coordinator.markPublicOpenApiKeyUsed(...arguments_), false),
    setRuntimeSettingsVersion: (...arguments_) =>
      runVoid(() => coordinator.setRuntimeSettingsVersion(...arguments_)),
    getRuntimeSettingsVersion: (...arguments_) =>
      run(() => coordinator.getRuntimeSettingsVersion(...arguments_), null),
    hitRateLimit: (scope, id, limit) =>
      run(() => coordinator.hitRateLimit(scope, id, limit), {
        allowed: true,
        remaining: limit.max,
        resetAt: new Date(Date.now() + limit.windowSeconds * 1_000).toISOString()
      })
  };
}
