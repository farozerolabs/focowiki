import type {
  SearchProviderKind,
  SearchProviderOperationReceipt,
  SearchProviderVectorPort
} from "../../application/ports/search-provider-runtime.js";
import { semanticVectorIndexUid } from "../vector/projection-planner.js";

export type SemanticDeletionPage = {
  items: readonly {
    semanticGenerationPublicId: string;
    mappingFingerprintSha256: string;
    searchProviderKind: SearchProviderKind;
    documentIds: readonly string[];
  }[];
  nextCursor: string | null;
};

export type SemanticDeletionRepositoryPort = {
  cancelSourceWork(input: {
    knowledgeBaseId: string;
    sourceFilePublicIds: readonly string[];
    requestedAt: string;
  }): Promise<number>;
  hasRunningSourceWork(input: {
    knowledgeBaseId: string;
    sourceFilePublicIds: readonly string[];
  }): Promise<boolean>;
  hasRunningKnowledgeBaseWork(input: {
    knowledgeBaseId: string;
  }): Promise<boolean>;
  deferUnavailableSourceVectors(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    sourceFilePublicIds: readonly string[];
    selectedProviderKind: SearchProviderKind;
    notBefore: string;
  }): Promise<number>;
  listSourceVectorPage(input: {
    knowledgeBaseId: string;
    sourceFilePublicIds: readonly string[];
    selectedProviderKind: SearchProviderKind;
    cursor: string | null;
    limit: number;
  }): Promise<SemanticDeletionPage>;
  listKnowledgeBaseGenerationPage(input: {
    knowledgeBaseId: string;
    selectedProviderKind: SearchProviderKind;
    cursor: string | null;
    limit: number;
  }): Promise<{
    items: readonly {
      semanticGenerationPublicId: string;
      mappingFingerprintSha256: string;
      searchProviderKind: SearchProviderKind;
    }[];
    nextCursor: string | null;
    remainingProviderKind: SearchProviderKind | null;
  }>;
  purgeSourceState(input: {
    knowledgeBaseId: string;
    sourceFilePublicIds: readonly string[];
    deletedAt: string;
  }): Promise<void>;
  cancelKnowledgeBaseWork(input: {
    knowledgeBaseId: string;
    requestedAt: string;
  }): Promise<number>;
};

