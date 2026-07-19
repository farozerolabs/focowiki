import { createHash } from "node:crypto";
import type {
  ActiveObjectReference,
  GenerationObjectReferenceRepository
} from "../application/ports/generation-object-reference-repository.js";
import type { ProjectionShardRepository } from "../application/ports/projection-shard-repository.js";
import { PUBLICATION_FORMAT_VERSION } from "../domain/generation.js";
import type { StorageAdapter } from "../storage/s3.js";
import type { ImmutableObjectWriteResult } from "./immutable-object-writer.js";
import { createGeneratedFileId } from "../domain/generated-file-id.js";
import {
  assertRecordsFitIndividually,
  byteLength,
  compareRecords,
  MAX_PARTITION_COUNT,
  parsePartitionIndex,
  parseShard,
  PARTITION_INDEX_REF_KIND,
  partitionDescriptor,
  partitionFor,
  partitionRecords,
  partitionRecordsSparse,
  projectionRefKey,
  renderPartitionShard,
  renderShard,
  type JsonProjectionRecord,
  type PartitionIndex
} from "./projection-shard-partitioning.js";

export type { JsonProjectionRecord } from "./projection-shard-partitioning.js";

type JsonProjectionShardChange = {
  recordId: string;
  record: JsonProjectionRecord | null;
};

type WriterContext = Parameters<typeof createJsonProjectionShardWriter>[0];

export function createJsonProjectionShardWriter(input: {
  references: GenerationObjectReferenceRepository;
  shards: ProjectionShardRepository;
  immutableObjects: {
    write: (input: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number;
    }) => Promise<ImmutableObjectWriteResult>;
  };
  storage: Pick<StorageAdapter, "getObjectText">;
  maxShardBytes: number;
}) {
  if (!Number.isSafeInteger(input.maxShardBytes) || input.maxShardBytes <= 0) {
    throw new Error("maxShardBytes must be a positive integer");
  }

  const applyBatch = async (change: {
    knowledgeBaseId: string;
    generationId: string;
    projectionKind: string;
    shardKey: string;
    logicalPath: string;
    changes: JsonProjectionShardChange[];
  }) => {
    if (change.changes.length === 0) {
      throw new Error("Projection shard batch must not be empty");
    }
    const baseRefKey = projectionRefKey(change.projectionKind, change.shardKey);
    const partitionIndexReference = await findEffectiveReference(input.references, {
      knowledgeBaseId: change.knowledgeBaseId,
      generationId: change.generationId,
      refKind: PARTITION_INDEX_REF_KIND,
      refKey: baseRefKey
    });
    if (partitionIndexReference) {
      const partitionIndex = parsePartitionIndex(
        await input.storage.getObjectText(partitionIndexReference.objectKey, {
          maxBytes: input.maxShardBytes
        }),
        change
      );
      return applyPartitionedBatch(input, change, partitionIndex);
    }

    const baseReference = await findEffectiveReference(input.references, {
      knowledgeBaseId: change.knowledgeBaseId,
      generationId: change.generationId,
      refKind: "projection_shard",
      refKey: baseRefKey
    });
    const records = baseReference
      ? parseShard(await input.storage.getObjectText(baseReference.objectKey, {
        maxBytes: input.maxShardBytes
      }))
      : [];
    const next = applyChanges(records, change.changes);
    if (next.length === 0) {
      await input.references.stageDelete({
        knowledgeBaseId: change.knowledgeBaseId,
        generationId: change.generationId,
        refKind: "projection_shard",
        refKey: baseRefKey,
        logicalPath: change.logicalPath,
        sourceFileId: null
      });
      return { deleted: true, recordCount: 0, reused: false };
    }

    const body = renderShard(change.projectionKind, change.shardKey, next);
    if (byteLength(body) <= input.maxShardBytes) {
      const result = await writeShard(input, {
        ...change,
        physicalShardKey: change.shardKey,
        refKey: baseRefKey,
        logicalPath: change.logicalPath,
        records: next,
        body
      });
      return { deleted: false, recordCount: next.length, reused: result.reused };
    }
    return repartition(input, change, next, 1);
  };

  return {
    apply(change: {
      knowledgeBaseId: string;
      generationId: string;
      projectionKind: string;
      shardKey: string;
      recordId: string;
      record: JsonProjectionRecord | null;
      logicalPath: string;
    }) {
      return applyBatch({
        knowledgeBaseId: change.knowledgeBaseId,
        generationId: change.generationId,
        projectionKind: change.projectionKind,
        shardKey: change.shardKey,
        logicalPath: change.logicalPath,
        changes: [{ recordId: change.recordId, record: change.record }]
      });
    },
    applyBatch
  };
}

