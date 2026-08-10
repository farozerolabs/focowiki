import { createHash } from "node:crypto";
import type { PersistentDirectoryLeaf } from
  "../../application/ports/directory-navigation-repository.js";
import type { EffectiveProjectionShard } from
  "../../application/ports/projection-catalog-repository.js";
import {
  compareOrderedDirectoryEntries,
  removeDirectoryEntry,
  type OrderedDirectoryEntry,
  type OrderedDirectoryLeaf
} from "../../publication/ordered-directory-leaves.js";
import { insertOrderedDirectoryEntries } from "./ordered-directory-batch.js";
import {
  extensionLeafPath,
  renderExtensionFamilyMarkdown,
  renderExtensionLandingMarkdown,
  renderExtensionLeafMarkdown,
  renderExtensionResourceRootMarkdown
} from "./extension-navigation-renderer.js";
import { createStorageVnextExtensionNavigationShards } from
  "./extension-navigation-state.js";
import type {
  StorageVnextInternalShard,
  StorageVnextPublicationArtifact
} from "./types.js";
import { STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES } from "./profile.js";

export type StorageVnextExtensionNavigationSource = {
  publicId: string;
  title: string;
  pagePath: string;
};

export type StorageVnextExtensionNavigationDescriptor = {
  publicPath: string;
  family: "manifest" | "search" | "links" | "tree" | "graph_node"
    | "graph_edge" | "by-file";
  version: "v1" | null;
  stableIdentity: string;
  label: string;
  sourceEvidence?: {
    sourceFilePublicId: string;
    pagePath: string;
  };
};

export type StorageVnextExtensionNavigationInput = {
  byFileLogicalPaths: readonly string[];
  existingMarkdownPaths: readonly string[];
  previousLeaves: ReadonlyMap<string, readonly PersistentDirectoryLeaf[]>;
  changedAt?: string;
  sources: AsyncIterable<readonly StorageVnextExtensionNavigationSource[]>;
  affectedDirectoryPaths: readonly string[];
  previousPresentDirectoryPaths: readonly string[];
  completeProfile: boolean;
  maxEntries: number;
  maxLeafBytes: number;
  maxShardBytes: number;
};

type FamilyDescriptor = {
  projectionKind: Exclude<StorageVnextExtensionNavigationDescriptor["family"], "by-file">;
  label: string;
  familyPath: string;
  resourcePath: string;
  rootPath: "_index" | "_graph";
};

const FAMILIES: readonly FamilyDescriptor[] = [
  family("manifest", "Manifest", "_index/manifest"),
  family("search", "Search", "_index/search"),
  family("links", "Links", "_index/links"),
  family("tree", "Tree", "_index/tree"),
  family("graph_node", "Graph nodes", "_graph/graph_node"),
  family("graph_edge", "Graph edges", "_graph/graph_edge")
];

