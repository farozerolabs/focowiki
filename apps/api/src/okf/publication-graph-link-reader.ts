import { deduplicateGraphRelationships, type OkfGraphRelationship } from "@focowiki/okf";
import type { GeneratedPageSummary } from "./publication-files.js";
import type { PublicationGraphState } from "./publication-graph-files.js";

export type PublicationGraphNeighborhoodReader = (request: {
  sourceFileId: string;
  limit: number;
}) => Promise<{ sourceFileId: string; relationships: OkfGraphRelationship[] }>;

export async function readGraphLinks(input: {
  graph: PublicationGraphState;
  sourceFileId: string;
  fetchGraphNeighborhood?: PublicationGraphNeighborhoodReader | undefined;
}): Promise<OkfGraphRelationship[]> {
  if (!input.fetchGraphNeighborhood) {
    return [];
  }
  const neighborhood = await input.fetchGraphNeighborhood({
    sourceFileId: input.sourceFileId,
    limit: input.graph.limits.pageRelatedLimit
  });
  return deduplicateGraphRelationships(neighborhood.relationships);
}

export async function attachGraphLinksToSummary(input: {
  summary: GeneratedPageSummary;
  graph: PublicationGraphState;
  fetchGraphNeighborhood?: PublicationGraphNeighborhoodReader | undefined;
}): Promise<GeneratedPageSummary> {
  const graphLinks = await readGraphLinks({
    graph: input.graph,
    sourceFileId: input.summary.fileId,
    fetchGraphNeighborhood: input.fetchGraphNeighborhood
  });
  return graphLinks.length > 0
    ? { ...input.summary, graphLinks }
    : input.summary;
}
