export type GenerationObjectReference = {
  knowledgeBaseId: string;
  generationId: string;
  refKind: string;
  refKey: string;
  fileId: string;
  action: "upsert" | "delete";
  checksumSha256: string | null;
  formatVersion: number | null;
  logicalPath: string | null;
  sourceFileId: string | null;
  projectionShardId: string | null;
};

export type ActiveObjectReference = Omit<
  GenerationObjectReference,
  "generationId" | "action"
> & {
  lastChangedGenerationId: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
};

export type GenerationObjectReferenceRepository = {
  stageUpsert: (input: Omit<GenerationObjectReference, "action">) => Promise<void>;
  stageDelete: (input: Pick<
    GenerationObjectReference,
    "knowledgeBaseId" | "generationId" | "refKind" | "refKey" | "logicalPath" | "sourceFileId"
  >) => Promise<void>;
  findActiveByPath: (input: {
    knowledgeBaseId: string;
    logicalPath: string;
  }) => Promise<ActiveObjectReference | null>;
  findActiveByRef: (input: {
    knowledgeBaseId: string;
    refKind: string;
    refKey: string;
  }) => Promise<ActiveObjectReference | null>;
  findStagedByRef: (input: {
    knowledgeBaseId: string;
    generationId: string;
    refKind: string;
    refKey: string;
  }) => Promise<ActiveObjectReference | null>;
};
