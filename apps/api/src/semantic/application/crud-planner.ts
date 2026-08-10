import {
  deriveStorageVnextReleaseDependencyClosure,
  deriveStorageVnextSemanticChangedFacts,
  includeStorageVnextSemanticDependencyClosure,
  type StorageVnextReleaseMutationKind,
  type StorageVnextSemanticImpact
} from "../../storage-vnext/release/dependency-closure.js";
import type {
  StorageVnextCandidateChangedFact,
  StorageVnextCandidateDependency
} from "../../storage-vnext/release/ports.js";
import type {
  SemanticStageKind,
  SemanticStageWorkItem
} from "./stage-orchestration.js";

export type SemanticCrudMutationKind =
  | "upload" | "body_replacement"
  | "empty_directory_create"
  | "file_rename" | "file_move" | "directory_rename" | "directory_move"
  | "knowledge_base_metadata_update" | "source_file_metadata"
  | "file_delete" | "directory_delete" | "knowledge_base_delete";

export type SemanticCrudSourceChange = {
  sourceFilePublicId: string;
  priorSourceRevisionPublicId: string | null;
  currentSourceRevisionPublicId: string | null;
  bodyChanged: boolean;
  deleted: boolean;
  priorLogicalPath: string | null;
  currentLogicalPath: string | null;
  semanticImpact: StorageVnextSemanticImpact;
};

export type SemanticCrudPlan = {
  knowledgeBaseId: string;
  operationPublicId: string;
  semanticGenerationPublicId: string;
  mutationKind: SemanticCrudMutationKind;
  extractionSourceRevisionPublicIds: readonly string[];
  embeddingOwnerPublicIds: readonly string[];
  reusedArtifactOwnerPublicIds: readonly string[];
  semanticReconciliationSourceFilePublicIds: readonly string[];
  cancelledSourceRevisionPublicIds: readonly string[];
  visibilityExcludedSourceFilePublicIds: readonly string[];
  vectorUpsertOwnerPublicIds: readonly string[];
  vectorDeleteOwnerPublicIds: readonly string[];
  affectedSourceFilePublicIds: readonly string[];
  affectedLogicalPaths: readonly string[];
  affectedDirectoryPaths: readonly string[];
  changedFacts: readonly StorageVnextCandidateChangedFact[];
  dependencies: readonly StorageVnextCandidateDependency[];
  cleanupScope: {
    knowledgeBaseId: string;
    sourceFilePublicIds: readonly string[];
  } | null;
  continuation: { nextCursor: string | null; hasMore: boolean } | null;
  unrelatedSourceReadAllowed: false;
  fullKnowledgeBaseFallbackAllowed: false;
};

const BODY_STAGE_KINDS = new Set<SemanticStageKind>([
  "extraction", "reconciliation", "community", "embedding",
  "vector", "publication", "validation"
]);
const PATH_STAGE_KINDS = new Set<SemanticStageKind>(["vector", "publication"]);

export function selectSemanticCrudStages(
  mutationKind: SemanticCrudMutationKind,
  stages: readonly SemanticStageWorkItem[]
): SemanticStageWorkItem[] {
  const allowed = stageKindsForMutation(mutationKind);
  return stages.filter((stage) => allowed.has(stage.stageKind));
}

