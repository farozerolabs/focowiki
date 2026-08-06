import { createHash } from "node:crypto";
import type {
  StorageVnextInternalShard,
  StorageVnextInternalShardRecord
} from "./types.js";

export function packStorageVnextInternalShards(input: {
  logicalKind: string;
  records: readonly StorageVnextInternalShardRecord[];
  maximumRecords: number;
  maximumBytes: number;
}): StorageVnextInternalShard[] {
  assertInput(input);
  const records = [...input.records].sort(compareRecord);
  const identities = new Set<string>();
  for (const record of records) {
    if (
      !record.publicId
      || !record.logicalPath
      || identities.has(record.publicId)
    ) {
      throw new Error("Storage vNext internal shard record is invalid");
    }
    identities.add(record.publicId);
  }

  const groups: StorageVnextInternalShardRecord[][] = [];
  let current: StorageVnextInternalShardRecord[] = [];
  for (const record of records) {
    const candidate = [...current, record];
    if (
      current.length > 0
      && (
        candidate.length > input.maximumRecords
        || encode(input.logicalKind, candidate).byteLength > input.maximumBytes
      )
    ) {
      groups.push(current);
      current = [record];
    } else {
      current = candidate;
    }
    if (encode(input.logicalKind, current).byteLength > input.maximumBytes) {
      throw new Error("A storage vNext internal shard record exceeds the byte budget");
    }
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, ordinal) => {
    const bytes = encode(input.logicalKind, group);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    return {
      publicId: `release-shard-${checksum}`,
      logicalKind: input.logicalKind,
      firstLogicalPath: group[0]!.logicalPath,
      lastLogicalPath: group.at(-1)!.logicalPath,
      recordCount: group.length,
      ordinal,
      bytes
    };
  });
}

function encode(
  logicalKind: string,
  records: readonly StorageVnextInternalShardRecord[]
): Uint8Array {
  return Buffer.from(`${JSON.stringify({
    formatVersion: 1,
    logicalKind,
    records: records.map((record) => ({
      id: record.publicId,
      path: record.logicalPath,
      value: record.value
    }))
  })}\n`, "utf8");
}

function assertInput(input: {
  logicalKind: string;
  maximumRecords: number;
  maximumBytes: number;
}): void {
  if (
    !input.logicalKind
    || !Number.isSafeInteger(input.maximumRecords)
    || input.maximumRecords < 1
    || !Number.isSafeInteger(input.maximumBytes)
    || input.maximumBytes < 1
  ) {
    throw new Error("Storage vNext internal shard limits are invalid");
  }
}

function compareRecord(
  left: StorageVnextInternalShardRecord,
  right: StorageVnextInternalShardRecord
): number {
  return compareUtf8(left.logicalPath, right.logicalPath)
    || compareUtf8(left.publicId, right.publicId);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
