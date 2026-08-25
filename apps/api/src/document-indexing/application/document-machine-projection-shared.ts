import { posix } from "node:path";
import { comparePortableRecordKeys } from "@focowiki/okf";
import type { DocumentSemanticPartDescriptor } from
  "./document-semantic-resource-packets.js";

export type ProjectionRecord = Record<string, unknown>;
export type DirectoryState = {
  scopePath: string;
  childDirectories: Array<{ title: string; scopePath: string; path: string }>;
  resources: DocumentSemanticPartDescriptor[];
  count: number;
};

export function directoryRouterValue(
  state: DirectoryState,
  countKey: "documentCount" | "relationshipCount",
  machineDirectory: (scopePath: string) => string
) {
  const parent = state.scopePath === "pages" ? undefined
    : `${machineDirectory(posix.dirname(state.scopePath))}/index.json`;
  return {
    formatVersion: 2,
    title: countKey === "documentCount"
      ? `${directoryTitle(state.scopePath)} documents`
      : `${directoryTitle(state.scopePath)} relationships`,
    scopePath: state.scopePath,
    ...(parent ? { parentPath: parent } : {}),
    childDirectories: state.childDirectories,
    resources: state.resources,
    [countKey]: state.count
  };
}

export function removeStalePaths(
  previous: readonly string[],
  current: readonly string[],
  removed: Set<string>
): void {
  const retained = new Set(current);
  for (const path of previous) if (!retained.has(path)) removed.add(path);
}

export function arrayRecords(value: unknown): ProjectionRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) =>
    typeof item !== "object" || item === null || Array.isArray(item))) {
    throw machineProjectionError("existing_resource_invalid");
  }
  return value.map((item) => ({ ...(item as ProjectionRecord) }));
}

export function asString(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw machineProjectionError("existing_resource_invalid");
  }
  return value;
}

export function directoryTitle(scopePath: string): string {
  return scopePath === "pages" ? "Documents" : posix.basename(scopePath);
}

export function directoryResourceTitle(
  scopePath: string,
  family: "documents" | "relationships"
): string {
  return `${scopePath === "pages" ? "All" : posix.basename(scopePath)} ${family}`;
}

export function isEmptyDirectoryState(state: DirectoryState): boolean {
  return state.count === 0 && state.resources.length === 0
    && state.childDirectories.length === 0;
}

export function compareText(left: string, right: string): number {
  return comparePortableRecordKeys(left, right);
}

export function machineProjectionError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document machine projection error: ${code}`), {
    code
  });
}
