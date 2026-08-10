import type { SemanticSearchLane } from "./orchestrator.js";

const MAXIMUM_OBSERVED_ITEMS = 1_000;

export type SemanticRankObservationStage = SemanticSearchLane
  | "fused"
  | "diversified"
  | "reranked";

export type SemanticRankObservation = {
  stage: SemanticRankObservationStage;
  items: readonly {
    sourceFilePublicId: string;
    rank: number;
  }[];
};

export type SemanticRankObserver = {
  observe(event: SemanticRankObservation): void;
};

export function observeSemanticRanks(
  observer: SemanticRankObserver | undefined,
  stage: SemanticRankObservationStage,
  sourceFilePublicIds: readonly string[]
): void {
  if (!observer) return;
  observer.observe(Object.freeze({
    stage,
    items: Object.freeze(sourceFilePublicIds
      .slice(0, MAXIMUM_OBSERVED_ITEMS)
      .map((sourceFilePublicId, index) => Object.freeze({
        sourceFilePublicId,
        rank: index + 1
      })))
  }));
}
