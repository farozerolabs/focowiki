import { createHash } from "node:crypto";
import type {
  PersistentDirectoryLeaf
} from "../../application/ports/directory-navigation-repository.js";
import { resolveProjectionShard } from "../../domain/generation.js";
import type { EffectiveProjectionShard } from
  "../../application/ports/projection-catalog-repository.js";
import {
  compareOrderedDirectoryEntries,
  removeDirectoryEntry,
  type OrderedDirectoryEntry,
  type OrderedDirectoryLeaf
} from "../../publication/ordered-directory-leaves.js";
import { insertOrderedDirectoryEntries } from "./ordered-directory-batch.js";
import type {
  StorageVnextCatalogReadPort,
  StorageVnextDirectoryFact,
  StorageVnextSourceFileFact
} from "../catalog/ports.js";
import type { StorageVnextSourceBodyReadPort } from
  "../catalog/s3-source-body-store.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact,
  StorageVnextGraphReadPort
} from "../graph/ports.js";
import type {
  StorageVnextKnowledgeBaseSummary,
  StorageVnextShardDescriptor
} from "../release/ports.js";
import { directoryLeafPath } from
  "../../publication/directory-navigation-writer.js";
import type {
  StorageVnextPublicationDirectoryInput,
  StorageVnextPublicationPageInput,
  StorageVnextPublicationProjectionBatch,
  StorageVnextPublicationProjection
} from "./artifact-assembler.js";
import type { StorageVnextPublicationBatchPlan } from "./planning.js";
import { createStorageVnextDirectoryNavigationShards } from "./directory-state.js";
import {
  assembleStorageVnextMachineProjection,
  type StorageVnextMachineProjectionKind
} from "./machine-projection.js";
import type { JsonProjectionRecord } from
  "../../publication/projection-shard-partitioning.js";
import type {
  StorageVnextExtensionNavigationInput,
  StorageVnextExtensionNavigationSource
} from "./extension-navigation.js";
import {
  STORAGE_VNEXT_CURRENT_NAVIGATION_PROFILE,
  STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES
} from "./profile.js";

type ProjectionRequest = {
  knowledgeBaseId: string;
  candidatePublicId: string;
  operationPublicId: string;
  searchProjectionPublicId: string;
  signal: AbortSignal;
};

export type StorageVnextPublicationSnapshotPort = {
  readKnowledgeBaseCounts(input: {
    knowledgeBaseId: string;
  }): Promise<{
    sourceFileCount: number;
    directoryCount: number;
    graphNodeCount: number;
    graphEdgeCount: number;
  }>;
  readBaseNavigationProfile(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
  }): Promise<number>;
  readDirectoryDescendantFileCounts(input: {
    knowledgeBaseId: string;
    directoryPaths: readonly string[];
  }): Promise<ReadonlyMap<string, number>>;
  readDirectoryLeaves(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    directoryPath: string;
    maximumBytes: number;
    signal: AbortSignal;
  }): Promise<readonly PersistentDirectoryLeaf[]>;
  readExtensionNavigationLeaves(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    directoryPath: string;
    maximumBytes: number;
    signal: AbortSignal;
  }): Promise<readonly PersistentDirectoryLeaf[]>;
  listExtensionNavigationShards(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    directoryPaths: readonly string[];
    limit: number;
  }): Promise<readonly StorageVnextShardDescriptor[]>;
  readProjectionRecords(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    logicalPath: string;
    maximumBytes: number;
    signal: AbortSignal;
  }): Promise<readonly JsonProjectionRecord[]>;
  listAffectedObsoletePaths(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    sourcePaths: readonly string[];
    currentDirectoryPaths: readonly string[];
    deletedDirectoryPaths: readonly string[];
    currentLogicalPaths: readonly string[];
    limit: number;
  }): Promise<readonly string[]>;
  listProjectionShards(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    limit: number;
    maximumBytes: number;
  }): Promise<readonly EffectiveProjectionShard[]>;
  listExtensionCatalogPaths(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{
    byFileLogicalPaths: readonly string[];
    markdownLogicalPaths: readonly string[];
    scannedCount: number;
    nextCursor: string | null;
  }>;
  summarizeCandidate(input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
  }): Promise<StorageVnextKnowledgeBaseSummary>;
};

type GraphPort = Pick<
  StorageVnextGraphReadPort,
  "getEdge" | "getNode" | "listBySourceFile" | "listNeighborhood"
>;