export async function assembleStorageVnextExtensionNavigation(input: {
  knowledgeBaseId: string;
  projectionShards: readonly EffectiveProjectionShard[];
  navigation: StorageVnextExtensionNavigationInput;
}): Promise<{
  artifacts: StorageVnextPublicationArtifact[];
  deletedLogicalPaths: string[];
  internalShards: StorageVnextInternalShard[];
}> {
  validateInput(input);
  const affectedDirectories = new Set(input.navigation.affectedDirectoryPaths);
  const previousPresentDirectories = new Set(
    input.navigation.previousPresentDirectoryPaths
  );
  const entriesByDirectory = new Map<string, OrderedDirectoryEntry[]>();
  const presentFamilies = new Set<string>();
  for (const shard of input.projectionShards) {
    const descriptor = FAMILIES.find((item) =>
      item.projectionKind === shard.projectionKind);
    if (!descriptor || !shard.logicalPath.startsWith(`${descriptor.resourcePath}/`)) {
      continue;
    }
    presentFamilies.add(descriptor.familyPath);
    append(entriesByDirectory, descriptor.resourcePath, descriptorEntry({
      publicPath: shard.logicalPath,
      family: descriptor.projectionKind,
      version: "v1",
      stableIdentity: shard.logicalPath,
      label: shard.logicalPath.split("/").at(-1)!
    }));
  }

  const byFilePaths = new Set(input.navigation.byFileLogicalPaths);
  if (byFilePaths.size > 0) presentFamilies.add("_graph/by-file");
  const byFileEntries = new Map<string, OrderedDirectoryEntry>();
  for (const leaf of input.navigation.previousLeaves.get("_graph/by-file") ?? []) {
    for (const entry of leaf.entries) {
      if (byFilePaths.has(entry.targetPath)) byFileEntries.set(entry.id, entry);
    }
  }
  for await (const page of input.navigation.sources) {
    for (const source of page) {
      const logicalPath = `_graph/by-file/${encodeURIComponent(source.publicId)}.json`;
      if (!byFilePaths.has(logicalPath)) continue;
      byFileEntries.set(source.publicId, descriptorEntry({
        publicPath: logicalPath,
        family: "by-file",
        version: null,
        stableIdentity: source.publicId,
        label: source.title,
        sourceEvidence: {
          sourceFilePublicId: source.publicId,
          pagePath: source.pagePath
        }
      }));
    }
  }
  const representedByFilePaths = new Set(
    [...byFileEntries.values()].map((entry) => entry.targetPath)
  );
  if ([...byFilePaths].some((logicalPath) =>
    !representedByFilePaths.has(logicalPath))) {
    throw extensionNavigationError("by_file_source_conflict");
  }
  if (byFileEntries.size > 0) {
    entriesByDirectory.set("_graph/by-file", [...byFileEntries.values()]);
  }
  for (const directoryPath of previousPresentDirectories) {
    if (affectedDirectories.has(directoryPath)) continue;
    presentFamilies.add(familyPathForDirectory(directoryPath));
  }

  const artifacts: StorageVnextPublicationArtifact[] = [];
  const internalShards: StorageVnextInternalShard[] = [];
  const existingMarkdownPaths = new Set(input.navigation.existingMarkdownPaths);
  for (const rootPath of ["_index", "_graph"] as const) {
    if (!input.navigation.completeProfile
      && existingMarkdownPaths.has(`${rootPath}/index.md`)
      && !familyMembershipChanged(rootPath, previousPresentDirectories, presentFamilies)) {
      continue;
    }
    addArtifact(
      artifacts,
      `${rootPath}/index.md`,
      rootPath === "_index" ? "index" : "graph",
      renderExtensionLandingMarkdown({
        rootPath,
        families: rootPath === "_index"
          ? FAMILIES.filter((item) =>
              item.rootPath === rootPath && presentFamilies.has(item.familyPath))
              .map((item) => ({ label: item.label, path: `${item.familyPath}/index.md` }))
          : [
              ...FAMILIES.filter((item) =>
                item.rootPath === rootPath && presentFamilies.has(item.familyPath))
                .map((item) => ({ label: item.label, path: `${item.familyPath}/index.md` })),
              ...(presentFamilies.has("_graph/by-file")
                ? [{ label: "Relationships by file", path: "_graph/by-file/index.md" }]
                : [])
            ]
      })
    );
  }

  const desiredAffectedPaths = new Set(["_index/index.md", "_graph/index.md"]);
  for (const directoryPath of [...affectedDirectories].sort(compareUtf8)) {
    const entries = (entriesByDirectory.get(directoryPath) ?? [])
      .sort(compareOrderedDirectoryEntries);
    const previousLeaves = input.navigation.previousLeaves.get(directoryPath) ?? [];
    const leaves = reconcileLeaves({
      knowledgeBaseId: input.knowledgeBaseId,
      directoryPath,
      entries,
      previousLeaves,
      ...(input.navigation.changedAt
        ? { changedAt: input.navigation.changedAt }
        : {}),
      maxEntries: input.navigation.maxEntries,
      maxBytes: input.navigation.maxLeafBytes
    });
    const familyDescriptor = FAMILIES.find((item) =>
      item.resourcePath === directoryPath);
    const kind = directoryPath.startsWith("_index/") ? "index" : "graph";
    if (entries.length > 0) {
      if (familyDescriptor) {
        const familyIndexPath = `${familyDescriptor.familyPath}/index.md`;
        desiredAffectedPaths.add(familyIndexPath);
        if (input.navigation.completeProfile
          || !existingMarkdownPaths.has(familyIndexPath)) {
          addArtifact(
            artifacts,
            familyIndexPath,
            kind,
            renderExtensionFamilyMarkdown({
              directoryPath: familyDescriptor.familyPath,
              versionPath: familyDescriptor.resourcePath
            })
          );
        }
      }
      const resourceIndexPath = `${directoryPath}/index.md`;
      desiredAffectedPaths.add(resourceIndexPath);
      if (input.navigation.completeProfile
        || !existingMarkdownPaths.has(resourceIndexPath)
        || !sameResourceRoot(previousLeaves, leaves)) {
        addArtifact(artifacts, resourceIndexPath, kind,
          renderExtensionResourceRootMarkdown({
            directoryPath,
            entryCount: entries.length,
            firstLeafId: leaves[0]?.id ?? null
          }));
      }
      const previousById = new Map(previousLeaves.map((leaf) => [leaf.id, leaf]));
      for (const leaf of leaves) {
        const leafPath = extensionLeafPath(directoryPath, leaf.id);
        desiredAffectedPaths.add(leafPath);
        if (input.navigation.completeProfile
          || !existingMarkdownPaths.has(leafPath)
          || previousById.get(leaf.id)?.revision !== leaf.revision) {
          addArtifact(artifacts, leafPath, kind,
            renderExtensionLeafMarkdown({ directoryPath, leaf }));
        }
      }
    }
    internalShards.push(...createStorageVnextExtensionNavigationShards({
      directoryPath,
      leaves,
      maximumBytes: input.navigation.maxShardBytes
    }));
  }

  return {
    artifacts: artifacts.map((artifact, ordinal) => ({ ...artifact, ordinal })),
    deletedLogicalPaths: [...new Set(input.navigation.existingMarkdownPaths)]
      .filter((path) => !desiredAffectedPaths.has(path))
      .sort(compareUtf8),
    internalShards
  };
}

