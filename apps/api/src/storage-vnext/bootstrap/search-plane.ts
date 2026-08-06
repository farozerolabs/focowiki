import type { StorageVnextOwnedScopeProof } from "../lifecycle/ports.js";
import type {
  StorageVnextOwnedPlaneInspection,
  StorageVnextResetBootstrapPlane
} from "./command.js";
import {
  createStorageVnextOwnerMarkerDocument,
  type StorageVnextOwnerMarkerDocument
} from "./owner-marker.js";
import { StorageVnextOwnedScopeError, validateStorageVnextOwnedScopeProof } from "./owned-scope.js";
import { assertStorageVnextOwnedPlane } from "./plane-safety.js";

type SearchTask = {
  uid: number;
  status: "enqueued" | "processing" | "succeeded" | "failed" | "canceled";
};

type EnqueuedSearchTask = { taskUid: number };

export type StorageVnextOwnedSearchClient = {
  getRawIndexes(input: { limit: number; offset: number }): Promise<{
    results: Array<{ uid: string }>;
    total: number;
  }>;
  deleteIndex(indexUid: string): Promise<EnqueuedSearchTask>;
  tasks: {
    getTasks(input: { uids: number[]; limit: number }): Promise<{ results: SearchTask[] }>;
    cancelTasks(input: { uids: number[] }): Promise<EnqueuedSearchTask>;
    deleteTasks(input: { uids: number[] }): Promise<EnqueuedSearchTask>;
    waitForTask(taskUid: number, options: { timeout: number; interval: number }): Promise<unknown>;
  };
};

export type StorageVnextSearchScopeReceipt = {
  marker: StorageVnextOwnerMarkerDocument;
  recordedIndexUids: string[];
  recordedTaskUids: number[];
};

export function createStorageVnextSearchPlane(input: {
  client: StorageVnextOwnedSearchClient;
  receipt: StorageVnextSearchScopeReceipt;
  taskTimeoutMs?: number;
}): StorageVnextResetBootstrapPlane {
  return {
    plane: "search",
    inspect: (proof) => inspectSearch(input, proof),
    async reset(proof) {
      const inspection = await inspectSearch(input, proof);
      assertStorageVnextOwnedPlane(inspection, proof, "search", proof.searchScope);
      const tasks = await listRecordedTasks(input.client, input.receipt.recordedTaskUids);
      const activeTaskUids = tasks
        .filter((task) => task.status === "enqueued" || task.status === "processing")
        .map((task) => task.uid);
      for (const taskUids of chunks(activeTaskUids, 1_000)) {
        await waitForTask(
          input.client,
          await input.client.tasks.cancelTasks({ uids: taskUids }),
          input.taskTimeoutMs
        );
      }

      const indexes = await listIndexes(input.client);
      const recordedIndexes = new Set(input.receipt.recordedIndexUids);
      for (const indexUid of indexes.filter((uid) => recordedIndexes.has(uid)).sort()) {
        await waitForTask(
          input.client,
          await input.client.deleteIndex(indexUid),
          input.taskTimeoutMs
        );
      }

      const remainingTasks = await listRecordedTasks(
        input.client,
        input.receipt.recordedTaskUids
      );
      for (const taskChunk of chunks(remainingTasks, 1_000)) {
        await waitForTask(
          input.client,
          await input.client.tasks.deleteTasks({
            uids: taskChunk.map((task) => task.uid)
          }),
          input.taskTimeoutMs
        );
      }
    },
    async verifyReset(proof) {
      const inspection = await inspectSearch(input, proof);
      return isOwnedSearch(inspection, proof) && inspection.bootstrapState === "current";
    },
    async bootstrap(proof) {
      const inspection = await inspectSearch(input, proof);
      assertStorageVnextOwnedPlane(inspection, proof, "search", proof.searchScope);
      if (inspection.bootstrapState === "incompatible") {
        throw new StorageVnextOwnedScopeError("Owned Meilisearch scope is not clean");
      }
    },
    async verifyBootstrap(proof) {
      const inspection = await inspectSearch(input, proof);
      return isOwnedSearch(inspection, proof) && inspection.bootstrapState === "current";
    }
  };
}

