import type { StorageVnextTerminalCleanupAdapter } from "../terminal-convergence.js";
import {
  createStorageVnextDomainCleanupAdapter,
  type StorageVnextDomainCleanupHandler
} from "../domain-cleanup-adapter.js";

export type StorageVnextSourceProcessingCleanupResource =
  | "process_resource"
  | "coordination"
  | "graph_candidate"
  | "model_attempt"
  | "source_checkpoint"
  | "source_claim";

export type StorageVnextSourceProcessingCleanupAdapter =
  StorageVnextTerminalCleanupAdapter<
    "source_processing",
    StorageVnextSourceProcessingCleanupResource
  >;

export function createStorageVnextSourceProcessingCleanupAdapter(input: {
  clean: StorageVnextDomainCleanupHandler<StorageVnextSourceProcessingCleanupResource>;
}): StorageVnextSourceProcessingCleanupAdapter {
  return createStorageVnextDomainCleanupAdapter({
    domain: "source_processing",
    resources: [
      { resourceKind: "process_resource", plane: "process" },
      { resourceKind: "coordination", plane: "redis" },
      { resourceKind: "graph_candidate", plane: "postgres" },
      { resourceKind: "model_attempt", plane: "postgres" },
      { resourceKind: "source_checkpoint", plane: "postgres" },
      { resourceKind: "source_claim", plane: "postgres" }
    ],
    clean: input.clean
  });
}
