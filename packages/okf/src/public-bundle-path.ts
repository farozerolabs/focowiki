import { normalizeGeneratedLogicalPath } from "./source-path.js";

const ROOT_MARKDOWN_FILE = /^(?:index|log|schema(?:-[a-z0-9-]+)?)(?:-\d{6})?\.md$/u;
const INDEX_ROOT_FILE = new Set([
  "_index/index.md",
  "_index/catalog.json"
]);
const GRAPH_ROOT_FILE = new Set([
  "_graph/index.md"
]);

export function isAllowedPublicBundleFilePath(path: string): boolean {
  if (!isCanonicalGeneratedPath(path)) return false;
  if (ROOT_MARKDOWN_FILE.test(path)) return true;
  if (path.startsWith("pages/") && path.endsWith(".md")) return true;
  if (INDEX_ROOT_FILE.has(path) || GRAPH_ROOT_FILE.has(path)) return true;
  return (
    /^_index\/(?:manifest|search|links|tree)\/v1\/[0-9]{4}\.json$/u.test(path) ||
    /^_graph\/(?:graph_node|graph_edge)\/v1\/[0-9]{4}\.json$/u.test(path) ||
    /^_graph\/by-file\/[^/]+\.json$/u.test(path)
  );
}

export function isAllowedPublicBundleDirectoryPath(path: string): boolean {
  if (path === "pages" || path === "_index" || path === "_graph") return true;
  if (!isCanonicalGeneratedPath(path)) return false;
  if (path.startsWith("pages/")) return !path.endsWith(".md");
  return (
    /^_index\/(?:manifest|search|links|tree)(?:\/v1)?$/u.test(path) ||
    /^_graph\/(?:graph_node|graph_edge)(?:\/v1)?$/u.test(path) ||
    path === "_graph/by-file"
  );
}

export function publicBundleContentType(path: string): string {
  if (path.endsWith(".jsonl")) return "application/x-ndjson; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/markdown; charset=utf-8";
}

export function toBundleMarkdownHref(path: string): string {
  const normalized = normalizeGeneratedLogicalPath(path.replace(/^\/+/, ""));
  return `/${normalized.split("/").map(encodeURIComponent).join("/")}`;
}

function isCanonicalGeneratedPath(path: string): boolean {
  try {
    return normalizeGeneratedLogicalPath(path) === path;
  } catch {
    return false;
  }
}