export function createStorageVnextPublicationProjectionLoader(input: {
  catalog: Pick<
    StorageVnextCatalogReadPort,
    | "getKnowledgeBase"
    | "getCurrentSourceRevision"
    | "listDirectories"
    | "listSourceFiles"
    | "listSourceFilesByPublicIds"
  >;
  graph: GraphPort;
  sourceBodies: StorageVnextSourceBodyReadPort;
  snapshot: StorageVnextPublicationSnapshotPort;
  limits: {
    catalogPageSize: number;
    maximumSourceBytes: number;
    maximumAffectedPaths: number;
    directoryIndexMaxEntries: number;
    directoryIndexMaxBytes: number;
    relatedFileLimit: number;
    maximumProjectionShards: number;
    maximumMachineArtifactBytes: number;
    machineShardCounts: {
      search: number;
      links: number;
      manifest: number;
      tree: number;
      graphNode: number;
      graphEdge: number;
    };
  };
}) {
  validateLimits(input.limits);
  return {
    async load(request: ProjectionRequest & {
      plan: StorageVnextPublicationBatchPlan;
    }): Promise<StorageVnextPublicationProjection> {
      validateRequest(request);
      throwIfAborted(request.signal);
      const knowledgeBase = await input.catalog.getKnowledgeBase({
        knowledgeBaseId: request.knowledgeBaseId
      });
      if (!knowledgeBase || knowledgeBase.visibility !== "current") {
        throw projectionLoaderError("knowledge_base_unavailable");
      }
      const counts = await input.snapshot.readKnowledgeBaseCounts({
        knowledgeBaseId: request.knowledgeBaseId
      });
      const baseNavigationProfile = await input.snapshot.readBaseNavigationProfile({
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId: request.candidatePublicId
      });
      const profileUpgrade = baseNavigationProfile
        < STORAGE_VNEXT_CURRENT_NAVIGATION_PROFILE;
      const upgradeDirectoryFacts = profileUpgrade
        ? await loadAllDirectoryFacts(input, request)
        : null;
      const effectivePlan = profileUpgrade ? {
        ...request.plan,
        directoryPaths: [
          "pages",
          ...[...upgradeDirectoryFacts!.keys()]
        ].sort(compareUtf8)
      } : request.plan;
      const effectiveRequest = { ...request, plan: effectivePlan };
      const affectedSourceIds = await resolveAffectedSourceIds(input, request);
      const removedSourceLogicalPaths = await resolveRemovedSourceLogicalPaths(
        input,
        request
      );
      const directoryFacts = upgradeDirectoryFacts
        ?? await loadDirectoryFacts(input, request, effectivePlan.directoryPaths);
      const descendantCounts = await input.snapshot.readDirectoryDescendantFileCounts({
        knowledgeBaseId: request.knowledgeBaseId,
        directoryPaths: effectivePlan.directoryPaths
      });
      const directories: StorageVnextPublicationDirectoryInput[] = [];
      for (const path of effectivePlan.directoryPaths) {
        const fact = path === "pages" ? null : directoryFacts.get(path);
        if (path !== "pages" && !fact) continue;
        directories.push(await loadDirectory(input, request, path, fact ?? null,
          descendantCounts.get(path) ?? 0));
      }
      const currentDirectoryPaths = directories.map((directory) => directory.directoryPath);
      const deletedDirectoryPaths = effectivePlan.directoryPaths.filter((path) =>
        !currentDirectoryPaths.includes(path));
      const projectionShards = await input.snapshot.listProjectionShards({
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId: request.candidatePublicId,
        limit: input.limits.maximumProjectionShards,
        maximumBytes: input.limits.maximumMachineArtifactBytes
      });
      const extensionNavigation = await loadExtensionNavigation(input, request, {
        profileUpgrade,
        projectionShards,
        plan: effectivePlan
      });
      return {
        knowledgeBase: {
          id: knowledgeBase.publicId,
          name: knowledgeBase.name,
          description: knowledgeBase.description,
          sourceFileCount: counts.sourceFileCount,
          graphEdgeCount: counts.graphEdgeCount
        },
        rootEntryCount: directories.find((directory) =>
          directory.directoryPath === "pages")?.entryCount ?? 0,
        directories,
        profileUpgrade,
        projectionShards,
        extensionNavigation: extensionNavigation.navigation,
        internalShards: directories.flatMap((directory) =>
          createStorageVnextDirectoryNavigationShards({
            directoryPath: directory.directoryPath,
            leaves: directory.leaves,
            maximumBytes: input.limits.maximumMachineArtifactBytes
          })),
        reusedInternalShards: extensionNavigation.reusedShards,
        removedSourceLogicalPaths,
        batches: createProjectionBatches({
          input,
          request: effectiveRequest,
          affectedSourceIds,
          directories,
          currentDirectoryPaths,
          deletedDirectoryPaths
        })
      };
    },

    summarizeCandidate(request: ProjectionRequest) {
      validateRequest(request);
      return input.snapshot.summarizeCandidate({
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId: request.candidatePublicId,
        operationPublicId: request.operationPublicId
      });
    }
  };
}

