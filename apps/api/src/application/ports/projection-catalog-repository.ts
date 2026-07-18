export type EffectiveProjectionShard = {
  projectionKind: string;
  shardKey: string;
  logicalPath: string;
  recordCount: number;
};

export type ProjectionCatalogRepository = {
  listEffectiveShards: (input: {
    knowledgeBaseId: string;
    generationId: string;
  }) => Promise<EffectiveProjectionShard[]>;
};
