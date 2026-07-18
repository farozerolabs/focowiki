export type ProjectionShardRecord = {
  id: string;
  knowledgeBaseId: string;
  projectionKind: string;
  shardKey: string;
  formatVersion: number;
  checksumSha256: string;
  objectKey: string;
  recordCount: number;
  firstSortKey: string | null;
  lastSortKey: string | null;
};

export type ProjectionShardRepository = {
  register: (input: ProjectionShardRecord) => Promise<ProjectionShardRecord>;
};