async function loadExtensionNavigation(
  input: Parameters<typeof createStorageVnextPublicationProjectionLoader>[0],
  request: ProjectionRequest,
  context: {
    profileUpgrade: boolean;
    projectionShards: readonly EffectiveProjectionShard[];
    plan: StorageVnextPublicationBatchPlan;
  }
): Promise<{
  navigation: StorageVnextExtensionNavigationInput;
  reusedShards: readonly StorageVnextShardDescriptor[];
}> {
  const affectedDirectories = context.profileUpgrade
    ? [...STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES]
    : affectedExtensionNavigationDirectories(context.plan);
  const previousLeaves = new Map<string, readonly PersistentDirectoryLeaf[]>();
  for (const directoryPath of affectedDirectories) {
    previousLeaves.set(directoryPath, await input.snapshot.readExtensionNavigationLeaves({
      knowledgeBaseId: request.knowledgeBaseId,
      candidatePublicId: request.candidatePublicId,
      directoryPath,
      maximumBytes: input.limits.maximumSourceBytes,
      signal: request.signal
    }));
  }
  const unaffectedDirectories = STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES.filter(
    (directoryPath) => !affectedDirectories.includes(directoryPath)
  );
  const reusedShards = unaffectedDirectories.length === 0 ? []
    : await input.snapshot.listExtensionNavigationShards({
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId: request.candidatePublicId,
        directoryPaths: unaffectedDirectories,
        limit: input.limits.maximumProjectionShards
      });
  if (!context.profileUpgrade && new Set(reusedShards.map((shard) =>
    shard.firstLogicalPath)).size !== unaffectedDirectories.length) {
    throw projectionLoaderError("extension_navigation_state_incomplete");
  }
  const paths = context.profileUpgrade
    ? await listLegacyExtensionPaths(input, request)
    : deriveCurrentExtensionPaths(
        context.projectionShards,
        previousLeaves,
        affectedDirectories
      );
  return {
    navigation: {
      byFileLogicalPaths: paths.byFileLogicalPaths,
      existingMarkdownPaths: paths.markdownLogicalPaths,
      previousLeaves,
      sources: context.profileUpgrade
        ? listExtensionSources(input, request)
        : emptyExtensionSources(),
      affectedDirectoryPaths: affectedDirectories,
      previousPresentDirectoryPaths: previousPresentExtensionDirectories(
        context.projectionShards,
        previousLeaves,
        reusedShards
      ),
      completeProfile: context.profileUpgrade,
      maxEntries: input.limits.directoryIndexMaxEntries,
      maxLeafBytes: input.limits.directoryIndexMaxBytes,
      maxShardBytes: input.limits.maximumMachineArtifactBytes
    },
    reusedShards
  };
}

async function listLegacyExtensionPaths(
  input: Parameters<typeof createStorageVnextPublicationProjectionLoader>[0],
  request: ProjectionRequest
): Promise<{
  byFileLogicalPaths: string[];
  markdownLogicalPaths: string[];
}> {
  const byFileLogicalPaths: string[] = [];
  const markdownLogicalPaths: string[] = [];
  let scannedCount = 0;
  let cursor: string | null = null;
  do {
    throwIfAborted(request.signal);
    const remaining = input.limits.maximumAffectedPaths - scannedCount;
    if (remaining < 1) throw projectionLoaderError("extension_path_budget_exceeded");
    const page = await input.snapshot.listExtensionCatalogPaths({
      knowledgeBaseId: request.knowledgeBaseId,
      candidatePublicId: request.candidatePublicId,
      limit: Math.min(input.limits.catalogPageSize, remaining),
      cursor
    });
    if (
      !Number.isSafeInteger(page.scannedCount)
      || page.scannedCount < page.byFileLogicalPaths.length
        + page.markdownLogicalPaths.length
      || page.scannedCount > Math.min(input.limits.catalogPageSize, remaining)
    ) throw projectionLoaderError("extension_catalog_page_invalid");
    scannedCount += page.scannedCount;
    byFileLogicalPaths.push(...page.byFileLogicalPaths);
    markdownLogicalPaths.push(...page.markdownLogicalPaths);
    cursor = advancingCursor(cursor, page.nextCursor, "extension_catalog");
  } while (cursor !== null);
  return { byFileLogicalPaths, markdownLogicalPaths };
}

function deriveCurrentExtensionPaths(
  projectionShards: readonly EffectiveProjectionShard[],
  previousLeaves: ReadonlyMap<string, readonly PersistentDirectoryLeaf[]>,
  affectedDirectories: readonly string[]
): { byFileLogicalPaths: string[]; markdownLogicalPaths: string[] } {
  const markdownLogicalPaths = new Set<string>();
  const byFileLogicalPaths = (previousLeaves.get("_graph/by-file") ?? [])
    .flatMap((leaf) => leaf.entries.map((entry) => entry.targetPath));
  for (const directoryPath of affectedDirectories) {
    const leaves = previousLeaves.get(directoryPath) ?? [];
    const hasTypedProjection = projectionShards.some((shard) =>
      parentPath(shard.logicalPath) === directoryPath);
    if (leaves.length === 0 && !hasTypedProjection) continue;
    markdownLogicalPaths.add(`${directoryPath}/index.md`);
    if (directoryPath !== "_graph/by-file") {
      markdownLogicalPaths.add(`${parentPath(directoryPath)}/index.md`);
    }
    for (const leaf of leaves) {
      markdownLogicalPaths.add(`${directoryPath}/index-${leaf.id}.md`);
    }
  }
  return {
    byFileLogicalPaths: [...new Set(byFileLogicalPaths)].sort(compareUtf8),
    markdownLogicalPaths: [...markdownLogicalPaths].sort(compareUtf8)
  };
}

function affectedExtensionNavigationDirectories(
  plan: StorageVnextPublicationBatchPlan
): string[] {
  const affected = new Set<string>();
  if (plan.searchSourceFilePublicIds.length > 0 || plan.graphPublicIds.length > 0) {
    for (const directoryPath of [
      "_index/manifest/v1",
      "_index/search/v1",
      "_index/tree/v1",
      "_graph/graph_node/v1",
      "_graph/by-file"
    ]) affected.add(directoryPath);
  }
  if (plan.directoryPaths.length > 0) affected.add("_index/tree/v1");
  if (plan.linkPublicIds.length > 0) {
    affected.add("_index/links/v1");
    affected.add("_graph/graph_edge/v1");
  }
  return STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES.filter((directoryPath) =>
    affected.has(directoryPath));
}

