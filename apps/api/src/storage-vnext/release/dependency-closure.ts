import {
  normalizeSourceDirectoryPath,
  normalizeSourceRelativePath
} from "../../domain/source-path.js";
import { REQUIRED_GENERATED_NAVIGATION_PATHS } from
  "../../okf/generated-graph-resources.js";
import {
  MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES,
  type StorageVnextCandidateChangedFact,
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

export type StorageVnextSemanticImpact = {
  sourceFilePublicIds: readonly string[];
  sourceRevisionPublicIds: readonly string[];
  entityPublicIds: readonly string[];
  relationshipPublicIds: readonly string[];
  evidencePublicIds: readonly string[];
  reverseReferencePublicIds: readonly string[];
  vectorOwnerPublicIds: readonly string[];
  dirtyPartitionKeys: readonly string[];
  affectedFileNeighborPublicIds: readonly string[];
  generatedLogicalPaths: readonly string[];
  graphShardPublicIds: readonly string[];
  searchShardPublicIds: readonly string[];
};

export function includeStorageVnextSemanticDependencyClosure(input: {
  base: StorageVnextReleaseDependencyClosure;
  semantic: StorageVnextSemanticImpact;
}): StorageVnextReleaseDependencyClosure {
  const dependencies = new Map(input.base.dependencies.map((dependency) => [
    `${dependency.kind}\u0000${dependency.publicId}`,
    dependency
  ]));
  const add = (dependency: StorageVnextCandidateDependency) => {
    if (!dependency.publicId) throw new Error("Semantic dependency identity is required");
    const key = `${dependency.kind}\u0000${dependency.publicId}`;
    const existing = dependencies.get(key);
    if (existing && existing.reasonCode !== dependency.reasonCode) {
      if (isSourceSemanticPageOverlap(existing, dependency)) {
        dependencies.set(key, existing.reasonCode === "source_path" ? existing : dependency);
        return;
      }
      throw new Error("Semantic dependency reason is inconsistent");
    }
    dependencies.set(key, dependency);
  };
  for (const publicId of stableUnique(input.semantic.entityPublicIds)) {
    add({ kind: "semantic", publicId, reasonCode: "semantic_entity" });
  }
  for (const publicId of stableUnique(input.semantic.relationshipPublicIds)) {
    add({ kind: "semantic", publicId, reasonCode: "semantic_relationship" });
  }
  for (const publicId of stableUnique(input.semantic.evidencePublicIds)) {
    add({ kind: "semantic", publicId, reasonCode: "semantic_evidence" });
  }
  for (const publicId of stableUnique(input.semantic.reverseReferencePublicIds)) {
    add({ kind: "semantic", publicId, reasonCode: "semantic_reverse_reference" });
  }
  for (const publicId of stableUnique(input.semantic.vectorOwnerPublicIds)) {
    add({ kind: "vector", publicId, reasonCode: "semantic_vector_owner" });
  }
  for (const publicId of stableUnique(input.semantic.dirtyPartitionKeys)) {
    add({ kind: "community", publicId, reasonCode: "semantic_dirty_partition" });
  }
  for (const publicId of stableUnique(input.semantic.graphShardPublicIds)) {
    add({ kind: "graph", publicId, reasonCode: "semantic_graph_shard" });
  }
  for (const publicId of stableUnique(input.semantic.searchShardPublicIds)) {
    add({ kind: "search", publicId, reasonCode: "semantic_search_shard" });
  }
  const semanticPaths = stableUnique(input.semantic.generatedLogicalPaths.map(
    assertGeneratedLogicalPath
  ));
  for (const publicId of semanticPaths) {
    add({ kind: "path", publicId, reasonCode: "semantic_generated_content" });
  }
  const orderedDependencies = [...dependencies.values()].sort(compareDependency);
  if (orderedDependencies.length > MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES) {
    throw new Error("Candidate dependency limit exceeded");
  }
  return {
    ...input.base,
    dependencies: orderedDependencies,
    affectedSourceFilePublicIds: stableUnique([
      ...input.base.affectedSourceFilePublicIds,
      ...input.semantic.sourceFilePublicIds,
      ...input.semantic.affectedFileNeighborPublicIds
    ]),
    affectedLogicalPaths: stableUnique([
      ...input.base.affectedLogicalPaths,
      ...semanticPaths
    ]),
    affectedDirectoryPaths: stableUnique([
      ...input.base.affectedDirectoryPaths,
      ...semanticPaths.flatMap(generatedPathAncestors)
    ])
  };
}

function isSourceSemanticPageOverlap(
  left: StorageVnextCandidateDependency,
  right: StorageVnextCandidateDependency
): boolean {
  if (left.kind !== "path" || right.kind !== "path") return false;
  return new Set([left.reasonCode, right.reasonCode]).size === 2
    && [left.reasonCode, right.reasonCode].includes("source_path")
    && [left.reasonCode, right.reasonCode].includes("semantic_generated_content");
}

export function deriveStorageVnextSemanticChangedFacts(input: {
  semantic: StorageVnextSemanticImpact;
  change: StorageVnextCandidateChangedFact["change"];
}): StorageVnextCandidateChangedFact[] {
  const facts: StorageVnextCandidateChangedFact[] = [];
  const append = (
    kind: StorageVnextCandidateChangedFact["kind"],
    values: readonly string[]
  ) => {
    for (const publicId of stableUnique(values)) {
      facts.push({ kind, publicId, change: input.change });
    }
  };
  append("source_file", input.semantic.sourceFilePublicIds);
  append("source_revision", input.semantic.sourceRevisionPublicIds);
  append("semantic_entity", input.semantic.entityPublicIds);
  append("semantic_relationship", input.semantic.relationshipPublicIds);
  append("semantic_evidence", input.semantic.evidencePublicIds);
  append("semantic_reverse_reference", input.semantic.reverseReferencePublicIds);
  append("semantic_vector", input.semantic.vectorOwnerPublicIds);
  append("semantic_community", input.semantic.dirtyPartitionKeys);
  return facts.sort((left, right) =>
    left.kind.localeCompare(right.kind, "en")
    || left.publicId.localeCompare(right.publicId, "en")
  );
}

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

function assertGeneratedLogicalPath(value: string): string {
  if (
    !value
    || value.length > 4096
    || value.startsWith("/")
    || value.includes("\\")
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) throw new Error("Semantic generated path is invalid");
  return value;
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
