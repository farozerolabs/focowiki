import type {
  SearchFilterExpression,
  SearchProviderOperationReceipt,
  SearchProviderRuntime,
  SearchProviderKind
} from "../../application/ports/search-provider-runtime.js";
import { isSearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";
import { createStorageVnextSearchKnowledgeBaseIndexUidPrefix } from
  "../search/candidate-identity.js";

const MAXIMUM_POLL_ATTEMPTS = 36_000;

export type StorageVnextUnifiedSearchDeletionErrorCode =
  | "invalid_configuration"
  | "invalid_input"
  | "provider_contract_unavailable"
  | "provider_task_failed"
  | "provider_task_timeout";

export class StorageVnextUnifiedSearchDeletionError extends Error {
  public constructor(public readonly code: StorageVnextUnifiedSearchDeletionErrorCode) {
    super(`Storage vNext unified search deletion error: ${code}`);
    this.name = "StorageVnextUnifiedSearchDeletionError";
  }
}

export function createStorageVnextUnifiedSearchDeletion(input: {
  provider: SearchProviderRuntime;
  indexUidPrefix: string;
  maximumPollAttempts: number;
  maximumSourceFiles: number;
  taskPageSize: number;
  sleep?: () => Promise<void>;
}) {
  validateConfiguration(input);
  const sleep = input.sleep ?? (() => Promise.resolve());
  return {
    async deleteSourceScope(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      activeProviderKind: SearchProviderKind | null;
      activeProviderIndexUid: string | null;
      candidateProviderKind: SearchProviderKind | null;
      candidateProviderIndexUid: string | null;
      sourceFilePublicIds: readonly string[];
    }) {
      validateBaseRequest(request);
      const sourceFilePublicIds = unique(request.sourceFilePublicIds);
      if (
        sourceFilePublicIds.length < 1
        || sourceFilePublicIds.length > input.maximumSourceFiles
      ) throw deletionError("invalid_input");
      sourceFilePublicIds.forEach(assertIdentifier);
      let deletedDocuments = false;
      if (
        request.activeProviderKind === input.provider.kind
        && request.activeProviderIndexUid
        && await input.provider.admin.getIndex({
          indexUid: request.activeProviderIndexUid
        })
      ) {
        const operation = await input.provider.write.deleteDocuments({
          indexUid: request.activeProviderIndexUid,
          filters: sourceScopeFilter(request.knowledgeBaseId, sourceFilePublicIds),
          correlation: `deletion-documents:${request.operationPublicId}`
        });
        await pollOperation(operation);
        deletedDocuments = true;
      }
      const candidate = request.candidateProviderKind === input.provider.kind
        ? request.candidateProviderIndexUid
        : null;
      const indexDeletion = candidate && (
        request.activeProviderKind !== input.provider.kind
        || candidate !== request.activeProviderIndexUid
      )
        ? await deleteIndexes([candidate])
        : emptyIndexDeletion();
      return {
        deletedDocuments,
        deletedIndexes: indexDeletion.deletedIndexes,
        deletedTasks: 0,
        processedProviderKind: input.provider.kind,
        remainingProviderKind: remainingProviderKind(request)
      };
    },

    async deleteKnowledgeBaseScope(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      activeProviderKind: SearchProviderKind | null;
      activeProviderIndexUid: string | null;
      candidateProviderKind: SearchProviderKind | null;
      candidateProviderIndexUid: string | null;
      finishedBefore: string;
      taskFrom: number | null;
    }) {
      validateBaseRequest(request);
      assertTimestamp(request.finishedBefore);
      if (request.taskFrom !== null) assertOrdinal(request.taskFrom);
      const providerIndexUids = unique([
        request.activeProviderKind === input.provider.kind
          ? request.activeProviderIndexUid
          : null,
        request.candidateProviderKind === input.provider.kind
          ? request.candidateProviderIndexUid
          : null
      ].filter((value): value is string => Boolean(value)));
      if (providerIndexUids.length > 2) throw deletionError("invalid_input");
      createStorageVnextSearchKnowledgeBaseIndexUidPrefix({
        indexUidPrefix: input.indexUidPrefix,
        knowledgeBaseId: request.knowledgeBaseId
      });
      const indexDeletion = await deleteIndexes(providerIndexUids);
      return {
        deletedIndexes: indexDeletion.deletedIndexes,
        deletedTasks: 0,
        nextTaskFrom: null,
        processedProviderKind: input.provider.kind,
        remainingProviderKind: remainingProviderKind(request)
      };
    }
  };

  async function deleteIndexes(providerIndexUids: readonly string[]): Promise<{
    deletedIndexes: number;
  }> {
    let deleted = 0;
    for (const providerIndexUid of providerIndexUids) {
      assertIdentifier(providerIndexUid);
      if (!await input.provider.admin.getIndex({ indexUid: providerIndexUid })) continue;
      const operation = await input.provider.admin.deleteIndex({
        indexUid: providerIndexUid
      });
      await pollOperation(operation);
      deleted += 1;
    }
    return { deletedIndexes: deleted };
  }

  async function pollOperation(
    receipt: SearchProviderOperationReceipt
  ): Promise<void> {
    if (receipt.state === "completed") return;
    for (let attempt = 1; attempt <= input.maximumPollAttempts; attempt += 1) {
      const operation = await input.provider.operations.getOperation({
        operationRef: receipt.operationRef
      });
      if (operation.state === "completed") return;
      if (operation.state === "failed") {
        throw deletionError("provider_task_failed");
      }
      if (attempt < input.maximumPollAttempts) await sleep();
    }
    throw deletionError("provider_task_timeout");
  }

  function remainingProviderKind(request: {
    activeProviderKind: SearchProviderKind | null;
    candidateProviderKind: SearchProviderKind | null;
  }): SearchProviderKind | null {
    return [request.activeProviderKind, request.candidateProviderKind]
      .find((providerKind) => providerKind !== null
        && providerKind !== input.provider.kind) ?? null;
  }
}

