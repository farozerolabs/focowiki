import type { StorageVnextTerminalCleanupAdapter } from "../terminal-convergence.js";
import {
  createStorageVnextDomainCleanupAdapter,
  type StorageVnextDomainCleanupHandler
} from "../domain-cleanup-adapter.js";

export type StorageVnextProjectionRepairCleanupResource =
  | "process_resource"
  | "coordination"
  | "unified_search_candidate"
  | "generated_object"
  | "temporary_owner"
  | "candidate_delta"
  | "repair_claim";

export type StorageVnextProjectionRepairCleanupAdapter =
  StorageVnextTerminalCleanupAdapter<
    "projection_repair",
    StorageVnextProjectionRepairCleanupResource
  >;

export function createStorageVnextProjectionRepairCleanupAdapter(input: {
  clean: StorageVnextDomainCleanupHandler<StorageVnextProjectionRepairCleanupResource>;
}): StorageVnextProjectionRepairCleanupAdapter {
  return createStorageVnextDomainCleanupAdapter({
    domain: "projection_repair",
    resources: [
      { resourceKind: "process_resource", plane: "process" },
      { resourceKind: "coordination", plane: "redis" },
      { resourceKind: "unified_search_candidate", plane: "search" },
      { resourceKind: "generated_object", plane: "object_storage" },
      { resourceKind: "temporary_owner", plane: "postgres" },
      { resourceKind: "candidate_delta", plane: "postgres" },
      { resourceKind: "repair_claim", plane: "postgres" }
    ],
    clean: input.clean
  });
}
