import type { StorageVnextTerminalCleanupAdapter } from "../terminal-convergence.js";
import {
  createStorageVnextDomainCleanupAdapter,
  type StorageVnextDomainCleanupHandler
} from "../domain-cleanup-adapter.js";

export type StorageVnextUploadCleanupResource =
  | "process_resource"
  | "coordination"
  | "temporary_object"
  | "reservation"
  | "upload_entry"
  | "upload_session";

export type StorageVnextUploadCleanupAdapter = StorageVnextTerminalCleanupAdapter<
  "upload",
  StorageVnextUploadCleanupResource
>;

export function createStorageVnextUploadCleanupAdapter(input: {
  clean: StorageVnextDomainCleanupHandler<StorageVnextUploadCleanupResource>;
}): StorageVnextUploadCleanupAdapter {
  return createStorageVnextDomainCleanupAdapter({
    domain: "upload",
    resources: [
      { resourceKind: "process_resource", plane: "process" },
      { resourceKind: "coordination", plane: "redis" },
      { resourceKind: "temporary_object", plane: "object_storage" },
      { resourceKind: "reservation", plane: "postgres" },
      { resourceKind: "upload_entry", plane: "postgres" },
      { resourceKind: "upload_session", plane: "postgres" }
    ],
    clean: input.clean
  });
}