async function applyPartitionedBatch(
  input: WriterContext,
  change: {
    knowledgeBaseId: string;
    generationId: string;
    projectionKind: string;
    shardKey: string;
    logicalPath: string;
    changes: JsonProjectionShardChange[];
  },
  partitionIndex: PartitionIndex
) {
  if (partitionIndex.previousPartitionCounts?.length) {
    await deletePreviousPartitionSets(
      input.references,
      change,
      partitionIndex.previousPartitionCounts
    );
    partitionIndex = {
      ...partitionIndex,
      previousPartitionCounts: []
    };
    await writePartitionIndex(input, change, partitionIndex);
  }
  const groupedChanges = new Map<number, JsonProjectionShardChange[]>();
  for (const recordChange of change.changes) {
    const index = partitionFor(recordChange.recordId, partitionIndex.partitionCount);
    const group = groupedChanges.get(index) ?? [];
    group.push(recordChange);
    groupedChanges.set(index, group);
  }

  const updatedPartitions = new Map<number, JsonProjectionRecord[]>();
  let recordCount = partitionIndex.recordCount;
  let overflow = false;
  for (const [partition, changes] of groupedChanges) {
    const records = await readPartition(input, change, partitionIndex.partitionCount, partition);
    const beforeIds = new Set(records.map((record) => record.id));
    const next = applyChanges(records, changes);
    recordCount += next.length - beforeIds.size;
    updatedPartitions.set(partition, next);
    overflow ||= byteLength(renderPartitionShard(
      change.projectionKind,
      change.shardKey,
      partitionIndex.partitionCount,
      partition,
      next
    )) > input.maxShardBytes;
  }

  if (recordCount === 0) {
    await deletePartitionSet(input.references, change, partitionIndex.partitionCount);
    await input.references.stageDelete({
      knowledgeBaseId: change.knowledgeBaseId,
      generationId: change.generationId,
      refKind: PARTITION_INDEX_REF_KIND,
      refKey: projectionRefKey(change.projectionKind, change.shardKey),
      logicalPath: null,
      sourceFileId: null
    });
    return { deleted: true, recordCount: 0, reused: false };
  }

  if (overflow) {
    return repartitionExisting(
      input,
      change,
      partitionIndex,
      updatedPartitions,
      recordCount
    );
  }

  let reused = true;
  for (const [partition, records] of updatedPartitions) {
    const physical = partitionDescriptor(change, partitionIndex.partitionCount, partition);
    if (records.length === 0) {
      await input.references.stageDelete({
        knowledgeBaseId: change.knowledgeBaseId,
        generationId: change.generationId,
        refKind: "projection_shard",
        refKey: physical.refKey,
        logicalPath: physical.logicalPath,
        sourceFileId: null
      });
      reused = false;
      continue;
    }
    const result = await writeShard(input, {
      ...change,
      physicalShardKey: physical.shardKey,
      refKey: physical.refKey,
      logicalPath: physical.logicalPath,
      records,
      body: renderPartitionShard(
        change.projectionKind,
        change.shardKey,
        partitionIndex.partitionCount,
        partition,
        records
      )
    });
    reused &&= result.reused;
  }
  if (recordCount !== partitionIndex.recordCount) {
    await writePartitionIndex(input, change, {
      ...partitionIndex,
      recordCount
    });
  }
  return { deleted: false, recordCount, reused };
}

