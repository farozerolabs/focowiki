import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";

export type DocumentObsoleteCleanupPlane =
  | "object_storage"
  | "search"
  | "vector";

export type DocumentObsoleteCleanupAction = {
  publicId: string;
  knowledgeBaseId: string;
  sourceRevisionPublicId: string;
  searchProviderKind: SearchProviderKind | null;
  plane: DocumentObsoleteCleanupPlane;
  resourceKind: "generated_object" | "search_document" | "vector_document";
  resourcePublicId: string;
  attempt: number;
  maximumAttempts: number;
};

export type DocumentObsoleteCleanupBatch = {
  owner: string;
  searchProviderKind: SearchProviderKind | null;
  limit: number;
  now: string;
  leaseExpiresAt: string;
  retryDelayMilliseconds: number;
  signal: AbortSignal;
};

export function createDocumentObsoleteArtifactCleanupWorker(input: {
  actions: {
    claim(request: {
      owner: string;
      searchProviderKind: SearchProviderKind | null;
      limit: number;
      leaseExpiresAt: string;
    }): Promise<readonly DocumentObsoleteCleanupAction[]>;
  };
  ownership: {
    isCurrentOwner(action: DocumentObsoleteCleanupAction): Promise<boolean>;
  };
  providers: {
    remove(action: DocumentObsoleteCleanupAction): Promise<void>;
  };
  audit: {
    record(event: {
      action: DocumentObsoleteCleanupAction;
      result: "success" | "failure";
      reasonCode: string | null;
      recordedAt: string;
    }): Promise<void>;
  };
  complete(request: {
    publicId: string;
    owner: string;
    completedAt: string;
  }): Promise<boolean>;
  retry(request: {
    publicId: string;
    owner: string;
    notBefore: string;
    safeErrorCode: string;
  }): Promise<boolean>;
  fail(request: {
    publicId: string;
    owner: string;
    safeErrorCode: string;
    failedAt: string;
  }): Promise<boolean>;
}) {
  return {
    async run(request: DocumentObsoleteCleanupBatch) {
      validateBatch(request);
      const actions = await input.actions.claim({
        owner: request.owner,
        searchProviderKind: request.searchProviderKind,
        limit: request.limit,
        leaseExpiresAt: request.leaseExpiresAt
      });
      const result = {
        claimed: actions.length,
        deleted: 0,
        skippedCurrent: 0,
        completed: 0,
        retried: 0,
        terminalFailed: 0
      };
      for (const action of actions) {
        throwIfAborted(request.signal);
        validateAction(action);
        try {
          const current = await input.ownership.isCurrentOwner(action);
          if (current) {
            await input.audit.record({
              action,
              result: "success",
              reasonCode: "current_owner_present",
              recordedAt: request.now
            });
            await requireTransition(input.complete({
              publicId: action.publicId,
              owner: request.owner,
              completedAt: request.now
            }));
            result.skippedCurrent += 1;
            result.completed += 1;
            continue;
          }

          await input.providers.remove(action);
          result.deleted += 1;
          await input.audit.record({
            action,
            result: "success",
            reasonCode: null,
            recordedAt: request.now
          });
          await requireTransition(input.complete({
            publicId: action.publicId,
            owner: request.owner,
            completedAt: request.now
          }));
          result.completed += 1;
        } catch (error) {
          const safeErrorCode = errorCode(error);
          if (safeErrorCode === "owners_present") {
            await input.audit.record({
              action,
              result: "success",
              reasonCode: "current_owner_present",
              recordedAt: request.now
            });
            await requireTransition(input.complete({
              publicId: action.publicId,
              owner: request.owner,
              completedAt: request.now
            }));
            result.skippedCurrent += 1;
            result.completed += 1;
            continue;
          }
          if (action.attempt < action.maximumAttempts) {
            await requireTransition(input.retry({
              publicId: action.publicId,
              owner: request.owner,
              notBefore: new Date(
                Date.parse(request.now) + request.retryDelayMilliseconds
              ).toISOString(),
              safeErrorCode
            }));
            result.retried += 1;
            continue;
          }
          await input.audit.record({
            action,
            result: "failure",
            reasonCode: safeErrorCode,
            recordedAt: request.now
          });
          await requireTransition(input.fail({
            publicId: action.publicId,
            owner: request.owner,
            safeErrorCode,
            failedAt: request.now
          }));
          result.terminalFailed += 1;
        }
      }
      return result;
    }
  };
}

function validateBatch(input: DocumentObsoleteCleanupBatch): void {
  if (!input.owner || Buffer.byteLength(input.owner, "utf8") > 255
    || !isNullableSearchProviderKind(input.searchProviderKind)
    || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000
    || !Number.isSafeInteger(input.retryDelayMilliseconds)
    || input.retryDelayMilliseconds < 1
    || !Number.isFinite(Date.parse(input.now))
    || !Number.isFinite(Date.parse(input.leaseExpiresAt))
    || Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) {
    throw cleanupError("invalid_input");
  }
  throwIfAborted(input.signal);
}

function validateAction(input: DocumentObsoleteCleanupAction): void {
  if (!input.publicId || !input.knowledgeBaseId || !input.sourceRevisionPublicId
    || !input.resourcePublicId
    || !["object_storage", "search", "vector"].includes(input.plane)
    || !isNullableSearchProviderKind(input.searchProviderKind)
    || !["generated_object", "search_document", "vector_document"]
      .includes(input.resourceKind)
    || !Number.isSafeInteger(input.attempt) || input.attempt < 1
    || !Number.isSafeInteger(input.maximumAttempts)
    || input.maximumAttempts < input.attempt || input.maximumAttempts > 100) {
    throw cleanupError("invalid_action");
  }
}

async function requireTransition(result: Promise<boolean>): Promise<void> {
  if (!await result) throw cleanupError("lease_lost");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? cleanupError("cancelled");
}

function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error
    && typeof error.code === "string" && error.code) {
    return error.code.slice(0, 128);
  }
  return "obsolete_artifact_cleanup_failed";
}

function cleanupError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document cleanup error: ${code}`), { code });
}

function isNullableSearchProviderKind(value: unknown): value is SearchProviderKind | null {
  return value === null || value === "opensearch" || value === "meilisearch";
}
