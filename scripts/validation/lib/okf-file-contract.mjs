import path from "node:path";

const RESERVED_MARKDOWN_BASENAMES = new Set(["index.md", "log.md"]);

export function isReservedOkfMarkdownPath(logicalPath) {
  return RESERVED_MARKDOWN_BASENAMES.has(path.posix.basename(logicalPath));
}

export function requiresSourceBodyComparison(file) {
  return file?.fileKind === "page"
    && typeof file?.sourceFileId === "string"
    && file.sourceFileId.length > 0;
}

export function isManifestOwnedPath(logicalPath) {
  return logicalPath === "_index/manifest.json"
    || logicalPath.startsWith("_index/manifest/");
}