async function repartition(
  input: WriterContext,
  change: {
    knowledgeBaseId: string;
    generationId: string;
    projectionKind: string;
    shardKey: string;
    logicalPath: string;
  },
  records: JsonProjectionRecord[],
  previousPartitionCount: number
) {
  assertRecordsFitIndividually(input.maxShardBytes, change, records);
  let partitionCount = Math.max(2, previousPartitionCount * 2);
  let partitions: JsonProjectionRecord[][];
  while (true) {
    if (partitionCount > MAX_PARTITION_COUNT) {
      throw new Error("Projection shard cannot be partitioned within the supported limit");
    }
    partitions = partitionRecords(records, partitionCount);
    const fits = partitions.every((partition, index) =>
      byteLength(renderPartitionShard(
        change.projectionKind,
        change.shardKey,
        partitionCount,
        index,
        partition
      )) <= input.maxShardBytes
    );
    if (fits) break;
    partitionCount *= 2;
  }

  let reused = true;
  for (let partition = 0; partition < partitions.length; partition += 1) {
    const partitionRecords = partitions[partition]!;
    if (partitionRecords.length === 0) continue;
    const physical = partitionDescriptor(change, partitionCount, partition);
    const result = await writeShard(input, {
      ...change,
      physicalShardKey: physical.shardKey,
      refKey: physical.refKey,
      logicalPath: physical.logicalPath,
      records: partitionRecords,
      body: renderPartitionShard(
        change.projectionKind,
        change.shardKey,
        partitionCount,
        partition,
        partitionRecords
      )
    });
    reused &&= result.reused;
  }
  await writePartitionIndex(input, change, {
    formatVersion: PUBLICATION_FORMAT_VERSION,
    projection: change.projectionKind,
    shard: change.shardKey,
    partitionCount,
    recordCount: records.length,
    previousPartitionCounts: [previousPartitionCount]
  });
  await completePartitionTransition(input, change, {
    formatVersion: PUBLICATION_FORMAT_VERSION,
    projection: change.projectionKind,
    shard: change.shardKey,
    partitionCount,
    recordCount: records.length,
    previousPartitionCounts: [previousPartitionCount]
  });
  return { deleted: false, recordCount: records.length, reused };
}

async function repartitionExisting(
  input: WriterContext,
  change: {
    knowledgeBaseId: string;
    generationId: string;
    projectionKind: string;
    shardKey: string;
    logicalPath: string;
  },
  current: PartitionIndex,
  updatedPartitions: Map<number, JsonProjectionRecord[]>,
  recordCount: number
) {
  let partitionCount = current.partitionCount * 2;
  while (true) {
    if (partitionCount > MAX_PARTITION_COUNT) {
      throw new Error("Projection shard cannot be partitioned within the supported limit");
    }
    let fits = true;
    for (let partition = 0; partition < current.partitionCount; partition += 1) {
      const records = updatedPartitions.get(partition)
        ?? await readPartition(input, change, current.partitionCount, partition);
      assertRecordsFitIndividually(input.maxShardBytes, change, records);
      for (const [targetPartition, targetRecords] of partitionRecordsSparse(records, partitionCount)) {
        if (byteLength(renderPartitionShard(
          change.projectionKind,
          change.shardKey,
          partitionCount,
          targetPartition,
          targetRecords
        )) > input.maxShardBytes) {
          fits = false;
          break;
        }
      }
      if (!fits) break;
    }
    if (fits) break;
    partitionCount *= 2;
  }

  let reused = true;
  for (let partition = 0; partition < current.partitionCount; partition += 1) {
    const records = updatedPartitions.get(partition)
      ?? await readPartition(input, change, current.partitionCount, partition);
    for (const [targetPartition, targetRecords] of partitionRecordsSparse(records, partitionCount)) {
      const physical = partitionDescriptor(change, partitionCount, targetPartition);
      const result = await writeShard(input, {
        ...change,
        physicalShardKey: physical.shardKey,
        refKey: physical.refKey,
        logicalPath: physical.logicalPath,
        records: targetRecords,
        body: renderPartitionShard(
          change.projectionKind,
          change.shardKey,
          partitionCount,
          targetPartition,
          targetRecords
        )
      });
      reused &&= result.reused;
    }
  }
  const transition = {
    formatVersion: PUBLICATION_FORMAT_VERSION,
    projection: change.projectionKind,
    shard: change.shardKey,
    partitionCount,
    recordCount,
    previousPartitionCounts: [current.partitionCount]
  };
  await writePartitionIndex(input, change, transition);
  await completePartitionTransition(input, change, transition);
  return { deleted: false, recordCount, reused };
}

