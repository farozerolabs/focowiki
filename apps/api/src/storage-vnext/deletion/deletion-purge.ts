import type { StorageVnextTerminalContext } from
  "../cleanup/terminal-convergence.js";
import { createStorageVnextDeletionCleanupCoordinator } from
  "./deletion-cleanup.js";
import type { StorageVnextDeletionKind } from "./ports.js";
import {
  isSearchProviderKind,
  type SearchProviderKind
} from "../../application/ports/search-provider-runtime.js";

export type StorageVnextDeletionPurgeScopePage = {
  sourceFilePublicIds: readonly string[];
  objectIds: readonly string[];
  nextCursor: string | null;
};

export type StorageVnextDeletionPurgeScope = {
  knowledgeBaseId: string;
  operationPublicId: string;
  targetKind: StorageVnextDeletionKind;
  targetPublicId: string;
  normalizedPath: string | null;
  cursor: string | null;
};

export type StorageVnextDeletionPurgePostgresPort = {
  readScopePage(input: StorageVnextDeletionPurgeScope & {
    limit: number;
  }): Promise<StorageVnextDeletionPurgeScopePage>;
  purgeSourceGraph(input: StorageVnextDeletionPurgeScope & {
    sourceFilePublicIds: readonly string[];
  }): Promise<void>;
  purgeKnowledgeBaseGraph(input: StorageVnextDeletionPurgeScope): Promise<void>;
  purgeSourceRelease(input: StorageVnextDeletionPurgeScope & {
    sourceFilePublicIds: readonly string[];
  }): Promise<void>;
  purgeKnowledgeBaseRelease(input: StorageVnextDeletionPurgeScope): Promise<void>;
  releaseSourceOwners(input: StorageVnextDeletionPurgeScope & {
    sourceFilePublicIds: readonly string[];
    objectIds: readonly string[];
  }): Promise<void>;
  releaseKnowledgeBaseOwners(input: StorageVnextDeletionPurgeScope & {
    objectIds: readonly string[];
  }): Promise<void>;
  purgeSourceCatalog(input: StorageVnextDeletionPurgeScope & {
    sourceFilePublicIds: readonly string[];
    finalPage: boolean;
  }): Promise<void>;
  purgeKnowledgeBaseCatalog(input: StorageVnextDeletionPurgeScope): Promise<void>;
  verifyDeletionClosure(input: StorageVnextDeletionPurgeScope): Promise<void>;
};

type DeletionPurgeInput = {
  processResources: {
    closeAll(input: { workPublicId: string }): Promise<unknown>;
  };
  coordination: {
    clearKnowledgeBaseRuntimeKeys(input: { knowledgeBaseId: string }): Promise<unknown>;
  };
  search: {
    deleteSourceScope(input: {
      knowledgeBaseId: string;
      operationPublicId: string;
      activeProviderKind: SearchProviderKind | null;
      activeProviderIndexUid: string | null;
      candidateProviderKind: SearchProviderKind | null;
      candidateProviderIndexUid: string | null;
      sourceFilePublicIds: readonly string[];
    }): Promise<{
      processedProviderKind: SearchProviderKind;
      remainingProviderKind: SearchProviderKind | null;
    }>;
    deleteKnowledgeBaseScope(input: {
      knowledgeBaseId: string;
      operationPublicId: string;
      activeProviderKind: SearchProviderKind | null;
      activeProviderIndexUid: string | null;
      candidateProviderKind: SearchProviderKind | null;
      candidateProviderIndexUid: string | null;
      finishedBefore: string;
      taskFrom: number | null;
    }): Promise<{
      deletedIndexes: number;
      deletedTasks: number;
      nextTaskFrom: number | null;
      processedProviderKind: SearchProviderKind;
      remainingProviderKind: SearchProviderKind | null;
    }>;
  };
  postgres: StorageVnextDeletionPurgePostgresPort;
  objects: {
    deleteZeroOwner(objectId: string): Promise<{
      deletedVersions: number;
      deletedMarkers: number;
      abortedMultipartUploads: number;
    }>;
  };
  maximumObjectsPerAttempt: number;
};

