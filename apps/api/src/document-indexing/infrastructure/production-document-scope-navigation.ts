import { posix } from "node:path";
import { portableByFileGraphDirectoryPath } from "@focowiki/okf";
import type { DocumentProjectionScopeClaim } from
  "../application/document-scope-projector-runtime.js";
import { reconcileDocumentDirectoryNavigation } from
  "../application/document-directory-navigation-state.js";
import {
  renderDocumentDirectoryMutationPages,
  renderDocumentRootPage
} from "../application/document-generated-navigation.js";
import { directoryLeafPath } from
  "../application/document-directory-navigation-renderer.js";
import { buildDocumentIndexCatalogPage } from
  "../application/document-page-term-projection.js";
import type { OrderedDirectoryLeafLimits } from
  "../domain/document-directory-leaves.js";
import { documentDirectoryEntryId } from
  "../domain/document-directory-entry-identity.js";
import type { createPostgresDocumentDirectoryNavigation } from
  "./postgres-document-directory-navigation.js";
import type { createPostgresDocumentMachineProjectionReader } from
  "./postgres-document-machine-projection-reader.js";
import { createDirectoryLeafId } from
  "./production-document-processor-support.js";
type RootLimits = {
  rootSummaryLimit: number;
  okfLogMaxEntries: number;
  okfLogMaxBytes: number;
};
export type DocumentScopeNavigationDependencies = {
  machineProjection: ReturnType<typeof createPostgresDocumentMachineProjectionReader>;
  directoryNavigation?: ReturnType<typeof createPostgresDocumentDirectoryNavigation>;
  directoryLeafLimits?: OrderedDirectoryLeafLimits;
  rootLimits?: RootLimits;
};
type ProjectedPage = {
  logicalPath: string;
  normalizedPath: string;
  entryKind: string;
  sourceFilePublicId: string | null;
  sourceRevisionPublicId: string | null;
  bytes: Uint8Array;
  checksumSha256: string;
  byteCount: number;
};

export async function materializeMachineDirectoryNavigation(input: {
  dependencies: DocumentScopeNavigationDependencies;
  scope: DocumentProjectionScopeClaim;
  directoryPath: string;
  projected: {
    pages: readonly ProjectedPage[];
    removedLogicalPaths: readonly string[];
    childDirectories?: readonly {
      scopePath: string;
      title: string;
      path: string;
    }[];
  };
  changedAt: string;
  removeWhenEmpty?: boolean;
  title?: string;
}) {
  return materializeDirectoryNavigation({
    ...input,
    dependencies: requireDirectoryNavigation(input.dependencies)
  });
}

export async function materializeSemanticDirectoryNavigation(input: {
  dependencies: DocumentScopeNavigationDependencies;
  scope: DocumentProjectionScopeClaim;
  directoryPath: string;
  projected: Awaited<ReturnType<typeof projectSemanticDirectory>>;
  changedAt: string;
}) {
  return materializeDirectoryNavigation({
    dependencies: requireDirectoryNavigation(input.dependencies),
    scope: input.scope,
    directoryPath: input.directoryPath,
    projected: input.projected,
    desiredEntries: semanticDirectoryEntries(input.projected),
    ...(input.projected.navigationCandidateEntryIds
      ? { candidateEntryIds: input.projected.navigationCandidateEntryIds }
      : {}),
    changedAt: input.changedAt,
    leafPrefix: "directory-leaf",
    rootEntryKind: "directory",
    leafEntryKind: "directory_leaf",
    title: input.directoryPath === "pages"
      ? "Documents" : posix.basename(input.directoryPath),
    removeWhenEmpty: input.directoryPath !== "pages"
  });
}