export function planSemanticCrudMutation(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  semanticGenerationPublicId: string;
  mutationKind: SemanticCrudMutationKind;
  sources: readonly SemanticCrudSourceChange[];
  directoryLogicalPaths?: readonly string[];
  page?: { maximumItems: number; nextCursor: string | null; hasMore: boolean };
}): SemanticCrudPlan {
  assertPlanInput(input);
  const sources = [...input.sources].sort((left, right) =>
    left.sourceFilePublicId.localeCompare(right.sourceFilePublicId, "en")
  );
  const sourceFilePublicIds = unique(sources.map((source) => source.sourceFilePublicId));
  let release = deriveStorageVnextReleaseDependencyClosure({
    knowledgeBaseId: input.knowledgeBaseId,
    mutationKind: releaseMutationKind(input.mutationKind),
    sourceFilePublicIds,
    sourceLogicalPaths: unique(sources.flatMap((source) =>
      source.currentLogicalPath ? [source.currentLogicalPath] : [])),
    previousSourceLogicalPaths: unique(sources.flatMap((source) =>
      source.priorLogicalPath ? [source.priorLogicalPath] : [])),
    directoryLogicalPaths: input.directoryLogicalPaths ?? [],
    searchSourceFilePublicIds: sourceFilePublicIds,
    graphSourceFilePublicIds: sourceFilePublicIds,
    graphEdgePublicIds: []
  });
  const semanticChangedFacts: StorageVnextCandidateChangedFact[] = [];
  for (const source of sources) {
    release = includeStorageVnextSemanticDependencyClosure({
      base: release,
      semantic: source.semanticImpact
    });
    semanticChangedFacts.push(...deriveStorageVnextSemanticChangedFacts({
      semantic: source.semanticImpact,
      change: source.deleted ? "deleted" : "updated"
    }));
  }
  const bodyChanges = sources.filter((source) => source.bodyChanged && !source.deleted);
  const deletions = sources.filter((source) => source.deleted);
  const pathOnly = sources.filter((source) => !source.bodyChanged && !source.deleted);
  return {
    knowledgeBaseId: input.knowledgeBaseId,
    operationPublicId: input.operationPublicId,
    semanticGenerationPublicId: input.semanticGenerationPublicId,
    mutationKind: input.mutationKind,
    extractionSourceRevisionPublicIds: unique(bodyChanges.flatMap((source) =>
      source.currentSourceRevisionPublicId ? [source.currentSourceRevisionPublicId] : [])),
    embeddingOwnerPublicIds: unique(bodyChanges.flatMap(
      (source) => source.semanticImpact.vectorOwnerPublicIds
    )),
    reusedArtifactOwnerPublicIds: unique(pathOnly.flatMap(
      (source) => source.semanticImpact.vectorOwnerPublicIds
    )),
    semanticReconciliationSourceFilePublicIds: unique([
      ...bodyChanges.map((source) => source.sourceFilePublicId),
      ...deletions.map((source) => source.sourceFilePublicId)
    ]),
    cancelledSourceRevisionPublicIds: unique([
      ...bodyChanges,
      ...deletions
    ].flatMap((source) =>
      source.priorSourceRevisionPublicId ? [source.priorSourceRevisionPublicId] : [])),
    visibilityExcludedSourceFilePublicIds: unique(
      deletions.map((source) => source.sourceFilePublicId)
    ),
    vectorUpsertOwnerPublicIds: deletions.length === sources.length
      ? []
      : unique(sources.filter((source) => !source.deleted).flatMap(
        (source) => source.semanticImpact.vectorOwnerPublicIds
      )),
    vectorDeleteOwnerPublicIds: unique(deletions.flatMap(
      (source) => source.semanticImpact.vectorOwnerPublicIds
    )),
    affectedSourceFilePublicIds: release.affectedSourceFilePublicIds,
    affectedLogicalPaths: release.affectedLogicalPaths,
    affectedDirectoryPaths: release.affectedDirectoryPaths,
    changedFacts: mergeChangedFacts([
      ...sourceFilePublicIds.map((publicId) => ({
        kind: "source_file" as const,
        publicId,
        change: deletions.some((source) => source.sourceFilePublicId === publicId)
          ? "deleted" as const
          : "updated" as const
      })),
      ...semanticChangedFacts
    ]),
    dependencies: release.dependencies,
    cleanupScope: input.mutationKind === "directory_delete"
      || input.mutationKind === "knowledge_base_delete"
      ? { knowledgeBaseId: input.knowledgeBaseId, sourceFilePublicIds }
      : null,
    continuation: input.page
      ? { nextCursor: input.page.nextCursor, hasMore: input.page.hasMore }
      : null,
    unrelatedSourceReadAllowed: false,
    fullKnowledgeBaseFallbackAllowed: false
  };
}

function stageKindsForMutation(
  mutationKind: SemanticCrudMutationKind
): ReadonlySet<SemanticStageKind> {
  switch (mutationKind) {
    case "upload":
    case "body_replacement":
      return BODY_STAGE_KINDS;
    case "file_rename":
    case "file_move":
    case "directory_rename":
    case "directory_move":
    case "source_file_metadata":
      return PATH_STAGE_KINDS;
    case "empty_directory_create":
    case "knowledge_base_metadata_update":
    case "file_delete":
    case "directory_delete":
    case "knowledge_base_delete":
      return new Set();
  }
}

function releaseMutationKind(value: SemanticCrudMutationKind): StorageVnextReleaseMutationKind {
  switch (value) {
    case "upload": return "upload";
    case "body_replacement": return "replacement";
    case "file_rename":
    case "directory_rename": return "rename";
    case "file_move":
    case "directory_move":
    case "empty_directory_create": return "move";
    case "file_delete": return "file_delete";
    case "directory_delete": return "directory_delete";
    case "knowledge_base_delete": return "knowledge_base_delete";
    case "knowledge_base_metadata_update": return "search_change";
    case "source_file_metadata": return "search_change";
  }
}

function assertPlanInput(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  semanticGenerationPublicId: string;
  sources: readonly SemanticCrudSourceChange[];
  page?: { maximumItems: number; nextCursor: string | null; hasMore: boolean };
}): void {
  if (!input.knowledgeBaseId || !input.operationPublicId || !input.semanticGenerationPublicId) {
    throw crudError("invalid_input");
  }
  if (new Set(input.sources.map((source) => source.sourceFilePublicId)).size
    !== input.sources.length) throw crudError("duplicate_source");
  if (input.page && (
    !Number.isSafeInteger(input.page.maximumItems)
    || input.page.maximumItems < 1
    || input.sources.length > input.page.maximumItems
  )) throw crudError("page bound exceeded");
}

function mergeChangedFacts(
  values: readonly StorageVnextCandidateChangedFact[]
): StorageVnextCandidateChangedFact[] {
  const facts = new Map<string, StorageVnextCandidateChangedFact>();
  for (const value of values) {
    const key = `${value.kind}\u0000${value.publicId}`;
    const prior = facts.get(key);
    if (prior && prior.change !== value.change) throw crudError("conflicting_change");
    facts.set(key, value);
  }
  return [...facts.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind, "en")
    || left.publicId.localeCompare(right.publicId, "en")
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, "en")
  );
}

function crudError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Semantic CRUD planner error: ${code}`), { code });
}
