import { posix } from "node:path";
import { portableByFileGraphDirectoryPath } from "@focowiki/okf";
import type { DocumentPublicationRenderScope } from
  "../application/document-publication-job-ports.js";
import { reconcileDocumentDirectoryNavigationDelta } from
  "../application/document-directory-navigation-windows.js";
import { renderDocumentDirectoryMutationPages } from
  "../application/document-generated-navigation.js";
import { directoryLeafPath } from
  "../application/document-directory-navigation-renderer.js";
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
import type { DocumentRootProjectionLimits } from
  "./production-document-root-projection.js";
export { projectRoot } from "./production-document-root-projection.js";
export type DocumentScopeNavigationDependencies = {
  machineProjection: ReturnType<typeof createPostgresDocumentMachineProjectionReader>;
  directoryNavigation?: ReturnType<typeof createPostgresDocumentDirectoryNavigation>;
  directoryLeafLimits?: OrderedDirectoryLeafLimits;
  rootLimits?: DocumentRootProjectionLimits;
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
  scope: DocumentPublicationRenderScope;
  directoryPath: string;
  projected: {
    pages: readonly ProjectedPage[];
    removedLogicalPaths: readonly string[];
    childDirectories?: readonly {
      scopePath: string;
      title: string;
      path: string;
    }[];
    navigationCandidateEntryIds?: readonly string[];
  };
  changedAt: string;
  removeWhenEmpty?: boolean;
  title?: string;
}) {
  return materializeDirectoryNavigation({
    ...input,
    ...(input.projected.navigationCandidateEntryIds
      ? { candidateEntryIds:
          input.projected.navigationCandidateEntryIds } : {}),
    dependencies: requireDirectoryNavigation(input.dependencies)
  });
}
export async function materializeSemanticDirectoryNavigation(input: {
  dependencies: DocumentScopeNavigationDependencies;
  scope: DocumentPublicationRenderScope;
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
  scope: DocumentPublicationRenderScope;
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
    navigationCandidateEntryIds?: readonly string[];
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
    ...(input.projected.navigationCandidateEntryIds
      ? { candidateEntryIds:
          input.projected.navigationCandidateEntryIds } : {}),
    changedAt: input.changedAt,
    leafPrefix: "extension-leaf",
    title: input.scopePath === "pages"
      ? "Relationships by file" : posix.basename(input.scopePath),
    removeWhenEmpty: true
  });
}

