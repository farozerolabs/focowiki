import type { StorageVnextOpaqueCursor } from "../shared/types.js";
import type {
  StorageVnextObjectRegistration,
  StorageVnextOwnershipClosure
} from "./ports.js";
import type {
  StorageVnextObjectInventory,
  StorageVnextProviderInventoryItem
} from "./s3-object-inventory.js";

export type StorageVnextObjectReconciliationIssue =
  | "missing_registration"
  | "missing_bytes"
  | "inactive_registration"
  | "zero_owner"
  | "noncurrent_version"
  | "delete_marker"
  | "incomplete_multipart";

export type StorageVnextObjectReconciliationFinding = {
  issue: StorageVnextObjectReconciliationIssue;
  storageKey: string;
  objectId: string | null;
  versionId: string | null;
  uploadId: string | null;
};

type RegistrationLookupPort = {
  getRegistrationsByStorageKeys(
    storageKeys: readonly string[]
  ): Promise<readonly StorageVnextObjectRegistration[]>;
  getClosure(objectId: string): Promise<StorageVnextOwnershipClosure>;
};

type RegistrationPagePort = {
  listRegistrations(input: {
    limit: number;
    cursor: StorageVnextOpaqueCursor | null;
  }): Promise<{ items: readonly StorageVnextObjectRegistration[]; nextCursor: string | null }>;
};

export async function reconcileStorageVnextProviderInventoryPage(input: {
  provider: StorageVnextObjectInventory;
  registrations: RegistrationLookupPort;
  graceElapsedAt: string;
  limit: number;
  cursor: string | null;
}): Promise<{ findings: readonly StorageVnextObjectReconciliationFinding[]; nextCursor: string | null }> {
  assertTimestamp(input.graceElapsedAt);
  const page = await input.provider.listPage({ limit: input.limit, cursor: input.cursor });
  const storageKeys = [...new Set(page.items.map((item) => item.storageKey))];
  const registrations = await input.registrations.getRegistrationsByStorageKeys(storageKeys);
  const byKey = new Map(registrations.map((registration) => [
    registration.storageKey,
    registration
  ]));
  const findings: StorageVnextObjectReconciliationFinding[] = [];
  for (const item of page.items) {
    addProviderPhysicalFinding(findings, item);
    if (item.kind === "delete_marker" || item.kind === "multipart") continue;
    const registration = byKey.get(item.storageKey);
    if (!registration) {
      findings.push(finding("missing_registration", item));
      continue;
    }
    if (registration.state !== "verified") {
      findings.push(finding("inactive_registration", item, registration.objectId));
      continue;
    }
    const closure = await input.registrations.getClosure(registration.objectId);
    if (
      closure.ownerCount === 0
      && closure.graceExpiresAt
      && new Date(closure.graceExpiresAt) <= new Date(input.graceElapsedAt)
    ) {
      findings.push(finding("zero_owner", item, registration.objectId));
    }
  }
  return { findings, nextCursor: page.nextCursor };
}

export async function reconcileStorageVnextRegistrationPage(input: {
  provider: StorageVnextObjectInventory;
  registrations: RegistrationPagePort;
  limit: number;
  cursor: string | null;
}): Promise<{ findings: readonly StorageVnextObjectReconciliationFinding[]; nextCursor: string | null }> {
  const page = await input.registrations.listRegistrations({
    limit: input.limit,
    cursor: input.cursor
  });
  const findings: StorageVnextObjectReconciliationFinding[] = [];
  for (const registration of page.items) {
    const exists = await input.provider.headCurrent(registration.storageKey);
    if (!exists && registration.state === "verified") {
      findings.push({
        issue: "missing_bytes",
        storageKey: registration.storageKey,
        objectId: registration.objectId,
        versionId: null,
        uploadId: null
      });
    }
    if (registration.state !== "verified" && registration.state !== "deleted") {
      findings.push({
        issue: "inactive_registration",
        storageKey: registration.storageKey,
        objectId: registration.objectId,
        versionId: null,
        uploadId: null
      });
    }
  }
  return { findings, nextCursor: page.nextCursor };
}

function addProviderPhysicalFinding(
  findings: StorageVnextObjectReconciliationFinding[],
  item: StorageVnextProviderInventoryItem
): void {
  if (item.kind === "version" && !item.isLatest) {
    findings.push(finding("noncurrent_version", item));
  } else if (item.kind === "delete_marker") {
    findings.push(finding("delete_marker", item));
  } else if (item.kind === "multipart") {
    findings.push(finding("incomplete_multipart", item));
  }
}

function finding(
  issue: StorageVnextObjectReconciliationIssue,
  item: StorageVnextProviderInventoryItem,
  objectId: string | null = null
): StorageVnextObjectReconciliationFinding {
  return {
    issue,
    storageKey: item.storageKey,
    objectId,
    versionId: "versionId" in item ? item.versionId : null,
    uploadId: "uploadId" in item ? item.uploadId : null
  };
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(new Date(value).getTime())) {
    throw Object.assign(new Error("Storage vNext reconciliation input is invalid"), {
      code: "invalid_input"
    });
  }
}
