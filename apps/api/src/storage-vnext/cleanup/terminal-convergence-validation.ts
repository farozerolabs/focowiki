import type { StorageVnextBoundedMetadata } from "../shared/types.js";
import type {
  StorageVnextCleanupPlane,
  StorageVnextCleanupReceipt,
  StorageVnextCleanupTarget,
  StorageVnextTerminalCleanupAdapter,
  StorageVnextTerminalContext
} from "./terminal-convergence.js";

export type StorageVnextPlannedCleanup = {
  adapter: StorageVnextTerminalCleanupAdapter<string>;
  adapterIndex: number;
  targetIndex: number;
  target: StorageVnextCleanupTarget;
};

const CLEANUP_PLANES: readonly StorageVnextCleanupPlane[] = [
  "postgres", "object_storage", "search", "redis", "process"
];

export function validateStorageVnextCleanupPlan(
  planned: readonly StorageVnextPlannedCleanup[]
): void {
  const identities = new Set<string>();
  for (const item of planned) {
    const target = item.target;
    assertIdentifier(target.publicId, 255, "cleanup target public ID");
    assertIdentifier(target.resourceKind, 128, "cleanup resource kind");
    if (!CLEANUP_PLANES.includes(target.plane)) {
      throw new Error("Storage vNext cleanup plane is invalid");
    }
    if (!Number.isSafeInteger(target.sequence) || target.sequence < 0) {
      throw new Error("Storage vNext cleanup sequence is invalid");
    }
    if (typeof target.required !== "boolean") {
      throw new Error("Storage vNext cleanup requirement is invalid");
    }
    const identity = [
      item.adapter.domain, target.plane, target.resourceKind, target.publicId
    ].join("\u0000");
    if (identities.has(identity)) {
      throw new Error("Storage vNext cleanup target is duplicated");
    }
    identities.add(identity);
  }
}

export function assertStorageVnextCleanupReceipt(
  target: StorageVnextCleanupTarget,
  receipt: StorageVnextCleanupReceipt
): void {
  if (
    receipt.target.publicId !== target.publicId
    || receipt.target.resourceKind !== target.resourceKind
    || receipt.target.plane !== target.plane
    || receipt.target.required !== target.required
    || receipt.target.sequence !== target.sequence
  ) throw new Error("Storage vNext cleanup receipt target is invalid");
  if (receipt.status !== "completed" && receipt.status !== "blocked" && receipt.status !== "retry") {
    throw new Error("Storage vNext cleanup receipt status is invalid");
  }
  if (receipt.reasonCode !== null) {
    assertIdentifier(receipt.reasonCode, 128, "cleanup reason code");
  }
  assertCheckpoint(receipt.checkpoint);
}

export function assertUniqueStorageVnextCleanupDomains(
  adapters: readonly StorageVnextTerminalCleanupAdapter<string>[]
): void {
  const domains = new Set<string>();
  for (const adapter of adapters) {
    assertIdentifier(adapter.domain, 128, "cleanup domain");
    if (domains.has(adapter.domain)) {
      throw new Error("Storage vNext cleanup domain is duplicated");
    }
    domains.add(adapter.domain);
  }
}

export function assertStorageVnextTerminalContext(
  context: StorageVnextTerminalContext
): void {
  assertIdentifier(context.workPublicId, 255, "work public ID");
  assertIdentifier(context.knowledgeBaseId, 255, "knowledge base ID");
  assertIdentifier(context.resultCode, 128, "terminal result code");
  if (!Number.isSafeInteger(context.operationRevision) || context.operationRevision < 0) {
    throw new Error("Storage vNext terminal operation revision is invalid");
  }
  if (context.safeMessage !== null && Buffer.byteLength(context.safeMessage, "utf8") > 2_048) {
    throw new Error("Storage vNext terminal safe message is invalid");
  }
  const completedAt = new Date(context.completedAt);
  if (!Number.isFinite(completedAt.getTime()) || completedAt.toISOString() !== context.completedAt) {
    throw new Error("Storage vNext terminal completion time is invalid");
  }
  assertCheckpoint(context.checkpoint);
}

export function assertStorageVnextCleanupTargetLimit(maximumTargets: number): void {
  if (!Number.isSafeInteger(maximumTargets) || maximumTargets < 1 || maximumTargets > 1_000) {
    throw new Error("Storage vNext cleanup target limit is invalid");
  }
}

function assertCheckpoint(checkpoint: StorageVnextBoundedMetadata): void {
  if (
    checkpoint === null
    || Array.isArray(checkpoint)
    || Buffer.byteLength(JSON.stringify(checkpoint), "utf8") > 32_768
  ) throw new Error("Storage vNext cleanup checkpoint is invalid");
}

function assertIdentifier(value: string, maxBytes: number, field: string): void {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`Storage vNext ${field} is invalid`);
  }
}