async function inspectSearch(
  input: {
    client: StorageVnextOwnedSearchClient;
    receipt: StorageVnextSearchScopeReceipt;
  },
  candidateProof: StorageVnextOwnedScopeProof
): Promise<StorageVnextOwnedPlaneInspection> {
  const proof = validateStorageVnextOwnedScopeProof(candidateProof);
  const receiptValid = isReceiptValid(input.receipt, proof);
  const indexes = await listIndexes(input.client);
  const prefixedIndexes = indexes.filter((uid) => uid.startsWith(proof.searchScope));
  const recordedIndexes = new Set(input.receipt.recordedIndexUids);
  const recordedTasks = receiptValid
    ? await listRecordedTasks(input.client, input.receipt.recordedTaskUids)
    : [];
  const unexpectedTargets = [
    ...prefixedIndexes.filter((uid) => !recordedIndexes.has(uid)),
    ...input.receipt.recordedIndexUids.filter((uid) => !uid.startsWith(proof.searchScope))
  ];
  const current = prefixedIndexes.length === 0 && recordedTasks.length === 0;

  return {
    plane: "search",
    target: proof.searchScope,
    exists: receiptValid,
    createdByRun: receiptValid && input.receipt.marker.createdByRun,
    existedBeforeRun: receiptValid ? input.receipt.marker.existedBeforeRun : true,
    broadTarget: !proof.searchScope.endsWith("_") || proof.searchScope === "svnext_",
    bootstrapState: current ? "current" : "incompatible",
    ownerMarker: receiptValid ? input.receipt.marker.ownerMarker : null,
    unexpectedTargets: [...new Set(unexpectedTargets)].sort()
  };
}

function isReceiptValid(
  receipt: StorageVnextSearchScopeReceipt,
  proof: StorageVnextOwnedScopeProof
): boolean {
  const expected = createStorageVnextOwnerMarkerDocument(proof, proof.searchScope);
  const markerValid = Object.entries(expected).every(
    ([key, value]) => receipt.marker[key as keyof StorageVnextOwnerMarkerDocument] === value
  );
  const indexesValid = new Set(receipt.recordedIndexUids).size === receipt.recordedIndexUids.length
    && receipt.recordedIndexUids.every((uid) => uid.startsWith(proof.searchScope));
  const tasksValid = new Set(receipt.recordedTaskUids).size === receipt.recordedTaskUids.length
    && receipt.recordedTaskUids.every((uid) => Number.isSafeInteger(uid) && uid >= 0);
  return markerValid && indexesValid && tasksValid;
}

async function listIndexes(client: StorageVnextOwnedSearchClient): Promise<string[]> {
  const indexes: string[] = [];
  const limit = 1_000;
  let offset = 0;
  while (true) {
    const page = await client.getRawIndexes({ limit, offset });
    indexes.push(...page.results.map((index) => index.uid));
    offset += page.results.length;
    if (offset >= page.total) break;
    if (page.results.length === 0) {
      throw new StorageVnextOwnedScopeError("Meilisearch index inventory pagination is incomplete");
    }
  }
  return [...new Set(indexes)].sort();
}

async function listRecordedTasks(
  client: StorageVnextOwnedSearchClient,
  recordedTaskUids: number[]
): Promise<SearchTask[]> {
  if (recordedTaskUids.length === 0) return [];
  const allowed = new Set(recordedTaskUids);
  const tasks: SearchTask[] = [];
  for (const taskUids of chunks(recordedTaskUids, 1_000)) {
    const page = await client.tasks.getTasks({ uids: taskUids, limit: taskUids.length });
    tasks.push(...page.results);
  }
  const unexpected = tasks.filter((task) => !allowed.has(task.uid));
  if (unexpected.length > 0) {
    throw new StorageVnextOwnedScopeError("Meilisearch returned a task outside the recorded receipt");
  }
  return tasks;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function waitForTask(
  client: StorageVnextOwnedSearchClient,
  task: EnqueuedSearchTask,
  timeoutMs = 30_000
): Promise<void> {
  await client.tasks.waitForTask(task.taskUid, { timeout: timeoutMs, interval: 50 });
}

function isOwnedSearch(
  inspection: StorageVnextOwnedPlaneInspection,
  proof: StorageVnextOwnedScopeProof
): boolean {
  try {
    assertStorageVnextOwnedPlane(inspection, proof, "search", proof.searchScope);
    return true;
  } catch {
    return false;
  }
}
