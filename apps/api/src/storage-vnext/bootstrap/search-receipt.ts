import type { StorageVnextOwnedScopeProof } from "../lifecycle/ports.js";
import {
  createStorageVnextOwnerMarkerDocument,
  type StorageVnextOwnerMarkerDocument
} from "./owner-marker.js";
import { validateStorageVnextOwnedScopeProof } from "./owned-scope.js";
import type { StorageVnextSearchScopeReceipt } from "./search-plane.js";

type SearchTaskReceipt = {
  uid: number;
  indexUid: string | null;
  details?: {
    swaps?: Array<{ indexes: string[] }>;
  };
};

export type StorageVnextSearchReceiptClient = {
  getRawIndexes(input: { limit: number; offset: number }): Promise<{
    results: Array<{ uid: string }>;
    total: number;
  }>;
  tasks: {
    getTasks(input: { limit: number; from?: number }): Promise<{
      results: SearchTaskReceipt[];
      next: number | null;
    }>;
  };
};

export async function synchronizeStorageVnextSearchReceipt(input: {
  proof: StorageVnextOwnedScopeProof;
  receipt: StorageVnextSearchScopeReceipt;
  client: StorageVnextSearchReceiptClient;
}): Promise<StorageVnextSearchScopeReceipt> {
  const proof = validateStorageVnextOwnedScopeProof(input.proof);
  assertReceiptMarker(input.receipt.marker, proof);

  const indexUids = new Set(input.receipt.recordedIndexUids);
  for (const uid of await listIndexes(input.client)) {
    if (uid.startsWith(proof.searchScope)) indexUids.add(uid);
  }
  if ([...indexUids].some((uid) => !uid.startsWith(proof.searchScope))) {
    throw new Error("Meilisearch receipt contains an index outside the run-owned prefix");
  }

  const taskUids = new Set(input.receipt.recordedTaskUids);
  let from: number | null = null;
  do {
    const page = await input.client.tasks.getTasks({
      limit: 1_000,
      ...(from === null ? {} : { from })
    });
    for (const task of page.results) {
      if (taskBelongsToScope(task, proof.searchScope)) taskUids.add(task.uid);
    }
    if (page.next !== null && page.next === from) {
      throw new Error("Meilisearch task receipt pagination did not advance");
    }
    from = page.next;
  } while (from !== null);

  if ([...taskUids].some((uid) => !Number.isSafeInteger(uid) || uid < 0)) {
    throw new Error("Meilisearch receipt contains an invalid task UID");
  }

  return {
    marker: input.receipt.marker,
    recordedIndexUids: [...indexUids].sort(),
    recordedTaskUids: [...taskUids].sort((left, right) => left - right)
  };
}

async function listIndexes(client: StorageVnextSearchReceiptClient): Promise<string[]> {
  const indexes: string[] = [];
  const limit = 1_000;
  let offset = 0;
  while (true) {
    const page = await client.getRawIndexes({ limit, offset });
    indexes.push(...page.results.map((index) => index.uid));
    offset += page.results.length;
    if (offset >= page.total) return [...new Set(indexes)];
    if (page.results.length === 0) {
      throw new Error("Meilisearch index receipt pagination did not advance");
    }
  }
}

function taskBelongsToScope(task: SearchTaskReceipt, prefix: string): boolean {
  if (task.indexUid?.startsWith(prefix)) return true;
  return task.details?.swaps?.some((swap) =>
    swap.indexes.some((uid) => uid.startsWith(prefix))) ?? false;
}

function assertReceiptMarker(
  marker: StorageVnextOwnerMarkerDocument,
  proof: StorageVnextOwnedScopeProof
): void {
  const expected = createStorageVnextOwnerMarkerDocument(proof, proof.searchScope);
  if (Object.entries(expected).some(
    ([key, value]) => marker[key as keyof StorageVnextOwnerMarkerDocument] !== value
  )) {
    throw new Error("Meilisearch receipt owner marker does not match the run proof");
  }
}
