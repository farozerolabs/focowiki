import type { DocumentDirectoryNavigationChange } from
  "./document-directory-navigation-state.js";
import { documentDirectoryEntryId } from
  "../domain/document-directory-entry-identity.js";

export type DocumentDirectoryNavigationChangePlan = {
  directoryPath: string;
  changes: DocumentDirectoryNavigationChange[];
};

export function planDocumentDirectoryNavigationChanges(input: {
  sourceFilePublicId: string;
  oldLogicalPath: string | null;
  newLogicalPath: string | null;
}): DocumentDirectoryNavigationChangePlan[] {
  if (!input.sourceFilePublicId
    || (!input.oldLogicalPath && !input.newLogicalPath)) {
    throw navigationPlanError("input_invalid");
  }
  const byDirectory = new Map<string, Map<string, DocumentDirectoryNavigationChange>>();
  if (input.oldLogicalPath) {
    const old = parseSourcePath(input.oldLogicalPath);
    for (let index = 0; index <= old.directories.length; index += 1) {
      ensureDirectory(byDirectory, directoryPath(old.directories.slice(0, index)));
    }
    const oldEntryId = documentDirectoryEntryId(
      "file",
      `pages/${input.oldLogicalPath}`
    );
    setChange(byDirectory, directoryPath(old.directories), {
      entryId: oldEntryId,
      desiredEntry: null
    });
  }
  if (input.newLogicalPath) {
    const next = parseSourcePath(input.newLogicalPath);
    for (let index = 0; index < next.directories.length; index += 1) {
      const parent = next.directories.slice(0, index);
      const child = next.directories.slice(0, index + 1).join("/");
      const name = next.directories[index]!;
      const targetPath = `pages/${child}/index.md`;
      const entryId = documentDirectoryEntryId("directory", targetPath);
      setChange(byDirectory, directoryPath(parent), {
        entryId,
        desiredEntry: {
          id: entryId,
          sortKey: `${name.toLocaleLowerCase("en-US")}/${entryId}`,
          name,
          targetPath,
          kind: "directory"
        }
      });
    }
    const targetPath = `pages/${input.newLogicalPath}`;
    const entryId = documentDirectoryEntryId("file", targetPath);
    setChange(byDirectory, directoryPath(next.directories), {
      entryId,
      desiredEntry: {
        id: entryId,
        sortKey: `${next.fileName.toLocaleLowerCase("en-US")}/${entryId}`,
        name: next.fileName,
        targetPath,
        kind: "file"
      }
    });
  }
  return [...byDirectory.entries()].sort(([left], [right]) => compareText(left, right))
    .map(([path, changes]) => ({
      directoryPath: path,
      changes: [...changes.values()].sort((left, right) =>
        compareText(left.entryId, right.entryId))
    }));
}

function ensureDirectory(
  target: Map<string, Map<string, DocumentDirectoryNavigationChange>>,
  directoryPathValue: string
): void {
  if (!target.has(directoryPathValue)) target.set(directoryPathValue, new Map());
}

function setChange(
  target: Map<string, Map<string, DocumentDirectoryNavigationChange>>,
  directoryPathValue: string,
  change: DocumentDirectoryNavigationChange
): void {
  const changes = target.get(directoryPathValue) ?? new Map();
  changes.set(change.entryId, change);
  target.set(directoryPathValue, changes);
}

function parseSourcePath(value: string): {
  directories: string[];
  fileName: string;
} {
  if (value.startsWith("/") || value.includes("\\")
    || !value.toLowerCase().endsWith(".md")
    || Buffer.byteLength(value, "utf8") > 4_096) {
    throw navigationPlanError("source_path_invalid");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw navigationPlanError("source_path_invalid");
  }
  return {
    directories: segments.slice(0, -1),
    fileName: segments.at(-1)!
  };
}

function directoryPath(segments: readonly string[]): string {
  return segments.length === 0 ? "pages" : `pages/${segments.join("/")}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function navigationPlanError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document navigation plan error: ${code}`), { code });
}