export async function materializeRootExtensionNavigation(input: {
  dependencies: DocumentScopeNavigationDependencies;
  scope: DocumentPublicationRenderScope;
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
  scope: DocumentPublicationRenderScope;
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
  const delta = input.candidateEntryIds !== undefined
    ? await input.dependencies.directoryNavigation.readDelta({
        knowledgeBaseId: input.scope.knowledgeBaseId,
        directoryPath: input.directoryPath,
        desiredEntries: input.candidateEntryIds
          ? desiredEntries.filter((entry) =>
              input.candidateEntryIds!.includes(entry.id))
          : desiredEntries,
        ...(input.candidateEntryIds
          ? { candidateEntryIds: input.candidateEntryIds } : {}),
        maximumChanges: 100_000,
        maximumLeaves: 10_000,
        maximumEntries: 100_000
      })
    : null;
  const boundedDelta = delta?.mode === "window" || delta?.mode === "windows"
    ? delta : null;
  const previous = delta?.mode === "window" ? delta.leaves
    : delta?.mode === "windows" ? delta.windows.flat()
    : await input.dependencies.directoryNavigation.read({
        knowledgeBaseId: input.scope.knowledgeBaseId,
        directoryPath: input.directoryPath,
        maximumLeaves: 10_000,
        maximumEntries: 100_000
      });
  const desiredById = new Map(desiredEntries.map((entry) => [entry.id, entry]));
  const changes = boundedDelta ? [...boundedDelta.changes] : [
    ...previous.flatMap((leaf) => leaf.entries)
      .filter((entry) => !desiredById.has(entry.id))
      .map((entry) => ({ entryId: entry.id, desiredEntry: null })),
    ...desiredEntries.map((entry) => ({ entryId: entry.id, desiredEntry: entry }))
  ].sort((left, right) => left.entryId.localeCompare(right.entryId, "en-US"));
  let sequence = 0;
  const occupiedLeafIds = new Set(previous.map((leaf) => leaf.id));
  const createLeafId = () => createDirectoryLeafId({
    prefix: input.leafPrefix ?? "extension-leaf",
    knowledgeBaseId: input.scope.knowledgeBaseId,
    directoryPath: input.directoryPath,
    occupiedLeafIds,
    sequence: ++sequence
  });
  const navigation = reconcileDocumentDirectoryNavigationDelta({
    previous,
    changes,
    delta: boundedDelta,
    limits: input.dependencies.directoryLeafLimits,
    changedAt: input.changedAt,
    createLeafId
  });
  const touchedLeafIds = new Set(navigation.touchedLeafIds);
  const touchedLeaves = navigation.leaves.filter((leaf) =>
    touchedLeafIds.has(leaf.id));
  const removeDirectory = input.removeWhenEmpty && navigation.entryCount === 0;
  const navigationChanged = navigation.touchedLeafIds.length > 0
    || navigation.removedLeafIds.length > 0;
  const navigationPages = removeDirectory
    || (!navigationChanged && boundedDelta?.rootExists)
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
          removedLeafIds: navigation.removedLeafIds,
          entryCount: navigation.entryCount,
          firstLeafId: navigation.firstLeafId
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
  affectedSourceFilePublicIds?: readonly string[];
  planningMode?: "initial" | "delta" | "repair";
}) {
  const includedSourceFilePublicIds = input.affectedSourceFilePublicIds
    ? []
    :
    input.includedSourceRevisionPublicIds.length > 0
      && input.excludedActiveSourceFilePublicIds.length === 0
      ? await input.dependencies.machineProjection
          .resolveSourceFilePublicIdsForRevisions({
            knowledgeBaseId: input.knowledgeBaseId,
            sourceRevisionPublicIds: input.includedSourceRevisionPublicIds
          })
      : [];
  const affectedSourceFilePublicIds = [...new Set([
    ...(input.affectedSourceFilePublicIds ?? []),
    ...includedSourceFilePublicIds,
    ...input.excludedActiveSourceFilePublicIds
  ])].sort();
  const navigationSourceFilePublicIds = [...new Set([
    ...includedSourceFilePublicIds,
    ...input.excludedActiveSourceFilePublicIds
  ])].sort();
  if (input.planningMode === "delta"
    && affectedSourceFilePublicIds.length === 0) {
    throw scopeNavigationError("publication_delta_closure_incomplete");
  }
  const state = input.planningMode === "delta"
    ? await input.dependencies.machineProjection.readSemanticDirectoryDeltaState({
        knowledgeBaseId: input.knowledgeBaseId,
        scopePath: input.scopePath,
        affectedSourceFilePublicIds,
        includedSourceRevisionPublicIds:
          input.includedSourceRevisionPublicIds,
        excludedActiveSourceFilePublicIds:
          input.excludedActiveSourceFilePublicIds,
        navigationSourceFilePublicIds
      })
    : affectedSourceFilePublicIds.length > 0 && !input.planningMode
      ? await input.dependencies.machineProjection.readSemanticDirectoryDeltaState({
          knowledgeBaseId: input.knowledgeBaseId,
          scopePath: input.scopePath,
          affectedSourceFilePublicIds,
          includedSourceRevisionPublicIds:
            input.includedSourceRevisionPublicIds,
          excludedActiveSourceFilePublicIds:
            input.excludedActiveSourceFilePublicIds,
          navigationSourceFilePublicIds
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
    ...(navigationCandidateEntryIds
      ? { navigationCandidateEntryIds } : {})
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
