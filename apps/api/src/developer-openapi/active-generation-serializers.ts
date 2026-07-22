import type {
  ActiveGenerationFile,
  ActiveGenerationProjection
} from "../application/ports/active-generation-read-repository.js";
import { readTreeStatistics } from "../domain/tree-statistics.js";
import { graphRefForSourceFile } from "../search/graph-search-documents.js";

export function toDeveloperActiveFile(
  knowledgeBaseId: string,
  file: ActiveGenerationFile
) {
  const metadata = readObject(file.payload, "metadata");
  return {
    generationId: file.generationId,
    fileId: file.fileId,
    knowledgeBaseId,
    sourceFileId: file.sourceFileId,
    path: file.path,
    fileKind: fileKind(file.refKind, file.path),
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    okfType: readString(file.payload, "type") ?? readString(metadata, "type"),
    title: file.title,
    description: file.summary,
    tags: readStrings(file.payload, "tags"),
    frontmatter: metadata,
    deletable: file.refKind === "page" && Boolean(file.sourceFileId),
    contentAvailable: true,
    readActions: createReadActions({
      knowledgeBaseId,
      fileId: file.fileId,
      path: file.path,
      sourceFileId: file.sourceFileId
    })
  };
}

export function toDeveloperActiveTreeEntry(
  knowledgeBaseId: string,
  record: ActiveGenerationProjection
) {
  const path = record.path ?? readString(record.payload, "path") ?? "";
  const entryType = readString(record.payload, "kind") === "directory"
    ? "directory"
    : "file";
  const fileId = entryType === "file"
    ? readString(record.payload, "fileId") ?? record.sourceFileId
    : null;
  const statistics = readTreeStatistics(record.payload, entryType);
  return {
    generationId: record.generationId,
    id: record.recordId,
    fileId,
    sourceFileId: record.sourceFileId,
    directoryId: entryType === "directory" ? record.recordId : null,
    parentPath: record.parentPath ?? "",
    name: readString(record.payload, "name") ?? record.title ?? path.split("/").at(-1) ?? path,
    path,
    sortKey: record.sortKey,
    entryType,
    fileKind: entryType === "directory"
      ? null
      : readString(record.payload, "fileKind") ?? "page",
    ...statistics,
    resourceRevision: readNumber(record.payload, "resourceRevision"),
    deletable: Boolean(record.sourceFileId) || entryType === "directory",
    contentAvailable: Boolean(fileId),
    readActions: fileId
      ? createReadActions({ knowledgeBaseId, fileId, path, sourceFileId: record.sourceFileId })
      : null
  };
}

export function toDeveloperActiveSearchResult(
  knowledgeBaseId: string,
  record: ActiveGenerationProjection,
  graph?: {
    mode: "file" | "graph" | "hybrid";
    depth: 0 | 1 | 2;
    relationships: ActiveGenerationProjection[];
  }
) {
  const path = record.path ?? readString(record.payload, "path") ?? "";
  const fileId = readString(record.payload, "fileId") ?? record.sourceFileId ?? record.recordId;
  const metadata = readObject(record.payload, "metadata");
  const rawMatchType = readString(record.payload, "matchType");
  const matchType = graph?.mode === "hybrid"
    ? "hybrid"
    : rawMatchType ?? (graph?.mode === "graph" ? "graph_node" : "file_direct");
  const relationships = graph?.relationships ?? [];
  const nodeId = record.projectionKind === "graph_node" ? record.recordId : null;
  const edgeId = record.projectionKind === "graph_edge"
    ? readString(record.payload, "graphEdgeId") ?? record.recordId
    : null;
  const graphRef = record.sourceFileId ? graphRefForSourceFile(record.sourceFileId) : null;
  const graphContext = graph && graph.mode !== "file" && record.sourceFileId && graphRef
    ? {
        graphRef,
        depth: graph.depth,
        seedSourceFileId: record.sourceFileId,
        matchedNodeFields: record.projectionKind === "graph_node" ? matchedFields(record) : [],
        matchedRelationshipFields: record.projectionKind === "graph_edge"
          ? ["title", "reason", "evidence"]
          : [],
        relationships: relationships.map((relationship) =>
          toDeveloperActiveRelatedFile(knowledgeBaseId, relationship)
        ),
        graphPaths: [...new Set([
          graphRef,
          ...relationships
            .map((relationship) => relationship.relatedSourceFileId)
            .filter((sourceFileId): sourceFileId is string => Boolean(sourceFileId))
            .map(graphRefForSourceFile)
        ])]
      }
    : null;
  return {
    generationId: record.generationId,
    nodeId,
    edgeId,
    fileId,
    generatedFileId: fileId,
    knowledgeBaseId,
    sourceFileId: record.sourceFileId,
    path,
    generatedFilePath: path,
    fileKind: "page",
    title: record.title,
    description: record.summary ?? readString(record.payload, "description"),
    tags: readStrings(record.payload, "tags"),
    frontmatter: metadata,
    matchedFields: matchedFields(record),
    score: record.score ?? 0,
    contentAvailable: true,
    matchType,
    ...(graphContext ? { graphContext } : {}),
    readActions: createReadActions({
      knowledgeBaseId,
      fileId,
      path,
      sourceFileId: record.sourceFileId
    })
  };
}