function previousPresentExtensionDirectories(
  projectionShards: readonly EffectiveProjectionShard[],
  previousLeaves: ReadonlyMap<string, readonly PersistentDirectoryLeaf[]>,
  reusedShards: readonly StorageVnextShardDescriptor[]
): string[] {
  const present = new Set<string>();
  for (const shard of projectionShards) {
    const directoryPath = parentPath(shard.logicalPath);
    if (STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES.includes(
      directoryPath as (typeof STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES)[number]
    )) present.add(directoryPath);
  }
  if ((previousLeaves.get("_graph/by-file") ?? []).length > 0) {
    present.add("_graph/by-file");
  }
  if (reusedShards.some((shard) =>
    shard.firstLogicalPath === "_graph/by-file" && shard.recordCount > 0)) {
    present.add("_graph/by-file");
  }
  return [...present].sort(compareUtf8);
}

async function* emptyExtensionSources(): AsyncIterable<
  readonly StorageVnextExtensionNavigationSource[]
> {
  return;
}

async function* listExtensionSources(
  input: Parameters<typeof createStorageVnextPublicationProjectionLoader>[0],
  request: ProjectionRequest
): AsyncIterable<readonly StorageVnextExtensionNavigationSource[]> {
  let cursor: string | null = null;
  do {
    throwIfAborted(request.signal);
    const page = await input.catalog.listSourceFiles({
      knowledgeBaseId: request.knowledgeBaseId,
      directoryPublicId: undefined,
      limit: input.limits.catalogPageSize,
      cursor
    });
    yield page.items.filter(isPublishedSource).map((source) => ({
      publicId: source.publicId,
      title: source.title,
      pagePath: `pages/${source.logicalPath}`
    }));
    cursor = advancingCursor(cursor, page.nextCursor, "extension_source");
  } while (cursor !== null);
}

async function resolveRemovedSourceLogicalPaths(
  input: Parameters<typeof createStorageVnextPublicationProjectionLoader>[0],
  request: ProjectionRequest & { plan: StorageVnextPublicationBatchPlan }
): Promise<string[]> {
  const currentPaths = new Set<string>();
  const possibleSourcePublicIds = [...new Set([
    ...request.plan.searchSourceFilePublicIds,
    ...request.plan.graphPublicIds
  ])];
  for (const publicIds of chunked(
    possibleSourcePublicIds,
    input.limits.catalogPageSize
  )) {
    throwIfAborted(request.signal);
    const sources = await input.catalog.listSourceFilesByPublicIds({
      knowledgeBaseId: request.knowledgeBaseId,
      publicIds,
      limit: publicIds.length
    });
    for (const source of sources) currentPaths.add(`pages/${source.logicalPath}`);
  }
  return request.plan.sourcePaths.filter((path) => !currentPaths.has(path));
}

async function* createProjectionBatches(context: {
  input: Parameters<typeof createStorageVnextPublicationProjectionLoader>[0];
  request: ProjectionRequest & { plan: StorageVnextPublicationBatchPlan };
  affectedSourceIds: readonly string[];
  directories: readonly StorageVnextPublicationDirectoryInput[];
  currentDirectoryPaths: readonly string[];
  deletedDirectoryPaths: readonly string[];
}): AsyncIterable<StorageVnextPublicationProjectionBatch> {
  const currentSourcePaths: string[] = [];
  const batches = context.affectedSourceIds.length === 0
    ? [[]]
    : chunked(context.affectedSourceIds, context.input.limits.catalogPageSize);
  for (let index = 0; index < batches.length; index += 1) {
    throwIfAborted(context.request.signal);
    const sourceIds = batches[index]!;
    const pages = await loadPages(context.input, context.request, sourceIds);
    currentSourcePaths.push(...pages.map((page) => page.node.logicalPath));
    const machine = await assembleStorageVnextMachineProjection({
      knowledgeBaseId: context.request.knowledgeBaseId,
      candidatePublicId: context.request.candidatePublicId,
      plan: emptyMachinePlan(),
      affectedSourceFilePublicIds: sourceIds,
      pages,
      directories: [],
      getEdge: (publicId) => context.input.graph.getEdge({
        knowledgeBaseId: context.request.knowledgeBaseId,
        publicId
      }),
      getNode: (publicId) => context.input.graph.getNode({
        knowledgeBaseId: context.request.knowledgeBaseId,
        publicId
      }),
      readExisting: (logicalPath) => context.input.snapshot.readProjectionRecords({
        knowledgeBaseId: context.request.knowledgeBaseId,
        candidatePublicId: context.request.candidatePublicId,
        logicalPath,
        maximumBytes: context.input.limits.maximumMachineArtifactBytes,
        signal: context.request.signal
      }),
      shardCounts: context.input.limits.machineShardCounts,
      maximumArtifactBytes: context.input.limits.maximumMachineArtifactBytes,
      relatedFileLimit: context.input.limits.relatedFileLimit,
      signal: context.request.signal,
      includedProjectionKinds: ["related_files"]
    });
    yield {
      pages,
      machineArtifacts: machine.artifacts,
      projectionShards: machine.shards,
      deletedLogicalPaths: machine.deletedLogicalPaths
    };
  }
  for (const work of createMachineProjectionWork(context)) {
    throwIfAborted(context.request.signal);
    const pages = await loadPages(
      context.input,
      context.request,
      work.sourceFilePublicIds
    );
    const nodeCache = new Map<string, StorageVnextGraphNodeFact | null>();
    const machine = await assembleStorageVnextMachineProjection({
      knowledgeBaseId: context.request.knowledgeBaseId,
      candidatePublicId: context.request.candidatePublicId,
      plan: {
        ...emptyMachinePlan(),
        directoryPaths: work.directoryPaths,
        linkPublicIds: work.edgePublicIds
      },
      affectedSourceFilePublicIds: work.sourceFilePublicIds,
      pages,
      directories: context.directories.filter((directory) =>
        work.directoryPaths.includes(directory.directoryPath)),
      getEdge: (publicId) => context.input.graph.getEdge({
        knowledgeBaseId: context.request.knowledgeBaseId,
        publicId
      }),
      getNode: async (publicId) => {
        if (nodeCache.has(publicId)) return nodeCache.get(publicId) ?? null;
        const node = await context.input.graph.getNode({
          knowledgeBaseId: context.request.knowledgeBaseId,
          publicId
        });
        nodeCache.set(publicId, node);
        return node;
      },
      readExisting: (logicalPath) => context.input.snapshot.readProjectionRecords({
        knowledgeBaseId: context.request.knowledgeBaseId,
        candidatePublicId: context.request.candidatePublicId,
        logicalPath,
        maximumBytes: context.input.limits.maximumMachineArtifactBytes,
        signal: context.request.signal
      }),
      shardCounts: context.input.limits.machineShardCounts,
      maximumArtifactBytes: context.input.limits.maximumMachineArtifactBytes,
      relatedFileLimit: context.input.limits.relatedFileLimit,
      signal: context.request.signal,
      includedProjectionKinds: [work.projectionKind]
    });
    yield {
      pages: [],
      machineArtifacts: machine.artifacts,
      projectionShards: machine.shards,
      deletedLogicalPaths: machine.deletedLogicalPaths
    };
  }
  const deletedLogicalPaths = await context.input.snapshot.listAffectedObsoletePaths({
    knowledgeBaseId: context.request.knowledgeBaseId,
    candidatePublicId: context.request.candidatePublicId,
    sourcePaths: context.request.plan.sourcePaths,
    currentDirectoryPaths: context.currentDirectoryPaths,
    deletedDirectoryPaths: context.deletedDirectoryPaths,
    currentLogicalPaths: [
      ...currentSourcePaths,
      ...context.directories.flatMap(directoryLogicalPaths)
    ],
    limit: context.input.limits.maximumAffectedPaths
  });
  if (deletedLogicalPaths.length > 0) {
    yield {
      pages: [],
      machineArtifacts: [],
      projectionShards: [],
      deletedLogicalPaths
    };
  }
}

