const MAXIMUM_SEMANTIC_STAGE_CONCURRENCY = 32;

export function resolveSemanticStageConcurrency(claimBatchSize: number): number {
  if (!Number.isSafeInteger(claimBatchSize) || claimBatchSize < 1) {
    throw new Error("Semantic stage claim window is invalid");
  }
  return Math.min(MAXIMUM_SEMANTIC_STAGE_CONCURRENCY, claimBatchSize);
}