export function toDeveloperActiveRelatedFile(
  knowledgeBaseId: string,
  record: ActiveGenerationProjection
) {
  const fileId = record.relatedSourceFileId ?? record.recordId;
  const path = record.path ?? "";
  const seedIsFrom = readString(record.payload, "toFileId") === fileId;
  return {
    generationId: record.generationId,
    edgeId: record.recordId,
    fileId,
    sourceFileId: fileId,
    path,
    title: record.title,
    relationType: readString(record.payload, "relationType") ?? "related",
    direction: seedIsFrom ? "outgoing" : "incoming",
    weight: readNumber(record.payload, "weight") ?? record.score ?? 0,
    reason: readString(record.payload, "reason") ?? record.summary ?? "Related source-backed file",
    source: readString(record.payload, "source") ?? "graph",
    evidence: readObject(record.payload, "evidence"),
    contentAvailable: true,
    readActions: createReadActions({
      knowledgeBaseId,
      fileId,
      path,
      sourceFileId: fileId
    })
  };
}

export function createReadActions(input: {
  knowledgeBaseId: string;
  fileId: string;
  path: string;
  sourceFileId: string | null;
}) {
  const base = `/openapi/v2/knowledge-bases/${input.knowledgeBaseId}`;
  return {
    fileDetailById: `${base}/files/${input.fileId}`,
    fileContentById: `${base}/files/${input.fileId}/content`,
    fileContentByPath: `${base}/files/content?path=${encodeURIComponent(input.path)}`,
    relatedFilesById: input.sourceFileId
      ? `${base}/files/${input.fileId}/related`
      : null,
    graphExpansionByFileId: input.sourceFileId
      ? `${base}/graph/expand?fileId=${input.fileId}`
      : null,
    sourceFileStatusById: input.sourceFileId ? `${base}/source-files/${input.sourceFileId}` : null,
    sourceFileEventsById: input.sourceFileId ? `${base}/source-files/${input.sourceFileId}/events` : null
  };
}

function fileKind(refKind: string, path: string): string {
  if (refKind === "page") return "page";
  if (refKind === "directory_root") return "directory_index";
  if (refKind === "directory_leaf") return "directory_index_page";
  if (refKind === "projection_shard") return "index_catalog";
  if (path === "index.md") return "index";
  if (path === "schema.md") return "schema";
  if (path === "log.md") return "log";
  if (path.startsWith("_graph/")) return "graph_index";
  return "index";
}

function matchedFields(record: ActiveGenerationProjection): string[] {
  const values = [
    record.path ? "path" : null,
    record.title ? "title" : null,
    record.summary ? "description" : null,
    Object.keys(readObject(record.payload, "metadata")).length > 0 ? "metadata" : null
  ];
  return values.filter((value): value is string => Boolean(value));
}

function readObject(value: unknown, key?: string): Record<string, unknown> {
  const target = key ? readProperty(value, key) : value;
  return target && typeof target === "object" && !Array.isArray(target) && !(target instanceof Date)
    ? target as Record<string, unknown>
    : {};
}

function readString(value: unknown, key: string): string | null {
  const target = readProperty(value, key);
  return typeof target === "string" ? target : null;
}

function readNumber(value: unknown, key: string): number | null {
  const target = readProperty(value, key);
  return typeof target === "number" && Number.isFinite(target) ? target : null;
}

function readStrings(value: unknown, key: string): string[] {
  const target = readProperty(value, key);
  return Array.isArray(target)
    ? target.filter((item): item is string => typeof item === "string")
    : [];
}

function readProperty(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
