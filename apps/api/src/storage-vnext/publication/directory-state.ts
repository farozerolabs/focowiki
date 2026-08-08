import { createHash } from "node:crypto";
import type { PersistentDirectoryLeaf } from
  "../../application/ports/directory-navigation-repository.js";
import type { StorageVnextInternalShard } from "./types.js";

export const STORAGE_VNEXT_DIRECTORY_NAVIGATION_SHARD_KIND =
  "directory_navigation";

export function createStorageVnextDirectoryNavigationShard(input: {
  directoryPath: string;
  leaves: readonly PersistentDirectoryLeaf[];
  ordinal: number;
}): StorageVnextInternalShard {
  const shards = createStorageVnextDirectoryNavigationShards({
    directoryPath: input.directoryPath,
    leaves: input.leaves,
    maximumBytes: Number.MAX_SAFE_INTEGER
  });
  if (shards.length !== 1) throw directoryStateError("unexpected_partition");
  return { ...shards[0]!, ordinal: input.ordinal };
}

export function createStorageVnextDirectoryNavigationShards(input: {
  directoryPath: string;
  leaves: readonly PersistentDirectoryLeaf[];
  maximumBytes: number;
}): StorageVnextInternalShard[] {
  assertDirectoryPath(input.directoryPath);
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1) {
    throw directoryStateError("invalid_byte_budget");
  }
  const leaves = validateLeaves(input.leaves);
  let groups: PersistentDirectoryLeaf[][] = [[]];
  for (const leaf of leaves) {
    const current = groups.at(-1)!;
    const candidate = [...current, leaf];
    if (
      current.length > 0
      && encode(input.directoryPath, 0, 1, candidate).byteLength > input.maximumBytes
    ) groups.push([leaf]);
    else groups[groups.length - 1] = candidate;
  }
  let changed = true;
  while (changed) {
    changed = false;
    const partCount = groups.length;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]!;
      if (encode(input.directoryPath, index, partCount, group).byteLength <= input.maximumBytes) {
        continue;
      }
      if (group.length < 2) throw directoryStateError("leaf_byte_budget_exceeded");
      const split = Math.ceil(group.length / 2);
      groups.splice(index, 1, group.slice(0, split), group.slice(split));
      changed = true;
      break;
    }
  }
  return groups.map((group, ordinal) => {
    const bytes = encode(input.directoryPath, ordinal, groups.length, group);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    return {
      publicId: `release-shard-${checksum}`,
      logicalKind: STORAGE_VNEXT_DIRECTORY_NAVIGATION_SHARD_KIND,
      firstLogicalPath: input.directoryPath,
      lastLogicalPath: input.directoryPath,
      recordCount: group.length,
      ordinal,
      bytes
    };
  });
}

export function parseStorageVnextDirectoryNavigationState(input: {
  bytes: Uint8Array;
  directoryPath: string;
}): {
  partIndex: number;
  partCount: number;
  leaves: PersistentDirectoryLeaf[];
} {
  assertDirectoryPath(input.directoryPath);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
  } catch {
    throw directoryStateError("invalid_bytes");
  }
  if (
    !isRecord(value)
    || value.formatVersion !== 1
    || value.kind !== "directory-navigation"
    || value.directoryPath !== input.directoryPath
    || !isRecord(value.part)
    || !Number.isSafeInteger(value.part.index)
    || Number(value.part.index) < 0
    || !Number.isSafeInteger(value.part.count)
    || Number(value.part.count) < 1
    || Number(value.part.index) >= Number(value.part.count)
    || !Array.isArray(value.leaves)
  ) throw directoryStateError("invalid_document");
  return {
    partIndex: Number(value.part.index),
    partCount: Number(value.part.count),
    leaves: validateLeaves(value.leaves)
  };
}

function encode(
  directoryPath: string,
  partIndex: number,
  partCount: number,
  leaves: readonly PersistentDirectoryLeaf[]
): Uint8Array {
  return Buffer.from(`${JSON.stringify({
    formatVersion: 1,
    kind: "directory-navigation",
    directoryPath,
    part: { index: partIndex, count: partCount },
    leaves
  })}\n`, "utf8");
}

function validateLeaves(input: readonly unknown[]): PersistentDirectoryLeaf[] {
  const leafIds = new Set<string>();
  const entryIds = new Set<string>();
  return input.map((value) => {
    if (
      !isRecord(value)
      || !validId(value.id)
      || leafIds.has(value.id)
      || !nullableId(value.previousLeafId)
      || !nullableId(value.nextLeafId)
      || !Number.isSafeInteger(value.revision)
      || Number(value.revision) < 1
      || !optionalInstant(value.changedAt)
      || !Array.isArray(value.entries)
    ) throw directoryStateError("invalid_leaf");
    leafIds.add(value.id);
    const entries = value.entries.map<PersistentDirectoryLeaf["entries"][number]>((entry) => {
      const kind = isRecord(entry) ? entry.kind : null;
      if (
        !isRecord(entry)
        || !validId(entry.id)
        || entryIds.has(entry.id)
        || typeof entry.sortKey !== "string"
        || !entry.sortKey
        || typeof entry.name !== "string"
        || !entry.name
        || typeof entry.targetPath !== "string"
        || !entry.targetPath
        || (kind !== "file" && kind !== "directory")
      ) throw directoryStateError("invalid_entry");
      entryIds.add(entry.id);
      return {
        id: entry.id,
        sortKey: entry.sortKey,
        name: entry.name,
        targetPath: entry.targetPath,
        kind
      };
    });
    return {
      id: value.id,
      previousLeafId: value.previousLeafId,
      nextLeafId: value.nextLeafId,
      revision: Number(value.revision),
      ...(typeof value.changedAt === "string" ? { changedAt: value.changedAt } : {}),
      entries
    };
  });
}

function assertDirectoryPath(value: string): void {
  if (!value || Buffer.byteLength(value, "utf8") > 4_096) {
    throw directoryStateError("invalid_directory_path");
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 4_096;
}

function nullableId(value: unknown): value is string | null {
  return value === null || validId(value);
}

function optionalInstant(value: unknown): value is string | undefined {
  return value === undefined || (
    typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T/u.test(value)
    && Number.isFinite(Date.parse(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function directoryStateError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext directory navigation state error: ${code}`),
    { code }
  );
}
