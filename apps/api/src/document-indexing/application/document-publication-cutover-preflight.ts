import { posix } from "node:path";

export type DocumentPublicationOwnerCandidate = Readonly<{
  scopeIdentity: string;
  artifactFamily: "source" | "page_directory" | "machine_index" | "term"
    | "graph" | "graph_catalog" | "root";
}>;

export function inferDocumentPublicationOwnerCandidate(input: Readonly<{
  normalizedPath: string;
  sourceFilePublicId: string | null;
}>): DocumentPublicationOwnerCandidate | null {
  const path = input.normalizedPath;
  if (input.sourceFilePublicId && path.startsWith("pages/")
    && !isNavigation(path)) {
    return owner(`source:${input.sourceFilePublicId}`, "source");
  }
  if (path === "_graph/catalog.json") {
    return owner("_graph:catalog", "graph_catalog");
  }
  if (input.sourceFilePublicId && path.startsWith("_graph/by-file/")
    && path.endsWith(".json") && !isNavigation(path)) {
    return owner(`_graph:${input.sourceFilePublicId}`, "graph");
  }
  if (path.startsWith("pages/") && isNavigation(path)) {
    return owner(`directory:${posix.dirname(path)}`, "page_directory");
  }
  if (path.startsWith("_index/pages/")) {
    const directory = posix.dirname(path);
    const pagesDirectory = `pages/${directory.slice("_index/pages/".length)}`
      .replace(/\/$/u, "");
    return owner(`_index:pages:${pagesDirectory}`, "machine_index");
  }
  if (path.startsWith("_index/terms/")) {
    const relative = path.slice("_index/terms/".length);
    const bucket = relative.split("/")[0];
    if (bucket && relative.includes("/")) {
      return owner(`_index:term:${bucket}`, "term");
    }
    return owner("_index:term-catalog", "term");
  }
  if (path.startsWith("_graph/by-directory/")) {
    const directory = posix.dirname(path);
    const pagesDirectory = `pages/${directory.slice(
      "_graph/by-directory/".length
    )}`.replace(/\/$/u, "");
    return owner(`_graph:directory:${pagesDirectory}`, "graph");
  }
  if (path.startsWith("_graph/by-file/") && isNavigation(path)) {
    const directory = posix.dirname(path);
    const pagesDirectory = `pages/${directory.slice("_graph/by-file/".length)}`
      .replace(/\/$/u, "");
    return owner(`_graph:file-directory:${pagesDirectory}`, "graph");
  }
  if (["index.md", "log.md", "_index/catalog.json"].includes(path)
    || (path.startsWith("_index/") && posix.dirname(path) === "_index")
    || (path.startsWith("_graph/") && posix.dirname(path) === "_graph")) {
    return owner("root:index", "root");
  }
  return null;
}

export function decideDocumentPublicationCutoverEligibility(input: Readonly<{
  activePathCount: number;
  unresolvedOwnerCount: number;
  duplicateProducerPathCount: number;
  unfinishedWorkCount: number;
  unverifiedObjectCount: number;
  searchOwnerMismatchCount: number;
}>): Readonly<{ eligible: boolean; blockers: readonly string[] }> {
  const blockers = [
    [input.unresolvedOwnerCount, "unresolved_path_owner"],
    [input.duplicateProducerPathCount, "duplicate_path_producer"],
    [input.unfinishedWorkCount, "unfinished_document_work"],
    [input.unverifiedObjectCount, "unverified_referenced_object"],
    [input.searchOwnerMismatchCount, "search_owner_mismatch"]
  ].flatMap(([count, code]) => Number(count) > 0 ? [String(code)] : []);
  return { eligible: blockers.length === 0, blockers };
}

function isNavigation(path: string): boolean {
  const name = posix.basename(path);
  return name === "index.md"
    || /^index-(?:directory|extension)-leaf-[^/]+\.md$/u.test(name);
}

function owner(
  scopeIdentity: string,
  artifactFamily: DocumentPublicationOwnerCandidate["artifactFamily"]
): DocumentPublicationOwnerCandidate {
  return { scopeIdentity, artifactFamily };
}