export async function materializePerFileGraphDirectoryNavigation(input: {
  dependencies: DocumentScopeNavigationDependencies;
  scope: DocumentProjectionScopeClaim;
  scopePath: string;
  projected: {
    pages: readonly ProjectedPage[];
    removedLogicalPaths: readonly string[];
    records: readonly { path: string; title: string }[];
    childDirectories: readonly {
      scopePath: string;
      title: string;
      path: string;
    }[];
  };
  changedAt: string;
}) {
  const directoryPath = portableByFileGraphDirectoryPath(input.scopePath);
  return materializeDirectoryNavigation({
    dependencies: requireDirectoryNavigation(input.dependencies),
    scope: input.scope,
    directoryPath,
    projected: input.projected,
    desiredEntries: [
      ...input.projected.records.map((record) => ({
        id: documentDirectoryEntryId("file", record.path),
        sortKey: `1/${record.title.toLocaleLowerCase("en-US")}/${record.path}`,
        name: record.title,
        targetPath: record.path,
        kind: "file" as const
      })),
      ...input.projected.childDirectories.map((directory) => ({
        id: documentDirectoryEntryId("directory", directory.path),
        sortKey: `0/${directory.title.toLocaleLowerCase("en-US")}/${directory.scopePath}`,
        name: directory.title,
        targetPath: directory.path,
        kind: "directory" as const
      }))
    ],
    changedAt: input.changedAt,
    leafPrefix: "extension-leaf",
    title: input.scopePath === "pages"
      ? "Relationships by file" : posix.basename(input.scopePath),
    removeWhenEmpty: true
  });
}

export async function materializeRootExtensionNavigation(input: {
  dependencies: DocumentScopeNavigationDependencies;
  scope: DocumentProjectionScopeClaim;
  projected: {
    pages: readonly ProjectedPage[];
    removedLogicalPaths: readonly string[];
    graphEdgeCount: number;
  };
  changedAt: string;
}) {
  const dependencies = requireDirectoryNavigation(input.dependencies);
  const [graph, index] = await Promise.all([
    materializeDirectoryNavigation({
      dependencies,
      scope: input.scope,
      directoryPath: "_graph",
      projected: { pages: [], removedLogicalPaths: [] },
      desiredEntries: [
        ...(input.projected.graphEdgeCount > 0 ? [
          rootDirectoryEntry("Relationships by directory",
            "_graph/by-directory/index.md"),
          rootDirectoryEntry("Relationships by file", "_graph/by-file/index.md")
        ] : []),
        rootFileEntry("Relationship catalog", "_graph/catalog.json")
      ],
      changedAt: input.changedAt,
      leafPrefix: "extension-leaf",
      rootEntryKind: "graph_index",
      leafEntryKind: "extension_leaf",
      title: "Relationship graph"
    }),
    materializeDirectoryNavigation({
      dependencies,
      scope: input.scope,
      directoryPath: "_index",
      projected: { pages: [], removedLogicalPaths: [] },
      desiredEntries: [
        rootDirectoryEntry("Documents", "_index/pages/index.md"),
        rootFileEntry("Index catalog", "_index/catalog.json"),
        rootDirectoryEntry("Navigation terms", "_index/terms/index.md")
      ],
      changedAt: input.changedAt,
      leafPrefix: "extension-leaf",
      rootEntryKind: "index",
      leafEntryKind: "extension_leaf",
      title: "Machine-readable indexes"
    })
  ]);
  const catalogPages = input.projected.pages.filter((page) =>
    page.logicalPath === "_index/catalog.json");
  const rootPages = input.projected.pages.filter((page) =>
    page.logicalPath !== "_index/catalog.json");
  return {
    pages: [...catalogPages, ...graph.pages, ...index.pages, ...rootPages],
    removedLogicalPaths: [...new Set([
      ...input.projected.removedLogicalPaths,
      ...graph.removedLogicalPaths,
      ...index.removedLogicalPaths
    ])].sort(),
    navigationMutations: [
      ...graph.navigationMutations,
      ...index.navigationMutations
    ]
  };
}

