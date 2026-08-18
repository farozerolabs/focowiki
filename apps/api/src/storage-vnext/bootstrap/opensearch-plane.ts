import type { StorageVnextOwnedScopeProof } from "../lifecycle/ports.js";
import type {
  StorageVnextOwnedPlaneInspection,
  StorageVnextResetBootstrapPlane
} from "./command.js";
import {
  createStorageVnextOwnerMarkerDocument,
  type StorageVnextOwnerMarkerDocument
} from "./owner-marker.js";
import {
  StorageVnextOwnedScopeError,
  validateStorageVnextOwnedScopeProof
} from "./owned-scope.js";
import { assertStorageVnextOwnedPlane } from "./plane-safety.js";
import type { StorageVnextSearchScopeReceipt } from "./search-plane.js";

type OpenSearchResponse = { body: unknown };

export type StorageVnextOwnedOpenSearchClient = {
  indices: {
    get(input: Record<string, unknown>): Promise<OpenSearchResponse>;
    delete(input: Record<string, unknown>): Promise<OpenSearchResponse>;
  };
};

export function createStorageVnextOpenSearchPlane(input: {
  client: StorageVnextOwnedOpenSearchClient;
  receipt: StorageVnextSearchScopeReceipt;
}): StorageVnextResetBootstrapPlane {
  return {
    plane: "search",
    inspect: (proof) => inspectOpenSearch(input, proof),
    async reset(proof) {
      const inspection = await inspectOpenSearch(input, proof);
      assertStorageVnextOwnedPlane(inspection, proof, "search", proof.searchScope);
      const indexes = new Set(await listOpenSearchIndexes(input.client, proof.searchScope));
      for (const indexUid of [...input.receipt.recordedIndexUids].sort()) {
        if (!indexes.has(indexUid)) continue;
        const response = await input.client.indices.delete({ index: indexUid });
        if (!isAcknowledged(response.body)) {
          throw new StorageVnextOwnedScopeError(
            "OpenSearch did not acknowledge an exact owned index deletion"
          );
        }
      }
    },
    async verifyReset(proof) {
      const inspection = await inspectOpenSearch(input, proof);
      return isOwnedOpenSearch(inspection, proof)
        && inspection.bootstrapState === "current";
    },
    async bootstrap(proof) {
      const inspection = await inspectOpenSearch(input, proof);
      assertStorageVnextOwnedPlane(inspection, proof, "search", proof.searchScope);
      if (inspection.bootstrapState === "incompatible") {
        throw new StorageVnextOwnedScopeError("Owned OpenSearch scope is not clean");
      }
    },
    async verifyBootstrap(proof) {
      const inspection = await inspectOpenSearch(input, proof);
      return isOwnedOpenSearch(inspection, proof)
        && inspection.bootstrapState === "current";
    }
  };
}

export async function synchronizeStorageVnextOpenSearchReceipt(input: {
  proof: StorageVnextOwnedScopeProof;
  receipt: StorageVnextSearchScopeReceipt;
  client: StorageVnextOwnedOpenSearchClient;
}): Promise<StorageVnextSearchScopeReceipt> {
  const proof = validateStorageVnextOwnedScopeProof(input.proof);
  if (!isReceiptValid(input.receipt, proof)) {
    throw new StorageVnextOwnedScopeError("OpenSearch ownership receipt is invalid");
  }
  const recordedIndexUids = await listOpenSearchIndexes(input.client, proof.searchScope);
  return {
    marker: input.receipt.marker,
    recordedIndexUids,
    recordedTaskUids: []
  };
}

async function inspectOpenSearch(
  input: {
    client: StorageVnextOwnedOpenSearchClient;
    receipt: StorageVnextSearchScopeReceipt;
  },
  candidateProof: StorageVnextOwnedScopeProof
): Promise<StorageVnextOwnedPlaneInspection> {
  const proof = validateStorageVnextOwnedScopeProof(candidateProof);
  const receiptValid = isReceiptValid(input.receipt, proof);
  const indexes = await listOpenSearchIndexes(input.client, proof.searchScope);
  const recordedIndexes = new Set(input.receipt.recordedIndexUids);
  const unexpectedTargets = [
    ...indexes.filter((uid) => !recordedIndexes.has(uid)),
    ...input.receipt.recordedIndexUids.filter((uid) => !uid.startsWith(proof.searchScope))
  ];

  return {
    plane: "search",
    target: proof.searchScope,
    exists: receiptValid,
    createdByRun: receiptValid && input.receipt.marker.createdByRun,
    existedBeforeRun: receiptValid ? input.receipt.marker.existedBeforeRun : true,
    broadTarget: !proof.searchScope.endsWith("_") || proof.searchScope === "svnext_",
    bootstrapState: indexes.length === 0 ? "current" : "incompatible",
    ownerMarker: receiptValid ? input.receipt.marker.ownerMarker : null,
    unexpectedTargets: [...new Set(unexpectedTargets)].sort()
  };
}

async function listOpenSearchIndexes(
  client: StorageVnextOwnedOpenSearchClient,
  prefix: string
): Promise<string[]> {
  const response = await client.indices.get({
    index: `${prefix}*`,
    allow_no_indices: true,
    expand_wildcards: "all",
    ignore_unavailable: true
  });
  const body = record(response.body);
  return Object.keys(body ?? {})
    .filter((indexUid) => indexUid.startsWith(prefix))
    .sort();
}

function isReceiptValid(
  receipt: StorageVnextSearchScopeReceipt,
  proof: StorageVnextOwnedScopeProof
): boolean {
  const expected = createStorageVnextOwnerMarkerDocument(proof, proof.searchScope);
  const markerValid = Object.entries(expected).every(
    ([key, value]) => receipt.marker[key as keyof StorageVnextOwnerMarkerDocument] === value
  );
  const indexesValid = new Set(receipt.recordedIndexUids).size
      === receipt.recordedIndexUids.length
    && receipt.recordedIndexUids.every((uid) => uid.startsWith(proof.searchScope));
  return markerValid && indexesValid && receipt.recordedTaskUids.length === 0;
}

function isAcknowledged(value: unknown): boolean {
  return record(value)?.acknowledged === true;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isOwnedOpenSearch(
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
