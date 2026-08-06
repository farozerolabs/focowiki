import type { StorageVnextOwnedScopeProof } from "../lifecycle/ports.js";
import {
  StorageVnextOwnedScopeError,
  validateStorageVnextOwnedScopeProof
} from "./owned-scope.js";

export type StorageVnextOwnerMarkerDocument = {
  version: 1;
  runId: string;
  ownerMarker: string;
  proofChecksum: string;
  target: string;
  createdByRun: true;
  existedBeforeRun: false;
};

export function createStorageVnextOwnerMarkerDocument(
  proof: StorageVnextOwnedScopeProof,
  target: string
): StorageVnextOwnerMarkerDocument {
  const validated = validateStorageVnextOwnedScopeProof(proof);
  if (!allowedMarkerTargets(validated).has(target)) {
    throw new StorageVnextOwnedScopeError("Owner marker target is outside the exact run proof");
  }

  return {
    version: 1,
    runId: validated.runId,
    ownerMarker: validated.ownerMarker,
    proofChecksum: validated.proofChecksum,
    target,
    createdByRun: true,
    existedBeforeRun: false
  };
}

export function serializeStorageVnextOwnerMarker(
  marker: StorageVnextOwnerMarkerDocument
): string {
  return `${JSON.stringify(marker)}\n`;
}

export function parseStorageVnextOwnerMarker(
  value: string,
  proof: StorageVnextOwnedScopeProof,
  target: string
): StorageVnextOwnerMarkerDocument | null {
  if (Buffer.byteLength(value, "utf8") > 4_096) return null;

  try {
    const parsed = JSON.parse(value) as Partial<StorageVnextOwnerMarkerDocument>;
    const expected = createStorageVnextOwnerMarkerDocument(proof, target);
    return Object.entries(expected).every(
      ([key, expectedValue]) => parsed[key as keyof StorageVnextOwnerMarkerDocument] === expectedValue
    ) && Object.keys(parsed).length === Object.keys(expected).length
      ? expected
      : null;
  } catch {
    return null;
  }
}

function allowedMarkerTargets(proof: StorageVnextOwnedScopeProof): Set<string> {
  return new Set([
    proof.postgresScope,
    proof.objectScope,
    proof.searchScope,
    proof.coordinationScope,
    proof.filesystemScope
  ]);
}
