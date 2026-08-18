import { portableByFileGraphPath } from "@focowiki/okf";
import {
  repositoryUnavailable,
  validationError
} from "../../developer-openapi/errors.js";
import { isAllowedPublicGeneratedFilePath } from "../../public-generated-path.js";
import {
  GENERATED_GRAPH_RESOURCES,
  graphFileContentAction,
  graphTreeAction
} from "../../okf/generated-graph-resources.js";
import type { StorageVnextSearchResult } from "../search/ports.js";
import type { StorageVnextAdminTreeEntry } from "./admin-ports.js";
import type { DeveloperOpenApiApplication } from "./openapi-application.js";
import { presentOkfSignals } from "./okf-signal-presentation.js";

export type StorageVnextOpenApiRelationship = {
  public_id: string;
  source_file_public_id: string;
  logical_path: string;
  title: string;
  relation: string;
  weight: number | string;
  reason: string | null;
  direction: "incoming" | "outgoing" | "bidirectional";
  from_source_file_public_id?: string;
  relationship_depth?: number | string;
};

export function presentOpenApiKnowledgeBase(
  record: {
    publicId: string;
    name: string;
    description: string | null;
    revision: number;
    createdAt: string;
    updatedAt: string;
  },
  activationRevision: number
) {
  return {
    knowledgeBaseId: record.publicId,
    name: record.name,
    description: record.description,
    activeContentRevision: activationRevision,
    resourceRevision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export function presentOpenApiTreeEntry(
  knowledgeBaseId: string,
  activeContentRevision: number | null,
  entry: StorageVnextAdminTreeEntry
) {
  const fileId = entry.entryType === "file"
    ? entry.sourceFileId ?? entry.generatedFileId
    : null;
  return {
    activeContentRevision,
    id: entry.id,
    fileId,
    sourceFileId: entry.sourceFileId,
    directoryId: entry.sourceDirectoryId,
    parentPath: entry.parentPath,
    name: entry.name,
    path: entry.logicalPath,
    sortKey: entry.sortKey,
    entryType: entry.entryType,
    fileKind: entry.fileKind,
    directEntryCount: entry.directEntryCount,
    directDirectoryCount: entry.directDirectoryCount,
    directFileCount: entry.directFileCount,
    descendantFileCount: entry.descendantFileCount,
    resourceRevision: entry.resourceRevision,
    deletable: entry.deletable,
    contentAvailable: Boolean(fileId),
    readActions: fileId
      ? openApiReadActions(knowledgeBaseId, fileId, entry.logicalPath, entry.sourceFileId)
      : null
  };
}

export function presentOpenApiGeneratedFile(
  knowledgeBaseId: string,
  activeContentRevision: number,
  file: Record<string, unknown>,
  content?: string
) {
  const fileId = readString(file.id) ?? readString(file.sourceFileId);
  const path = readString(file.logicalPath);
  if (!fileId || !path) throw repositoryUnavailable();
  const frontmatter = readRecord(file.frontmatter) ?? {};
  return {
    activeContentRevision,
    fileId,
    knowledgeBaseId,
    sourceFileId: readString(file.sourceFileId),
    path,
    fileKind: readString(file.fileKind) ?? "page",
    contentType: readString(file.contentType) ?? "text/markdown; charset=utf-8",
    sizeBytes: readNumber(file.sizeBytes) ?? 0,
    okfType: readString(file.okfType),
    title: readString(frontmatter.title)
      ?? firstMarkdownHeading(content)
      ?? readString(file.title)
      ?? path.split("/").at(-1)
      ?? path,
    description: readString(file.description),
    tags: readStringArray(frontmatter.tags) ?? readStringArray(file.tags) ?? [],
    frontmatter,
    okfSignals: presentOkfSignals(frontmatter),
    deletable: file.deletable === true,
    contentAvailable: true,
    readActions: openApiReadActions(
      knowledgeBaseId,
      fileId,
      path,
      readString(file.sourceFileId)
    )
  };
}

function firstMarkdownHeading(content: string | undefined): string | null {
  if (!content) return null;
  for (const line of content.split(/\r?\n/u)) {
    const match = /^#\s+(.+?)\s*$/u.exec(line);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return null;
}

export function presentOpenApiRelationship(
  knowledgeBaseId: string,
  activeContentRevision: number,
  row: StorageVnextOpenApiRelationship
) {
  return {
    activeContentRevision,
    fileId: row.source_file_public_id,
    sourceFileId: row.source_file_public_id,
    path: row.logical_path,
    title: row.title,
    relationType: row.relation,
    direction: row.direction,
    fromFileId: row.from_source_file_public_id ?? row.source_file_public_id,
    relationshipDepth: Number(row.relationship_depth ?? 1),
    reason: row.reason,
    contentAvailable: true,
    readActions: openApiReadActions(
      knowledgeBaseId,
      row.source_file_public_id,
      row.logical_path,
      row.source_file_public_id
    )
  };
}

export function presentOpenApiSearchResult(input: {
  knowledgeBaseId: string;
  activeContentRevision: number;
  mode: "file" | "graph" | "hybrid";
  depth: 0 | 1 | 2;
  item: StorageVnextSearchResult;
  relationships: StorageVnextOpenApiRelationship[];
}) {
  const semanticMatchedFields = input.item.evidenceFamilies?.flatMap(
    searchMatchedFields
  );
  const semanticEvidenceTypes = input.item.evidenceFamilies?.map(
    searchEvidenceType
  );
  const relationships = input.relationships.map((row) => presentOpenApiRelationship(
    input.knowledgeBaseId,
    input.activeContentRevision,
    row
  ));
  const graphContext = input.mode === "file" ? null : {
    graphRef: portableByFileGraphPath(input.item.logicalPath),
    depth: input.depth,
    seedSourceFileId: input.item.sourceFilePublicId,
    relationships,
    graphPaths: [...new Set([
      input.item.logicalPath,
      ...input.relationships.map((row) => row.logical_path)
    ])].map(portableByFileGraphPath)
  };
  const frontmatter = input.item.metadata;
  return {
    activeContentRevision: input.activeContentRevision,
    fileId: input.item.sourceFilePublicId,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.item.sourceFilePublicId,
    path: input.item.logicalPath,
    fileKind: "page",
    title: input.item.title,
    description: readString(frontmatter.description),
    tags: readStringArray(frontmatter.tags) ?? [],
    frontmatter,
    okfSignals: presentOkfSignals(frontmatter),
    matchedFields: input.item.matchedFields
      ? [...input.item.matchedFields]
      : semanticMatchedFields?.length
        ? uniqueStrings(semanticMatchedFields)
      : input.item.snippet ? ["description"] : ["title"],
    evidenceTypes: input.item.evidenceTypes
      ? [...input.item.evidenceTypes]
      : semanticEvidenceTypes?.length
        ? uniqueStrings(semanticEvidenceTypes)
      : [input.item.kind === "graph" ? "file_relationship" : "content"],
    sourceExcerpt: input.item.sourceExcerpt
      ?? (input.item.kind === "file" ? input.item.snippet : null),
    score: input.item.score,
    contentAvailable: true,
    matchType: searchMatchType(input.item),
    ...(graphContext ? { graphContext } : {}),
    readActions: openApiReadActions(
      input.knowledgeBaseId,
      input.item.sourceFilePublicId,
      input.item.logicalPath,
      input.item.sourceFilePublicId
    )
  };
}

function searchMatchType(item: StorageVnextSearchResult) {
  const families = new Set(item.evidenceFamilies ?? []);
  const hasFileEvidence = [
    "exact_path", "exact_title", "lexical", "jieba", "content_vector"
  ].some((family) => families.has(family));
  const hasGraphEvidence = [
    "file_graph", "file_relationship", "entity_vector",
    "relationship_vector", "community_vector"
  ].some((family) => families.has(family));
  if (hasFileEvidence && hasGraphEvidence) return "hybrid";
  if (families.has("relationship_vector")) return "graph_edge";
  if (families.has("file_relationship")) return "graph_edge";
  if (families.has("file_graph")) return "graph_neighbor";
  if (hasGraphEvidence || item.kind === "graph") return "graph_node";
  return "file_direct";
}

function searchMatchedFields(family: string): string[] {
  if (family === "exact_path") return ["path"];
  if (family === "exact_title") return ["title"];
  if (family === "file_graph") return ["graph_node"];
  if (family === "file_relationship") return ["file_relationship"];
  return ["content"];
}

function searchEvidenceType(family: string): string {
  if (family === "exact_path") return "path";
  if (family === "exact_title") return "title";
  if (family === "file_graph") return "graph_node";
  if (family === "file_relationship") return "file_relationship";
  if (family === "entity_vector") return "entity";
  if (family === "relationship_vector") return "relationship";
  if (family === "community_vector") return "community";
  return "content";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en"));
}

export function presentOpenApiGraphOverview(input: {
  knowledgeBaseId: string;
  activeContentRevision: number;
  nodeCount: number;
  edgeCount: number;
  graphIndexAvailable: boolean;
}) {
  const availability = !input.graphIndexAvailable ? "unavailable"
    : input.edgeCount > 0 ? "available" : "empty";
  return {
    activeContentRevision: input.activeContentRevision,
    availability,
    summary: {
      readableFileCount: input.nodeCount,
      relationshipCount: input.edgeCount
    },
    resources: {
      graphIndexPath: input.graphIndexAvailable
        ? GENERATED_GRAPH_RESOURCES.index.path
        : null,
      byDirectoryPath: input.edgeCount > 0
        ? GENERATED_GRAPH_RESOURCES.edgeDirectoryPath
        : null,
      byFilePath: input.nodeCount > 0
        ? GENERATED_GRAPH_RESOURCES.byFileDirectoryPath
        : null
    },
    readActions: {
      graphIndexContent: input.graphIndexAvailable
        ? graphFileContentAction(input.knowledgeBaseId, GENERATED_GRAPH_RESOURCES.index.path)
        : null,
      listGraphRoot: graphTreeAction(
        input.knowledgeBaseId,
        GENERATED_GRAPH_RESOURCES.rootDirectoryPath
      ),
      listRelationshipsByDirectory: input.edgeCount > 0
        ? graphTreeAction(input.knowledgeBaseId, GENERATED_GRAPH_RESOURCES.edgeDirectoryPath)
        : null,
      listRelationshipsByFile: input.nodeCount > 0
        ? graphTreeAction(input.knowledgeBaseId, GENERATED_GRAPH_RESOURCES.byFileDirectoryPath)
        : null
    }
  };
}

export function openApiSearchQuery(
  input: Parameters<DeveloperOpenApiApplication["searchFiles"]>[0],
  normalizedQuery: string
) {
  return {
    query: input.query,
    normalizedQuery,
    scope: input.scope,
    fileKind: input.fileKind ?? "all",
    mode: input.mode,
    graphDepth: input.graphDepth,
    graphFanout: input.graphFanout,
    okfStatus: input.okfFilters?.status ?? null,
    okfTrustTier: input.okfFilters?.trustTier ?? null,
    okfFreshness: input.okfFilters?.freshness ?? null,
    limit: input.limit,
    rerank: input.rerank,
    rerankTopK: input.rerankTopK,
    rerankScoreThreshold: input.rerankScoreThreshold,
    cursorProvided: Boolean(input.cursor)
  };
}

export function emptyOpenApiSearchResponse(
  input: Parameters<DeveloperOpenApiApplication["searchFiles"]>[0],
  activeContentRevision: number | null
) {
  return {
    activeContentRevision,
    query: openApiSearchQuery(input, input.query.trim()),
    items: [],
    nextCursor: null,
    semanticStatus: {
      state: "unavailable" as const,
      safeCode: "SEMANTIC_ADOPTION_REQUIRED"
    },
    evidenceStatus: {
      completedFamilies: [],
      degradedFamilies: []
    },
    rerankerStatus: input.rerank
      ? {
          state: "skipped" as const,
          safeCode: "RERANKER_RETRIEVAL_UNAVAILABLE"
        }
      : { state: "skipped" as const, safeCode: "RERANKER_DISABLED" },
    searchStatus: "no_candidates",
    searchMode: input.mode,
    graphStatus: input.mode === "file" ? "disabled_for_file_mode" : "index_unavailable",
    graphSummary: {
      available: false,
      indexedDocumentCount: 0,
      indexedRelationshipCount: 0,
      depth: input.graphDepth,
      fanout: input.graphFanout
    },
    resultSummary: {
      resultCount: 0,
      hasMore: false,
      sort: ["relevance_desc", "logical_path_asc", "source_file_id_asc"],
      meaning: "No current readable files matched the search."
    }
  };
}

export function openApiNoCandidateSearchHints() {
  return {
    message:
      "No generated files matched this query. The knowledge base may still contain relevant data through different titles, paths, or metadata terms.",
    nextActions: [
      "Split the user question into shorter terms and search again.",
      "Read index.md through the file content endpoint.",
      "List the file tree and continue exploration from visible directories.",
      "Try title, path, subject, product name, workflow, identifier, or shorter terms from the question.",
      "Use graph or hybrid search mode when a direct file search does not find enough evidence."
    ]
  };
}

export function assertOpenApiPublicFilePath(path: string): void {
  if (!isAllowedPublicGeneratedFilePath(path)) {
    throw validationError("This knowledge-base file path is not supported.", { field: "path" });
  }
}

function openApiReadActions(
  knowledgeBaseId: string,
  fileId: string,
  path: string,
  sourceFileId: string | null
) {
  const base = `/openapi/v2/knowledge-bases/${knowledgeBaseId}`;
  return {
    fileDetailById: `${base}/files/${fileId}`,
    fileContentById: `${base}/files/${fileId}/content`,
    fileContentByPath: `${base}/files/content?path=${encodeURIComponent(path)}`,
    relatedFilesById: sourceFileId ? `${base}/files/${fileId}/related` : null,
    graphExpansionByFileId: sourceFileId
      ? `${base}/graph/expand?fileId=${fileId}`
      : null,
    sourceFileStatusById: sourceFileId ? `${base}/source-files/${sourceFileId}` : null
  };
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
