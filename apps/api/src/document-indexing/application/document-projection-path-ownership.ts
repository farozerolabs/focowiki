import { posix } from "node:path";
import {
  isAllowedPublicBundleDirectoryPath,
  isAllowedPublicBundleFilePath,
  normalizeGeneratedLogicalPath,
  portableByFileGraphDirectoryPath,
  portableGraphDirectoryPath,
  portableIndexDirectoryPath
} from "@focowiki/okf";
import type { DocumentPublicationRenderScope } from
  "./document-publication-job-ports.js";

export type DocumentProjectionScopeIdentity = Pick<
  DocumentPublicationRenderScope,
  "kind" | "key"
>;

export type DocumentProjectionPathOwnershipInput = Readonly<{
  scope: DocumentProjectionScopeIdentity;
  logicalPath: string;
  sourceFilePublicId?: string | null;
}>;

const NAVIGATION_LEAF = /^index-(?:directory|extension)-leaf-[^/]+\.md$/u;
const TERM_BUCKETS = new Set([
  "latin", "han", "kana", "hangul", "number", "other"
]);

export function normalizeDocumentProjectionOwnedPath(path: string): string {
  const logicalPath = normalizeGeneratedLogicalPath(path);
  if (!isAllowedPublicBundleFilePath(logicalPath)) {
    throw pathOwnershipError("projection_path_not_public");
  }
  return logicalPath.toLocaleLowerCase("en-US");
}

export function documentProjectionScopeIdentity(
  scope: DocumentProjectionScopeIdentity
): string {
  validateScopeKey(scope);
  return `${scope.kind}:${scope.key}`;
}

export function isDocumentProjectionPathOwnedBy(
  input: DocumentProjectionPathOwnershipInput
): boolean {
  const logicalPath = normalizeGeneratedLogicalPath(input.logicalPath);
  if (!isAllowedPublicBundleFilePath(logicalPath)) return false;
  const { scope } = input;
  validateScopeKey(scope);
  if (scope.kind === "source") {
    return input.sourceFilePublicId === scope.key
      && logicalPath.startsWith("pages/")
      && logicalPath.endsWith(".md")
      && !isNavigationFile(logicalPath);
  }
  if (scope.kind === "directory") {
    return ownsDirectoryNavigation(scope.key, logicalPath);
  }
  if (scope.kind === "_index") {
    return ownsIndexPath(scope.key, logicalPath);
  }
  if (scope.kind === "_graph") {
    return ownsGraphPath(scope.key, logicalPath, input.sourceFilePublicId);
  }
  return scope.kind === "root" && scope.key === "index"
    && ownsRootPath(logicalPath);
}

export function isDocumentProjectionDirectoryOwnedBy(input: Readonly<{
  scope: DocumentProjectionScopeIdentity;
  directoryPath: string;
}>): boolean {
  const directoryPath = normalizeDirectoryPath(input.directoryPath);
  const { scope } = input;
  validateScopeKey(scope);
  if (scope.kind === "directory") return directoryPath === scope.key;
  if (scope.kind === "_index" && scope.key.startsWith("pages:")) {
    return directoryPath === portableIndexDirectoryPath(
      scope.key.slice("pages:".length)
    );
  }
  if (scope.kind === "_index" && scope.key.startsWith("term:")) {
    return directoryPath === `_index/terms/${scope.key.slice("term:".length)}`;
  }
  if (scope.kind === "_index" && scope.key === "term-catalog") {
    return directoryPath === "_index/terms";
  }
  if (scope.kind === "_graph" && scope.key.startsWith("directory:")) {
    return directoryPath === portableGraphDirectoryPath(
      scope.key.slice("directory:".length)
    );
  }
  if (scope.kind === "_graph" && scope.key.startsWith("file-directory:")) {
    return directoryPath === portableByFileGraphDirectoryPath(
      scope.key.slice("file-directory:".length)
    );
  }
  return scope.kind === "root" && scope.key === "index"
    && (directoryPath === "_index" || directoryPath === "_graph");
}

export function assertDocumentProjectionPathOwnership(
  input: DocumentProjectionPathOwnershipInput
): void {
  if (!isDocumentProjectionPathOwnedBy(input)) {
    throw pathOwnershipError("projection_path_owner_mismatch");
  }
}

