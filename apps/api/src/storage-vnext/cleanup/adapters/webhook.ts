import type { StorageVnextTerminalCleanupAdapter } from "../terminal-convergence.js";
import {
  createStorageVnextDomainCleanupAdapter,
  type StorageVnextDomainCleanupHandler
} from "../domain-cleanup-adapter.js";

export type StorageVnextWebhookCleanupResource =
  | "process_resource"
  | "coordination"
  | "delivery_attempt"
  | "webhook_claim";

export type StorageVnextWebhookCleanupAdapter = StorageVnextTerminalCleanupAdapter<
  "webhook",
  StorageVnextWebhookCleanupResource
>;

export function createStorageVnextWebhookCleanupAdapter(input: {
  clean: StorageVnextDomainCleanupHandler<StorageVnextWebhookCleanupResource>;
}): StorageVnextWebhookCleanupAdapter {
  return createStorageVnextDomainCleanupAdapter({
    domain: "webhook",
    resources: [
      { resourceKind: "process_resource", plane: "process" },
      { resourceKind: "coordination", plane: "redis" },
      { resourceKind: "delivery_attempt", plane: "postgres" },
      { resourceKind: "webhook_claim", plane: "postgres" }
    ],
    clean: input.clean
  });
}
