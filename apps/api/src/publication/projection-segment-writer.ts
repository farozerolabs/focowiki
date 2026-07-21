import { createHash } from "node:crypto";
import type { GenerationObjectReferenceRepository } from "../application/ports/generation-object-reference-repository.js";
import type {
  ProjectionSegment,
  ProjectionSegmentKind,
  ProjectionSegmentRepository
} from "../application/ports/projection-segment-repository.js";
import { createGeneratedFileId } from "../domain/generated-file-id.js";
import type { ImmutableObjectWriteResult } from "./immutable-object-writer.js";
import { planProjectionSegments } from "./projection-segment-planner.js";
import { projectionRefKey, type JsonProjectionRecord } from "./projection-shard-partitioning.js";

export type ProjectionSegmentChange = {
  recordId: string;
  record: JsonProjectionRecord | null;
};

type InlineProjectionSegment = {
  kind: "delta" | "tombstone";
  sequence: number;
  entryCount: number;
  records?: JsonProjectionRecord[];
  tombstones?: string[];
};

export function createProjectionSegmentWriter(input: {
  segments: ProjectionSegmentRepository;
  references: GenerationObjectReferenceRepository;
  immutableObjects: {
    write: (input: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number;
    }) => Promise<ImmutableObjectWriteResult>;
  };
  maxSegmentEntries: number;
  maxSegmentBytes: number;
  maxObjectBytes: number;
}) {
  assertPositiveInteger(input.maxSegmentEntries, "maxSegmentEntries");
  assertPositiveInteger(input.maxSegmentBytes, "maxSegmentBytes");
  assertPositiveInteger(input.maxObjectBytes, "maxObjectBytes");
  if (input.maxObjectBytes < input.maxSegmentBytes) {
    throw new Error("maxObjectBytes must be greater than or equal to maxSegmentBytes");
  }

  const applyBatch = async (change: {
    knowledgeBaseId: string;
    generationId: string;
    projectionKind: string;
    shardKey: string;
    logicalPath: string;
    changes: ProjectionSegmentChange[];
  }) => {
    if (change.changes.length === 0) {
      throw new Error("Projection segment batch must not be empty");
    }
    const partition = partitionInput(change);
    await input.segments.initializeLineage(partition);
    const inheritedLineage = await input.segments.listGenerationLineage(partition);
    const baseSegmentId = [...inheritedLineage]
      .reverse()
      .find((segment) => segment.segmentKind === "base" || segment.segmentKind === "compacted")
      ?.id ?? null;
    const firstSequence = await input.segments.nextSequence(partition);
    const plan = planProjectionSegments({
      changes: change.changes.map((item) => ({
        projectionKind: change.projectionKind,
        logicalPartition: change.shardKey,
        recordIdentity: item.recordId,
        action: item.record ? "upsert" : "delete",
        encodedBytes: encodedChangeBytes(item)
      })),
      maxEntries: input.maxSegmentEntries,
      maxEncodedBytes: Math.max(1, input.maxSegmentBytes - 512)
    });
    const byRecordId = new Map(change.changes.map((item) => [item.recordId, item]));
    const plannedSegments = refineProjectionSegments({
      change,
      planned: plan.segments,
      byRecordId,
      firstSequence,
      maxSegmentBytes: input.maxSegmentBytes
    });
    let reused = true;
    let sequence = firstSequence;
    const inlineCandidate = plannedSegments.at(-1)!;
    for (const planned of plannedSegments.slice(0, -1)) {
      const result = await writeExternalSegment({
        change,
        planned,
        sequence,
        baseSegmentId,
        byRecordId,
        maxObjectBytes: input.maxObjectBytes,
        immutableObjects: input.immutableObjects,
        segments: input.segments,
        references: input.references
      });
      reused &&= result.reused;
      sequence += 1;
    }

    let lineage = await input.segments.listGenerationLineage(partition);
    const recordCount = await input.segments.countEffectiveRecords({
      ...partition,
      changes: change.changes.map((item) => ({
        recordId: item.recordId,
        action: item.record ? "upsert" : "delete"
      }))
    });
    await input.segments.setGenerationRecordCount({ ...partition, recordCount });
    const inlineSegment = createInlineProjectionSegment({
      segmentKind: inlineCandidate.segmentKind,
      sequenceNumber: sequence,
      changes: inlineCandidate.changes.map((item) => byRecordId.get(item.recordIdentity)!)
    });
    let manifestBody = renderProjectionManifest({
      projectionKind: change.projectionKind,
      logicalPartition: change.shardKey,
      recordCount,
      segments: lineage,
      inlineSegments: [inlineSegment]
    });
    let inline = Buffer.byteLength(manifestBody, "utf8") <= input.maxSegmentBytes;
    if (!inline) {
      const result = await writeExternalSegment({
        change,
        planned: inlineCandidate,
        sequence,
        baseSegmentId,
        byRecordId,
        maxObjectBytes: input.maxObjectBytes,
        immutableObjects: input.immutableObjects,
        segments: input.segments,
        references: input.references
      });
      reused &&= result.reused;
      lineage = await input.segments.listGenerationLineage(partition);
      manifestBody = renderProjectionManifest({
        projectionKind: change.projectionKind,
        logicalPartition: change.shardKey,
        recordCount,
        segments: lineage
      });
    }
    const manifest = await input.immutableObjects.write({
      body: manifestBody,
      contentType: "application/json; charset=utf-8",
      formatVersion: inline ? 3 : 2
    });
    reused &&= manifest.reused;
    if (inline) {
      const recordIds = inlineCandidate.changes.map((item) => item.recordIdentity).sort();
      const registered = await input.segments.registerAndAttach({
        id: createProjectionSegmentId({
          knowledgeBaseId: change.knowledgeBaseId,
          projectionKind: change.projectionKind,
          logicalPartition: change.shardKey,
          segmentKind: inlineCandidate.segmentKind,
          sequenceNumber: sequence,
          checksumSha256: manifest.checksumSha256
        }),
        knowledgeBaseId: change.knowledgeBaseId,
        generationId: change.generationId,
        projectionKind: change.projectionKind,
        logicalPartition: change.shardKey,
        segmentKind: inlineCandidate.segmentKind,
        sequenceNumber: sequence,
        ordinal: sequence,
        formatVersion: manifest.formatVersion,
        checksumSha256: manifest.checksumSha256,
        objectKey: manifest.objectKey,
        logicalPath: projectionSegmentPath({
          projectionKind: change.projectionKind,
          logicalPartition: change.shardKey,
          segmentKind: inlineCandidate.segmentKind,
          sequenceNumber: sequence,
          checksumSha256: manifest.checksumSha256
        }),
        entryCount: recordIds.length,
        encodedBytes: manifest.sizeBytes,
        firstRecordIdentity: recordIds[0] ?? null,
        lastRecordIdentity: recordIds.at(-1) ?? null,
        baseSegmentId,
        lifecycleState: "active"
      });
      await stageSegmentReference(input.references, change, registered);
    }
    const refKey = projectionRefKey(change.projectionKind, change.shardKey);
    await input.references.stageUpsert({
      knowledgeBaseId: change.knowledgeBaseId,
      generationId: change.generationId,
      refKind: "projection_manifest",
      refKey,
      fileId: createGeneratedFileId({
        refKind: "projection_manifest",
        refKey,
        sourceFileId: null
      }),
      checksumSha256: manifest.checksumSha256,
      formatVersion: manifest.formatVersion,
      logicalPath: change.logicalPath,
      sourceFileId: null,
      projectionShardId: null
    });
    return { deleted: recordCount === 0, recordCount, reused };
  };

  return {
    apply(change: {
      knowledgeBaseId: string;
      generationId: string;
      projectionKind: string;
      shardKey: string;
      logicalPath: string;
      recordId: string;
      record: JsonProjectionRecord | null;
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

export function renderProjectionSegment(input: {
  projectionKind: string;
  logicalPartition: string;
  segmentKind: "delta" | "tombstone" | "base" | "compacted";
  sequenceNumber: number;
  changes: ProjectionSegmentChange[];
}): string {
  const records = input.changes
    .filter((item) => item.record !== null)
    .map((item) => item.record)
    .sort(compareNullableRecords);
  const tombstones = input.changes
    .filter((item) => item.record === null)
    .map((item) => item.recordId)
    .sort();
  return `${JSON.stringify({
    formatVersion: 2,
    projection: input.projectionKind,
    logicalPartition: input.logicalPartition,
    segmentKind: input.segmentKind,
    sequenceNumber: input.sequenceNumber,
    ...(records.length > 0 ? { records } : {}),
    ...(tombstones.length > 0 ? { tombstones } : {})
  })}\n`;
}

export function renderProjectionManifest(input: {
  projectionKind: string;
  logicalPartition: string;
  recordCount: number;
  segments: ProjectionSegment[];
  inlineSegments?: InlineProjectionSegment[];
}): string {
  const inlineSegments = input.inlineSegments ?? [];
  return `${JSON.stringify({
    formatVersion: inlineSegments.length > 0 ? 3 : 2,
    projection: input.projectionKind,
    logicalPartition: input.logicalPartition,
    recordCount: input.recordCount,
    segments: input.segments.map((segment) => ({
      kind: segment.segmentKind,
      sequence: segment.sequenceNumber,
      path: segment.logicalPath,
      checksumSha256: segment.checksumSha256,
      entryCount: segment.entryCount,
      encodedBytes: segment.encodedBytes
    })),
    ...(inlineSegments.length > 0 ? { inlineSegments } : {})
  })}\n`;
}

async function writeExternalSegment(input: {
  change: {
    knowledgeBaseId: string;
    generationId: string;
    projectionKind: string;
    shardKey: string;
  };
  planned: ReturnType<typeof planProjectionSegments>["segments"][number];
  sequence: number;
  baseSegmentId: string | null;
  byRecordId: Map<string, ProjectionSegmentChange>;
  maxObjectBytes: number;
  immutableObjects: Parameters<typeof createProjectionSegmentWriter>[0]["immutableObjects"];
  segments: ProjectionSegmentRepository;
  references: GenerationObjectReferenceRepository;
}): Promise<{ reused: boolean }> {
  const body = renderProjectionSegment({
    projectionKind: input.change.projectionKind,
    logicalPartition: input.change.shardKey,
    segmentKind: input.planned.segmentKind,
    sequenceNumber: input.sequence,
    changes: input.planned.changes.map((item) => input.byRecordId.get(item.recordIdentity)!)
  });
  if (Buffer.byteLength(body, "utf8") > input.maxObjectBytes) {
    throw new Error("Projection segment exceeds the generated object read limit");
  }
  const object = await input.immutableObjects.write({
    body,
    contentType: "application/json; charset=utf-8",
    formatVersion: 2
  });
  const recordIds = input.planned.changes.map((item) => item.recordIdentity).sort();
  const registered = await input.segments.registerAndAttach({
    id: createProjectionSegmentId({
      knowledgeBaseId: input.change.knowledgeBaseId,
      projectionKind: input.change.projectionKind,
      logicalPartition: input.change.shardKey,
      segmentKind: input.planned.segmentKind,
      sequenceNumber: input.sequence,
      checksumSha256: object.checksumSha256
    }),
    knowledgeBaseId: input.change.knowledgeBaseId,
    generationId: input.change.generationId,
    projectionKind: input.change.projectionKind,
    logicalPartition: input.change.shardKey,
    segmentKind: input.planned.segmentKind,
    sequenceNumber: input.sequence,
    ordinal: input.sequence,
    formatVersion: object.formatVersion,
    checksumSha256: object.checksumSha256,
    objectKey: object.objectKey,
    logicalPath: projectionSegmentPath({
      projectionKind: input.change.projectionKind,
      logicalPartition: input.change.shardKey,
      segmentKind: input.planned.segmentKind,
      sequenceNumber: input.sequence,
      checksumSha256: object.checksumSha256
    }),
    entryCount: recordIds.length,
    encodedBytes: object.sizeBytes,
    firstRecordIdentity: recordIds[0] ?? null,
    lastRecordIdentity: recordIds.at(-1) ?? null,
    baseSegmentId: input.baseSegmentId,
    lifecycleState: "active"
  });
  await stageSegmentReference(input.references, input.change, registered);
  return { reused: object.reused };
}

function refineProjectionSegments(input: {
  change: {
    projectionKind: string;
    shardKey: string;
  };
  planned: ReturnType<typeof planProjectionSegments>["segments"];
  byRecordId: Map<string, ProjectionSegmentChange>;
  firstSequence: number;
  maxSegmentBytes: number;
}): ReturnType<typeof planProjectionSegments>["segments"] {
  const refined: ReturnType<typeof planProjectionSegments>["segments"] = [];
  const queue = [...input.planned];
  while (queue.length > 0) {
    const candidate = queue.shift()!;
    const changes = candidate.changes.map((item) => input.byRecordId.get(item.recordIdentity)!);
    const body = renderProjectionSegment({
      projectionKind: input.change.projectionKind,
      logicalPartition: input.change.shardKey,
      segmentKind: candidate.segmentKind,
      sequenceNumber: input.firstSequence + refined.length,
      changes
    });
    if (Buffer.byteLength(body, "utf8") <= input.maxSegmentBytes || candidate.changes.length === 1) {
      refined.push(candidate);
      continue;
    }
    const midpoint = Math.ceil(candidate.changes.length / 2);
    queue.unshift(
      withPlannedChanges(candidate, candidate.changes.slice(0, midpoint)),
      withPlannedChanges(candidate, candidate.changes.slice(midpoint))
    );
  }
  return refined;
}

function withPlannedChanges(
  source: ReturnType<typeof planProjectionSegments>["segments"][number],
  changes: ReturnType<typeof planProjectionSegments>["segments"][number]["changes"]
): ReturnType<typeof planProjectionSegments>["segments"][number] {
  return {
    ...source,
    changes,
    encodedBytes: changes.reduce((sum, change) => sum + change.encodedBytes, 0)
  };
}

function createInlineProjectionSegment(input: {
  segmentKind: "delta" | "tombstone";
  sequenceNumber: number;
  changes: ProjectionSegmentChange[];
}): InlineProjectionSegment {
  const records = input.changes
    .filter((item) => item.record !== null)
    .map((item) => item.record!)
    .sort(compareNullableRecords);
  const tombstones = input.changes
    .filter((item) => item.record === null)
    .map((item) => item.recordId)
    .sort();
  return {
    kind: input.segmentKind,
    sequence: input.sequenceNumber,
    entryCount: records.length + tombstones.length,
    ...(records.length > 0 ? { records } : {}),
    ...(tombstones.length > 0 ? { tombstones } : {})
  };
}

function partitionInput(input: {
  knowledgeBaseId: string;
  generationId: string;
  projectionKind: string;
  shardKey: string;
}) {
  return {
    knowledgeBaseId: input.knowledgeBaseId,
    generationId: input.generationId,
    projectionKind: input.projectionKind,
    logicalPartition: input.shardKey
  };
}

async function stageSegmentReference(
  references: GenerationObjectReferenceRepository,
  change: { knowledgeBaseId: string; generationId: string },
  segment: ProjectionSegment
): Promise<void> {
  await references.stageUpsert({
    knowledgeBaseId: change.knowledgeBaseId,
    generationId: change.generationId,
    refKind: "projection_segment",
    refKey: segment.id,
    fileId: createGeneratedFileId({
      refKind: "projection_segment",
      refKey: segment.id,
      sourceFileId: null
    }),
    checksumSha256: segment.checksumSha256,
    formatVersion: segment.formatVersion,
    logicalPath: segment.logicalPath,
    sourceFileId: null,
    projectionShardId: null
  });
}

function projectionSegmentPath(input: {
  projectionKind: string;
  logicalPartition: string;
  segmentKind: ProjectionSegmentKind;
  sequenceNumber: number;
  checksumSha256: string;
}): string {
  assertInternalPath(input.projectionKind, "projectionKind");
  assertInternalPath(input.logicalPartition, "logicalPartition");
  return `_segments/${input.projectionKind}/${input.logicalPartition}/${input.segmentKind}-${String(input.sequenceNumber).padStart(6, "0")}-${input.checksumSha256.slice(0, 16)}.json`;
}

function createProjectionSegmentId(input: {
  knowledgeBaseId: string;
  projectionKind: string;
  logicalPartition: string;
  segmentKind: ProjectionSegmentKind;
  sequenceNumber: number;
  checksumSha256: string;
}): string {
  return `projection-segment-${createHash("sha256")
    .update([
      input.knowledgeBaseId,
      input.projectionKind,
      input.logicalPartition,
      input.segmentKind,
      input.sequenceNumber,
      input.checksumSha256
    ].join("\u0000"))
    .digest("hex")
    .slice(0, 32)}`;
}

function encodedChangeBytes(change: ProjectionSegmentChange): number {
  return Buffer.byteLength(JSON.stringify(change.record ?? change.recordId), "utf8") + 8;
}

function compareNullableRecords(
  left: JsonProjectionRecord | null,
  right: JsonProjectionRecord | null
): number {
  return (left?.id ?? "").localeCompare(right?.id ?? "", "en");
}

function assertInternalPath(value: string, name: string): void {
  if (!/^[a-z0-9_/-]+$/.test(value) || value.includes("..") || value.startsWith("/")) {
    throw new Error(`${name} must be a safe internal path`);
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