function rootDirectoryEntry(name: string, targetPath: string) {
  return {
    id: documentDirectoryEntryId("directory", targetPath),
    sortKey: `0/${name.toLocaleLowerCase("en-US")}/${targetPath}`,
    name,
    targetPath,
    kind: "directory" as const
  };
}

function rootFileEntry(name: string, targetPath: string) {
  return {
    id: documentDirectoryEntryId("file", targetPath),
    sortKey: `1/${name.toLocaleLowerCase("en-US")}/${targetPath}`,
    name,
    targetPath,
    kind: "file" as const
  };
}

async function materializeDirectoryNavigation(input: {
  dependencies: DocumentScopeNavigationDependencies & {
    directoryNavigation: ReturnType<typeof createPostgresDocumentDirectoryNavigation>;
    directoryLeafLimits: OrderedDirectoryLeafLimits;
  };
  scope: DocumentProjectionScopeClaim;
  directoryPath: string;
  projected: {
    pages: readonly ProjectedPage[];
    removedLogicalPaths: readonly string[];
    childDirectories?: readonly {
      scopePath: string;
      title: string;
      path: string;
    }[];
  };
  changedAt: string;
  removeWhenEmpty?: boolean;
  desiredEntries?: ReadonlyArray<{
    id: string;
    sortKey: string;
    name: string;
    targetPath: string;
    kind: "file" | "directory";
  }>;
  candidateEntryIds?: readonly string[];
  leafPrefix?: "directory-leaf" | "extension-leaf";
  rootEntryKind?: string;
  leafEntryKind?: string;
  title?: string;
}) {
  const desiredEntries = input.desiredEntries ?? [
    ...input.projected.pages
      .filter((page) => posix.dirname(page.logicalPath) === input.directoryPath)
      .map((page) => ({
      id: documentDirectoryEntryId("file", page.logicalPath),
      sortKey: `1/${posix.basename(page.logicalPath).toLocaleLowerCase("en-US")}/${page.logicalPath}`,
      name: posix.basename(page.logicalPath),
      targetPath: page.logicalPath,
      kind: "file" as const
      })),
    ...(input.projected.childDirectories ?? []).map((directory) => ({
      id: documentDirectoryEntryId(
        "directory",
        `${posix.dirname(directory.path)}/index.md`
      ),
      sortKey: `0/${directory.title.toLocaleLowerCase("en-US")}/${directory.scopePath}`,
      name: directory.title,
      targetPath: `${posix.dirname(directory.path)}/index.md`,
      kind: "directory" as const
    }))
  ];
  const delta = input.scope.publicationGenerationPublicId
    ? await input.dependencies.directoryNavigation.readDelta({
        knowledgeBaseId: input.scope.knowledgeBaseId,
        directoryPath: input.directoryPath,
        desiredEntries: input.candidateEntryIds
          ? desiredEntries.filter((entry) =>
              input.candidateEntryIds!.includes(entry.id))
          : desiredEntries,
        ...(input.candidateEntryIds
          ? { candidateEntryIds: input.candidateEntryIds } : {}),
        maximumChanges: 2_048,
        maximumLeaves: 10_000,
        maximumEntries: 100_000
      })
    : null;
  const previous = delta?.mode === "window" ? delta.leaves
    : await input.dependencies.directoryNavigation.read({
        knowledgeBaseId: input.scope.knowledgeBaseId,
        directoryPath: input.directoryPath,
        maximumLeaves: 10_000,
        maximumEntries: 100_000
      });
  const desiredById = new Map(desiredEntries.map((entry) => [entry.id, entry]));
  const changes = delta?.mode === "window" ? [...delta.changes] : [
    ...previous.flatMap((leaf) => leaf.entries)
      .filter((entry) => !desiredById.has(entry.id))
      .map((entry) => ({ entryId: entry.id, desiredEntry: null })),
    ...desiredEntries.map((entry) => ({ entryId: entry.id, desiredEntry: entry }))
  ].sort((left, right) => left.entryId.localeCompare(right.entryId, "en-US"));
  let sequence = 0;
  const occupiedLeafIds = new Set(previous.map((leaf) => leaf.id));
  const navigation = reconcileDocumentDirectoryNavigation({
    previous,
    changes,
    ...(delta?.mode === "window" ? { window: {
      totalEntryCount: delta.totalEntryCount,
      firstLeafId: delta.firstLeafId
    } } : {}),
    limits: input.dependencies.directoryLeafLimits,
    changedAt: input.changedAt,
    createLeafId: () => createDirectoryLeafId({
      prefix: input.leafPrefix ?? "extension-leaf",
      knowledgeBaseId: input.scope.knowledgeBaseId,
      directoryPath: input.directoryPath,
      occupiedLeafIds,
      sequence: ++sequence
    })
  });
  const touchedLeafIds = new Set(navigation.touchedLeafIds);
  const touchedLeaves = navigation.leaves.filter((leaf) =>
    touchedLeafIds.has(leaf.id));
  const removeDirectory = input.removeWhenEmpty && navigation.entryCount === 0;
  const navigationChanged = navigation.touchedLeafIds.length > 0
    || navigation.removedLeafIds.length > 0;
  const navigationPages = removeDirectory
    || (!navigationChanged && delta?.mode === "window" && delta.rootExists)
    ? []
    : renderDocumentDirectoryMutationPages({
        directoryPath: input.directoryPath,
        entryCount: navigation.entryCount,
        firstLeafId: navigation.firstLeafId,
        touchedLeaves,
        title: input.title ?? posix.basename(input.directoryPath),
        rootEntryKind: input.rootEntryKind ?? "extension_version",
        leafEntryKind: input.leafEntryKind ?? "extension_leaf",
        ...(input.leafPrefix === "directory-leaf" ? {}
          : { leafMetadataType: "extension-resource-index-page" }),
        changedAt: input.changedAt
      });
  return {
    pages: [...input.projected.pages, ...navigationPages],
    removedLogicalPaths: [...new Set([
      ...input.projected.removedLogicalPaths,
      ...(removeDirectory ? [`${input.directoryPath}/index.md`] : []),
      ...navigation.removedLeafIds.map((leafId) =>
        directoryLeafPath(input.directoryPath, leafId))
    ])].sort(),
    navigationMutations: navigation.touchedLeafIds.length > 0
      || navigation.removedLeafIds.length > 0
      ? [{
          directoryPath: input.directoryPath,
          touchedLeaves,
          removedLeafIds: navigation.removedLeafIds
        }]
      : []
  };
}