type MachineProjectionWork = {
  projectionKind: Exclude<StorageVnextMachineProjectionKind, "related_files">;
  logicalPath: string;
  sourceFilePublicIds: string[];
  directoryPaths: string[];
  edgePublicIds: string[];
};

function createMachineProjectionWork(context: {
  input: Parameters<typeof createStorageVnextPublicationProjectionLoader>[0];
  request: ProjectionRequest & { plan: StorageVnextPublicationBatchPlan };
  affectedSourceIds: readonly string[];
}): MachineProjectionWork[] {
  const workByPath = new Map<string, MachineProjectionWork>();
  const add = (
    projectionKind: MachineProjectionWork["projectionKind"],
    stableIdentity: string,
    value: { sourceFilePublicId?: string; directoryPath?: string; edgePublicId?: string }
  ) => {
    const shardKey = resolveProjectionShard({
      projectionKind,
      stableIdentity,
      shardCount: machineShardCount(context.input.limits.machineShardCounts, projectionKind)
    });
    const logicalPath = projectionKind === "graph_node" || projectionKind === "graph_edge"
      ? `_graph/${shardKey}.json`
      : `_index/${shardKey}.json`;
    const work = workByPath.get(logicalPath) ?? {
      projectionKind,
      logicalPath,
      sourceFilePublicIds: [],
      directoryPaths: [],
      edgePublicIds: []
    };
    if (value.sourceFilePublicId) {
      work.sourceFilePublicIds.push(value.sourceFilePublicId);
    }
    if (value.directoryPath) work.directoryPaths.push(value.directoryPath);
    if (value.edgePublicId) work.edgePublicIds.push(value.edgePublicId);
    workByPath.set(logicalPath, work);
  };
  for (const sourceFilePublicId of context.affectedSourceIds) {
    for (const projectionKind of [
      "search", "manifest", "tree", "graph_node"
    ] as const) {
      add(projectionKind, sourceFilePublicId, { sourceFilePublicId });
    }
  }
  for (const directoryPath of context.request.plan.directoryPaths) {
    const relativePath = directoryPath === "pages"
      ? ""
      : directoryPath.slice("pages/".length);
    add("tree", `directory:${relativePath}`, { directoryPath });
  }
  for (const edgePublicId of context.request.plan.linkPublicIds) {
    add("links", edgePublicId, { edgePublicId });
    add("graph_edge", edgePublicId, { edgePublicId });
  }
  return [...workByPath.values()]
    .map((work) => ({
      ...work,
      sourceFilePublicIds: work.sourceFilePublicIds.sort(compareUtf8),
      directoryPaths: work.directoryPaths.sort(compareUtf8),
      edgePublicIds: work.edgePublicIds.sort(compareUtf8)
    }))
    .sort((left, right) => compareUtf8(left.logicalPath, right.logicalPath));
}

