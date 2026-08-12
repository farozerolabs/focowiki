import type { SearchProviderRuntime } from
  "../../application/ports/search-provider-runtime.js";
import type {
  StorageVnextCleanupActionRepository
} from "../cleanup/postgres-cleanup-action-repository.js";

type CleanupActions = Pick<
  StorageVnextCleanupActionRepository,
  "claim" | "complete" | "releaseForRetry"
>;

const MAXIMUM_CLEANUP_ACTION_CLAIM = 100;
const CLEANUP_DOMAINS = [
  "search_projection_retirement",
  "provider_adoption"
] as const;

export function createStorageVnextProviderIndexCleanupWorker(input: {
  actions: CleanupActions;
  provider: Pick<SearchProviderRuntime, "kind" | "admin" | "operations">;
  maxPollAttempts: number;
  pollIntervalMs: number;
  retryDelayMs: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  validateConfiguration(input);
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? wait;
  return {
    async runBatch(request: {
      owner: string;
      limit: number;
      leaseExpiresAt: string;
    }): Promise<{ claimed: number; completed: number; retried: number }> {
      validateRequest(request);
      const claimLimit = Math.min(request.limit, MAXIMUM_CLEANUP_ACTION_CLAIM);
      const actions = [] as Awaited<ReturnType<CleanupActions["claim"]>>[number][];
      for (const domain of CLEANUP_DOMAINS) {
        const remaining = claimLimit - actions.length;
        if (remaining === 0) break;
        actions.push(...await input.actions.claim({
          ...request,
          limit: remaining,
          selector: {
            domain,
            plane: "search",
            resourceKind: "search_index",
            searchProviderKind: input.provider.kind
          }
        }));
      }
      let completed = 0;
      let retried = 0;
      for (const action of actions) {
        try {
          assertOwnedAction(action, input.provider.kind);
          const receipt = await input.provider.admin.deleteIndex({
            indexUid: action.target.publicId
          });
          if (receipt.state === "pending") {
            await convergeOperation(receipt.operationRef);
          }
          if (!await input.actions.complete({
            publicId: action.publicId,
            owner: request.owner
          })) throw cleanupError("lease_lost");
          completed += 1;
        } catch {
          const retryAt = new Date(now().getTime() + input.retryDelayMs);
          await input.actions.releaseForRetry({
            publicId: action.publicId,
            owner: request.owner,
            notBefore: retryAt.toISOString(),
            safeErrorCode: "SEARCH_INDEX_CLEANUP_FAILED",
            checkpoint: action.checkpoint
          });
          retried += 1;
        }
      }
      return { claimed: actions.length, completed, retried };
    }
  };

  async function convergeOperation(operationRef: string): Promise<void> {
    for (let attempt = 1; attempt <= input.maxPollAttempts; attempt += 1) {
      const status = await input.provider.operations.getOperation({ operationRef });
      if (status.state === "completed") return;
      if (status.state === "failed") throw cleanupError("provider_operation_failed");
      if (attempt < input.maxPollAttempts) await sleep(input.pollIntervalMs);
    }
    throw cleanupError("provider_operation_timeout");
  }
}

function assertOwnedAction(
  action: Awaited<ReturnType<CleanupActions["claim"]>>[number],
  providerKind: SearchProviderRuntime["kind"]
): void {
  if (
    !CLEANUP_DOMAINS.includes(action.domain as typeof CLEANUP_DOMAINS[number])
    || action.searchProviderKind !== providerKind
    || action.target.plane !== "search"
    || action.target.resourceKind !== "search_index"
    || action.target.publicId !== action.checkpoint.providerIndexUid
  ) throw cleanupError("ownership_conflict");
}

function validateConfiguration(input: {
  maxPollAttempts: number;
  pollIntervalMs: number;
  retryDelayMs: number;
}): void {
  if (
    !Number.isSafeInteger(input.maxPollAttempts)
    || input.maxPollAttempts < 1
    || !Number.isSafeInteger(input.pollIntervalMs)
    || input.pollIntervalMs < 0
    || !Number.isSafeInteger(input.retryDelayMs)
    || input.retryDelayMs < 0
  ) throw cleanupError("invalid_configuration");
}

function validateRequest(input: {
  owner: string;
  limit: number;
  leaseExpiresAt: string;
}): void {
  if (
    !input.owner
    || Buffer.byteLength(input.owner) > 255
    || !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > 1_000
    || !Number.isFinite(Date.parse(input.leaseExpiresAt))
  ) throw cleanupError("invalid_input");
}

function cleanupError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext provider index cleanup error: ${code}`),
    { code }
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
