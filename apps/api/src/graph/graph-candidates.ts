import type { OkfGraphNode } from "@focowiki/okf";
import type {
  FileGraphRelatedRecord,
  FileGraphRepository
} from "../db/admin-repositories.js";
import { isUsefulTerm } from "./content-profile.js";
import {
  extractPathTerms,
  extractSearchTerms,
  readContentProfileStringArray,
  unique
} from "./graph-utils.js";

export function buildCandidateTerms(node: OkfGraphNode): string[] {
  const definitions = readContentProfileStringArray(node, "definitions");
  const processHints = readContentProfileStringArray(node, "processHints");
  const versionHints = readContentProfileStringArray(node, "versionHints");
  const evidencePhrases = readContentProfileStringArray(node, "evidencePhrases");

  return unique([
    ...extractSearchTerms(node.title),
    ...extractPathTerms(node.path),
    ...(node.subjects ?? []),
    ...(node.entities ?? []),
    ...(node.keywords ?? []),
    ...(node.explicitReferences ?? []),
    ...(node.relationshipHints ?? []),
    ...definitions,
    ...processHints,
    ...versionHints,
    ...evidencePhrases,
    ...(node.tags ?? [])
  ])
    .filter(isUsefulTerm)
    .slice(0, 100);
}

export async function listCandidateNodes(input: {
  graph: FileGraphRepository;
  knowledgeBaseId: string;
  sourceFileId: string;
  candidateTerms: string[];
  pageSize: number;
  maxCandidateNodes: number;
}): Promise<OkfGraphNode[]> {
  const candidatesById = new Map<string, OkfGraphNode>();
  const indexedCandidates = input.graph.listGraphCandidates
    ? await input.graph.listGraphCandidates({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.sourceFileId,
        terms: input.candidateTerms,
        limit: input.maxCandidateNodes
      })
    : [];

  for (const candidate of indexedCandidates) {
    if (candidate.fileId !== input.sourceFileId) {
      candidatesById.set(candidate.fileId, candidate);
    }
  }

  if (candidatesById.size < input.maxCandidateNodes) {
    const neighborhood = await input.graph.listGraphNeighborhood({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFileId: input.sourceFileId,
      limit: input.maxCandidateNodes - candidatesById.size,
      cursor: null
    });

    for (const related of neighborhood.items) {
      if (related.sourceFileId !== input.sourceFileId && !candidatesById.has(related.sourceFileId)) {
        candidatesById.set(related.sourceFileId, graphNodeFromRelatedRecord(related));
      }
    }
  }

  let cursor: string | null = null;

  while (candidatesById.size < input.maxCandidateNodes) {
    const page = await input.graph.listGraphNodes({
      knowledgeBaseId: input.knowledgeBaseId,
      limit: input.pageSize,
      cursor
    });

    for (const node of page.items.filter((node) => node.fileId !== input.sourceFileId)) {
      if (candidatesById.size >= input.maxCandidateNodes) {
        break;
      }
      candidatesById.set(node.fileId, node);
    }
    cursor = page.nextCursor;

    if (!cursor) {
      break;
    }
  }

  return Array.from(candidatesById.values()).slice(0, input.maxCandidateNodes);
}

function graphNodeFromRelatedRecord(record: FileGraphRelatedRecord): OkfGraphNode {
  return {
    fileId: record.sourceFileId,
    path: record.path,
    title: record.title,
    type: "page",
    tags: [],
    subjects: [],
    entities: [],
    keywords: extractSearchTerms(record.title),
    metadata: {
      priorGraphContext: {
        relationType: record.relationType,
        direction: record.direction,
        source: record.source
      }
    }
  };
}
