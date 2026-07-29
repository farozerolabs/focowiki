import type { AcceptedGraphEdge } from "./graph-expansion.js";
import { expandSearchGraph } from "./graph-expansion.js";
import {
  fuseSearchCandidates,
  type SearchFusionCandidate,
  type SearchFusionCursor
} from "./rank-fusion.js";
import type {
  SearchRetrievalPage
} from "./search-retrieval.js";

export async function expandGraphRetrievalPage(input: {
  seeds: SearchRetrievalPage;
  neighborLimitPerSeed: number;
  depth: 0 | 1 | 2;
  limit: number;
  cursor: SearchFusionCursor | null;
  listAcceptedEdges: (
    seedSourceFileIds: string[],
    limitPerSeed: number
  ) => Promise<AcceptedGraphEdge[]>;
}): Promise<SearchRetrievalPage> {
  if (!Number.isSafeInteger(input.depth) || input.depth < 0 || input.depth > 2) {
    throw new Error("Graph search depth must be between 0 and 2");
  }
  const evidence = new Map(
    input.seeds.items.map((item) => [item.sourceFileId, item])
  );
  const candidates: SearchFusionCandidate[] = input.seeds.items.map(
    (seed, index) => ({
      sourceFileId: seed.sourceFileId,
      family: "graph",
      familyRank: index + 1,
      familyScore: 1
    })
  );
  const visited = new Set(input.seeds.items.map((seed) => seed.sourceFileId));
  let frontier = input.seeds.items.map((seed, index) => ({
    sourceFileId: seed.sourceFileId,
    sourceRevisionId: seed.sourceRevisionId,
    familyRank: index + 1
  }));

  for (let level = 0; level < input.depth && frontier.length > 0; level += 1) {
    const edges = await input.listAcceptedEdges(
      frontier.map((seed) => seed.sourceFileId),
      input.neighborLimitPerSeed
    );
    const revisionBySourceFile = new Map(
      edges.map((edge) => [
        edge.relatedSourceFileId,
        edge.relatedSourceRevisionId
      ])
    );
    const expanded = await expandSearchGraph({
      seeds: frontier,
      neighborLimitPerSeed: input.neighborLimitPerSeed,
      listAcceptedEdges: async () => edges
    });
    candidates.push(...expanded);
    const nextFrontier = [];
    for (const candidate of expanded) {
      const sourceRevisionId = revisionBySourceFile.get(candidate.sourceFileId);
      if (!sourceRevisionId) continue;
      if (!evidence.has(candidate.sourceFileId)) {
        evidence.set(candidate.sourceFileId, {
          sourceFileId: candidate.sourceFileId,
          sourceRevisionId,
          logicalPath: "",
          title: null,
          summary: null,
          sourceUrl: null,
          exactPriority: 0,
          fusedScore: 0,
          families: ["graph"],
          relationshipReasons: []
        });
      }
      if (visited.has(candidate.sourceFileId)) continue;
      visited.add(candidate.sourceFileId);
      nextFrontier.push({
        sourceFileId: candidate.sourceFileId,
        sourceRevisionId,
        familyRank: candidate.familyRank
      });
    }
    frontier = nextFrontier;
  }

  const fused = fuseSearchCandidates({
    candidates,
    limit: input.limit,
    cursor: input.cursor
  });
  return {
    items: fused.items.flatMap((item) => {
      const source = evidence.get(item.sourceFileId);
      return source
        ? [{
            ...source,
            exactPriority: item.exactPriority,
            fusedScore: item.fusedScore,
            families: item.families,
            relationshipReasons: item.relationshipReasons
          }]
        : [];
    }),
    nextCursor: fused.nextCursor
  };
}
