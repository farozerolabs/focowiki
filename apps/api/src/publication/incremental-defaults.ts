export const INCREMENTAL_PUBLICATION_DEFAULTS = {
  impactPlanner: {
    searchShardCount: 64,
    linkShardCount: 64,
    manifestShardCount: 64,
    treeShardCount: 64,
    graphNodeShardCount: 64,
    graphEdgeShardCount: 128
  },
  maxShardBytes: 1_048_576,
  impactBatchSize: 100,
  impactConcurrency: 8
} as const;