function machineShardCount(
  counts: Parameters<typeof createStorageVnextPublicationProjectionLoader>[0]["limits"]["machineShardCounts"],
  projectionKind: MachineProjectionWork["projectionKind"]
): number {
  if (projectionKind === "graph_node") return counts.graphNode;
  if (projectionKind === "graph_edge") return counts.graphEdge;
  return counts[projectionKind];
}

function emptyMachinePlan(): StorageVnextPublicationBatchPlan {
  return {
    sourcePaths: [],
    directoryPaths: [],
    graphPublicIds: [],
    linkPublicIds: [],
    searchSourceFilePublicIds: [],
    rootPaths: []
  };
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const output: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    output.push(items.slice(offset, offset + size));
  }
  return output;
}

async function resolveAffectedSourceIds(
  input: Parameters<typeof createStorageVnextPublicationProjectionLoader>[0],
  request: ProjectionRequest & { plan: StorageVnextPublicationBatchPlan }
): Promise<string[]> {
  const ids = new Set([
    ...request.plan.searchSourceFilePublicIds,
    ...request.plan.graphPublicIds
  ]);
  for (const edgePublicId of request.plan.linkPublicIds) {
    throwIfAborted(request.signal);
    const edge = await input.graph.getEdge({
      knowledgeBaseId: request.knowledgeBaseId,
      publicId: edgePublicId
    });
    if (!edge) continue;
    for (const nodePublicId of [edge.fromNodePublicId, edge.toNodePublicId]) {
      const node = await input.graph.getNode({
        knowledgeBaseId: request.knowledgeBaseId,
        publicId: nodePublicId
      });
      if (!node) throw projectionLoaderError("graph_endpoint_conflict");
      ids.add(node.sourceFilePublicId);
    }
  }
  if (ids.size > input.limits.maximumAffectedPaths) {
    throw projectionLoaderError("affected_path_budget_exceeded");
  }
  return [...ids].sort(compareUtf8);
}

async function loadPages(
  input: Parameters<typeof createStorageVnextPublicationProjectionLoader>[0],
  request: ProjectionRequest,
  sourceFilePublicIds: readonly string[]
): Promise<StorageVnextPublicationPageInput[]> {
  const sourceFiles: StorageVnextSourceFileFact[] = [];
  for (let offset = 0; offset < sourceFilePublicIds.length;
    offset += input.limits.catalogPageSize) {
    const publicIds = sourceFilePublicIds.slice(
      offset,
      offset + input.limits.catalogPageSize
    );
    sourceFiles.push(...await input.catalog.listSourceFilesByPublicIds({
        knowledgeBaseId: request.knowledgeBaseId,
        publicIds,
        limit: publicIds.length
      }));
  }
  const pages: StorageVnextPublicationPageInput[] = [];
  for (const sourceFile of sourceFiles) {
    throwIfAborted(request.signal);
    if (
      sourceFile.visibility !== "current"
      || sourceFile.status !== "ready"
      || !sourceFile.currentRevisionPublicId
    ) continue;
    const sourceRevision = await input.catalog.getCurrentSourceRevision({
      knowledgeBaseId: request.knowledgeBaseId,
      sourceFilePublicId: sourceFile.publicId
    });
    if (!sourceRevision) throw projectionLoaderError("source_revision_conflict");
    const current = { sourceFile, sourceRevision };
    const nodePage = await input.graph.listBySourceFile({
      knowledgeBaseId: request.knowledgeBaseId,
      sourceFilePublicId: sourceFile.publicId,
      limit: 2,
      cursor: null
    });
    const node = nodePage.items[0];
    if (!node || nodePage.items.length !== 1 || nodePage.nextCursor !== null) {
      throw projectionLoaderError("graph_source_conflict");
    }
    const neighborhood = await loadNeighborhood(input.graph, request, node.publicId,
      input.limits.relatedFileLimit);
    const endpointNodes = await loadEndpointNodes(input.graph, request, node, neighborhood);
    const chunks = await input.sourceBodies.readVerifiedStream({
      objectId: sourceRevision.objectId,
      checksum: sourceRevision.checksum,
      byteCount: sourceRevision.byteCount,
      contentType: sourceRevision.contentType,
      maxBytes: input.limits.maximumSourceBytes,
      signal: request.signal
    });
    pages.push({
      current,
      node,
      neighborhood,
      endpointNodes,
      sourceBody: await readUtf8(chunks, request.signal)
    });
  }
  return pages.sort((left, right) =>
    compareUtf8(left.node.logicalPath, right.node.logicalPath));
}

async function loadNeighborhood(
  graph: GraphPort,
  request: ProjectionRequest,
  nodePublicId: string,
  limit: number
): Promise<StorageVnextGraphEdgeFact[]> {
  const page = await graph.listNeighborhood({
    knowledgeBaseId: request.knowledgeBaseId,
    nodePublicId,
    depth: 1,
    limit,
    cursor: null
  });
  if (page.items.length > limit) throw projectionLoaderError("graph_page_overflow");
  return [...page.items];
}

async function loadEndpointNodes(
  graph: GraphPort,
  request: ProjectionRequest,
  source: StorageVnextGraphNodeFact,
  edges: readonly StorageVnextGraphEdgeFact[]
): Promise<StorageVnextGraphNodeFact[]> {
  const ids = new Set(edges.flatMap((edge) =>
    [edge.fromNodePublicId, edge.toNodePublicId]));
  ids.add(source.publicId);
  const nodes: StorageVnextGraphNodeFact[] = [];
  for (const publicId of [...ids].sort(compareUtf8)) {
    throwIfAborted(request.signal);
    const node = publicId === source.publicId ? source : await graph.getNode({
      knowledgeBaseId: request.knowledgeBaseId,
      publicId
    });
    if (!node) throw projectionLoaderError("graph_endpoint_conflict");
    nodes.push(node);
  }
  return nodes;
}

