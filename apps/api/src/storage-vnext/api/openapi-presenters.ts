import { graphRefForFile } from "@focowiki/okf";
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
import type { StorageVnextReleaseReadPort } from "../release/ports.js";
import type { StorageVnextSearchResult } from "../search/ports.js";
import type { StorageVnextSourceEventSummary } from "../source-events/ports.js";
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
  direction: "incoming" | "outgoing";
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
  root: Awaited<ReturnType<StorageVnextReleaseReadPort["getActiveRoot"]>>
) {
  return {
    knowledgeBaseId: record.publicId,
    name: record.name,
    description: record.description,
    activeGenerationId: root?.publicId ?? null,
    resourceRevision: record.revision,
    catalogGeneration: root?.revision ?? 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export function presentOpenApiTreeEntry(
  knowledgeBaseId: string,
  generationId: string | null,
  entry: StorageVnextAdminTreeEntry
) {
  const fileId = entry.entryType === "file"
    ? entry.sourceFileId ?? entry.generatedFileId
    : null;
  return {
    generationId,
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
      : null,
    ancestors: []
  };
}

export function presentOpenApiGeneratedFile(
  knowledgeBaseId: string,
  generationId: string,
  file: Record<string, unknown>
) {
  const fileId = readString(file.id) ?? readString(file.sourceFileId);
  const path = readString(file.logicalPath);
  if (!fileId || !path) throw repositoryUnavailable();
  const frontmatter = readRecord(file.frontmatter) ?? {};
  return {
    generationId,
    fileId,
    knowledgeBaseId,
    sourceFileId: readString(file.sourceFileId),
    path,
    fileKind: readString(file.fileKind) ?? "page",
    contentType: readString(file.contentType) ?? "text/markdown; charset=utf-8",
    sizeBytes: readNumber(file.sizeBytes) ?? 0,
    okfType: readString(file.okfType),
    title: readString(file.title) ?? path.split("/").at(-1) ?? path,
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

export function presentOpenApiRelationship(
  knowledgeBaseId: string,
  generationId: string,
  row: StorageVnextOpenApiRelationship
) {
  return {
    generationId,
    edgeId: row.public_id,
    fileId: row.source_file_public_id,
    sourceFileId: row.source_file_public_id,
    path: row.logical_path,
    title: row.title,
    relationType: row.relation,
    direction: row.direction,
    weight: Number(row.weight),
    reason: row.reason ?? "Related Markdown file",
    source: "graph",
    evidence: {},
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
  generationId: string;
  mode: "file" | "graph" | "hybrid";
  depth: 0 | 1 | 2;
  nodePublicId: string | null;
  item: StorageVnextSearchResult;
  relationships: StorageVnextOpenApiRelationship[];
}) {
  const relationships = input.relationships.map((row) => presentOpenApiRelationship(
    input.knowledgeBaseId,
    input.generationId,
    row
  ));
  const graphContext = input.mode === "file" ? null : {
    graphRef: graphRefForFile(input.item.sourceFilePublicId),
    depth: input.depth,
    seedSourceFileId: input.item.sourceFilePublicId,
    matchedNodeFields: input.item.kind === "graph"
      ? [input.item.snippet ? "content" : "title"]
      : [],
    matchedRelationshipFields: [],
    relationships,
    graphPaths: [...new Set([
      input.item.sourceFilePublicId,
      ...input.relationships.map((row) => row.source_file_public_id)
    ])].map(graphRefForFile)
  };
  const frontmatter = input.item.metadata;
  return {
    generationId: input.generationId,
    nodeId: input.item.kind === "graph" ? input.nodePublicId : null,
    edgeId: null,
    fileId: input.item.sourceFilePublicId,
    generatedFileId: input.item.sourceFilePublicId,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.item.sourceFilePublicId,
    path: input.item.logicalPath,
    generatedFilePath: input.item.logicalPath,
    fileKind: "page",
    title: input.item.title,
    description: input.item.snippet,
    tags: readStringArray(frontmatter.tags) ?? [],
    frontmatter,
    okfSignals: presentOkfSignals(frontmatter),
    matchedFields: input.item.snippet ? ["description"] : ["title"],
    score: input.item.score,
    contentAvailable: true,
    matchType: input.mode === "file" ? "file_direct"
      : input.mode === "hybrid" ? "hybrid"
        : "graph_node",
    ...(graphContext ? { graphContext } : {}),
    readActions: openApiReadActions(
      input.knowledgeBaseId,
      input.item.sourceFilePublicId,
      input.item.logicalPath,
      input.item.sourceFilePublicId
    )
  };
}

export function presentOpenApiSourceEvent(
  event: StorageVnextSourceEventSummary
) {
  return {
    eventId: event.publicId,
    knowledgeBaseId: event.knowledgeBaseId,
    sourceFileId: event.sourceFilePublicId,
    stageKey: event.stageKey,
    messageKey: event.messageKey,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    severity: event.severity,
    createdAt: event.createdAt
  };
}

export function presentOpenApiGraphOverview(input: {
  knowledgeBaseId: string;
  generationId: string;
  nodeCount: number;
  edgeCount: number;
  graphIndexAvailable: boolean;
}) {
  const availability = !input.graphIndexAvailable ? "unavailable"
    : input.nodeCount > 0 || input.edgeCount > 0 ? "available" : "empty";
  const base = `/openapi/v2/knowledge-bases/${input.knowledgeBaseId}`;
  return {
    generationId: input.generationId,
    availability,
    summary: { nodeCount: input.nodeCount, edgeCount: input.edgeCount },
    resources: {
      graphIndexPath: input.graphIndexAvailable
        ? GENERATED_GRAPH_RESOURCES.index.path
        : null,
      nodeDirectoryPath: input.nodeCount > 0
        ? GENERATED_GRAPH_RESOURCES.nodeDirectoryPath
        : null,
      edgeDirectoryPath: input.edgeCount > 0
        ? GENERATED_GRAPH_RESOURCES.edgeDirectoryPath
        : null,
      byFileDirectoryPath: input.nodeCount > 0
        ? GENERATED_GRAPH_RESOURCES.byFileDirectoryPath
        : null
    },
    readActions: {
      readIndexContent: `${base}/files/content?path=index.md`,
      graphIndexContent: input.graphIndexAvailable
        ? graphFileContentAction(input.knowledgeBaseId, GENERATED_GRAPH_RESOURCES.index.path)
        : null,
      listGraphRoot: graphTreeAction(
        input.knowledgeBaseId,
        GENERATED_GRAPH_RESOURCES.rootDirectoryPath
      ),
      listGraphNodes: input.nodeCount > 0
        ? graphTreeAction(input.knowledgeBaseId, GENERATED_GRAPH_RESOURCES.nodeDirectoryPath)
        : null,
      listGraphEdges: input.edgeCount > 0
        ? graphTreeAction(input.knowledgeBaseId, GENERATED_GRAPH_RESOURCES.edgeDirectoryPath)
        : null,
      listByFileGraph: input.nodeCount > 0
        ? graphTreeAction(input.knowledgeBaseId, GENERATED_GRAPH_RESOURCES.byFileDirectoryPath)
        : null,
      searchGraph: `${base}/files/search?query={query}&mode=graph`,
      expandGraphByFileId: `${base}/graph/expand?fileId={fileId}`,
      fileDetailById: `${base}/files/{fileId}`,
      fileContentById: `${base}/files/{fileId}/content`,
      fileContentByPath: `${base}/files/content?path={path}`,
      relatedFilesById: `${base}/files/{fileId}/related`
    },
    message: availability === "available"
      ? "File relationships are available. Read the related Markdown files before using their content."
      : availability === "empty"
        ? "No file relationships are currently available. Relevant Markdown files may still exist."
        : "File relationships are not available yet. Continue with index.md, the file tree, and file search.",
    nextActions: [
      input.graphIndexAvailable
        ? "Read `_graph/index.md` or browse the `_graph/` directory to inspect file relationships."
        : "Read index.md and browse the file tree to discover relevant Markdown files.",
      "Search relationships, list related files, or explore from a file to find matching files.",
      "Read the returned Markdown files before using their content."
    ]
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
    cursorProvided: Boolean(input.cursor)
  };
}

export function emptyOpenApiSearchResponse(
  input: Parameters<DeveloperOpenApiApplication["searchFiles"]>[0],
  generationId: string | null
) {
  return {
    generationId,
    query: openApiSearchQuery(input, input.query.trim()),
    items: [],
    nextCursor: null,
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
      meaning: "No current published files matched the search."
    },
    nextRequestTemplates: openApiNextRequestTemplates(input.knowledgeBaseId)
  };
}

export function openApiNextRequestTemplates(knowledgeBaseId: string) {
  const base = `/openapi/v2/knowledge-bases/${knowledgeBaseId}`;
  return {
    searchAgain: `${base}/files/search?query={query}`,
    listTree: `${base}/tree?parentPath={parentPath}`,
    readIndex: `${base}/files/content?path=index.md`,
    fileDetailById: `${base}/files/{generatedFileId}`,
    fileContentById: `${base}/files/{generatedFileId}/content`,
    fileContentByPath: `${base}/files/content?path={generatedFilePath}`,
    relatedFilesById: `${base}/files/{generatedFileId}/related`,
    graphExpansionByFileId: `${base}/graph/expand?fileId={generatedFileId}`,
    sourceFileStatusById: `${base}/source-files/{sourceFileId}`,
    sourceFileEventsById: `${base}/source-files/{sourceFileId}/events`
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
    relatedFilesById: `${base}/files/${fileId}/related`,
    graphExpansionByFileId: `${base}/graph/expand?fileId=${fileId}`,
    sourceFileStatusById: sourceFileId ? `${base}/source-files/${sourceFileId}` : null,
    sourceFileEventsById: sourceFileId ? `${base}/source-files/${sourceFileId}/events` : null
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
