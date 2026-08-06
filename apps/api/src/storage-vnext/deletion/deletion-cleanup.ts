import {
  createStorageVnextHardDeleteCleanupAdapter,
  type StorageVnextHardDeleteCleanupResource
} from "../cleanup/adapters/hard-delete.js";
import {
  createStorageVnextTerminalConvergence,
  type StorageVnextTerminalContext
} from "../cleanup/terminal-convergence.js";
import type { StorageVnextDomainCleanupResult } from "../cleanup/domain-cleanup-adapter.js";

export type StorageVnextDeletionCleanupHandler = (input: {
  context: StorageVnextTerminalContext;
  resourceKind: StorageVnextHardDeleteCleanupResource;
}) => Promise<StorageVnextDomainCleanupResult>;

export function createStorageVnextDeletionCleanupCoordinator(input: {
  clean: StorageVnextDeletionCleanupHandler;
  maximumTargets?: number;
}) {
  const adapter = createStorageVnextHardDeleteCleanupAdapter({
    clean: ({ context, target }) => input.clean({
      context,
      resourceKind: target.resourceKind
    })
  });
  const terminal = createStorageVnextTerminalConvergence({
    adapters: [adapter],
    maximumTargets: input.maximumTargets ?? 9
  });
  return {
    runAttempt(context: StorageVnextTerminalContext) {
      return terminal.converge(context);
    }
  };
}