export function createStorageVnextDeletionPurgeCoordinator(
  input: DeletionPurgeInput
) {
  assertLimit(input.maximumObjectsPerAttempt);
  let currentPage: StorageVnextDeletionPurgeScopePage | null = null;
  const cleanup = createStorageVnextDeletionCleanupCoordinator({
    clean: async ({ context, resourceKind }) => {
      const state = readState(context);
      const scope = purgeScope(context, state);
      switch (resourceKind) {
        case "process_resource":
          await input.processResources.closeAll({ workPublicId: context.workPublicId });
          return completed();
        case "coordination":
          await input.coordination.clearKnowledgeBaseRuntimeKeys({
            knowledgeBaseId: context.knowledgeBaseId
          });
          return completed();
        case "unified_search_scope":
          if (state.targetKind === "knowledge_base") {
            const result = await input.search.deleteKnowledgeBaseScope({
              knowledgeBaseId: context.knowledgeBaseId,
              operationPublicId: context.workPublicId,
              activeProviderKind: state.activeProviderKind,
              activeProviderIndexUid: state.activeProviderIndexUid,
              candidateProviderKind: state.candidateProviderKind,
              candidateProviderIndexUid: state.candidateProviderIndexUid,
              finishedBefore: state.finishedBefore,
              taskFrom: state.taskFrom
            });
            if (result.nextTaskFrom !== null) {
              return {
                status: "retry" as const,
                reasonCode: "DELETION_SEARCH_TASK_PAGE_REMAINING",
                checkpoint: { taskFrom: result.nextTaskFrom }
              };
            }
            const continuation = providerContinuation(result, state);
            if (continuation) return continuation;
          } else {
            const page = await requirePage();
            if (page.sourceFilePublicIds.length > 0) {
              const result = await input.search.deleteSourceScope({
                knowledgeBaseId: context.knowledgeBaseId,
                operationPublicId: context.workPublicId,
                activeProviderKind: state.activeProviderKind,
                activeProviderIndexUid: state.activeProviderIndexUid,
                candidateProviderKind: state.candidateProviderKind,
                candidateProviderIndexUid: state.candidateProviderIndexUid,
                sourceFilePublicIds: page.sourceFilePublicIds
              });
              const continuation = providerContinuation(result, state);
              if (continuation) return continuation;
            }
          }
          return completed();
        case "graph_scope":
          if (state.targetKind === "knowledge_base") {
            await input.postgres.purgeKnowledgeBaseGraph(scope);
          } else {
            const page = await requirePage();
            await input.postgres.purgeSourceGraph({
              ...scope,
              sourceFilePublicIds: page.sourceFilePublicIds
            });
          }
          return completed();
        case "release_scope":
          if (state.targetKind === "knowledge_base") {
            return completed();
          } else {
            const page = await requirePage();
            try {
              await input.postgres.purgeSourceRelease({
                ...scope,
                sourceFilePublicIds: page.sourceFilePublicIds
              });
            } catch (error) {
              if (hasCode(error, "release_pending")) {
                return {
                  status: "retry" as const,
                  reasonCode: "DELETION_RELEASE_PENDING",
                  checkpoint: { cursor: state.cursor }
                };
              }
              throw error;
            }
          }
          return completed();
        case "object_owner": {
          const page = await requirePage();
          if (state.targetKind === "knowledge_base") {
            await input.postgres.releaseKnowledgeBaseOwners({
              ...scope,
              objectIds: page.objectIds
            });
          } else {
            await input.postgres.releaseSourceOwners({
              ...scope,
              sourceFilePublicIds: page.sourceFilePublicIds,
              objectIds: page.objectIds
            });
          }
          return completed();
        }
        case "object_body":
          return purgeObjectPage(await requirePage(), state.cursor);
        case "catalog_scope": {
          const page = await requirePage();
          if (state.targetKind === "knowledge_base") {
            if (page.nextCursor !== null) return remaining(page.nextCursor);
            await input.postgres.purgeKnowledgeBaseRelease(scope);
            await input.postgres.purgeKnowledgeBaseCatalog(scope);
          } else {
            await input.postgres.purgeSourceCatalog({
              ...scope,
              sourceFilePublicIds: page.sourceFilePublicIds,
              finalPage: page.nextCursor === null
            });
            if (page.nextCursor !== null) return remaining(page.nextCursor);
          }
          return completed();
        }
        case "deletion_claim":
          await input.postgres.verifyDeletionClosure(scope);
          return completed();
      }

      async function requirePage(): Promise<StorageVnextDeletionPurgeScopePage> {
        if (currentPage) return currentPage;
        const page = await input.postgres.readScopePage({
          ...scope,
          limit: input.maximumObjectsPerAttempt
        });
        assertPage(page, input.maximumObjectsPerAttempt);
        currentPage = page;
        return page;
      }
    }
  });
  return {
    async runAttempt(context: StorageVnextTerminalContext) {
      currentPage = null;
      try {
        return await cleanup.runAttempt(context);
      } finally {
        currentPage = null;
      }
    }
  };

  async function purgeObjectPage(
    page: StorageVnextDeletionPurgeScopePage,
    cursor: string | null
  ) {
    let deletedVersions = 0;
    let deletedMarkers = 0;
    let abortedMultipartUploads = 0;
    let sharedObjects = 0;
    for (const objectId of page.objectIds) {
      try {
        const result = await input.objects.deleteZeroOwner(objectId);
        deletedVersions += result.deletedVersions;
        deletedMarkers += result.deletedMarkers;
        abortedMultipartUploads += result.abortedMultipartUploads;
      } catch (error) {
        if (hasCode(error, "owners_present")) {
          sharedObjects += 1;
          continue;
        }
        return {
          status: "retry" as const,
          reasonCode: objectFailureReason(error),
          checkpoint: {
            cursor,
            deletedVersions,
            deletedMarkers,
            abortedMultipartUploads,
            sharedObjects
          }
        };
      }
    }
    return completed({
      deletedVersions,
      deletedMarkers,
      abortedMultipartUploads,
      sharedObjects
    });
  }
}

