import { createHash } from "node:crypto";
import { PUBLICATION_FORMAT_VERSION } from "../domain/generation.js";

export type JsonProjectionRecord = {
  id: string;
  [key: string]: unknown;
};

export type PartitionIndex = {
  formatVersion: number;
  projection: string;
  shard: string;
  partitionCount: number;
  recordCount: number;
  previousPartitionCounts?: number[];
};

export const PARTITION_INDEX_REF_KIND = "projection_partition_index";
export const MAX_PARTITION_COUNT = 65_536;

export function parseShard(body: string | null): JsonProjectionRecord[] {
  if (!body) {
    throw new Error("Active projection shard object is unavailable");
  }
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { records?: unknown }).records)) {
    throw new Error("Active projection shard is invalid");
  }
  const records = (parsed as { records: unknown[] }).records;
  if (records.some((record) => !record || typeof record !== "object" || typeof (record as { id?: unknown }).id !== "string")) {
    throw new Error("Active projection shard contains an invalid record");
  }
  return records as JsonProjectionRecord[];
}

export function parsePartitionIndex(
  body: string | null,
  expected: { projectionKind: string; shardKey: string }
): PartitionIndex {
  if (!body) throw new Error("Projection partition index is unavailable");
  const parsed = JSON.parse(body) as Partial<PartitionIndex>;
  if (
    parsed.formatVersion !== PUBLICATION_FORMAT_VERSION
    || parsed.projection !== expected.projectionKind
    || parsed.shard !== expected.shardKey
    || !isPowerOfTwo(parsed.partitionCount)
    || !Number.isSafeInteger(parsed.recordCount)
    || parsed.recordCount! < 0
    || !isValidPreviousPartitionCounts(parsed.previousPartitionCounts)
  ) {
    throw new Error("Projection partition index is invalid");
  }
  return parsed as PartitionIndex;
}

export function renderShard(
  projection: string,
  shard: string,
  records: JsonProjectionRecord[]
): string {
  return `${JSON.stringify({
    formatVersion: PUBLICATION_FORMAT_VERSION,
    projection,
    shard,
    records
  })}\n`;
}

export function renderPartitionShard(
  projection: string,
  shard: string,
  partitionCount: number,
  partition: number,
  records: JsonProjectionRecord[]
): string {
  return `${JSON.stringify({
    formatVersion: PUBLICATION_FORMAT_VERSION,
    projection,
    shard,
    partition: { index: partition, count: partitionCount },
    records
  })}\n`;
}

export function partitionRecords(
  records: JsonProjectionRecord[],
  partitionCount: number
): JsonProjectionRecord[][] {
  const partitions = Array.from(
    { length: partitionCount },
    () => [] as JsonProjectionRecord[]
  );
  for (const record of records) {
    partitions[partitionFor(record.id, partitionCount)]!.push(record);
  }
  for (const partition of partitions) partition.sort(compareRecords);
  return partitions;
}

export function partitionRecordsSparse(
  records: JsonProjectionRecord[],
  partitionCount: number
): Map<number, JsonProjectionRecord[]> {
  const partitions = new Map<number, JsonProjectionRecord[]>();
  for (const record of records) {
    const index = partitionFor(record.id, partitionCount);
    const partition = partitions.get(index) ?? [];
    partition.push(record);
    partitions.set(index, partition);
  }
  for (const partition of partitions.values()) partition.sort(compareRecords);
  return partitions;
}

export function partitionFor(recordId: string, partitionCount: number): number {
  const digest = createHash("sha256").update(recordId).digest();
  return digest.readUInt32BE(0) % partitionCount;
}

export function partitionDescriptor(
  change: { projectionKind: string; shardKey: string; logicalPath: string },
  partitionCount: number,
  partition: number
) {
  const suffix = `part-${partition.toString().padStart(5, "0")}-of-${partitionCount.toString().padStart(5, "0")}`;
  const shardKey = `${change.shardKey}/${suffix}`;
  const stem = change.logicalPath.endsWith(".json")
    ? change.logicalPath.slice(0, -5)
    : change.logicalPath;
  return {
    shardKey,
    refKey: projectionRefKey(change.projectionKind, shardKey),
    logicalPath: `${stem}/${suffix}.json`
  };
}

export function assertRecordsFitIndividually(
  maxShardBytes: number,
  change: { projectionKind: string; shardKey: string },
  records: JsonProjectionRecord[]
): void {
  for (const record of records) {
    if (byteLength(renderPartitionShard(
      change.projectionKind,
      change.shardKey,
      MAX_PARTITION_COUNT,
      0,
      [record]
    )) > maxShardBytes) {
      throw new Error(`Projection record exceeds the configured byte budget: ${record.id}`);
    }
  }
}

export function projectionRefKey(projectionKind: string, shardKey: string): string {
  return `${projectionKind}:${shardKey}`;
}

export function compareRecords(left: JsonProjectionRecord, right: JsonProjectionRecord): number {
  return left.id.localeCompare(right.id, "en");
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isPowerOfTwo(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && Number(value) >= 2
    && Number(value) <= MAX_PARTITION_COUNT
    && (Number(value) & (Number(value) - 1)) === 0;
}

function isValidPreviousPartitionCounts(value: unknown): value is number[] | undefined {
  return value === undefined || (
    Array.isArray(value)
    && value.every((count) => count === 1 || isPowerOfTwo(count))
  );
}
