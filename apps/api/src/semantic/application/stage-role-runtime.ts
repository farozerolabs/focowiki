import type { SemanticStageKind } from "./stage-orchestration.js";
import type {
  SemanticStageRepositoryPort,
  SemanticStageWorkClaim
} from "./stage-ports.js";

const ALL_STAGE_KINDS: readonly SemanticStageKind[] = [
  "extraction", "reconciliation", "community", "embedding",
  "vector", "publication", "validation", "cleanup"
];
const PARALLEL_STAGE_KINDS = new Set<SemanticStageKind>([
  "extraction", "reconciliation", "community",
  "embedding", "vector", "publication"
]);

type StageWorker = {
  runClaim(claim: SemanticStageWorkClaim, signal?: AbortSignal): Promise<unknown>;
};

type ActiveExecution = {
  claim: SemanticStageWorkClaim;
  promise: Promise<void>;
};

export function createSemanticStageRoleRuntime(input: {
  owner: string;
  repository: SemanticStageRepositoryPort;
  worker: StageWorker;
  clock?: () => string;
  stageKinds?: readonly SemanticStageKind[];
  settings: {
    claimLimit: number;
    maximumParallelStagesPerKnowledgeBase?: number;
    pollIntervalMs: number;
    leaseDurationMs: number;
    recoveryBatchSize: number;
  };
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onFailure?: (input: { claim: SemanticStageWorkClaim; error: unknown }) => void;
}) {
  assertInput(input);
  const clock = input.clock ?? (() => new Date().toISOString());
  const stageKinds = input.stageKinds ?? ALL_STAGE_KINDS;
  const wait = input.wait ?? waitForPoll;
  const maximumParallelStagesPerKnowledgeBase =
    input.settings.maximumParallelStagesPerKnowledgeBase
    ?? input.settings.claimLimit;
  return {
    async run(signal: AbortSignal): Promise<void> {
      const active = new Map<string, ActiveExecution>();
      try {
        while (!signal.aborted) {
          if (active.size < input.settings.claimLimit) {
            const now = clock();
            const leaseExpiresAt = addMilliseconds(
              now,
              input.settings.leaseDurationMs
            );
            await input.repository.recoverExpired({
              expiredBefore: now,
              nextAttemptAt: now,
              limit: input.settings.recoveryBatchSize
            });
            const claims = await input.repository.claim({
              stageKinds,
              owner: input.owner,
              limit: input.settings.claimLimit - active.size,
              maximumParallelStagesPerKnowledgeBase,
              excludedKnowledgeBaseIds: excludedKnowledgeBaseIds(
                active,
                maximumParallelStagesPerKnowledgeBase
              ),
              now,
              leaseExpiresAt
            });
            for (const claim of claims) {
              assertClaimCanRun(
                active,
                claim,
                maximumParallelStagesPerKnowledgeBase
              );
              let execution!: Promise<void>;
              execution = input.worker.runClaim(claim, signal)
                .then(() => undefined)
                .catch((error: unknown) => {
                  input.onFailure?.({ claim, error });
                })
                .finally(() => {
                  if (active.get(claim.publicId)?.promise === execution) {
                    active.delete(claim.publicId);
                  }
                });
              active.set(claim.publicId, { claim, promise: execution });
            }
            if (claims.length > 0) continue;
          }
          await waitForProgress({
            active: [...active.values()].map((item) => item.promise),
            milliseconds: input.settings.pollIntervalMs,
            signal,
            wait
          });
        }
      } finally {
        await Promise.allSettled(
          [...active.values()].map((item) => item.promise)
        );
      }
    }
  };
}

function excludedKnowledgeBaseIds(
  active: ReadonlyMap<string, ActiveExecution>,
  maximumParallelStagesPerKnowledgeBase: number
): string[] {
  const byKnowledgeBase = new Map<string, SemanticStageWorkClaim[]>();
  for (const { claim } of active.values()) {
    const claims = byKnowledgeBase.get(claim.knowledgeBaseId) ?? [];
    claims.push(claim);
    byKnowledgeBase.set(claim.knowledgeBaseId, claims);
  }
  return [...byKnowledgeBase]
    .filter(([, claims]) => claims.length >= maximumParallelStagesPerKnowledgeBase
      || !isParallelStage(claims[0]!.stageKind)
      || claims.some((claim) => claim.stageKind !== claims[0]!.stageKind))
    .map(([knowledgeBaseId]) => knowledgeBaseId);
}

function activeClaimsForKnowledgeBase(
  active: ReadonlyMap<string, ActiveExecution>,
  knowledgeBaseId: string
): SemanticStageWorkClaim[] {
  return [...active.values()]
    .filter((item) => item.claim.knowledgeBaseId === knowledgeBaseId)
    .map((item) => item.claim);
}

function assertClaimCanRun(
  active: ReadonlyMap<string, ActiveExecution>,
  claim: SemanticStageWorkClaim,
  maximumParallelStagesPerKnowledgeBase: number
): void {
  const peers = activeClaimsForKnowledgeBase(active, claim.knowledgeBaseId);
  if (peers.length === 0) return;
  if (!isParallelStage(claim.stageKind)
    || peers.some((item) => item.stageKind !== claim.stageKind)
    || peers.length >= maximumParallelStagesPerKnowledgeBase) {
    throw new Error("Semantic stage claim exceeded its knowledge-base concurrency bound");
  }
}

function assertInput(input: {
  owner: string;
  stageKinds?: readonly SemanticStageKind[];
  settings: {
    claimLimit: number;
    maximumParallelStagesPerKnowledgeBase?: number;
    pollIntervalMs: number;
    leaseDurationMs: number;
    recoveryBatchSize: number;
  };
}): void {
  const { settings } = input;
  if (!input.owner || Buffer.byteLength(input.owner) > 255
    || input.stageKinds?.length === 0
    || !Number.isSafeInteger(settings.claimLimit)
    || settings.claimLimit < 1 || settings.claimLimit > 32
    || settings.maximumParallelStagesPerKnowledgeBase !== undefined
      && (!Number.isSafeInteger(settings.maximumParallelStagesPerKnowledgeBase)
        || settings.maximumParallelStagesPerKnowledgeBase < 1
        || settings.maximumParallelStagesPerKnowledgeBase > settings.claimLimit)
    || !Number.isSafeInteger(settings.pollIntervalMs)
    || settings.pollIntervalMs < 1 || settings.pollIntervalMs > 60_000
    || !Number.isSafeInteger(settings.leaseDurationMs)
    || settings.leaseDurationMs < 1_000 || settings.leaseDurationMs > 3_600_000
    || !Number.isSafeInteger(settings.recoveryBatchSize)
    || settings.recoveryBatchSize < 1 || settings.recoveryBatchSize > 1_000) {
    throw new Error("Semantic stage role settings are invalid");
  }
}

function isParallelStage(stageKind: SemanticStageKind): boolean {
  return PARALLEL_STAGE_KINDS.has(stageKind);
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw new Error("Semantic stage role clock is invalid");
  return new Date(value + milliseconds).toISOString();
}

async function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

async function waitForProgress(input: {
  active: readonly Promise<void>[];
  milliseconds: number;
  signal: AbortSignal;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}): Promise<void> {
  if (input.active.length === 0) {
    await input.wait(input.milliseconds, input.signal);
    return;
  }
  const waitController = new AbortController();
  const waitSignal = AbortSignal.any([input.signal, waitController.signal]);
  try {
    await Promise.race([
      ...input.active,
      input.wait(input.milliseconds, waitSignal)
    ]);
  } finally {
    waitController.abort();
  }
}
