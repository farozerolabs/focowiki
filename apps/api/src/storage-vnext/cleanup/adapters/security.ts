import type { StorageVnextTerminalCleanupAdapter } from "../terminal-convergence.js";
import {
  createStorageVnextDomainCleanupAdapter,
  type StorageVnextDomainCleanupHandler
} from "../domain-cleanup-adapter.js";

export type StorageVnextSecurityCleanupResource =
  | "process_resource"
  | "temporary_secret"
  | "coordination"
  | "security_claim";

export type StorageVnextSecurityCleanupAdapter = StorageVnextTerminalCleanupAdapter<
  "security",
  StorageVnextSecurityCleanupResource
>;

export function createStorageVnextSecurityCleanupAdapter(input: {
  clean: StorageVnextDomainCleanupHandler<StorageVnextSecurityCleanupResource>;
}): StorageVnextSecurityCleanupAdapter {
  return createStorageVnextDomainCleanupAdapter({
    domain: "security",
    resources: [
      { resourceKind: "process_resource", plane: "process" },
      { resourceKind: "temporary_secret", plane: "process" },
      { resourceKind: "coordination", plane: "redis" },
      { resourceKind: "security_claim", plane: "postgres" }
    ],
    clean: input.clean
  });
}