function readState(context: StorageVnextTerminalContext) {
  const value = context.checkpoint;
  const targetKind = value.targetKind;
  if (!isTargetKind(targetKind)) throw purgeError("invalid_input");
  return {
    targetKind,
    targetPublicId: requiredString(value.targetPublicId),
    normalizedPath: nullableString(value.normalizedPath),
    activeProviderKind: nullableProviderKind(value.activeSearchProviderKind),
    activeProviderIndexUid: nullableString(value.activeSearchProviderIndexUid),
    candidateProviderKind: nullableProviderKind(value.candidateSearchProviderKind),
    candidateProviderIndexUid: nullableString(value.candidateSearchProviderIndexUid),
    finishedBefore: optionalString(value.finishedBefore) ?? context.completedAt,
    taskFrom: nullableOrdinal(value.taskFrom),
    cursor: nullableString(value.cursor)
  };
}

function providerContinuation(
  result: {
    processedProviderKind: SearchProviderKind;
    remainingProviderKind: SearchProviderKind | null;
  },
  state: ReturnType<typeof readState>
) {
  if (result.remainingProviderKind === null) return null;
  const checkpoint: Record<string, string | null> = {
    requiredSearchProviderKind: result.remainingProviderKind
  };
  if (state.activeProviderKind === result.processedProviderKind) {
    checkpoint.activeSearchProviderKind = null;
    checkpoint.activeSearchProviderIndexUid = null;
  }
  if (state.candidateProviderKind === result.processedProviderKind) {
    checkpoint.candidateSearchProviderKind = null;
    checkpoint.candidateSearchProviderIndexUid = null;
  }
  return {
    status: "retry" as const,
    reasonCode: "DELETION_SEARCH_PROVIDER_REQUIRED",
    checkpoint
  };
}

function nullableProviderKind(value: unknown): SearchProviderKind | null {
  if (value === null || value === undefined) return null;
  if (!isSearchProviderKind(value)) throw purgeError("invalid_input");
  return value;
}

function purgeScope(
  context: StorageVnextTerminalContext,
  state: ReturnType<typeof readState>
): StorageVnextDeletionPurgeScope {
  return {
    knowledgeBaseId: context.knowledgeBaseId,
    operationPublicId: context.workPublicId,
    targetKind: state.targetKind,
    targetPublicId: state.targetPublicId,
    normalizedPath: state.normalizedPath,
    cursor: state.cursor
  };
}

function assertPage(page: StorageVnextDeletionPurgeScopePage, limit: number): void {
  if (
    page.objectIds.length > limit
    || page.sourceFilePublicIds.length > limit
    || page.objectIds.some((value) => !validId(value))
    || page.sourceFilePublicIds.some((value) => !validId(value))
    || (page.nextCursor !== null && !validId(page.nextCursor))
  ) throw purgeError("invalid_input");
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw purgeError("invalid_configuration");
  }
}

function remaining(cursor: string) {
  return {
    status: "retry" as const,
    reasonCode: "DELETION_SCOPE_PAGE_REMAINING",
    checkpoint: { cursor }
  };
}

function completed(
  checkpoint: Record<string, boolean | number | string | null> = {}
) {
  return { status: "completed" as const, reasonCode: null, checkpoint };
}

function objectFailureReason(error: unknown): string {
  if (hasCode(error, "provider_delete_failed")) {
    return "OBJECT_PROVIDER_DELETE_FAILED";
  }
  if (hasCode(error, "provider_residue")) return "OBJECT_PROVIDER_RESIDUE";
  return "OBJECT_PROVIDER_UNAVAILABLE";
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isTargetKind(value: unknown): value is StorageVnextDeletionKind {
  return value === "source_file"
    || value === "source_directory"
    || value === "knowledge_base";
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value);
}

function nullableString(value: unknown): string | null {
  return optionalString(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !validId(value)) throw purgeError("invalid_input");
  return value;
}

function validId(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value) <= 255 && !value.includes("\0");
}

function nullableOrdinal(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw purgeError("invalid_input");
  return Number(value);
}

function purgeError(code: string): Error {
  return Object.assign(new Error(`Storage vNext deletion purge error: ${code}`), { code });
}
