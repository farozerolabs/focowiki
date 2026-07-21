export type ProjectionSegmentKind = "base" | "delta" | "tombstone" | "compacted";

export type ProjectionSegment = {
  id: string;
  knowledgeBaseId: string;
  projectionKind: string;
  logicalPartition: string;
  segmentKind: ProjectionSegmentKind;
  sequenceNumber: number;
  formatVersion: number;
  checksumSha256: string;
  objectKey: string;
  logicalPath: string;
  entryCount: number;
  encodedBytes: number;
  firstRecordIdentity: string | null;
  lastRecordIdentity: string | null;
  baseSegmentId: string | null;
  lifecycleState: "writing" | "active" | "retained" | "quarantined" | "deleted";
};

export type ProjectionSegmentRecordChange = {
  recordId: string;
  action: "upsert" | "delete";
};

export type ProjectionSegmentPartition = {
  knowledgeBaseId: string;
  generationId: string;
  projectionKind: string;
  logicalPartition: string;
};

export type ProjectionSegmentRepository = {
  initializeLineage: (input: ProjectionSegmentPartition) => Promise<void>;
  nextSequence: (input: ProjectionSegmentPartition) => Promise<number>;
  registerAndAttach: (input: ProjectionSegment & {
    generationId: string;
    ordinal: number;
  }) => Promise<ProjectionSegment>;
  listGenerationLineage: (input: ProjectionSegmentPartition) => Promise<ProjectionSegment[]>;
  setGenerationRecordCount: (input: ProjectionSegmentPartition & {
    recordCount: number;
  }) => Promise<void>;
  countEffectiveRecords: (input: ProjectionSegmentPartition & {
    changes: ProjectionSegmentRecordChange[];
  }) => Promise<number>;
};