function reconcileLeaves(input: {
  knowledgeBaseId: string;
  directoryPath: string;
  entries: readonly OrderedDirectoryEntry[];
  previousLeaves: readonly PersistentDirectoryLeaf[];
  changedAt?: string;
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
  return leaves.map((leaf, index) => {
    const previous = previousById.get(leaf.id) ?? null;
    const revision = nextLeafRevision({
      leaf,
      previous,
      previousLeafId: leaves[index - 1]?.id ?? null,
      nextLeafId: leaves[index + 1]?.id ?? null
    });
    const changedAt = previous && revision === previous.revision && previous.changedAt
      ? previous.changedAt
      : input.changedAt;
    return {
      ...leaf,
      previousLeafId: leaves[index - 1]?.id ?? null,
      nextLeafId: leaves[index + 1]?.id ?? null,
      revision,
      ...(changedAt ? { changedAt } : {})
    };
  });
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
    .update("storage-vnext-extension-leaf-v1\0")
    .update(input.knowledgeBaseId)
    .update("\0")
    .update(input.directoryPath)
    .update("\0")
    .update(String(sequence))
    .digest("hex");
  return `extension-leaf-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function family(
  projectionKind: FamilyDescriptor["projectionKind"],
  label: string,
  familyPath: string
): FamilyDescriptor {
  return {
    projectionKind,
    label,
    familyPath,
    resourcePath: `${familyPath}/v1`,
    rootPath: familyPath.startsWith("_index/") ? "_index" : "_graph"
  };
}

function descriptorEntry(
  descriptor: StorageVnextExtensionNavigationDescriptor
): OrderedDirectoryEntry {
  return {
    id: descriptor.stableIdentity,
    sortKey: descriptor.family === "by-file"
      ? descriptor.stableIdentity
      : descriptor.publicPath,
    name: descriptor.label,
    targetPath: descriptor.publicPath,
    ...(descriptor.sourceEvidence
      ? { evidencePath: descriptor.sourceEvidence.pagePath }
      : {}),
    kind: "file"
  };
}

function append(
  map: Map<string, OrderedDirectoryEntry[]>,
  key: string,
  entry: OrderedDirectoryEntry
): void {
  const entries = map.get(key) ?? [];
  entries.push(entry);
  map.set(key, entries);
}

function addArtifact(
  artifacts: StorageVnextPublicationArtifact[],
  logicalPath: string,
  kind: StorageVnextPublicationArtifact["kind"],
  body: string
): void {
  if (artifacts.some((artifact) => artifact.logicalPath === logicalPath)) {
    throw extensionNavigationError("duplicate_logical_path");
  }
  artifacts.push({
    logicalPath,
    kind,
    sourceFilePublicId: null,
    ordinal: 0,
    bytes: Buffer.from(body, "utf8")
  });
}

function validateInput(input: Parameters<typeof assembleStorageVnextExtensionNavigation>[0]): void {
  if (
    !input.knowledgeBaseId
    || [
      input.navigation.maxEntries,
      input.navigation.maxLeafBytes,
      input.navigation.maxShardBytes
    ].some((value) => !Number.isSafeInteger(value) || value < 1)
    || input.navigation.maxEntries < 2
    || input.navigation.affectedDirectoryPaths.some((directoryPath) =>
      !STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES.includes(
        directoryPath as (typeof STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES)[number]
      ))
  ) throw extensionNavigationError("invalid_input");
}

function familyPathForDirectory(directoryPath: string): string {
  return FAMILIES.find((item) => item.resourcePath === directoryPath)?.familyPath
    ?? directoryPath;
}

function familyMembershipChanged(
  rootPath: "_index" | "_graph",
  previousPresentDirectories: ReadonlySet<string>,
  presentFamilies: ReadonlySet<string>
): boolean {
  const previous = [...previousPresentDirectories]
    .map(familyPathForDirectory)
    .filter((path) => path.startsWith(`${rootPath}/`))
    .sort(compareUtf8);
  const current = [...presentFamilies]
    .filter((path) => path.startsWith(`${rootPath}/`))
    .sort(compareUtf8);
  return JSON.stringify(previous) !== JSON.stringify(current);
}

function sameResourceRoot(
  previous: readonly PersistentDirectoryLeaf[],
  current: readonly PersistentDirectoryLeaf[]
): boolean {
  return previous.flatMap((leaf) => leaf.entries).length
      === current.flatMap((leaf) => leaf.entries).length
    && (previous[0]?.id ?? null) === (current[0]?.id ?? null);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function extensionNavigationError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext extension navigation error: ${code}`),
    { code }
  );
}
