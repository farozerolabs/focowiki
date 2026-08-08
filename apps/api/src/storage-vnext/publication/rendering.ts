import {
  renderDirectoryLeafMarkdown,
  renderDirectoryRootMarkdown,
  directoryLeafPath
} from "../../publication/directory-navigation-writer.js";
import {
  renderBoundedRootFile
} from "../../publication/bounded-root-writer.js";
import type {
  PersistentDirectoryLeaf
} from "../../application/ports/directory-navigation-repository.js";
import {
  renderPageFile,
  type GeneratedPageSummary
} from "../../okf/publication-files.js";
import { GENERATED_GRAPH_RESOURCES } from "../../okf/generated-graph-resources.js";
import type { StorageVnextPublicationArtifact } from "./types.js";

export function renderStorageVnextPageArtifact(input: {
  page: GeneratedPageSummary;
  sourceBody: string;
  removedSourceLogicalPaths?: readonly string[] | undefined;
  ordinal: number;
}): StorageVnextPublicationArtifact {
  return artifact({
    logicalPath: input.page.pagePath,
    kind: "source",
    sourceFilePublicId: input.page.fileId,
    ordinal: input.ordinal,
    body: renderPageFile(input.page, input.sourceBody, {
      removedSourceLogicalPaths: input.removedSourceLogicalPaths
    })
  });
}

export function renderStorageVnextDirectoryArtifacts(input: {
  directoryPath: string;
  entryCount: number;
  leaves: readonly PersistentDirectoryLeaf[];
  ordinalStart: number;
}): StorageVnextPublicationArtifact[] {
  assertOrdinal(input.ordinalStart);
  const root = artifact({
    logicalPath: `${input.directoryPath}/index.md`,
    kind: "directory",
    sourceFilePublicId: null,
    ordinal: input.ordinalStart,
    body: renderDirectoryRootMarkdown({
      directoryPath: input.directoryPath,
      entryCount: input.entryCount,
      firstLeafId: input.leaves[0]?.id ?? null
    })
  });
  return [
    root,
    ...input.leaves.map((leaf, index) => artifact({
      logicalPath: directoryLeafPath(input.directoryPath, leaf.id),
      kind: "directory",
      sourceFilePublicId: null,
      ordinal: input.ordinalStart + index + 1,
      body: renderDirectoryLeafMarkdown({
        directoryPath: input.directoryPath,
        leaf
      })
    }))
  ];
}

export function renderStorageVnextRootArtifact(input: {
  path: string;
  knowledgeBase: {
    id: string;
    name: string;
    description: string | null;
    sourceFileCount: number;
    graphEdgeCount: number;
    changedAt?: string;
  };
  rootEntryCount: number;
  generationId: string;
  ordinal: number;
}): StorageVnextPublicationArtifact {
  if (!ROOT_PATHS.has(input.path)) {
    throw new Error("Storage vNext publication root path is unsupported");
  }
  const rendered = renderBoundedRootFile(input);
  return artifact({
    logicalPath: input.path,
    kind: rootKind(input.path),
    sourceFilePublicId: null,
    ordinal: input.ordinal,
    body: rendered.body
  });
}

const ROOT_PATHS = new Set([
  "index.md",
  "schema.md",
  "log.md",
  "_index/index.md",
  GENERATED_GRAPH_RESOURCES.index.path
]);

function artifact(input: {
  logicalPath: string;
  kind: StorageVnextPublicationArtifact["kind"];
  sourceFilePublicId: string | null;
  ordinal: number;
  body: string;
}): StorageVnextPublicationArtifact {
  assertOrdinal(input.ordinal);
  return {
    logicalPath: input.logicalPath,
    kind: input.kind,
    sourceFilePublicId: input.sourceFilePublicId,
    ordinal: input.ordinal,
    bytes: Buffer.from(input.body, "utf8")
  };
}

function rootKind(path: string): StorageVnextPublicationArtifact["kind"] {
  if (path === "schema.md") return "schema";
  if (path === "log.md") return "log";
  if (path.startsWith("_graph/")) return "graph";
  return "index";
}

function assertOrdinal(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Storage vNext publication ordinal is invalid");
  }
}
