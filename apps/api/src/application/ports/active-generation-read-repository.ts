import type { SerializableJson } from "./source-dispatch-repository.js";

export type ActiveGenerationFile = {
  generationId: string;
  fileId: string;
  refKind: string;
  refKey: string;
  lastChangedGenerationId: string;
  path: string;
  sourceFileId: string | null;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  title: string | null;
  summary: string | null;
  payload: SerializableJson;
};

export type ActiveGenerationProjection = {
  generationId: string;
  projectionKind: string;
  recordId: string;
  sourceFileId: string | null;
  relatedSourceFileId: string | null;
  path: string | null;
  parentPath: string | null;
  sortKey: string;
  title: string | null;
  summary: string | null;
  score: number | null;
  payload: SerializableJson;
};

export type ActiveGenerationCursor = {
  sortKey: string;
  recordId: string;
};

export type ActiveGenerationScoredCursor = {
  score: number;
  recordId: string;
};

export type ActiveGenerationPage<T, TCursor> = {
  items: T[];
  nextCursor: TCursor | null;
};

export type ActiveGenerationReadScope = {
  knowledgeBaseId: string;
  generationId: string;
  findFileById: (fileId: string) => Promise<ActiveGenerationFile | null>;
  findFileByPath: (path: string) => Promise<ActiveGenerationFile | null>;
  findFilesBySourceIds: (sourceFileIds: string[]) => Promise<ActiveGenerationFile[]>;
  findProjection: (input: {
    projectionKind: "graph_node" | "graph_edge";
    recordId: string;
  }) => Promise<ActiveGenerationProjection | null>;
  listTree: (input: {
    parentPath: string;
    entryType: "file" | "directory" | null;
    query: string | null;
    limit: number;
    cursor: ActiveGenerationCursor | null;
  }) => Promise<ActiveGenerationPage<ActiveGenerationProjection, ActiveGenerationCursor>>;
  listTreeAncestors: (
    paths: string[]
  ) => Promise<Map<string, ActiveGenerationProjection[]>>;
  search: (input: {
    query: string;
    mode: "file" | "graph" | "hybrid";
    limit: number;
    cursor: ActiveGenerationScoredCursor | null;
  }) => Promise<ActiveGenerationPage<ActiveGenerationProjection, ActiveGenerationScoredCursor>>;
  listRelated: (input: {
    sourceFileId: string;
    limit: number;
    cursor: ActiveGenerationScoredCursor | null;
  }) => Promise<ActiveGenerationPage<ActiveGenerationProjection, ActiveGenerationScoredCursor>>;
  listRelatedForSources: (input: {
    sourceFileIds: string[];
    limitPerSource: number;
  }) => Promise<Map<string, ActiveGenerationProjection[]>>;
};

export type ActiveGenerationReadRepository = {
  withActiveGeneration: <T>(
    knowledgeBaseId: string,
    reader: (scope: ActiveGenerationReadScope) => Promise<T>
  ) => Promise<T | null>;
};