async function completePartitionTransition(
  input: WriterContext,
  change: {
    knowledgeBaseId: string;
    generationId: string;
    projectionKind: string;
    shardKey: string;
    logicalPath: string;
  },
  transition: PartitionIndex & { previousPartitionCounts: number[] }
): Promise<void> {
  await deletePreviousPartitionSets(
    input.references,
    change,
    transition.previousPartitionCounts
  );
  await writePartitionIndex(input, change, {
    ...transition,
    previousPartitionCounts: []
  });
}

async function writeShard(
  input: WriterContext,
  change: {
    knowledgeBaseId: string;
    generationId: string;
    projectionKind: string;
    physicalShardKey: string;
    refKey: string;
    logicalPath: string;
    records: JsonProjectionRecord[];
    body: string;
  }
): Promise<ImmutableObjectWriteResult> {
  if (byteLength(change.body) > input.maxShardBytes) {
    throw new Error("Projection shard exceeds the configured byte budget");
  }
  const object = await input.immutableObjects.write({
    body: change.body,
    contentType: "application/json; charset=utf-8"
  });
  const shard = await input.shards.register({
    id: projectionShardId({
      knowledgeBaseId: change.knowledgeBaseId,
      projectionKind: change.projectionKind,
      shardKey: change.physicalShardKey,
      checksumSha256: object.checksumSha256
    }),
    knowledgeBaseId: change.knowledgeBaseId,
    projectionKind: change.projectionKind,
    shardKey: change.physicalShardKey,
    formatVersion: object.formatVersion,
    checksumSha256: object.checksumSha256,
    objectKey: object.objectKey,
    recordCount: change.records.length,
    firstSortKey: change.records[0]?.id ?? null,
    lastSortKey: change.records.at(-1)?.id ?? null
  });
  await input.references.stageUpsert({
    knowledgeBaseId: change.knowledgeBaseId,
    generationId: change.generationId,
    refKind: "projection_shard",
    refKey: change.refKey,
    fileId: createGeneratedFileId({
      refKind: "projection_shard",
      refKey: change.refKey,
      sourceFileId: null
    }),
    checksumSha256: object.checksumSha256,
    formatVersion: object.formatVersion,
    logicalPath: change.logicalPath,
    sourceFileId: null,
    projectionShardId: shard.id
  });
  return object;
}

async function writePartitionIndex(
  input: WriterContext,
  change: {
    knowledgeBaseId: string;
    generationId: string;
    projectionKind: string;
    shardKey: string;
  },
  index: PartitionIndex
): Promise<void> {
  const body = `${JSON.stringify(index)}\n`;
  if (byteLength(body) > input.maxShardBytes) {
    throw new Error("Projection partition index exceeds the configured byte budget");
  }
  const object = await input.immutableObjects.write({
    body,
    contentType: "application/json; charset=utf-8"
  });
  const refKey = projectionRefKey(change.projectionKind, change.shardKey);
  await input.references.stageUpsert({
    knowledgeBaseId: change.knowledgeBaseId,
    generationId: change.generationId,
    refKind: PARTITION_INDEX_REF_KIND,
    refKey,
    fileId: createGeneratedFileId({
      refKind: PARTITION_INDEX_REF_KIND,
      refKey,
      sourceFileId: null
    }),
    checksumSha256: object.checksumSha256,
    formatVersion: object.formatVersion,
    logicalPath: null,
    sourceFileId: null,
    projectionShardId: null
  });
}

