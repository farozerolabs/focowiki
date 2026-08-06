import type { StorageVnextTerminalCleanupAdapter } from "../terminal-convergence.js";
import {
  createStorageVnextDomainCleanupAdapter,
  type StorageVnextDomainCleanupHandler
} from "../domain-cleanup-adapter.js";

export type StorageVnextReconciliationCleanupResource =
  | "process_resource"
  | "coordination"
  | "delete_candidate"
  | "quarantine_candidate"
  | "scan_checkpoint"
  | "reconciliation_claim";

export type StorageVnextReconciliationCleanupAdapter =
  StorageVnextTerminalCleanupAdapter<
    "reconciliation",
    StorageVnextReconciliationCleanupResource
  >;

export function createStorageVnextReconciliationCleanupAdapter(input: {
  clean: StorageVnextDomainCleanupHandler<StorageVnextReconciliationCleanupResource>;
}): StorageVnextReconciliationCleanupAdapter {
  return createStorageVnextDomainCleanupAdapter({
    domain: "reconciliation",
    resources: [
      { resourceKind: "process_resource", plane: "process" },
      { resourceKind: "coordination", plane: "redis" },
      { resourceKind: "delete_candidate", plane: "object_storage" },
      { resourceKind: "quarantine_candidate", plane: "postgres" },
      { resourceKind: "scan_checkpoint", plane: "postgres" },
      { resourceKind: "reconciliation_claim", plane: "postgres" }
    ],
    clean: input.clean
  });
}
