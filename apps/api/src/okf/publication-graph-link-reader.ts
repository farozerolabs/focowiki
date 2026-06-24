import type {
  OkfGraphEdge,
  OkfGraphRelationship
} from "@focowiki/okf";
import type { CursorPage, CursorPageRequest } from "../runtime/bounded.js";
import type { GeneratedPageSummary } from "./publication-files.js";
import type {
  PublicationGraphState,
  PublicationPublicFilePlans
} from "./publication-graph-files.js";

export async function readGraphLinks(input: {
  graph: PublicationGraphState;
  sourceFileId: string;
  publicFilePlans: PublicationPublicFilePlans;
  fetchGraphNeighborhood:
    | ((request: {
        sourceFileId: string;
        limit: number;
      }) => Promise<{ sourceFileId: string; relationships: OkfGraphRelationship[] }>)
    | undefined;
  fetchGraphEdgePage?: ((request: CursorPageRequest) => Promise<CursorPage<OkfGraphEdge>>) | undefined;
  pageSize: number;
}): Promise<OkfGraphRelationship[]> {
  if (!input.fetchGraphNeighborhood) {
    return readGraphLinksFromEdges(input);
  }

  const neighborhood = await input.fetchGraphNeighborhood({
    sourceFileId: input.sourceFileId,
    limit: input.graph.limits.pageRelatedLimit
  });
  return neighborhood.relationships;
}

export async function attachGraphLinksToSummary(input: {
  summary: GeneratedPageSummary;
  graph: PublicationGraphState;
  publicFilePlans: PublicationPublicFilePlans;
  fetchGraphNeighborhood:
    | ((request: {
        sourceFileId: string;
        limit: number;
      }) => Promise<{ sourceFileId: string; relationships: OkfGraphRelationship[] }>)
    | undefined;
  fetchGraphEdgePage?: ((request: CursorPageRequest) => Promise<CursorPage<OkfGraphEdge>>) | undefined;
  pageSize: number;
}): Promise<GeneratedPageSummary> {
  const graphLinks = await readGraphLinks({
    graph: input.graph,
    sourceFileId: input.summary.fileId,
    publicFilePlans: input.publicFilePlans,
    fetchGraphNeighborhood: input.fetchGraphNeighborhood,
    fetchGraphEdgePage: input.fetchGraphEdgePage,
    pageSize: input.pageSize
  });

  return graphLinks.length > 0
    ? { ...input.summary, graphLinks }
    : input.summary;
}

async function readGraphLinksFromEdges(input: {
  graph: PublicationGraphState;
  sourceFileId: string;
  publicFilePlans: PublicationPublicFilePlans;
  fetchGraphEdgePage?: ((request: CursorPageRequest) => Promise<CursorPage<OkfGraphEdge>>) | undefined;
  pageSize: number;
}): Promise<OkfGraphRelationship[]> {
  if (!input.fetchGraphEdgePage) {
    return [];
  }

  const relationships: OkfGraphRelationship[] = [];
  let cursor: string | null = null;

  do {
    const page = await input.fetchGraphEdgePage({
      cursor,
      limit: input.pageSize
    });

    for (const edge of page.items) {
      if (edge.fromFileId === input.sourceFileId) {
        const plan = input.publicFilePlans.bySourceId.get(edge.toFileId);
        if (plan) {
          relationships.push(edgeToGraphRelationship(edge, plan, "outgoing"));
        }
      } else if (edge.toFileId === input.sourceFileId) {
        const plan = input.publicFilePlans.bySourceId.get(edge.fromFileId);
        if (plan) {
          relationships.push(edgeToGraphRelationship(edge, plan, "incoming"));
        }
      }

      if (relationships.length >= input.graph.limits.pageRelatedLimit) {
        return relationships;
      }
    }

    cursor = page.nextCursor;
  } while (cursor);

  return relationships;
}

function edgeToGraphRelationship(
  edge: OkfGraphEdge,
  plan: { pagePath: string },
  direction: "outgoing" | "incoming"
): OkfGraphRelationship {
  const fileId = direction === "outgoing" ? edge.toFileId : edge.fromFileId;
  return {
    fileId,
    path: plan.pagePath,
    title: titleFromPagePath(plan.pagePath),
    relationType: edge.relationType,
    direction,
    weight: edge.weight,
    reason: edge.reason,
    source: edge.source,
    ...(edge.evidence ? { evidence: edge.evidence } : {})
  };
}

function titleFromPagePath(path: string): string {
  const fileName = path.split("/").at(-1) ?? path;
  return fileName.replace(/\.md$/i, "");
}