function semanticDirectoryEntries(projected: Awaited<ReturnType<
  typeof projectSemanticDirectory
>>) {
  return [
    ...projected.records
      .filter((record) => posix.dirname(String(record.path))
        === projected.scopePath)
      .map((record) => ({
        id: documentDirectoryEntryId("file", String(record.path)),
        sortKey: `1/${posix.basename(String(record.path)).toLocaleLowerCase("en-US")}/${String(record.path)}`,
        name: String(record.title),
        targetPath: String(record.path),
        kind: "file" as const
      })),
    ...projected.childDirectories.map((directory) => ({
      id: documentDirectoryEntryId("directory", `${directory.scopePath}/index.md`),
      sortKey: `0/${directory.title.toLocaleLowerCase("en-US")}/${directory.scopePath}`,
      name: directory.title,
      targetPath: `${directory.scopePath}/index.md`,
      kind: "directory" as const
    }))
  ];
}

export async function projectSemanticDirectory(input: {
  dependencies: DocumentScopeNavigationDependencies;
  knowledgeBaseId: string;
  scopePath: string;
  includedSourceRevisionPublicIds: readonly string[];
  excludedActiveSourceFilePublicIds: readonly string[];
}) {
  const state = input.excludedActiveSourceFilePublicIds.length > 0
    ? await input.dependencies.machineProjection.readSemanticDirectoryDeltaState({
        knowledgeBaseId: input.knowledgeBaseId,
        scopePath: input.scopePath,
        affectedSourceFilePublicIds:
          input.excludedActiveSourceFilePublicIds,
        includedSourceRevisionPublicIds:
          input.includedSourceRevisionPublicIds
      })
    : await input.dependencies.machineProjection.readSemanticDirectoryState({
        knowledgeBaseId: input.knowledgeBaseId,
        scopePath: input.scopePath,
        includedSourceRevisionPublicIds: input.includedSourceRevisionPublicIds,
        excludedActiveSourceFilePublicIds:
          input.excludedActiveSourceFilePublicIds
      });
  const navigationCandidateEntryIds = "navigationCandidateEntryIds" in state
    && Array.isArray(state.navigationCandidateEntryIds)
    && state.navigationCandidateEntryIds.every((value) =>
      typeof value === "string")
    ? state.navigationCandidateEntryIds as string[] : undefined;
  return {
    scopePath: input.scopePath,
    pages: [] as ProjectedPage[],
    removedLogicalPaths: [] as string[],
    records: state.records,
    childDirectories: state.childDirectories,
    navigationCandidateEntryIds
  };
}

