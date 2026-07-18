import type {
  ActiveGenerationFile,
  ActiveGenerationProjection
} from "../application/ports/active-generation-read-repository.js";

export function toAdminActiveTreeEntry(record: ActiveGenerationProjection) {
  const entryType = readString(record.payload, "kind") === "directory"
    ? "directory" as const
    : "file" as const;
  const logicalPath = record.path ?? readString(record.payload, "path") ?? "";
  const sourceFileId = entryType === "file" ? record.sourceFileId : null;
  const sourceDirectoryId = entryType === "directory"
    ? readString(record.payload, "sourceDirectoryId")
    : null;
  return {
    id: record.recordId,
    parentPath: record.parentPath ?? readString(record.payload, "parentPath") ?? "",
    name: readString(record.payload, "name")
      ?? record.title
      ?? logicalPath.split("/").at(-1)
      ?? logicalPath,
    logicalPath,
    sortKey: record.sortKey,
    entryType,
    generatedFileId: entryType === "file"
      ? readString(record.payload, "fileId") ?? sourceFileId
      : null,
    sourceFileId,
    sourceDirectoryId,
    fileKind: entryType === "file"
      ? readString(record.payload, "fileKind") ?? (sourceFileId ? "page" : "index")
      : null,
    childCount: readNumber(record.payload, "childCount") ?? 0,
    directFileCount: readNumber(record.payload, "directFileCount") ?? 0,
    descendantFileCount: readNumber(record.payload, "descendantFileCount") ?? 0,
    resourceRevision: readNumber(record.payload, "resourceRevision"),
    deletable: Boolean(sourceFileId || sourceDirectoryId)
  };
}

export function toAdminActiveFile(file: ActiveGenerationFile) {
  const metadata = readObject(file.payload, "metadata");
  return {
    id: file.fileId,
    sourceFileId: file.sourceFileId,
    fileKind: activeFileKind(file),
    logicalPath: file.path,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    okfType: readString(file.payload, "type") ?? readString(metadata, "type"),
    title: file.title,
    description: file.summary,
    tags: readStrings(file.payload, "tags"),
    frontmatter: metadata,
    deletable: file.refKind === "page" && Boolean(file.sourceFileId)
  };
}

export function toAdminActiveRelationship(record: ActiveGenerationProjection) {
  const fileId = record.relatedSourceFileId ?? record.recordId;
  const path = record.path ?? "";
  const direction = readString(record.payload, "fromFileId") === record.sourceFileId
    ? "outgoing" as const
    : "incoming" as const;
  return {
    fileId,
    sourceFileId: fileId,
    generatedFileId: fileId,
    path,
    title: record.title ?? path.split("/").at(-1) ?? path,
    relationType: readString(record.payload, "relationType") ?? "related",
    direction,
    weight: readNumber(record.payload, "weight") ?? record.score ?? 0,
    reason: readString(record.payload, "reason")
      ?? record.summary
      ?? "Related source-backed file",
    source: readString(record.payload, "source") ?? "graph",
    contentAvailable: Boolean(path)
  };
}

function activeFileKind(file: ActiveGenerationFile): string {
  if (file.refKind === "page") return "page";
  if (file.path === "index.md") return "index";
  if (file.path === "schema.md") return "schema";
  if (file.path === "log.md") return "log";
  if (file.refKind === "directory_root" || file.refKind === "directory_leaf") {
    return "index";
  }
  if (file.path.startsWith("_graph/")) return "graph_index";
  if (file.path.startsWith("_index/")) return "search_index";
  return "index";
}

function readObject(value: unknown, key: string): Record<string, unknown> {
  const property = readProperty(value, key);
  return property && typeof property === "object" && !Array.isArray(property)
    ? property as Record<string, unknown>
    : {};
}

function readString(value: unknown, key: string): string | null {
  const property = readProperty(value, key);
  return typeof property === "string" ? property : null;
}

function readNumber(value: unknown, key: string): number | null {
  const property = readProperty(value, key);
  return typeof property === "number" && Number.isFinite(property) ? property : null;
}

function readStrings(value: unknown, key: string): string[] {
  const property = readProperty(value, key);
  return Array.isArray(property)
    ? property.filter((item): item is string => typeof item === "string")
    : [];
}

function readProperty(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
