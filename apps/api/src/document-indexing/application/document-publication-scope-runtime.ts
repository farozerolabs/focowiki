import type { DocumentLeaseGeneration } from
  "../domain/document-publication-identifiers.js";
import type { DocumentPublicationRecoveryDecision } from
  "./document-publication-recovery.js";

type ScopeClaim = Readonly<{
  publicId: string;
  leaseGeneration: DocumentLeaseGeneration;
  knowledgeBaseId?: string;
  publicationGenerationPublicId?: string;
  scopeKind?: string;
  safeScopeKeyHash?: string;
  targetFactEpoch?: number;
  activeFactEpoch?: number;
  scopeGeneration?: number;
}>;

export function createDocumentPublicationScopeRuntime(input: {
  workerId: string;
  leaseDurationMs: number;
  maximumConcurrency: number;
  repository: {
    claim(request: Readonly<{
      workerId: string;
      now: string;
      leaseDurationMs: number;
      limit: number;
    }>): Promise<readonly ScopeClaim[]>;
    fail(request: Readonly<{
      publicId: string;
      workerId: string;
      leaseGeneration: DocumentLeaseGeneration;
      now: string;
      errorCode: string;
      recoveryAction: DocumentPublicationRecoveryDecision["action"];
    }>): Promise<unknown>;
    recoverExpired(request: Readonly<{
      now: string;
      limit: number;
    }>): Promise<number>;
  };
  execute(request: Readonly<{
    claim: ScopeClaim;
    workerId: string;
    checkedAt: string;
    signal: AbortSignal;
  }>): Promise<void>;
  now(): string;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
  classifyError(error: unknown, claim: ScopeClaim): {
    code: string;
    recoveryAction: DocumentPublicationRecoveryDecision["action"];
  };
  idlePollMilliseconds?: number;
  recoveryIntervalMilliseconds?: number;
  onFailure?(input: Readonly<{
    claim: ScopeClaim;
    code: string;
    recoveryAction: DocumentPublicationRecoveryDecision["action"];
    error: unknown;
  }>): void;
  onClaim?(input: Readonly<{ claim: ScopeClaim }>): void;
  onComplete?(input: Readonly<{
    claim: ScopeClaim;
    durationMs: number;
  }>): void;
  onRecovered?(input: Readonly<{ count: number }>): void;
}) {
  let maximumConcurrency = positiveCapacity(input.maximumConcurrency);
  const active = new Set<Promise<void>>();

  function launch(claim: ScopeClaim, signal: AbortSignal): void {
    const execution = execute(claim, signal);
    active.add(execution);
    void execution.finally(() => active.delete(execution));
  }

  async function execute(claim: ScopeClaim, signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    input.onClaim?.({ claim });
    try {
      await input.execute({
        claim,
        workerId: input.workerId,
        checkedAt: input.now(),
        signal
      });
      input.onComplete?.({
        claim,
        durationMs: Math.max(0, Date.now() - startedAt)
      });
    } catch (error) {
      if (signal.aborted) return;
      const classification = input.classifyError(error, claim);
      await input.repository.fail({
        publicId: claim.publicId,
        workerId: input.workerId,
        leaseGeneration: claim.leaseGeneration,
        now: input.now(),
        errorCode: classification.code,
        recoveryAction: classification.recoveryAction
      });
      input.onFailure?.({ claim, ...classification, error });
    }
  }

  return {
    activeCount: () => active.size,
    updateMaximumConcurrency(value: number): void {
      maximumConcurrency = positiveCapacity(value);
    },
    async run(signal: AbortSignal): Promise<void> {
      let nextRecoveryAt = 0;
      while (!signal.aborted) {
        const now = Date.parse(input.now());
        if (now >= nextRecoveryAt) {
          const recovered = await input.repository.recoverExpired({
            now: input.now(),
            limit: Math.max(maximumConcurrency * 4, 16)
          });
          if (recovered > 0) input.onRecovered?.({ count: recovered });
          nextRecoveryAt = now
            + (input.recoveryIntervalMilliseconds ?? 5_000);
        }
        const capacity = maximumConcurrency - active.size;
        if (capacity > 0) {
          const claims = await input.repository.claim({
            workerId: input.workerId,
            now: input.now(),
            leaseDurationMs: input.leaseDurationMs,
            limit: capacity
          });
          claims.forEach((claim) => launch(claim, signal));
        }
        if (active.size > 0) {
          await Promise.race(active);
        } else {
          await input.wait(input.idlePollMilliseconds ?? 100, signal);
        }
      }
      await Promise.allSettled(active);
    }
  };
}

function positiveCapacity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw runtimeError("publication_scope_capacity_invalid");
  }
  return value;
}

function runtimeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication scope runtime error: ${code}`), {
    code
  });
}