export function assertDocumentProjectionDirectoryOwnership(input: Readonly<{
  scope: DocumentProjectionScopeIdentity;
  directoryPath: string;
}>): void {
  if (!isDocumentProjectionDirectoryOwnedBy(input)) {
    throw pathOwnershipError("projection_directory_owner_mismatch");
  }
}

export function validateDocumentProjectionScopeOutputOwnership(input: Readonly<{
  scope: DocumentProjectionScopeIdentity;
  pages: readonly {
    logicalPath: string;
    sourceFilePublicId: string | null;
  }[];
  removedLogicalPaths: readonly string[];
  navigationMutations: readonly { directoryPath: string }[];
}>): void {
  for (const page of input.pages) {
    assertDocumentProjectionPathOwnership({
      scope: input.scope,
      logicalPath: page.logicalPath,
      sourceFilePublicId: page.sourceFilePublicId
    });
  }
  const sourceFilePublicId = input.scope.kind === "source"
    || (input.scope.kind === "_graph" && input.scope.key !== "catalog"
      && !input.scope.key.includes(":")) ? input.scope.key : null;
  for (const logicalPath of input.removedLogicalPaths) {
    assertDocumentProjectionPathOwnership({
      scope: input.scope,
      logicalPath,
      sourceFilePublicId
    });
  }
  for (const mutation of input.navigationMutations) {
    assertDocumentProjectionDirectoryOwnership({
      scope: input.scope,
      directoryPath: mutation.directoryPath
    });
  }
}

function ownsIndexPath(key: string, path: string): boolean {
  if (key.startsWith("pages:")) {
    return directlyInside(portableIndexDirectoryPath(
      key.slice("pages:".length)
    ), path);
  }
  if (key.startsWith("term:")) {
    const bucket = key.slice("term:".length);
    return TERM_BUCKETS.has(bucket)
      && directlyInside(`_index/terms/${bucket}`, path);
  }
  return key === "term-catalog"
    && ownsDirectoryNavigation("_index/terms", path, true);
}

function ownsGraphPath(
  key: string,
  path: string,
  sourceFilePublicId: string | null | undefined
): boolean {
  if (key === "catalog") return path === "_graph/catalog.json";
  if (key.startsWith("directory:")) {
    return directlyInside(portableGraphDirectoryPath(
      key.slice("directory:".length)
    ), path);
  }
  if (key.startsWith("file-directory:")) {
    return ownsDirectoryNavigation(portableByFileGraphDirectoryPath(
      key.slice("file-directory:".length)
    ), path);
  }
  return (sourceFilePublicId === undefined
      || sourceFilePublicId === null
      || sourceFilePublicId === key)
    && /^_graph\/by-file\/(?:[^/]+\/)*[^/]+\.json$/u.test(path)
    && posix.basename(path) !== "index.json";
}

function ownsRootPath(path: string): boolean {
  if (["index.md", "log.md", "_index/catalog.json"].includes(path)) {
    return true;
  }
  return ownsDirectoryNavigation("_index", path)
    || ownsDirectoryNavigation("_graph", path);
}

function ownsDirectoryNavigation(
  directoryPath: string,
  path: string,
  includeJsonIndex = false
): boolean {
  if (posix.dirname(path) !== directoryPath) return false;
  const name = posix.basename(path);
  return name === "index.md" || NAVIGATION_LEAF.test(name)
    || (includeJsonIndex && name === "index.json");
}

function directlyInside(directoryPath: string, path: string): boolean {
  return posix.dirname(path) === directoryPath;
}

function isNavigationFile(path: string): boolean {
  const name = posix.basename(path);
  return name === "index.md" || NAVIGATION_LEAF.test(name);
}

function normalizeDirectoryPath(path: string): string {
  const normalized = normalizeGeneratedLogicalPath(`${path}/placeholder.md`);
  const directory = posix.dirname(normalized);
  if (directory !== path || !isAllowedPublicBundleDirectoryPath(directory)) {
    throw pathOwnershipError("projection_directory_path_invalid");
  }
  return directory;
}

function validateScopeKey(scope: DocumentProjectionScopeIdentity): void {
  if (!scope.key || scope.key !== scope.key.trim()) {
    throw pathOwnershipError("projection_scope_identity_invalid");
  }
}

function pathOwnershipError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document projection ownership error: ${code}`), {
    code
  });
}
