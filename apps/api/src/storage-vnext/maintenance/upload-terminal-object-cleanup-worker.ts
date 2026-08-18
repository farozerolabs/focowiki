import type {
  StorageVnextCleanupActionRepository,
  StorageVnextCleanupActionSelector
} from "../cleanup/postgres-cleanup-action-repository.js";
import { createStorageVnextObjectCleanupWorker } from
  "./zero-owner-object-cleanup-worker.js";

const SELECTOR: StorageVnextCleanupActionSelector = {
  domain: "upload_terminal",
  plane: "object_storage",
  resourceKind: "temporary_object"
};

export function createStorageVnextUploadTerminalObjectCleanupWorker(input: {
  actions: Pick<StorageVnextCleanupActionRepository,
    "claim" | "recoverStale" | "complete" | "releaseForRetry">;
  objects: {
    deleteZeroOwner(objectId: string): Promise<{
      deletedVersions: number;
      deletedMarkers: number;
      abortedMultipartUploads: number;
    }>;
  };
  purgeDeletedRegistrations(request: { limit: number }): Promise<number>;
}) {
  return createStorageVnextObjectCleanupWorker({
    ...input,
    selector: SELECTOR,
    staleLeaseCode: "STALE_UPLOAD_OBJECT_CLEANUP_LEASE",
    providerFailureCode: "UPLOAD_OBJECT_PROVIDER_DELETE_FAILED"
  });
}
