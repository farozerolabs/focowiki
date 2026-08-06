export type StorageVnextGracefulRoleShutdownResult = {
  outcome: "closed" | "deadline_exceeded";
};

export function createStorageVnextGracefulRoleShutdown(input: {
  deadlineMs: number;
  readiness: { stop(): void | Promise<void> };
  claims: { stop(): void | Promise<void> };
  controller: {
    beginShutdown(): void;
    drain(): Promise<void>;
  };
  requests: { abortAll(): void };
  leases: { releaseOwned(): void | Promise<void> };
  resources: {
    closeAll(): Promise<void>;
    assertIdle(maximumOpenResources?: number): void;
  };
}) {
  if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1) {
    throw shutdownError("invalid_configuration");
  }
  let activeShutdown: Promise<StorageVnextGracefulRoleShutdownResult> | null = null;
  return {
    shutdown(): Promise<StorageVnextGracefulRoleShutdownResult> {
      activeShutdown ??= runShutdown();
      return activeShutdown;
    }
  };

  async function runShutdown(): Promise<StorageVnextGracefulRoleShutdownResult> {
    const errors: unknown[] = [];
    await attempt(() => input.readiness.stop(), errors);
    await attempt(() => input.claims.stop(), errors);
    await attempt(() => input.controller.beginShutdown(), errors);
    const drained = await drainBeforeDeadline(input.controller.drain, input.deadlineMs)
      .catch((error) => {
        errors.push(error);
        return false;
      });
    await attempt(() => input.requests.abortAll(), errors);
    await attempt(() => input.leases.releaseOwned(), errors);
    await attempt(() => input.resources.closeAll(), errors);
    await attempt(() => input.resources.assertIdle(0), errors);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Storage vNext graceful role shutdown failed");
    }
    return { outcome: drained ? "closed" : "deadline_exceeded" };
  }
}

async function drainBeforeDeadline(
  drain: () => Promise<void>,
  deadlineMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      Promise.resolve().then(drain).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), deadlineMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function attempt(
  operation: () => void | Promise<void>,
  errors: unknown[]
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
}

function shutdownError(code: string): Error {
  return Object.assign(
    new Error(`Storage vNext graceful role shutdown error: ${code}`),
    { code }
  );
}
