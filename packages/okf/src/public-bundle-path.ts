import { normalizeGeneratedLogicalPath } from "./source-path.js";
import { portableSemanticResourceFamilyForPath } from "./portable-bundle.js";

const ROOT_MARKDOWN_FILE = /^(?:index\.md|log\.md)$/u;
const INDEX_ROOT_FILE = new Set([
  "_index/index.md",
  "_index/catalog.json"
]);
const GRAPH_ROOT_FILE = new Set([
  "_graph/index.md",
  "_graph/catalog.json"
]);
const EXTENSION_STABLE_LEAF_ID = "(?!(?:map)-)[A-Za-z0-9](?:[A-Za-z0-9._-]{0,238}[A-Za-z0-9])?";
const EXTENSION_ROOT_NAVIGATION_MARKDOWN = new RegExp(
  `^_(?:index|graph)/index-${EXTENSION_STABLE_LEAF_ID}\\.md$`,
  "u"
);
const INDEX_NAVIGATION_MARKDOWN = new RegExp(
  `^_index/(?:pages(?:/[^/]+)*|terms(?:/(?:latin|han|kana|hangul|number|other))?)/(?:index\\.md|index-${EXTENSION_STABLE_LEAF_ID}\\.md)$`,
  "u"
);
const GRAPH_NAVIGATION_MARKDOWN = new RegExp(
  `^_graph/(?:by-directory|by-file)(?:/[^/]+)*/(?:index\\.md|index-${EXTENSION_STABLE_LEAF_ID}\\.md)$`,
  "u"
);
const INDEX_SEMANTIC_ROUTER_JSON = /^(?:_index\/pages(?:\/[^/]+)*\/index\.json|_index\/terms\/(?:index|(?:latin|han|kana|hangul|number|other)\/index)\.json)$/u;
const GRAPH_SEMANTIC_ROUTER_JSON = /^(?:_graph\/by-directory(?:\/[^/]+)*\/index\.json|_graph\/by-file\/(?:[^/]+\/)*(?!index\.json$)[^/]+\.json)$/u;
export function isAllowedPublicBundleFilePath(path: string): boolean {
  if (!isCanonicalGeneratedPath(path)) return false;
  if (ROOT_MARKDOWN_FILE.test(path)) return true;
  if (path.startsWith("pages/") && hasMarkdownExtension(path)) return true;
  if (
    INDEX_ROOT_FILE.has(path)
    || GRAPH_ROOT_FILE.has(path)
    || EXTENSION_ROOT_NAVIGATION_MARKDOWN.test(path)
    || INDEX_NAVIGATION_MARKDOWN.test(path)
    || GRAPH_NAVIGATION_MARKDOWN.test(path)
  ) return true;
  return INDEX_SEMANTIC_ROUTER_JSON.test(path)
    || GRAPH_SEMANTIC_ROUTER_JSON.test(path)
    || portableSemanticResourceFamilyForPath(path) !== null;
}

export function isAllowedPublicBundleDirectoryPath(path: string): boolean {
  if (path === "pages" || path === "_index" || path === "_graph") return true;
  if (!isCanonicalGeneratedPath(path)) return false;
  if (path.startsWith("pages/")) return !hasMarkdownExtension(path);
  return (
    /^(?:_index\/pages(?:\/[^/]+)*|_index\/terms(?:\/(?:latin|han|kana|hangul|number|other))?)$/u
      .test(path) ||
    /^_graph\/(?:by-directory|by-file)(?:\/[^/]+)*$/u.test(path)
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

export function hasMarkdownExtension(path: string): boolean {
  return path.toLocaleLowerCase("en-US").endsWith(".md");
}
