import type { SearchFusionCandidate } from "./rank-fusion.js";
import type { GraphSeedCandidate } from "./search-retrieval.js";

export type AcceptedGraphEdge = {
  seedSourceFileId: string;
  relatedSourceFileId: string;
  relatedSourceRevisionId: string;
  weight: number;
  reason: string | null;
};

export async function expandSearchGraph(input: {
  seeds: GraphSeedCandidate[];
  neighborLimitPerSeed: number;
  listAcceptedEdges: (
    seedSourceFileIds: string[],
    limitPerSeed: number
  ) => Promise<AcceptedGraphEdge[]>;
}): Promise<SearchFusionCandidate[]> {
  assertLimit(input.neighborLimitPerSeed);
  const seedRanks = new Map(
    input.seeds.map((seed) => [seed.sourceFileId, seed.familyRank])
  );
  if (seedRanks.size === 0) return [];
  const edges = await input.listAcceptedEdges(
    [...seedRanks.keys()],
    input.neighborLimitPerSeed
  );
  const neighborOrdinals = new Map<string, number>();
  return edges.flatMap((edge) => {
    const seedRank = seedRanks.get(edge.seedSourceFileId);
    if (seedRank === undefined || !Number.isFinite(edge.weight)) return [];
    const neighborOrdinal =
      (neighborOrdinals.get(edge.seedSourceFileId) ?? 0) + 1;
    neighborOrdinals.set(edge.seedSourceFileId, neighborOrdinal);
    return [{
      sourceFileId: edge.relatedSourceFileId,
      family: "graph",
      familyRank:
        seedRank + neighborOrdinal / (input.neighborLimitPerSeed + 1),
      familyScore: edge.weight,
      relationshipReason: edge.reason
    }];
  });
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Graph neighbor limit must be between 1 and 1000");
  }
}
