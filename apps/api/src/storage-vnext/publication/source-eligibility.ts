import type { StorageVnextSourceFileFact } from "../catalog/ports.js";

export const STORAGE_VNEXT_RECOVERABLE_PUBLICATION_FAILURE_CODE =
  "PUBLICATION_FAILED";

export function isStorageVnextStablePublicationSource(
  source: StorageVnextSourceFileFact
): boolean {
  return source.status === "ready";
}

export function isStorageVnextCandidatePublicationSource(
  source: StorageVnextSourceFileFact
): boolean {
  return source.status === "processing"
    || (
      source.status === "failed"
      && source.safeErrorCode === STORAGE_VNEXT_RECOVERABLE_PUBLICATION_FAILURE_CODE
    );
}