function emptyIndexDeletion(): { deletedIndexes: number } {
  return { deletedIndexes: 0 };
}

function sourceScopeFilter(
  knowledgeBaseId: string,
  sourceFilePublicIds: readonly string[]
): SearchFilterExpression {
  return {
    kind: "and",
    operands: [{
      kind: "equals",
      field: "knowledgeBaseId",
      value: knowledgeBaseId
    }, {
      kind: "or",
      operands: sourceFilePublicIds.map((publicId) => ({
        kind: "equals" as const,
        field: "sourceFilePublicId" as const,
        value: publicId
      }))
    }]
  };
}

function validateConfiguration(input: {
  indexUidPrefix: string;
  maximumPollAttempts: number;
  maximumSourceFiles: number;
  taskPageSize: number;
}): void {
  try {
    createStorageVnextSearchKnowledgeBaseIndexUidPrefix({
      indexUidPrefix: input.indexUidPrefix,
      knowledgeBaseId: "configuration-validation"
    });
  } catch {
    throw deletionError("invalid_configuration");
  }
  if (
    !Number.isSafeInteger(input.maximumPollAttempts)
    || input.maximumPollAttempts < 1
    || input.maximumPollAttempts > MAXIMUM_POLL_ATTEMPTS
  ) {
    throw deletionError("invalid_configuration");
  }
  for (const value of [input.maximumSourceFiles, input.taskPageSize]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
      throw deletionError("invalid_configuration");
    }
  }
}

function validateBaseRequest(request: {
  knowledgeBaseId: string;
  operationPublicId: string;
  activeProviderKind: SearchProviderKind | null;
  activeProviderIndexUid: string | null;
  candidateProviderKind: SearchProviderKind | null;
  candidateProviderIndexUid: string | null;
}): void {
  assertIdentifier(request.knowledgeBaseId);
  assertIdentifier(request.operationPublicId);
  assertOwnedIndex(request.activeProviderKind, request.activeProviderIndexUid);
  assertOwnedIndex(request.candidateProviderKind, request.candidateProviderIndexUid);
}

function assertOwnedIndex(
  providerKind: SearchProviderKind | null,
  providerIndexUid: string | null
): void {
  if ((providerKind === null) !== (providerIndexUid === null)) {
    throw deletionError("invalid_input");
  }
  if (providerKind !== null && !isSearchProviderKind(providerKind)) {
    throw deletionError("invalid_input");
  }
  if (providerIndexUid !== null) assertIdentifier(providerIndexUid);
}

function assertIdentifier(value: string): void {
  if (!value || Buffer.byteLength(value) > 255 || value.includes("\0")) {
    throw deletionError("invalid_input");
  }
}

function assertTimestamp(value: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) throw deletionError("invalid_input");
}

function assertOrdinal(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw deletionError("invalid_input");
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function deletionError(
  code: StorageVnextUnifiedSearchDeletionErrorCode
): StorageVnextUnifiedSearchDeletionError {
  return new StorageVnextUnifiedSearchDeletionError(code);
}
