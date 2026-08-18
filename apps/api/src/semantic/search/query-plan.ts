import type { SearchProviderVectorFamily } from
  "../../application/ports/search-provider-runtime.js";
import type {
  SemanticRankedLane,
  SemanticVectorLane
} from "./orchestrator.js";

const MINIMUM_FAMILY_CANDIDATES = 30;
const MAXIMUM_FAMILY_CANDIDATES = 1_000;
const OVERSAMPLING_FACTOR = 3;

export type SemanticSearchPlan = {
  rankedLanes: readonly SemanticRankedLane[];
  vectorLanes: readonly {
    lane: SemanticVectorLane;
    family: SearchProviderVectorFamily;
  }[];
  candidateLimitPerLane: number;
};

export function createSemanticSearchPlan(input: {
  mode: "file" | "graph" | "hybrid";
  scope: "all" | "path" | "metadata";
  resultLimit: number;
}): SemanticSearchPlan {
  return {
    rankedLanes: rankedLanes(input.mode, input.scope),
    vectorLanes: vectorLanes(input.mode, input.scope),
    candidateLimitPerLane: Math.min(
      MAXIMUM_FAMILY_CANDIDATES,
      Math.max(
        MINIMUM_FAMILY_CANDIDATES,
        input.resultLimit + 1,
        input.resultLimit * OVERSAMPLING_FACTOR
      )
    )
  };
}

function rankedLanes(
  mode: "file" | "graph" | "hybrid",
  scope: "all" | "path" | "metadata"
): SemanticRankedLane[] {
  if (scope === "path") return ["exact_path", "exact_title"];
  if (scope === "metadata") return ["lexical"];
  return [
    "exact_path",
    "exact_title",
    ...(mode === "graph" ? [] : ["lexical", "jieba"] as const),
    ...(mode === "file" ? [] : ["file_graph", "file_relationship"] as const)
  ];
}

function vectorLanes(
  mode: "file" | "graph" | "hybrid",
  scope: "all" | "path" | "metadata"
): SemanticSearchPlan["vectorLanes"] {
  if (scope !== "all") return [];
  return [
    ...(mode === "graph" ? [] : [{
      lane: "content_vector" as const,
      family: "content" as const
    }]),
    ...(mode === "file" ? [] : [
      { lane: "entity_vector" as const, family: "entity" as const },
      {
        lane: "relationship_vector" as const,
        family: "relationship" as const
      },
      { lane: "community_vector" as const, family: "community" as const }
    ])
  ];
}
