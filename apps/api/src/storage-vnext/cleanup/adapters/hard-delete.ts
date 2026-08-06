import type { StorageVnextTerminalCleanupAdapter } from "../terminal-convergence.js";
import {
  createStorageVnextDomainCleanupAdapter,
  type StorageVnextDomainCleanupHandler
} from "../domain-cleanup-adapter.js";

export type StorageVnextHardDeleteCleanupResource =
  | "process_resource"
  | "coordination"
  | "unified_search_scope"
  | "object_body"
  | "object_owner"
  | "catalog_scope"
  | "graph_scope"
  | "release_scope"
  | "deletion_claim";

export type StorageVnextHardDeleteCleanupAdapter = StorageVnextTerminalCleanupAdapter<
  "hard_delete",
  StorageVnextHardDeleteCleanupResource
>;

export function createStorageVnextHardDeleteCleanupAdapter(input: {
  clean: StorageVnextDomainCleanupHandler<StorageVnextHardDeleteCleanupResource>;
}): StorageVnextHardDeleteCleanupAdapter {
  return createStorageVnextDomainCleanupAdapter({
    domain: "hard_delete",
    resources: [
      { resourceKind: "process_resource", plane: "process" },
      { resourceKind: "coordination", plane: "redis" },
      { resourceKind: "unified_search_scope", plane: "search" },
      { resourceKind: "graph_scope", plane: "postgres" },
      { resourceKind: "release_scope", plane: "postgres" },
      { resourceKind: "object_owner", plane: "postgres" },
      { resourceKind: "object_body", plane: "object_storage" },
      { resourceKind: "catalog_scope", plane: "postgres" },
      { resourceKind: "deletion_claim", plane: "postgres" }
    ],
    clean: input.clean
  });
}
