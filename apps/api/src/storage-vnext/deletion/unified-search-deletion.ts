import type {
  SearchEngineFinishedTaskPage,
  SearchEngineTask,
  SearchEngineTransport
} from "../../application/ports/search-engine-transport.js";
import { createStorageVnextSearchKnowledgeBaseIndexUidPrefix } from
  "../search/candidate-identity.js";

type UnifiedSearchDeletionTransport = Pick<
  SearchEngineTransport,
  "deleteDocuments" | "deleteIndex" | "getIndex" | "getTask"
> & Pick<SearchEngineTransport, "deleteFinishedTasks" | "listFinishedTasks">;

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
  transport: UnifiedSearchDeletionTransport;
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
      activeProviderIndexUid: string | null;
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
      const exactTaskUids: number[] = [];
      if (
        request.activeProviderIndexUid
        && await input.transport.getIndex({
          indexUid: request.activeProviderIndexUid
        })
      ) {
        const task = await input.transport.deleteDocuments({
          indexUid: request.activeProviderIndexUid,
          filter: sourceScopeFilter(request.knowledgeBaseId, sourceFilePublicIds),
          correlation: `deletion-documents:${request.operationPublicId}`
        });
        await pollTask(task.taskUid);
        exactTaskUids.push(task.taskUid);
        deletedDocuments = true;
      }
      const candidate = request.candidateProviderIndexUid;
      const indexDeletion = candidate && candidate !== request.activeProviderIndexUid
        ? await deleteIndexes([candidate])
        : emptyIndexDeletion();
      exactTaskUids.push(...indexDeletion.taskUids);
      const deletedTasks = await removeFinishedTaskUids(exactTaskUids);
      return {
        deletedDocuments,
        deletedIndexes: indexDeletion.deletedIndexes,
        deletedTasks
      };
    },

    async deleteKnowledgeBaseScope(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      activeProviderIndexUid: string | null;
      candidateProviderIndexUid: string | null;
      finishedBefore: string;
      taskFrom: number | null;
    }) {
      validateBaseRequest(request);
      assertTimestamp(request.finishedBefore);
      if (request.taskFrom !== null) assertOrdinal(request.taskFrom);
      const providerIndexUids = unique([
        request.activeProviderIndexUid,
        request.candidateProviderIndexUid
      ].filter((value): value is string => Boolean(value)));
      if (providerIndexUids.length > 2) throw deletionError("invalid_input");
      const providerIndexUidPrefix = createStorageVnextSearchKnowledgeBaseIndexUidPrefix({
        indexUidPrefix: input.indexUidPrefix,
        knowledgeBaseId: request.knowledgeBaseId
      });
      const indexDeletion = await deleteIndexes(providerIndexUids);
      const { deletedTasks, nextTaskFrom } = await deleteFinishedTasks({
        providerIndexUids,
        providerIndexUidPrefix,
        finishedBefore: request.finishedBefore,
        taskFrom: request.taskFrom,
        exactTaskUids: indexDeletion.taskUids
      });
      return {
        deletedIndexes: indexDeletion.deletedIndexes,
        deletedTasks,
        nextTaskFrom
      };
    }
  };

  async function deleteIndexes(providerIndexUids: readonly string[]): Promise<{
    deletedIndexes: number;
    taskUids: number[];
  }> {
    let deleted = 0;
    const taskUids: number[] = [];
    for (const providerIndexUid of providerIndexUids) {
      assertIdentifier(providerIndexUid);
      if (!await input.transport.getIndex({ indexUid: providerIndexUid })) continue;
      const task = await input.transport.deleteIndex(providerIndexUid);
      await pollTask(task.taskUid);
      taskUids.push(task.taskUid);
      deleted += 1;
    }
    return { deletedIndexes: deleted, taskUids };
  }

  async function deleteFinishedTasks(request: {
    providerIndexUids: readonly string[];
    providerIndexUidPrefix: string;
    finishedBefore: string;
    taskFrom: number | null;
    exactTaskUids: readonly number[];
  }): Promise<{ deletedTasks: number; nextTaskFrom: number | null }> {
    const listFinishedTasks = input.transport.listFinishedTasks;
    const removeFinishedTasks = input.transport.deleteFinishedTasks;
    if (!listFinishedTasks || !removeFinishedTasks) {
      throw deletionError("provider_contract_unavailable");
    }
    const page = await listFinishedTasks({
      statuses: ["succeeded", "failed", "canceled"],
      beforeFinishedAt: request.finishedBefore,
      from: request.taskFrom,
      limit: input.taskPageSize
    });
    validateTaskPage(page, request.finishedBefore);
    const retained = new Set(request.providerIndexUids);
    const taskUids = unique([
      ...page.tasks
      .filter((task) => task.indexUid !== null && (
        retained.has(task.indexUid)
        || task.indexUid.startsWith(request.providerIndexUidPrefix)
      ))
      .map((task) => task.taskUid),
      ...request.exactTaskUids
    ]);
    await removeFinishedTaskUids(taskUids);
    return { deletedTasks: taskUids.length, nextTaskFrom: page.next };
  }

  async function removeFinishedTaskUids(taskUids: readonly number[]): Promise<number> {
    const uniqueTaskUids = unique([...taskUids]);
    if (uniqueTaskUids.length === 0) return 0;
    uniqueTaskUids.forEach(assertOrdinal);
    const removeFinishedTasks = input.transport.deleteFinishedTasks;
    if (!removeFinishedTasks) throw deletionError("provider_contract_unavailable");
    const task = await removeFinishedTasks({ taskUids: uniqueTaskUids });
    await pollTask(task.taskUid);
    return uniqueTaskUids.length;
  }

  async function pollTask(taskUid: number): Promise<void> {
    assertOrdinal(taskUid);
    for (let attempt = 1; attempt <= input.maximumPollAttempts; attempt += 1) {
      const task = await input.transport.getTask(taskUid);
      validateTask(task);
      if (task.status === "succeeded") return;
      if (task.status === "failed" || task.status === "canceled") {
        throw deletionError("provider_task_failed");
      }
      if (attempt < input.maximumPollAttempts) await sleep();
    }
    throw deletionError("provider_task_timeout");
  }
}

