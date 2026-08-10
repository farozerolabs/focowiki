import type {
  SemanticStageRepositoryPort,
  SemanticStageWorkClaim
} from "./stage-ports.js";
import type {
  SemanticStageBudgetKind,
  SemanticStageKind,
  SemanticStageSettingsSnapshot
} from "./stage-orchestration.js";
import {
  SEMANTIC_EXTRACTION_CONTRACT_VERSION,
  SEMANTIC_PROMPT_CONTRACT_VERSION
} from "../domain/contracts.js";

type BudgetManager = {
  acquire(kind: SemanticStageBudgetKind, knowledgeBaseId: string): Promise<() => void>;
};

export type SemanticStageHandlerResult = {
  checkpoint: SemanticStageSettingsSnapshot;
  reusedArtifactCount: number;
};

export function createSemanticStageWorker(input: {
  repository: SemanticStageRepositoryPort;
  budgets: BudgetManager;
  handlers: Record<SemanticStageKind, (
    claim: SemanticStageWorkClaim,
    signal?: AbortSignal
  ) => Promise<SemanticStageHandlerResult>>;
  clock?: () => string;
  nowMilliseconds?: () => number;
  retryDelayMs?: number;
  lease?: { durationMs: number; renewalIntervalMs: number };
  onSettled?: (input: {
    stageKind: SemanticStageKind;
    outcome: "completed" | "superseded" | "retry" | "failed" | "cancelled";
    durationMs: number;
  }) => void;
}) {
  const clock = input.clock ?? (() => new Date().toISOString());
  const nowMilliseconds = input.nowMilliseconds ?? Date.now;
  const retryDelayMs = input.retryDelayMs ?? 1_000;
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("Semantic stage retry delay is invalid");
  }
  if (input.lease) assertLease(input.lease);
  return {
    async runClaim(claim: SemanticStageWorkClaim, signal?: AbortSignal) {
      const startedAt = nowMilliseconds();
      let settledOutcome:
        "completed" | "superseded" | "retry" | "failed" | "cancelled" = "failed";
      const releases: Array<() => void> = [];
      const leaseController = new AbortController();
      const effectiveSignal = signal
        ? AbortSignal.any([signal, leaseController.signal])
        : leaseController.signal;
      const stopHeartbeat = input.lease
        ? startLeaseHeartbeat({
            repository: input.repository,
            claim,
            lease: input.lease,
            clock,
            controller: leaseController
          })
        : async () => undefined;
      try {
        assertNotAborted(effectiveSignal);
        assertCurrentSemanticContract(claim);
        if (!await input.repository.isOwned({ claim })) {
          settledOutcome = "superseded";
          return { outcome: "superseded" as const, reusedArtifactCount: 0 };
        }
        for (const budget of stageBudgets(claim.stageKind)) {
          releases.push(await input.budgets.acquire(budget, claim.knowledgeBaseId));
        }
        assertNotAborted(effectiveSignal);
        const result = await input.handlers[claim.stageKind](claim, effectiveSignal);
        assertNotAborted(effectiveSignal);
        if (!await input.repository.isOwned({ claim })) {
          settledOutcome = "superseded";
          return { outcome: "superseded" as const, reusedArtifactCount: 0 };
        }
        if (!await input.repository.saveCheckpoint({
          claim,
          checkpoint: {
            ...result.checkpoint,
            reusedArtifactCount: result.reusedArtifactCount
          }
        })) {
          settledOutcome = "superseded";
          return { outcome: "superseded" as const, reusedArtifactCount: 0 };
        }
        const completedAt = clock();
        if (!await input.repository.finish({
          claim, outcome: "completed", safeCode: null,
          nextAttemptAt: completedAt, completedAt
        })) {
          settledOutcome = "superseded";
          return { outcome: "superseded" as const, reusedArtifactCount: 0 };
        }
        settledOutcome = "completed";
        return { outcome: "completed" as const, reusedArtifactCount: result.reusedArtifactCount };
      } catch (error) {
        const completedAt = clock();
        const cancelled = claim.cancellationRequestedAt !== null;
        const retry = !cancelled && isRetryable(error);
        settledOutcome = cancelled ? "cancelled" : retry ? "retry" : "failed";
        await input.repository.finish({
          claim,
          outcome: cancelled ? "cancelled" : retry ? "retry" : "failed",
          safeCode: semanticStageSafeCode(error, {
            cancelled,
            retry
          }),
          nextAttemptAt: new Date(Date.parse(completedAt) + retryDelayMs).toISOString(),
          completedAt
        });
        throw error;
      } finally {
        await stopHeartbeat();
        for (const release of releases.reverse()) release();
        input.onSettled?.({
          stageKind: claim.stageKind,
          outcome: settledOutcome,
          durationMs: Math.max(0, nowMilliseconds() - startedAt)
        });
      }
    }
  };
}

