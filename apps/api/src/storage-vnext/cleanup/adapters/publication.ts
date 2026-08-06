import type { StorageVnextTerminalCleanupAdapter } from "../terminal-convergence.js";
import {
  createStorageVnextDomainCleanupAdapter,
  type StorageVnextDomainCleanupHandler
} from "../domain-cleanup-adapter.js";

export type StorageVnextPublicationCleanupResource =
  | "process_resource"
  | "coordination"
  | "unified_search_task"
  | "unified_search_candidate"
  | "generated_object"
  | "temporary_owner"
  | "candidate_delta"
  | "publication_claim";

export type StorageVnextPublicationCleanupAdapter = StorageVnextTerminalCleanupAdapter<
  "publication",
  StorageVnextPublicationCleanupResource
>;

export function createStorageVnextPublicationCleanupAdapter(input: {
  clean: StorageVnextDomainCleanupHandler<StorageVnextPublicationCleanupResource>;
}): StorageVnextPublicationCleanupAdapter {
  return createStorageVnextDomainCleanupAdapter({
    domain: "publication",
    resources: [
      { resourceKind: "process_resource", plane: "process" },
      { resourceKind: "coordination", plane: "redis" },
      { resourceKind: "unified_search_task", plane: "search" },
      { resourceKind: "unified_search_candidate", plane: "search" },
      { resourceKind: "generated_object", plane: "object_storage" },
      { resourceKind: "temporary_owner", plane: "postgres" },
      { resourceKind: "candidate_delta", plane: "postgres" },
      { resourceKind: "publication_claim", plane: "postgres" }
    ],
    clean: input.clean
  });
}
