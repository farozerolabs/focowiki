import type {
  StorageVnextBoundedMetadata,
  StorageVnextKnowledgeBaseId,
  StorageVnextPublicId,
  StorageVnextTimestamp
} from "../shared/types.js";
import {
  assertStorageVnextCleanupReceipt,
  assertStorageVnextCleanupTargetLimit,
  assertStorageVnextTerminalContext,
  assertUniqueStorageVnextCleanupDomains,
  validateStorageVnextCleanupPlan,
  type StorageVnextPlannedCleanup
} from "./terminal-convergence-validation.js";

export type StorageVnextTerminalOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded"
  | "timed_out"
  | "deleted";

export type StorageVnextTerminalContext = {
  workPublicId: StorageVnextPublicId;
  knowledgeBaseId: StorageVnextKnowledgeBaseId;
  operationRevision: number;
  outcome: StorageVnextTerminalOutcome;
  resultCode: string;
  safeMessage: string | null;
  checkpoint: StorageVnextBoundedMetadata;
  completedAt: StorageVnextTimestamp;
};

export type StorageVnextCleanupPlane =
  | "postgres"
  | "object_storage"
  | "search"
  | "redis"
  | "process";

export type StorageVnextCleanupTarget<ResourceKind extends string = string> = {
  publicId: StorageVnextPublicId;
  resourceKind: ResourceKind;
  plane: StorageVnextCleanupPlane;
  required: boolean;
  sequence: number;
};

export type StorageVnextCleanupReceipt<ResourceKind extends string = string> = {
  target: StorageVnextCleanupTarget<ResourceKind>;
  status: "completed" | "blocked" | "retry";
  reasonCode: string | null;
  checkpoint: StorageVnextBoundedMetadata;
};

export type StorageVnextTerminalCleanupAdapter<
  Domain extends string,
  ResourceKind extends string = string
> = {
  readonly domain: Domain;
  plan(
    context: StorageVnextTerminalContext
  ): Promise<readonly StorageVnextCleanupTarget<ResourceKind>[]>;
  clean(input: {
    context: StorageVnextTerminalContext;
    target: StorageVnextCleanupTarget<ResourceKind>;
  }): Promise<StorageVnextCleanupReceipt<ResourceKind>>;
};

export type StorageVnextTerminalConvergenceResult = {
  context: StorageVnextTerminalContext;
  status: "completed" | "blocked" | "retry";
  receipts: readonly StorageVnextCleanupReceipt[];
};

export type StorageVnextTerminalConvergencePort = {
  converge(
    context: StorageVnextTerminalContext
  ): Promise<StorageVnextTerminalConvergenceResult>;
};

export function createStorageVnextTerminalConvergence(input: {
  adapters: readonly StorageVnextTerminalCleanupAdapter<string>[];
  maximumTargets: number;
}): StorageVnextTerminalConvergencePort {
  assertStorageVnextCleanupTargetLimit(input.maximumTargets);
  assertUniqueStorageVnextCleanupDomains(input.adapters);

  return {
    async converge(context) {
      assertStorageVnextTerminalContext(context);
      const planned = (await Promise.all(input.adapters.map(async (adapter, adapterIndex) =>
        (await adapter.plan(context)).map((target, targetIndex) => ({
          adapter,
          adapterIndex,
          targetIndex,
          target
        }))
      ))).flat();
      if (planned.length > input.maximumTargets) {
        throw new Error("Storage vNext cleanup target limit exceeded");
      }
      validateStorageVnextCleanupPlan(planned as StorageVnextPlannedCleanup[]);
      planned.sort((left, right) => left.target.sequence - right.target.sequence
        || left.adapterIndex - right.adapterIndex
        || left.targetIndex - right.targetIndex);

      const receipts: StorageVnextCleanupReceipt[] = [];
      for (const item of planned) {
        const receipt = await item.adapter.clean({ context, target: item.target });
        assertStorageVnextCleanupReceipt(item.target, receipt);
        receipts.push(receipt);
        if (receipt.status === "retry") {
          return { context, status: "retry", receipts };
        }
        if (receipt.status === "blocked" && item.target.required) {
          return { context, status: "blocked", receipts };
        }
      }
      return { context, status: "completed", receipts };
    }
  };
}