export async function projectRoot(input: {
  dependencies: DocumentScopeNavigationDependencies;
  knowledgeBaseId: string;
  includedSourceRevisionPublicIds: readonly string[];
  excludedActiveSourceFilePublicIds: readonly string[];
  changedAt: string;
}) {
  const limits = input.dependencies.rootLimits;
  if (!limits) throw scopeNavigationError(
    "projection_scope_root_configuration_invalid");
  const state = await input.dependencies.machineProjection.readRootProjectionState({
    knowledgeBaseId: input.knowledgeBaseId,
    includedSourceRevisionPublicIds: input.includedSourceRevisionPublicIds,
    excludedActiveSourceFilePublicIds: input.excludedActiveSourceFilePublicIds,
    logLimit: limits.okfLogMaxEntries
  });
  const currentLogEntry = state.currentLogEntries[0];
  return {
    pages: [
      buildDocumentIndexCatalogPage(),
      ...(["index.md", "log.md"] as const)
        .map((path) => renderDocumentRootPage({
          path,
          knowledgeBase: {
            ...state.knowledgeBase,
            sourceFileCount: state.sourceFileCount,
            graphEdgeCount: state.graphEdgeCount,
            changedAt: input.changedAt
          },
          rootEntryCount: state.rootEntryCount,
          limits,
          logEntries: [
            ...state.currentLogEntries.slice(1),
            ...state.previousLogEntries
          ],
          ...(currentLogEntry ? { currentLogEntry } : {})
        }))
    ],
    removedLogicalPaths: [] as string[],
    records: [] as Record<string, unknown>[],
    graphEdgeCount: state.graphEdgeCount,
    factCount: state.sourceFileCount
  };
}

function requireDirectoryNavigation(
  input: DocumentScopeNavigationDependencies
): DocumentScopeNavigationDependencies & {
  directoryNavigation: ReturnType<typeof createPostgresDocumentDirectoryNavigation>;
  directoryLeafLimits: OrderedDirectoryLeafLimits;
} {
  const limits = input.directoryLeafLimits;
  if (!input.directoryNavigation || !limits
    || !Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 2
    || !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1_024
    || !Number.isSafeInteger(limits.mergeBelowEntries)
    || limits.mergeBelowEntries < 1) {
    throw scopeNavigationError(
      "projection_scope_navigation_configuration_invalid");
  }
  return { ...input, directoryNavigation: input.directoryNavigation,
    directoryLeafLimits: limits };
}
function scopeNavigationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Projection scope navigation error: ${code}`), {
    code
  });
}
