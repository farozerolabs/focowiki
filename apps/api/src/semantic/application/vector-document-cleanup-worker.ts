import type {
  SearchProviderKind,
  SearchProviderOperationReceipt,
  SearchProviderVectorPort
} from "../../application/ports/search-provider-runtime.js";
import { semanticVectorIndexUid } from "../vector/projection-planner.js";

const ACTION_KIND = "semantic_vector_document_cleanup";
const RESOURCE_KIND = "semantic_vector_document";
const MAXIMUM_CLAIM = 100;
const MAXIMUM_REQUEST = 1_000;

type ClaimedAction = {
  publicId: string;
  operationPublicId: string;
  knowledgeBaseId: string;
  domain: string;
  searchProviderKind: SearchProviderKind | null;
  target: {
    plane: string;
    resourceKind: string;
    publicId: string;
  };
  checkpoint: Record<string, boolean | number | string | null>;
};

type CleanupActions = {
  claim(input: {
    owner: string;
    limit: number;
    leaseExpiresAt: string;
    selector: {
      domain: string;
      plane: "search";
      resourceKind: string;
      searchProviderKind: SearchProviderKind;
    };
  }): Promise<readonly ClaimedAction[]>;
  complete(input: { publicId: string; owner: string }): Promise<boolean>;
  releaseForRetry(input: {
    publicId: string;
    owner: string;
    notBefore: string;
    safeErrorCode: string;
    checkpoint: Record<string, boolean | number | string | null>;
  }): Promise<void>;
};

type CleanupGroup = {
  knowledgeBaseId: string;
  semanticGenerationPublicId: string;
  mappingFingerprintSha256: string;
  actions: ClaimedAction[];
};

export function createSemanticVectorDocumentCleanupWorker(input: {
  actions: CleanupActions;
  provider: {
    kind: SearchProviderKind;
    vector: Pick<
      SearchProviderVectorPort,
      "deleteDocuments" | "getIndexDefinition" | "getOperation"
    >;
  };
  indexPrefix: string;
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
      const actions = await input.actions.claim({
        ...request,
        limit: Math.min(request.limit, MAXIMUM_CLAIM),
        selector: {
          domain: ACTION_KIND,
          plane: "search",
          resourceKind: RESOURCE_KIND,
          searchProviderKind: input.provider.kind
        }
      });
      const groups = groupActions(actions, input.provider.kind);
      let completed = 0;
      let retried = 0;
      for (const group of groups) {
        let completedInGroup = 0;
        try {
          const indexUid = semanticVectorIndexUid({
            indexPrefix: input.indexPrefix,
            knowledgeBaseId: group.knowledgeBaseId,
            semanticGenerationPublicId: group.semanticGenerationPublicId,
            mappingFingerprintSha256: group.mappingFingerprintSha256
          });
          const definition = await input.provider.vector.getIndexDefinition({
            indexUid
          });
          if (definition === null) {
            await completeGroup();
            continue;
          }
          const receipt = await input.provider.vector.deleteDocuments({
            indexUid,
            knowledgeBaseId: group.knowledgeBaseId,
            semanticGenerationPublicId: group.semanticGenerationPublicId,
            documentIds: [...new Set(group.actions.map(providerDocumentId))],
            correlation: `${group.actions[0]!.operationPublicId}:vector-cleanup`
          });
          await convergeOperation(receipt, indexUid);
          await completeGroup();
        } catch {
          const retryAt = new Date(now().getTime() + input.retryDelayMs)
            .toISOString();
          for (const action of group.actions.slice(completedInGroup)) {
            await input.actions.releaseForRetry({
              publicId: action.publicId,
              owner: request.owner,
              notBefore: retryAt,
              safeErrorCode: "SEMANTIC_VECTOR_DOCUMENT_CLEANUP_FAILED",
              checkpoint: action.checkpoint
            });
            retried += 1;
          }
        }

        async function completeGroup(): Promise<void> {
          for (const action of group.actions) {
            if (!await input.actions.complete({
              publicId: action.publicId,
              owner: request.owner
            })) throw cleanupError("lease_lost");
            completed += 1;
            completedInGroup += 1;
          }
        }
      }
      return { claimed: actions.length, completed, retried };
    }
  };

  async function convergeOperation(
    receipt: SearchProviderOperationReceipt,
    indexUid: string
  ): Promise<void> {
    if (receipt.state === "completed") return;
    for (let attempt = 1; attempt <= input.maxPollAttempts; attempt += 1) {
      const status = await input.provider.vector.getOperation({
        operationRef: receipt.operationRef
      });
      if (status.state === "completed") return;
      if (status.state === "failed") {
        const definition = await input.provider.vector.getIndexDefinition({
          indexUid
        });
        if (definition === null) return;
        throw cleanupError("provider_operation_failed");
      }
      if (attempt < input.maxPollAttempts) await sleep(input.pollIntervalMs);
    }
    throw cleanupError("provider_operation_timeout");
  }
}

function groupActions(
  actions: readonly ClaimedAction[],
  providerKind: SearchProviderKind
): CleanupGroup[] {
  const groups = new Map<string, CleanupGroup>();
  for (const action of actions) {
    const semanticGenerationPublicId = checkpointString(
      action.checkpoint.semanticGenerationPublicId
    );
    const mappingFingerprintSha256 = checkpointString(
      action.checkpoint.mappingFingerprintSha256
    );
    if (
      action.domain !== ACTION_KIND
      || action.searchProviderKind !== providerKind
      || action.target.plane !== "search"
      || action.target.resourceKind !== RESOURCE_KIND
      || !/^[0-9a-f]{64}$/u.test(mappingFingerprintSha256)
    ) throw cleanupError("ownership_conflict");
    const key = [
      action.knowledgeBaseId,
      semanticGenerationPublicId,
      mappingFingerprintSha256
    ].join("\0");
    const group = groups.get(key) ?? {
      knowledgeBaseId: action.knowledgeBaseId,
      semanticGenerationPublicId,
      mappingFingerprintSha256,
      actions: []
    };
    group.actions.push(action);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function providerDocumentId(action: ClaimedAction): string {
  return checkpointString(
    action.checkpoint.providerDocumentId ?? action.target.publicId
  );
}

function checkpointString(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 4_096) {
    throw cleanupError("ownership_conflict");
  }
  return value;
}

function validateConfiguration(input: {
  indexPrefix: string;
  maxPollAttempts: number;
  pollIntervalMs: number;
  retryDelayMs: number;
}): void {
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(input.indexPrefix)
    || !Number.isSafeInteger(input.maxPollAttempts)
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
    || input.limit > MAXIMUM_REQUEST
    || !Number.isFinite(Date.parse(input.leaseExpiresAt))
  ) throw cleanupError("invalid_input");
}

function cleanupError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Semantic vector document cleanup failed: ${code}`),
    { code }
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