export function createSemanticDeletionService(input: {
  repository: SemanticDeletionRepositoryPort;
  provider: SearchProviderVectorPort;
  selectedProviderKind: SearchProviderKind;
  indexPrefix: string;
  pageSize: number;
  maximumOperationPolls: number;
  operationPollIntervalMs: number;
  wait?: (milliseconds: number) => Promise<void>;
  clock?: () => string;
}) {
  assertLimits(input);
  const wait = input.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const clock = input.clock ?? (() => new Date().toISOString());
  return {
    async deleteSourceScope(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      sourceFilePublicIds: readonly string[];
      cursor: string | null;
    }) {
      await input.repository.cancelSourceWork({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicIds: request.sourceFilePublicIds,
        requestedAt: clock()
      });
      if (await input.repository.hasRunningSourceWork({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicIds: request.sourceFilePublicIds
      })) {
        return { outcome: "blocked" as const, nextCursor: request.cursor };
      }
      await input.repository.deferUnavailableSourceVectors({
        knowledgeBaseId: request.knowledgeBaseId,
        operationPublicId: request.operationPublicId,
        sourceFilePublicIds: request.sourceFilePublicIds,
        selectedProviderKind: input.selectedProviderKind,
        notBefore: clock()
      });
      const page = await input.repository.listSourceVectorPage({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicIds: request.sourceFilePublicIds,
        selectedProviderKind: input.selectedProviderKind,
        cursor: request.cursor,
        limit: input.pageSize
      });
      for (const item of page.items) {
        assertProvider(item.searchProviderKind);
        if (item.documentIds.length > 0) {
          await awaitReceipt(await input.provider.deleteDocuments({
            indexUid: indexUid(request.knowledgeBaseId, item),
            knowledgeBaseId: request.knowledgeBaseId,
            semanticGenerationPublicId: item.semanticGenerationPublicId,
            documentIds: item.documentIds,
            correlation: `${request.operationPublicId}:semantic-source-delete`
          }));
        }
      }
      if (page.nextCursor !== null) {
        return { outcome: "continue" as const, nextCursor: page.nextCursor };
      }
      await input.repository.purgeSourceState({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicIds: request.sourceFilePublicIds,
        deletedAt: clock()
      });
      return { outcome: "completed" as const, nextCursor: null };
    },

    async deleteKnowledgeBaseScope(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      cursor: string | null;
      completedProviderKind: SearchProviderKind | null;
    }) {
      await input.repository.cancelKnowledgeBaseWork({
        knowledgeBaseId: request.knowledgeBaseId,
        requestedAt: clock()
      });
      if (await input.repository.hasRunningKnowledgeBaseWork({
        knowledgeBaseId: request.knowledgeBaseId
      })) {
        return { outcome: "blocked" as const, nextCursor: request.cursor };
      }
      const page = await input.repository.listKnowledgeBaseGenerationPage({
        knowledgeBaseId: request.knowledgeBaseId,
        selectedProviderKind: input.selectedProviderKind,
        cursor: request.cursor,
        limit: Math.min(input.pageSize, 100)
      });
      for (const item of page.items) {
        assertProvider(item.searchProviderKind);
        const targetIndexUid = indexUid(request.knowledgeBaseId, item);
        if (await input.provider.getIndexDefinition({ indexUid: targetIndexUid }) === null) {
          continue;
        }
        await awaitReceipt(await input.provider.deleteIndex({
          indexUid: targetIndexUid,
          correlation: `${request.operationPublicId}:semantic-index-delete`
        }));
      }
      if (page.nextCursor !== null) {
        return { outcome: "continue" as const, nextCursor: page.nextCursor };
      }
      if (
        page.remainingProviderKind !== null
        && page.remainingProviderKind !== request.completedProviderKind
      ) {
        return {
          outcome: "provider_required" as const,
          nextCursor: null,
          completedProviderKind: input.selectedProviderKind,
          requiredProviderKind: page.remainingProviderKind
        };
      }
      return { outcome: "completed" as const, nextCursor: null };
    }
  };

  function indexUid(
    knowledgeBaseId: string,
    item: {
      semanticGenerationPublicId: string;
      mappingFingerprintSha256: string;
    }
  ): string {
    return semanticVectorIndexUid({
      indexPrefix: input.indexPrefix,
      knowledgeBaseId,
      semanticGenerationPublicId: item.semanticGenerationPublicId,
      mappingFingerprintSha256: item.mappingFingerprintSha256
    });
  }

  function assertProvider(value: SearchProviderKind): void {
    if (value !== input.selectedProviderKind) {
      throw Object.assign(
        deletionError("semantic_search_provider_required", true),
        { requiredProviderKind: value }
      );
    }
  }

  async function awaitReceipt(receipt: SearchProviderOperationReceipt): Promise<void> {
    if (receipt.state === "completed") return;
    for (let poll = 0; poll < input.maximumOperationPolls; poll += 1) {
      const status = await input.provider.getOperation({
        operationRef: receipt.operationRef
      });
      if (status.state === "completed") return;
      if (status.state === "failed") {
        throw deletionError("semantic_provider_delete_failed", true);
      }
      if (poll + 1 < input.maximumOperationPolls) {
        await wait(input.operationPollIntervalMs);
      }
    }
    throw deletionError("semantic_provider_delete_timeout", true);
  }
}

function assertLimits(input: {
  pageSize: number;
  maximumOperationPolls: number;
  operationPollIntervalMs: number;
}): void {
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1
    || input.pageSize > 1_000
    || !Number.isSafeInteger(input.maximumOperationPolls)
    || input.maximumOperationPolls < 1 || input.maximumOperationPolls > 10_000
    || !Number.isSafeInteger(input.operationPollIntervalMs)
    || input.operationPollIntervalMs < 0
    || input.operationPollIntervalMs > 30_000) {
    throw deletionError("semantic_deletion_limits_invalid", false);
  }
}

function deletionError(code: string, retryable: boolean): Error & {
  code: string;
  retryable: boolean;
} {
  return Object.assign(new Error(`Semantic deletion failed: ${code}`), {
    code,
    retryable
  });
}
