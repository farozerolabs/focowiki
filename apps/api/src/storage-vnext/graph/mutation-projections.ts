import type {
  StorageVnextGraphMutationClosure,
  StorageVnextGraphNodeFact
} from "./ports.js";
import {
  mapStorageVnextGraphSeedDocument,
  type StorageVnextGraphSeedDocument
} from "./read-models.js";

export type StorageVnextGraphProjectionMutationKind =
  | "source_replaced"
  | "source_moved"
  | "source_deleted"
  | "directory_deleted"
  | "knowledge_base_deleted";

export type StorageVnextGraphProjectionChange = {
  knowledgeBaseId: string;
  mutationKind: StorageVnextGraphProjectionMutationKind;
  seedUpserts: readonly StorageVnextGraphSeedDocument[];
  seedDeleteSourceFilePublicIds: readonly string[];
  affectedSourceFilePublicIds: readonly string[];
  affectedEdgePublicIds: readonly string[];
  removedEdgePublicIds: readonly string[];
  logicalPaths: readonly string[];
  refreshGeneratedGraphCatalog: true;
  refreshGeneratedNavigation: true;
};

export function createStorageVnextGraphUpsertProjectionChange(input: {
  mutationKind: "source_moved" | "source_replaced";
  node: StorageVnextGraphNodeFact;
  previousLogicalPath?: string | null;
  affectedSourceFilePublicIds: readonly string[];
  affectedEdgePublicIds: readonly string[];
}): StorageVnextGraphProjectionChange {
  return {
    knowledgeBaseId: input.node.knowledgeBaseId,
    mutationKind: input.mutationKind,
    seedUpserts: [mapStorageVnextGraphSeedDocument(input.node)],
    seedDeleteSourceFilePublicIds: [],
    affectedSourceFilePublicIds: stableUnique([
      input.node.sourceFilePublicId,
      ...input.affectedSourceFilePublicIds
    ]),
    affectedEdgePublicIds: stableUnique(input.affectedEdgePublicIds),
    removedEdgePublicIds: [],
    logicalPaths: stableUnique([
      input.node.logicalPath,
      ...(input.previousLogicalPath ? [input.previousLogicalPath] : [])
    ]),
    refreshGeneratedGraphCatalog: true,
    refreshGeneratedNavigation: true
  };
}

export function createStorageVnextGraphDeleteProjectionChange(input: {
  knowledgeBaseId: string;
  mutationKind:
    | "source_deleted"
    | "directory_deleted"
    | "knowledge_base_deleted";
  deletedSourceFilePublicIds: readonly string[];
  closure: StorageVnextGraphMutationClosure;
}): StorageVnextGraphProjectionChange {
  return {
    knowledgeBaseId: input.knowledgeBaseId,
    mutationKind: input.mutationKind,
    seedUpserts: [],
    seedDeleteSourceFilePublicIds: stableUnique(
      input.deletedSourceFilePublicIds
    ),
    affectedSourceFilePublicIds: stableUnique([
      ...input.deletedSourceFilePublicIds,
      ...input.closure.affectedSourceFilePublicIds
    ]),
    affectedEdgePublicIds: [],
    removedEdgePublicIds: stableUnique(input.closure.edgePublicIds),
    logicalPaths: stableUnique(input.closure.logicalPaths),
    refreshGeneratedGraphCatalog: true,
    refreshGeneratedNavigation: true
  };
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, "en")
  );
}