async function loadDirectoryFacts(
  input: Parameters<typeof createStorageVnextPublicationProjectionLoader>[0],
  request: ProjectionRequest,
  generatedPaths: readonly string[]
): Promise<Map<string, StorageVnextDirectoryFact>> {
  const wanted = new Set(generatedPaths.filter((path) => path !== "pages"));
  const found = new Map<string, StorageVnextDirectoryFact>();
  let cursor: string | null = null;
  do {
    throwIfAborted(request.signal);
    const page = await input.catalog.listDirectories({
      knowledgeBaseId: request.knowledgeBaseId,
      parentPublicId: undefined,
      limit: input.limits.catalogPageSize,
      cursor
    });
    for (const directory of page.items) {
      const generatedPath = `pages/${directory.logicalPath}`;
      if (wanted.has(generatedPath)) found.set(generatedPath, directory);
    }
    cursor = advancingCursor(cursor, page.nextCursor, "directory");
  } while (cursor !== null && found.size < wanted.size);
  return found;
}

async function loadAllDirectoryFacts(
  input: Parameters<typeof createStorageVnextPublicationProjectionLoader>[0],
  request: ProjectionRequest
): Promise<Map<string, StorageVnextDirectoryFact>> {
  const found = new Map<string, StorageVnextDirectoryFact>();
  let cursor: string | null = null;
  do {
    throwIfAborted(request.signal);
    const page = await input.catalog.listDirectories({
      knowledgeBaseId: request.knowledgeBaseId,
      parentPublicId: undefined,
      limit: input.limits.catalogPageSize,
      cursor
    });
    for (const directory of page.items) {
      found.set(`pages/${directory.logicalPath}`, directory);
    }
    cursor = advancingCursor(cursor, page.nextCursor, "upgrade_directory");
  } while (cursor !== null);
  return found;
}

async function loadDirectory(
  input: Parameters<typeof createStorageVnextPublicationProjectionLoader>[0],
  request: ProjectionRequest,
  directoryPath: string,
  directory: StorageVnextDirectoryFact | null,
  descendantFileCount: number
): Promise<StorageVnextPublicationDirectoryInput> {
  const [directories, sources, previousLeaves] = await Promise.all([
    listAllDirectories(input, request, directory?.publicId ?? null),
    listAllSourceFiles(input, request, directory?.publicId ?? null),
    input.snapshot.readDirectoryLeaves({
      knowledgeBaseId: request.knowledgeBaseId,
      candidatePublicId: request.candidatePublicId,
      directoryPath,
      maximumBytes: input.limits.maximumSourceBytes,
      signal: request.signal
    })
  ]);
  const entries: OrderedDirectoryEntry[] = [
    ...directories.map((child) => {
      const name = child.logicalPath.split("/").at(-1)!;
      return {
        id: `directory:${child.logicalPath}`,
        sortKey: `${name.toLocaleLowerCase("en-US")}/directory:${child.logicalPath}`,
        name,
        targetPath: `pages/${child.logicalPath}/index.md`,
        kind: "directory" as const
      };
    }),
    ...sources
      .filter(isPublishedSource)
      .map((source) => {
        const name = source.logicalPath.split("/").at(-1)!;
        return {
          id: source.publicId,
          sortKey: `${name.toLocaleLowerCase("en-US")}/${source.publicId}`,
          name,
          targetPath: `pages/${source.logicalPath}`,
          kind: "file" as const
        };
      })
  ].sort(compareOrderedDirectoryEntries);
  return {
    directoryPublicId: directory?.publicId ?? null,
    directoryPath,
    entryCount: entries.length,
    descendantFileCount,
    leaves: packLeaves({
      knowledgeBaseId: request.knowledgeBaseId,
      directoryPath,
      entries,
      previousLeaves,
      maxEntries: input.limits.directoryIndexMaxEntries,
      maxBytes: input.limits.directoryIndexMaxBytes
    })
  };
}

async function listAllDirectories(
  input: Parameters<typeof createStorageVnextPublicationProjectionLoader>[0],
  request: ProjectionRequest,
  parentPublicId: string | null
): Promise<StorageVnextDirectoryFact[]> {
  const items: StorageVnextDirectoryFact[] = [];
  let cursor: string | null = null;
  do {
    const page = await input.catalog.listDirectories({
      knowledgeBaseId: request.knowledgeBaseId,
      parentPublicId,
      limit: input.limits.catalogPageSize,
      cursor
    });
    items.push(...page.items);
    cursor = advancingCursor(cursor, page.nextCursor, "child_directory");
  } while (cursor !== null);
  return items;
}

async function listAllSourceFiles(
  input: Parameters<typeof createStorageVnextPublicationProjectionLoader>[0],
  request: ProjectionRequest,
  directoryPublicId: string | null
): Promise<StorageVnextSourceFileFact[]> {
  const items: StorageVnextSourceFileFact[] = [];
  let cursor: string | null = null;
  do {
    const page = await input.catalog.listSourceFiles({
      knowledgeBaseId: request.knowledgeBaseId,
      directoryPublicId,
      limit: input.limits.catalogPageSize,
      cursor
    });
    items.push(...page.items);
    cursor = advancingCursor(cursor, page.nextCursor, "source");
  } while (cursor !== null);
  return items;
}