function assertCurrentSemanticContract(claim: SemanticStageWorkClaim): void {
  if (claim.extractionContractVersion !== SEMANTIC_EXTRACTION_CONTRACT_VERSION
    || claim.settingsSnapshot.promptContractVersion
      !== SEMANTIC_PROMPT_CONTRACT_VERSION) {
    throw Object.assign(
      new Error("Semantic stage contract requires explicit maintenance"),
      {
        code: "semantic_contract_maintenance_required",
        retryable: false
      }
    );
  }
}

function startLeaseHeartbeat(input: {
  repository: SemanticStageRepositoryPort;
  claim: SemanticStageWorkClaim;
  lease: { durationMs: number; renewalIntervalMs: number };
  clock: () => string;
  controller: AbortController;
}): () => Promise<void> {
  let renewal: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (renewal || input.controller.signal.aborted) return;
    renewal = renew().finally(() => {
      renewal = null;
    });
  }, input.lease.renewalIntervalMs);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await renewal;
  };

  async function renew(): Promise<void> {
    try {
      const now = Date.parse(input.clock());
      if (!Number.isFinite(now)) throw new Error("Semantic stage clock is invalid");
      const owned = await input.repository.renew({
        claim: input.claim,
        leaseExpiresAt: new Date(now + input.lease.durationMs).toISOString()
      });
      if (!owned) throw new Error("Semantic stage lease was lost");
    } catch (error) {
      input.controller.abort(error);
    }
  }
}

function assertLease(value: { durationMs: number; renewalIntervalMs: number }): void {
  if (!Number.isSafeInteger(value.durationMs) || value.durationMs < 1
    || !Number.isSafeInteger(value.renewalIntervalMs)
    || value.renewalIntervalMs < 1
    || value.renewalIntervalMs >= value.durationMs) {
    throw new Error("Semantic stage lease settings are invalid");
  }
}

export function stageBudgets(stageKind: SemanticStageKind): SemanticStageBudgetKind[] {
  switch (stageKind) {
    case "extraction": return [];
    case "embedding": return [];
    case "reconciliation": return ["database_mutation"];
    case "community": return ["database_mutation"];
    case "vector": return ["s3_read", "database_mutation", "search_write"];
    case "publication": return ["database_mutation"];
    case "validation": return ["database_mutation"];
    case "cleanup": return ["s3_write", "database_mutation", "search_write"];
  }
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof Error && "retryable" in error && error.retryable === false);
}

function semanticStageSafeCode(
  error: unknown,
  state: { cancelled: boolean; retry: boolean }
): string {
  if (state.cancelled) return "semantic_stage_cancelled";
  if (error instanceof Error && "code" in error) {
    const code = String(error.code);
    if (/^semantic_[a-z0-9_]+$/u.test(code) && code.length <= 128) {
      return code;
    }
  }
  return state.retry
    ? "semantic_stage_dependency_failed"
    : "semantic_stage_invalid_output";
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Semantic stage cancelled", "AbortError");
  }
}
