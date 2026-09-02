const MAXIMUM_RERANKER_RESERVE_MS = 5_000;
const MINIMUM_RERANKER_RESERVE_MS = 250;
const RERANKER_RESERVE_RATIO = 0.4;

export const MAXIMUM_SEMANTIC_SEARCH_DEADLINE_MS = 30_000;

export type SemanticSearchBudget = {
  laneCutoffMs: number;
  rerankerReserveMs: number;
  retrievalDeadlineMs: number;
};

export function createSemanticSearchBudget(input: {
  overallDeadlineMs: number;
  laneCutoffMs: number;
  rerank: boolean;
}): SemanticSearchBudget {
  const rerankerReserveMs = input.rerank
    ? Math.min(
        MAXIMUM_RERANKER_RESERVE_MS,
        Math.max(
          MINIMUM_RERANKER_RESERVE_MS,
          Math.floor(input.overallDeadlineMs * RERANKER_RESERVE_RATIO)
        ),
        Math.floor(input.overallDeadlineMs / 2)
      )
    : 0;
  const retrievalDeadlineMs = Math.max(
    1,
    input.overallDeadlineMs - rerankerReserveMs
  );
  return {
    laneCutoffMs: Math.min(input.laneCutoffMs, retrievalDeadlineMs),
    rerankerReserveMs,
    retrievalDeadlineMs
  };
}

export function remainingBudget(input: {
  deadlineMs: number;
  startedAt: number;
  now?: number;
}): number {
  return input.deadlineMs - Math.max(
    0,
    (input.now ?? Date.now()) - input.startedAt
  );
}
