import type {
  RankedSearchCandidate,
  RankedSearchFamily
} from "./ranked-search-candidate.js";

export const SEARCH_FUSION_RANK_CONSTANT = 60;
export const SEARCH_FUSION_VERSION = "weighted-rrf-v1";
export const SEARCH_FUSION_WEIGHTS = {
  exact_title: 2.0,
  exact_path: 1.9,
  title: 1.5,
  body: 1.3,
  path: 1.1,
  metadata: 0.8,
  graph: 1.0,
  typo: 0.4
} as const satisfies Record<RankedSearchFamily | "graph", number>;

export type SearchFusionCandidate = Omit<RankedSearchCandidate, "family"> & {
  family: RankedSearchFamily | "graph";
  relationshipReason?: string | null;
};

export type FusedSearchResult = {
  sourceFileId: string;
  exactPriority: number;
  fusedScore: number;
  families: Array<RankedSearchFamily | "graph">;
  relationshipReasons: string[];
};

export type SearchFusionCursor = {
  exactPriority: number;
  fusedScore: number;
  sourceFileId: string;
};

export function fuseSearchCandidates(input: {
  candidates: SearchFusionCandidate[];
  limit: number;
  cursor: SearchFusionCursor | null;
}): { items: FusedSearchResult[]; nextCursor: SearchFusionCursor | null } {
  const grouped = new Map<string, {
    exactPriority: number;
    fusedScore: number;
    families: Set<RankedSearchFamily | "graph">;
    relationshipReasons: Set<string>;
  }>();
  for (const candidate of input.candidates) {
    const current = grouped.get(candidate.sourceFileId) ?? {
      exactPriority: 0,
      fusedScore: 0,
      families: new Set<RankedSearchFamily | "graph">(),
      relationshipReasons: new Set<string>()
    };
    const family = candidate.family;
    current.exactPriority = Math.max(
      current.exactPriority,
      family === "exact_title" ? 2 : family === "exact_path" ? 1 : 0
    );
    current.fusedScore += SEARCH_FUSION_WEIGHTS[family]
      / (SEARCH_FUSION_RANK_CONSTANT + Math.max(1, candidate.familyRank));
    current.families.add(family);
    if (candidate.relationshipReason) {
      current.relationshipReasons.add(candidate.relationshipReason);
    }
    grouped.set(candidate.sourceFileId, current);
  }
  const ranked = [...grouped.entries()]
    .map(([sourceFileId, value]) => ({
      sourceFileId,
      exactPriority: value.exactPriority,
      fusedScore: value.fusedScore,
      families: [...value.families].sort(),
      relationshipReasons: [...value.relationshipReasons].sort()
    }))
    .filter((item) => isAfterCursor(item, input.cursor))
    .sort(compareFusedResults);
  const visible = ranked.slice(0, input.limit);
  const hasMore = ranked.length > input.limit;
  const last = visible.at(-1);
  return {
    items: visible,
    nextCursor: hasMore && last
      ? {
          exactPriority: last.exactPriority,
          fusedScore: last.fusedScore,
          sourceFileId: last.sourceFileId
        }
      : null
  };
}

function isAfterCursor(
  item: FusedSearchResult,
  cursor: SearchFusionCursor | null
): boolean {
  if (!cursor) return true;
  return compareFusedResults(item, {
    ...item,
    exactPriority: cursor.exactPriority,
    fusedScore: cursor.fusedScore,
    sourceFileId: cursor.sourceFileId
  }) > 0;
}

function compareFusedResults(
  left: FusedSearchResult,
  right: FusedSearchResult
): number {
  return right.exactPriority - left.exactPriority
    || right.fusedScore - left.fusedScore
    || left.sourceFileId.localeCompare(right.sourceFileId);
}