async function readPartition(
  input: WriterContext,
  change: {
    knowledgeBaseId: string;
    generationId: string;
    projectionKind: string;
    shardKey: string;
    logicalPath: string;
  },
  partitionCount: number,
  partition: number
): Promise<JsonProjectionRecord[]> {
  const physical = partitionDescriptor(change, partitionCount, partition);
  const reference = await findEffectiveReference(input.references, {
    knowledgeBaseId: change.knowledgeBaseId,
    generationId: change.generationId,
    refKind: "projection_shard",
    refKey: physical.refKey
  });
  if (!reference) return [];
  return parseShard(await input.storage.getObjectText(reference.objectKey, {
    maxBytes: input.maxShardBytes
  }));
}

async function deletePartitionSet(
  references: GenerationObjectReferenceRepository,
  change: {
    knowledgeBaseId: string;
    generationId: string;
    projectionKind: string;
    shardKey: string;
    logicalPath: string;
  },
  partitionCount: number
): Promise<void> {
  for (let partition = 0; partition < partitionCount; partition += 1) {
    const physical = partitionDescriptor(change, partitionCount, partition);
    await references.stageDelete({
      knowledgeBaseId: change.knowledgeBaseId,
      generationId: change.generationId,
      refKind: "projection_shard",
      refKey: physical.refKey,
      logicalPath: physical.logicalPath,
      sourceFileId: null
    });
  }
}

async function deletePreviousPartitionSets(
  references: GenerationObjectReferenceRepository,
  change: Parameters<typeof deletePartitionSet>[1],
  partitionCounts: number[]
): Promise<void> {
  for (const partitionCount of partitionCounts) {
    if (partitionCount === 1) {
      await references.stageDelete({
        knowledgeBaseId: change.knowledgeBaseId,
        generationId: change.generationId,
        refKind: "projection_shard",
        refKey: projectionRefKey(change.projectionKind, change.shardKey),
        logicalPath: change.logicalPath,
        sourceFileId: null
      });
      continue;
    }
    await deletePartitionSet(references, change, partitionCount);
  }
}

async function findEffectiveReference(
  references: GenerationObjectReferenceRepository,
  input: {
    knowledgeBaseId: string;
    generationId: string;
    refKind: string;
    refKey: string;
  }
): Promise<ActiveObjectReference | null> {
  if (references.findEffectiveByRef) {
    return references.findEffectiveByRef(input);
  }
  return await references.findStagedByRef(input)
    ?? references.findActiveByRef({
      knowledgeBaseId: input.knowledgeBaseId,
      refKind: input.refKind,
      refKey: input.refKey
    });
}

function applyChanges(
  records: JsonProjectionRecord[],
  changes: JsonProjectionShardChange[]
): JsonProjectionRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const change of changes) {
    if (change.record) {
      byId.set(change.recordId, change.record);
    } else {
      byId.delete(change.recordId);
    }
  }
  return [...byId.values()].sort(compareRecords);
}

function projectionShardId(input: {
  knowledgeBaseId: string;
  projectionKind: string;
  shardKey: string;
  checksumSha256: string;
}): string {
  return `projection-shard-${createHash("sha256")
    .update(`${input.knowledgeBaseId}\u0000${input.projectionKind}\u0000${input.shardKey}\u0000${input.checksumSha256}`)
    .digest("hex")
    .slice(0, 32)}`;
}