function packLeaves(input: {
  knowledgeBaseId: string;
  directoryPath: string;
  entries: readonly OrderedDirectoryEntry[];
  previousLeaves: readonly PersistentDirectoryLeaf[];
  maxEntries: number;
  maxBytes: number;
}): PersistentDirectoryLeaf[] {
  let leaves: OrderedDirectoryLeaf[] = input.previousLeaves.map((leaf) => ({
    id: leaf.id,
    entries: [...leaf.entries]
  }));
  const desired = new Map(input.entries.map((entry) => [entry.id, entry]));
  const limits = {
    maxEntries: input.maxEntries,
    maxBytes: input.maxBytes,
    mergeBelowEntries: Math.max(1, Math.floor(input.maxEntries / 4))
  };
  for (const existing of leaves.flatMap((leaf) => leaf.entries)) {
    const next = desired.get(existing.id);
    if (next && JSON.stringify(existing) === JSON.stringify(next)) continue;
    leaves = removeDirectoryEntry({
      leaves,
      entryId: existing.id,
      limits
    }).leaves;
  }
  const leafIds = new Set(leaves.map((leaf) => leaf.id));
  let sequence = 0;
  leaves = insertOrderedDirectoryEntries({
    leaves,
    entries: input.entries,
    limits,
    createLeafId: () => {
      let id: string;
      do id = createLeafId(input, sequence++);
      while (leafIds.has(id));
      leafIds.add(id);
      return id;
    }
  }).leaves;
  const previousById = new Map(input.previousLeaves.map((leaf) => [leaf.id, leaf]));
  return leaves.map((leaf, index) => ({
    ...leaf,
    previousLeafId: leaves[index - 1]?.id ?? null,
    nextLeafId: leaves[index + 1]?.id ?? null,
    revision: nextLeafRevision({
      leaf,
      previous: previousById.get(leaf.id) ?? null,
      previousLeafId: leaves[index - 1]?.id ?? null,
      nextLeafId: leaves[index + 1]?.id ?? null
    })
  }));
}

function nextLeafRevision(input: {
  leaf: OrderedDirectoryLeaf;
  previous: PersistentDirectoryLeaf | null;
  previousLeafId: string | null;
  nextLeafId: string | null;
}): number {
  if (!input.previous) return 1;
  const unchanged = input.previous.previousLeafId === input.previousLeafId
    && input.previous.nextLeafId === input.nextLeafId
    && JSON.stringify(input.previous.entries) === JSON.stringify(input.leaf.entries);
  return unchanged ? input.previous.revision : input.previous.revision + 1;
}

function createLeafId(
  input: { knowledgeBaseId: string; directoryPath: string },
  sequence: number
): string {
  const digest = createHash("sha256")
    .update("storage-vnext-directory-leaf-v1\0")
    .update(input.knowledgeBaseId)
    .update("\0")
    .update(input.directoryPath)
    .update("\0")
    .update(String(sequence))
    .digest("hex");
  return `directory-leaf-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function directoryLogicalPaths(directory: StorageVnextPublicationDirectoryInput): string[] {
  return [
    `${directory.directoryPath}/index.md`,
    ...directory.leaves.map((leaf) => directoryLeafPath(directory.directoryPath, leaf.id))
  ];
}

function isPublishedSource(source: StorageVnextSourceFileFact): boolean {
  return source.visibility === "current"
    && source.status === "ready"
    && source.currentRevisionPublicId !== null;
}

async function readUtf8(
  chunks: AsyncIterable<Uint8Array>,
  signal: AbortSignal
): Promise<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const output: string[] = [];
  for await (const chunk of chunks) {
    throwIfAborted(signal);
    output.push(decoder.decode(chunk, { stream: true }));
  }
  output.push(decoder.decode());
  return output.join("");
}

function validateLimits(limits: Parameters<
  typeof createStorageVnextPublicationProjectionLoader
>[0]["limits"]): void {
  const numericLimits = Object.entries(limits)
    .filter(([key]) => key !== "machineShardCounts")
    .map(([, value]) => value as number);
  if (
    [...numericLimits, ...Object.values(limits.machineShardCounts)]
      .some((value) => !Number.isSafeInteger(value) || value < 1)
    || limits.catalogPageSize > 1_000
    || limits.maximumAffectedPaths > 250_000
    || limits.relatedFileLimit > 1_000
    || limits.directoryIndexMaxEntries < 2
  ) throw projectionLoaderError("invalid_configuration");
}

function validateRequest(request: ProjectionRequest): void {
  if (
    [
      request.knowledgeBaseId,
      request.candidatePublicId,
      request.operationPublicId,
      request.searchProjectionPublicId
    ]
      .some((value) => !value || Buffer.byteLength(value) > 255)
  ) throw projectionLoaderError("invalid_request");
}

function advancingCursor(
  previous: string | null,
  next: string | null,
  kind: string
): string | null {
  if (next !== null && next === previous) {
    throw projectionLoaderError(`${kind}_cursor_stalled`);
  }
  return next;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function parentPath(logicalPath: string): string {
  return logicalPath.slice(0, logicalPath.lastIndexOf("/"));
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("Storage vNext publication projection loading aborted", "AbortError");
}

function projectionLoaderError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext publication projection loader error: ${code}`),
    { code }
  );
}
