const RESERVED_MARKDOWN_PATHS = new Set([
  "index.md",
  "log.md",
  "schema.md",
  "_graph/index.md",
  "_index/index.md"
]);

export function isReservedOkfMarkdownPath(logicalPath) {
  return RESERVED_MARKDOWN_PATHS.has(logicalPath);
}

export function validateReservedMarkdownFrontmatter(logicalPath, data) {
  const keys = Object.keys(data ?? {});

  if (logicalPath === "index.md") {
    return keys.length === 1
      && keys[0] === "okf_version"
      && data.okf_version === "0.2";
  }
  if (logicalPath === "schema.md") {
    return typeof data?.type === "string"
      && data.type.length > 0
      && typeof data?.title === "string"
      && data.title.length > 0;
  }

  return keys.length === 0;
}

export function validateProjectionCatalog(catalog) {
  if (
    catalog?.formatVersion !== 1
    || typeof catalog.knowledgeBaseId !== "string"
    || catalog.knowledgeBaseId.length === 0
    || typeof catalog.generationId !== "string"
    || catalog.generationId.length === 0
    || !isObject(catalog.projections)
  ) {
    return false;
  }

  const shardedProjectionKeys = [
    "search",
    "links",
    "manifest",
    "tree",
    "graphNodes",
    "graphEdges"
  ];
  if (!shardedProjectionKeys.every((key) =>
    isValidShardDescriptor(catalog.projections[key])
  )) {
    return false;
  }

  return catalog.projections.relatedFiles?.pathTemplate
    === "_graph/by-file/{fileId}.json";
}

export function requiresSourceBodyComparison(file) {
  return file?.fileKind === "page"
    && typeof file?.sourceFileId === "string"
    && file.sourceFileId.length > 0;
}

export function isManifestOwnedPath(logicalPath) {
  return logicalPath === "_index/catalog.json"
    || /^_index\/manifest\/v1\/[0-9]{4}\.json$/u.test(logicalPath);
}

function isValidShardDescriptor(value) {
  return isObject(value)
    && Array.isArray(value.shards)
    && value.shards.every((shard) =>
      isObject(shard)
      && isSafeLogicalPath(shard.path)
      && Number.isSafeInteger(shard.recordCount)
      && shard.recordCount >= 0
    );
}

function isSafeLogicalPath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && value.split("/").every((segment) =>
      segment.length > 0 && segment !== "." && segment !== ".."
    );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
