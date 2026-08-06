import type { StorageVnextTerminalCleanupAdapter } from "../terminal-convergence.js";
import {
  createStorageVnextDomainCleanupAdapter,
  type StorageVnextDomainCleanupHandler
} from "../domain-cleanup-adapter.js";

export type StorageVnextSearchRebuildCleanupResource =
  | "process_resource"
  | "coordination"
  | "unified_search_task"
  | "unified_search_candidate"
  | "search_claim";

export type StorageVnextSearchRebuildCleanupAdapter =
  StorageVnextTerminalCleanupAdapter<
    "search_rebuild",
    StorageVnextSearchRebuildCleanupResource
  >;

export function createStorageVnextSearchRebuildCleanupAdapter(input: {
  clean: StorageVnextDomainCleanupHandler<StorageVnextSearchRebuildCleanupResource>;
}): StorageVnextSearchRebuildCleanupAdapter {
  return createStorageVnextDomainCleanupAdapter({
    domain: "search_rebuild",
    resources: [
      { resourceKind: "process_resource", plane: "process" },
      { resourceKind: "coordination", plane: "redis" },
      { resourceKind: "unified_search_task", plane: "search" },
      { resourceKind: "unified_search_candidate", plane: "search" },
      { resourceKind: "search_claim", plane: "postgres" }
    ],
    clean: input.clean
  });
}
