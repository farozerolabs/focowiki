export type DocumentProjectionScopeClaim = Readonly<{
  publicId: string;
  knowledgeBaseId: string;
  kind: "source" | "relation" | "directory" | "graph"
    | "_index" | "_graph" | "root";
  key: string;
  requiredSequence: number;
  renderedSequence: number;
  publicationGenerationPublicId?: string;
  deterministicEventTime?: string;
  leaseGeneration?: number;
  leaseExpiresAt?: string;
}>;

export type DocumentProjectionStorageRequests = Readonly<{
  put: number;
  head: number;
  verification: number;
  attemptedBytes: number;
  retries: number;
  latencyMilliseconds: number;
}>;

type DocumentProjectionScopeRendered = Readonly<{
  outputFingerprintSha256: string;
  storageRequests: DocumentProjectionStorageRequests;
}>;

export type DocumentProjectionScopeCommitResult = Readonly<{
  state: "completed" | "waiting";
  readyDocumentJobPublicIds: readonly string[];
}>;

export function createDocumentScopeProjectorRuntime<
  TRendered extends DocumentProjectionScopeRendered
>(input: {
  workerId: string;
  leaseDurationMs: number;
  scopes: {
    claim(request: {
      workerId: string;
      now: string;
      leaseDurationMs: number;
      limit: number;
    }): Promise<readonly DocumentProjectionScopeClaim[]>;
    fail(request: {
      publicId: string;
      workerId: string;
      leaseGeneration?: number;
      now: string;
      errorCode: string;
      retryable: boolean;
      nextEligibleAt: string | null;
    }): Promise<"waiting" | "error" | null>;
    recoverExpired(request: {
      now: string;
      retryAt: string;
      limit: number;
    }): Promise<number>;
    heartbeat?(request: {
      publicId: string;
      workerId: string;
      leaseGeneration: number;
      now: string;
      leaseDurationMs: number;
    }): Promise<boolean>;
    compactTerminalHistory?(request: {
      before: string;
      limit: number;
    }): Promise<{ contributions: number; storageMetrics: number }>;
  };
  commit(request: {
    publicId: string;
    workerId: string;
    renderedSequence: number;
    leaseGeneration?: number;
    outputFingerprintSha256: string;
    storageRequests: DocumentProjectionStorageRequests;
    now: string;
  }): Promise<DocumentProjectionScopeCommitResult | null>;
  render(scope: DocumentProjectionScopeClaim, signal: AbortSignal): Promise<TRendered>;
  persist(
    scope: DocumentProjectionScopeClaim,
    rendered: TRendered,
    signal: AbortSignal
  ): Promise<void>;
  finalize(request: {
    now: string;
    limit: number;
    documentJobPublicIds?: readonly string[];
  }): Promise<number>;
  now(): string;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  classifyError(error: unknown): { code: string; retryable: boolean };
  onFailure?(input: {
    scope: DocumentProjectionScopeClaim;
    error: unknown;
    errorCode: string;
    retryable: boolean;
  }): void;
  retryDelayMs?(attempt: number): number;
  maximumConcurrency?: number;
  idlePollIntervalMs?: number;
  recoveryIntervalMs?: number;
  recoveryLimit?: number;
}) {
  validateInput(input);
  let maximumConcurrency = input.maximumConcurrency ?? 4;
  const active = new Set<Promise<void>>();

  async function runOne(signal: AbortSignal): Promise<boolean> {
    const scope = await claimOne(signal);
    if (!scope) return false;
    const execution = launch(scope, signal);
    await execution;
    return true;
  }

  async function claimOne(
    signal: AbortSignal
  ): Promise<DocumentProjectionScopeClaim | null> {
    if (signal.aborted) return null;
    const claims = await input.scopes.claim({
      workerId: input.workerId,
      now: input.now(),
      leaseDurationMs: input.leaseDurationMs,
      limit: 1
    });
    return claims[0] ?? null;
  }

  async function claimAvailable(
    signal: AbortSignal,
    limit: number
  ): Promise<readonly DocumentProjectionScopeClaim[]> {
    if (signal.aborted || limit < 1) return [];
    return input.scopes.claim({
      workerId: input.workerId,
      now: input.now(),
      leaseDurationMs: input.leaseDurationMs,
      limit
    });
  }

  async function finalizeDocumentJobs(
    now: string,
    documentJobPublicIds: readonly string[]
  ): Promise<void> {
    const unique = [...new Set(documentJobPublicIds)];
    for (let offset = 0; offset < unique.length; offset += 256) {
      const chunk = unique.slice(offset, offset + 256);
      let completed: number;
      do {
        completed = await input.finalize({
          now,
          limit: 64,
          documentJobPublicIds: chunk
        });
      } while (completed === 64);
    }
  }

  function launch(
    scope: DocumentProjectionScopeClaim,
    signal: AbortSignal
  ): Promise<void> {
    const execution = execute(scope, signal);
    active.add(execution);
    void execution.finally(() => active.delete(execution));
    return execution;
  }

  async function execute(
    scope: DocumentProjectionScopeClaim,
    signal: AbortSignal
  ): Promise<void> {
    const leaseController = new AbortController();
    const abortFromParent = () => leaseController.abort(signal.reason);
    signal.addEventListener("abort", abortFromParent, { once: true });
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    try {
      if (input.scopes.heartbeat && scope.leaseGeneration !== undefined) {
        await requireLeaseHeartbeat(scope, leaseController);
        heartbeatTimer = setInterval(() => {
          void requireLeaseHeartbeat(scope, leaseController).catch((error) => {
            leaseController.abort(error);
          });
        }, Math.max(100, Math.floor(input.leaseDurationMs / 3)));
        heartbeatTimer.unref?.();
      }
      const rendered = await input.render(scope, leaseController.signal);
      if (input.scopes.heartbeat && scope.leaseGeneration !== undefined) {
        await requireLeaseHeartbeat(scope, leaseController);
      }
      leaseController.signal.throwIfAborted();
      if (!/^[0-9a-f]{64}$/u.test(rendered.outputFingerprintSha256)) {
        throw projectorError("projection_scope_fingerprint_invalid");
      }
      validateStorageRequests(rendered.storageRequests);
      await input.persist(scope, rendered, leaseController.signal);
      const now = input.now();
      const committed = await input.commit({
        publicId: scope.publicId,
        workerId: input.workerId,
        renderedSequence: scope.renderedSequence,
        ...(scope.leaseGeneration !== undefined
          ? { leaseGeneration: scope.leaseGeneration } : {}),
        outputFingerprintSha256: rendered.outputFingerprintSha256,
        storageRequests: rendered.storageRequests,
        now
      });
      if (!committed) throw projectorError("projection_scope_lease_lost");
      if (committed.readyDocumentJobPublicIds.length > 0) {
        await finalizeDocumentJobs(now, committed.readyDocumentJobPublicIds);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      const diagnostic = input.classifyError(error);
      const now = input.now();
      const delay = diagnostic.retryable
        ? (input.retryDelayMs?.(1) ?? 1_000)
        : null;
      await input.scopes.fail({
        publicId: scope.publicId,
        workerId: input.workerId,
        ...(scope.leaseGeneration !== undefined
          ? { leaseGeneration: scope.leaseGeneration } : {}),
        now,
        errorCode: diagnostic.code,
        retryable: diagnostic.retryable,
        nextEligibleAt: delay === null
          ? null
          : new Date(Date.parse(now) + delay).toISOString()
      });
      input.onFailure?.({
        scope,
        error,
        errorCode: diagnostic.code,
        retryable: diagnostic.retryable
      });
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      signal.removeEventListener("abort", abortFromParent);
    }
  }

  async function requireLeaseHeartbeat(
    scope: DocumentProjectionScopeClaim,
    controller: AbortController
  ): Promise<void> {
    const renewed = await input.scopes.heartbeat!({
      publicId: scope.publicId,
      workerId: input.workerId,
      leaseGeneration: scope.leaseGeneration!,
      now: input.now(),
      leaseDurationMs: input.leaseDurationMs
    });
    if (!renewed) {
      const error = projectorError("projection_scope_lease_lost");
      controller.abort(error);
      throw error;
    }
  }

  return {
    runOne,
    maximumConcurrency(): number {
      return maximumConcurrency;
    },
    updateMaximumConcurrency(value: number): void {
      if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
        throw projectorError("projection_scope_runtime_configuration_invalid");
      }
      maximumConcurrency = value;
    },
    async run(signal: AbortSignal): Promise<void> {
      const idlePollIntervalMs = input.idlePollIntervalMs ?? 100;
      const recoveryIntervalMs = input.recoveryIntervalMs ?? 5_000;
      const recoveryLimit = input.recoveryLimit ?? 100;
      let nextRecoveryAt = 0;
      while (!signal.aborted) {
        const nowMs = Date.now();
        if (nowMs >= nextRecoveryAt) {
          const now = input.now();
          await input.scopes.recoverExpired({
            now,
            retryAt: new Date(Date.parse(now)
              + (input.retryDelayMs?.(1) ?? 1_000)).toISOString(),
            limit: recoveryLimit
          });
          await input.finalize({ now, limit: 64 });
          await input.scopes.compactTerminalHistory?.({
            before: new Date(Date.parse(now) - 86_400_000).toISOString(),
            limit: recoveryLimit
          });
          nextRecoveryAt = nowMs + recoveryIntervalMs;
        }
        let launched = false;
        while (!signal.aborted && active.size < maximumConcurrency) {
          const scopes = await claimAvailable(
            signal,
            maximumConcurrency - active.size
          );
          if (scopes.length === 0) break;
          scopes.forEach((scope) => launch(scope, signal));
          launched = true;
        }
        if (active.size > 0 && (!launched || active.size >= maximumConcurrency)) {
          await Promise.race([...active]);
        } else if (!launched && !signal.aborted) {
          await input.wait(idlePollIntervalMs, signal);
        }
      }
      await Promise.allSettled([...active]);
    },
    activeCount(): number {
      return active.size;
    }
  };
}

function validateStorageRequests(
  requests: DocumentProjectionStorageRequests
): void {
  if (!requests || ![
    requests.put,
    requests.head,
    requests.verification,
    requests.attemptedBytes,
    requests.retries
  ].every((value) => Number.isSafeInteger(value) && value >= 0)
    || !Number.isFinite(requests.latencyMilliseconds)
    || requests.latencyMilliseconds < 0) {
    throw projectorError("projection_scope_storage_metrics_invalid");
  }
}

function validateInput(input: {
  workerId: string;
  leaseDurationMs: number;
  maximumConcurrency?: number;
}): void {
  if (!input.workerId || Buffer.byteLength(input.workerId, "utf8") > 255
    || !Number.isSafeInteger(input.leaseDurationMs)
    || input.leaseDurationMs < 1_000 || input.leaseDurationMs > 300_000
    || (input.maximumConcurrency !== undefined
      && (!Number.isSafeInteger(input.maximumConcurrency)
        || input.maximumConcurrency < 1 || input.maximumConcurrency > 64))) {
    throw projectorError("projection_scope_runtime_configuration_invalid");
  }
}

function projectorError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document scope projector error: ${code}`), {
    code
  });
}
