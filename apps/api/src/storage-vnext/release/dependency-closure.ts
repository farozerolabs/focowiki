import {
  normalizeSourceDirectoryPath,
  normalizeSourceRelativePath
} from "../../domain/source-path.js";
import { REQUIRED_GENERATED_NAVIGATION_PATHS } from
  "../../okf/generated-graph-resources.js";
import {
  MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES,
  type StorageVnextCandidateDependency
} from "./ports.js";

export type StorageVnextReleaseMutationKind =
  | "upload"
  | "replacement"
  | "rename"
  | "move"
  | "file_delete"
  | "directory_delete"
  | "knowledge_base_delete"
  | "graph_change"
  | "search_change";

export type StorageVnextReleaseDependencyClosure = {
  knowledgeBaseId: string;
  mutationKind: StorageVnextReleaseMutationKind;
  dependencies: readonly StorageVnextCandidateDependency[];
  affectedSourceFilePublicIds: readonly string[];
  affectedLogicalPaths: readonly string[];
  affectedDirectoryPaths: readonly string[];
};

export function includeStorageVnextNavigationProfileUpgrade(input: {
  knowledgeBaseId: string;
  navigationProfileVersion: number | null;
  dependencies: readonly StorageVnextCandidateDependency[];
}): readonly StorageVnextCandidateDependency[] {
  if (input.navigationProfileVersion === null || input.navigationProfileVersion >= 1) {
    return input.dependencies;
  }
  return [
    ...input.dependencies,
    {
      kind: "scope" as const,
      publicId: input.knowledgeBaseId,
      reasonCode: "navigation_profile_upgrade"
    }
  ].sort(compareDependency);
}

export function deriveStorageVnextReleaseDependencyClosure(input: {
  knowledgeBaseId: string;
  mutationKind: StorageVnextReleaseMutationKind;
  sourceFilePublicIds: readonly string[];
  sourceLogicalPaths: readonly string[];
  previousSourceLogicalPaths: readonly string[];
  directoryLogicalPaths: readonly string[];
  searchSourceFilePublicIds: readonly string[];
  graphSourceFilePublicIds: readonly string[];
  graphEdgePublicIds: readonly string[];
}): StorageVnextReleaseDependencyClosure {
  if (!input.knowledgeBaseId) throw new Error("Knowledge-base identity is required");
  if (input.mutationKind === "knowledge_base_delete") {
    return {
      knowledgeBaseId: input.knowledgeBaseId,
      mutationKind: input.mutationKind,
      dependencies: [{
        kind: "scope",
        publicId: input.knowledgeBaseId,
        reasonCode: "knowledge_base_delete"
      }],
      affectedSourceFilePublicIds: [],
      affectedLogicalPaths: [],
      affectedDirectoryPaths: []
    };
  }

  const sourceFilePublicIds = stableUnique([
    ...input.sourceFilePublicIds,
    ...input.searchSourceFilePublicIds,
    ...input.graphSourceFilePublicIds
  ]);
  const generatedPaths = stableUnique([
    ...input.sourceLogicalPaths,
    ...input.previousSourceLogicalPaths
  ].map((path) => normalizeSourceRelativePath(path).generatedPath));
  const explicitDirectories = stableUnique(
    input.directoryLogicalPaths.map((path) =>
      normalizeSourceDirectoryPath(path).generatedPath
    )
  );
  const directoryPaths = stableUnique([
    ...generatedPaths.flatMap(generatedPathAncestors),
    ...explicitDirectories.flatMap(generatedDirectoryAncestors)
  ]);
  const dependencies = new Map<string, StorageVnextCandidateDependency>();
  const add = (dependency: StorageVnextCandidateDependency) => {
    if (!dependency.publicId) throw new Error("Dependency identity is required");
    const key = `${dependency.kind}\u0000${dependency.publicId}`;
    const existing = dependencies.get(key);
    if (existing && existing.reasonCode !== dependency.reasonCode) {
      throw new Error("Dependency reason is inconsistent");
    }
    dependencies.set(key, dependency);
  };

  add({
    kind: "ancestor",
    publicId: "pages",
    reasonCode: "directory_ancestor"
  });

  for (const logicalPath of generatedPaths) {
    add({ kind: "path", publicId: logicalPath, reasonCode: "source_path" });
  }
  for (const directoryPath of directoryPaths) {
    add({
      kind: "ancestor",
      publicId: directoryPath,
      reasonCode: "directory_ancestor"
    });
  }
  if (input.mutationKind === "directory_delete") {
    for (const directoryPath of explicitDirectories) {
      add({
        kind: "scope",
        publicId: directoryPath,
        reasonCode: "directory_delete"
      });
    }
  }
  for (const sourceFilePublicId of stableUnique([
    ...input.sourceFilePublicIds,
    ...input.searchSourceFilePublicIds
  ])) {
    add({
      kind: "search",
      publicId: sourceFilePublicId,
      reasonCode: "search_document"
    });
  }
  for (const sourceFilePublicId of stableUnique([
    ...input.sourceFilePublicIds,
    ...input.graphSourceFilePublicIds
  ])) {
    add({
      kind: "graph",
      publicId: sourceFilePublicId,
      reasonCode: "graph_source"
    });
  }
  for (const edgePublicId of stableUnique(input.graphEdgePublicIds)) {
    add({ kind: "link", publicId: edgePublicId, reasonCode: "graph_edge" });
    add({ kind: "graph", publicId: edgePublicId, reasonCode: "graph_edge" });
  }
  for (const logicalPath of REQUIRED_GENERATED_NAVIGATION_PATHS) {
    if (logicalPath === "schema.md") {
      add({ kind: "schema", publicId: logicalPath, reasonCode: "required_schema" });
    } else if (logicalPath === "log.md") {
      add({ kind: "log", publicId: logicalPath, reasonCode: "bounded_update_log" });
    } else {
      add({ kind: "index", publicId: logicalPath, reasonCode: "required_navigation" });
    }
  }

  const orderedDependencies = [...dependencies.values()].sort(compareDependency);
  if (orderedDependencies.length > MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES) {
    throw new Error("Candidate dependency limit exceeded");
  }
  return {
    knowledgeBaseId: input.knowledgeBaseId,
    mutationKind: input.mutationKind,
    dependencies: orderedDependencies,
    affectedSourceFilePublicIds: sourceFilePublicIds,
    affectedLogicalPaths: generatedPaths,
    affectedDirectoryPaths: directoryPaths
  };
}

function generatedPathAncestors(path: string): string[] {
  const segments = path.split("/");
  segments.pop();
  const directories: string[] = [];
  for (let index = 1; index <= segments.length; index += 1) {
    directories.push(segments.slice(0, index).join("/"));
  }
  return directories;
}

function generatedDirectoryAncestors(path: string): string[] {
  const segments = path.split("/");
  const directories: string[] = [];
  for (let index = 1; index <= segments.length; index += 1) {
    directories.push(segments.slice(0, index).join("/"));
  }
  return directories;
}

function compareDependency(
  left: StorageVnextCandidateDependency,
  right: StorageVnextCandidateDependency
): number {
  return left.kind.localeCompare(right.kind, "en")
    || left.publicId.localeCompare(right.publicId, "en")
    || left.reasonCode.localeCompare(right.reasonCode, "en");
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, "en")
  );
}