function emptyIndexDeletion(): { deletedIndexes: number; taskUids: number[] } {
  return { deletedIndexes: 0, taskUids: [] };
}

function sourceScopeFilter(
  knowledgeBaseId: string,
  sourceFilePublicIds: readonly string[]
): string {
  return [
    `knowledgeBaseId = ${JSON.stringify(knowledgeBaseId)}`,
    `sourceFilePublicId IN [${sourceFilePublicIds
      .map((publicId) => JSON.stringify(publicId)).join(", ")}]`
  ].join(" AND ");
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
  activeProviderIndexUid: string | null;
  candidateProviderIndexUid: string | null;
}): void {
  assertIdentifier(request.knowledgeBaseId);
  assertIdentifier(request.operationPublicId);
  if (request.activeProviderIndexUid) assertIdentifier(request.activeProviderIndexUid);
  if (request.candidateProviderIndexUid) {
    assertIdentifier(request.candidateProviderIndexUid);
  }
}

function validateTaskPage(
  page: SearchEngineFinishedTaskPage,
  finishedBefore: string
): void {
  if (page.next !== null) assertOrdinal(page.next);
  for (const task of page.tasks) {
    assertOrdinal(task.taskUid);
    const finishedAt = Date.parse(task.finishedAt);
    if (
      !["succeeded", "failed", "canceled"].includes(task.status)
      || !Number.isFinite(finishedAt)
      || finishedAt > Date.parse(finishedBefore)
    ) throw deletionError("invalid_input");
  }
}

function validateTask(task: SearchEngineTask): void {
  assertOrdinal(task.taskUid);
  if (![
    "enqueued",
    "processing",
    "succeeded",
    "failed",
    "canceled",
    "unknown"
  ].includes(task.status)) throw deletionError("invalid_input");
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
