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

export function requiresSourceBodyComparison(file) {
  return file?.fileKind === "page"
    && typeof file?.sourceFileId === "string"
    && file.sourceFileId.length > 0;
}

export function isManifestOwnedPath(logicalPath) {
  return logicalPath === "_index/catalog.json"
    || /^_index\/manifest\/v1\/[0-9]{4}\.json$/u.test(logicalPath);
}
