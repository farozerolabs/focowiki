import type { SerializableJson } from "./source-dispatch-repository.js";

export type ProjectionRecordKind =
  | "search"
  | "links"
  | "manifest"
  | "tree"
  | "graph_node"
  | "graph_edge"
  | "related_files";

export type ProjectionRecord = {
  knowledgeBaseId: string;
  projectionKind: ProjectionRecordKind;
  recordId: string;
  lastChangedGenerationId: string;
  shardKey: string;
  sourceFileId: string | null;
  relatedSourceFileId: string | null;
  logicalPath: string | null;
  parentPath: string | null;
  sortKey: string | null;
  title: string | null;
  summary: string | null;
  searchableText: string | null;
  payload: SerializableJson;
};

export type ProjectionRecordRepository = {
  stageUpsert: (input: Omit<ProjectionRecord, "lastChangedGenerationId"> & {
    generationId: string;
  }) => Promise<void>;
  stageDelete: (input: {
    knowledgeBaseId: string;
    generationId: string;
    projectionKind: ProjectionRecordKind;
    recordId: string;
    shardKey: string;
  }) => Promise<void>;
  findActive: (input: {
    knowledgeBaseId: string;
    projectionKind: ProjectionRecordKind;
    recordId: string;
  }) => Promise<ProjectionRecord | null>;
  findStaged: (input: {
    knowledgeBaseId: string;
    generationId: string;
    projectionKind: ProjectionRecordKind;
    recordId: string;
  }) => Promise<ProjectionRecord | null>;
};
