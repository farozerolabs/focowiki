import type { StorageVnextTerminalCleanupAdapter } from "../terminal-convergence.js";
import {
  createStorageVnextDomainCleanupAdapter,
  type StorageVnextDomainCleanupHandler
} from "../domain-cleanup-adapter.js";

export type StorageVnextMutationCleanupResource =
  | "process_resource"
  | "coordination"
  | "unified_search_candidate"
  | "temporary_owner"
  | "candidate_delta"
  | "mutation_claim";

export type StorageVnextMutationCleanupAdapter = StorageVnextTerminalCleanupAdapter<
  "mutation",
  StorageVnextMutationCleanupResource
>;

export function createStorageVnextMutationCleanupAdapter(input: {
  clean: StorageVnextDomainCleanupHandler<StorageVnextMutationCleanupResource>;
}): StorageVnextMutationCleanupAdapter {
  return createStorageVnextDomainCleanupAdapter({
    domain: "mutation",
    resources: [
      { resourceKind: "process_resource", plane: "process" },
      { resourceKind: "coordination", plane: "redis" },
      { resourceKind: "unified_search_candidate", plane: "search" },
      { resourceKind: "temporary_owner", plane: "postgres" },
      { resourceKind: "candidate_delta", plane: "postgres" },
      { resourceKind: "mutation_claim", plane: "postgres" }
    ],
    clean: input.clean
  });
}
