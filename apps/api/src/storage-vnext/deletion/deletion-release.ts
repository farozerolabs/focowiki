import { createHash } from "node:crypto";
import { deriveStorageVnextReleaseDependencyClosure } from
  "../release/dependency-closure.js";
import type {
  StorageVnextCandidateChangedFact,
  StorageVnextCandidateDependency,
  StorageVnextReleaseReadPort,
  StorageVnextReleaseWritePort
} from "../release/ports.js";

export type StorageVnextDeletionCandidatePlan = {
  mode: "candidate" | "direct";
  knowledgeBaseId: string;
  operationPublicId: string;
  changedFacts: readonly StorageVnextCandidateChangedFact[];
  dependencies: readonly StorageVnextCandidateDependency[];
  affectedSourceFilePublicIds: readonly string[];
  affectedLogicalPaths: readonly string[];
  affectedDirectoryPaths: readonly string[];
};

type ReleasePort = Pick<
  StorageVnextReleaseReadPort & StorageVnextReleaseWritePort,
  "getActiveRoot" | "getLiveCandidate" | "createCandidate" | "addCandidateFacts"
>;

export function planStorageVnextDeletionCandidate(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  targetKind: "source_file" | "source_directory" | "knowledge_base";
  targetPublicId: string;
  sourceFilePublicIds: readonly string[];
  sourceLogicalPaths: readonly string[];
  directoryLogicalPaths: readonly string[];
  graphSourceFilePublicIds: readonly string[];
  graphEdgePublicIds: readonly string[];
  maximumChangedFacts: number;
  maximumDependencies: number;
}): StorageVnextDeletionCandidatePlan {
  assertPlanInput(input);
  const sourceFilePublicIds = stableUnique(
    input.targetKind === "source_file" && input.sourceFilePublicIds.length === 0
      ? [input.targetPublicId]
      : input.sourceFilePublicIds
  );
  const closure = deriveStorageVnextReleaseDependencyClosure({
    knowledgeBaseId: input.knowledgeBaseId,
    mutationKind: input.targetKind === "knowledge_base"
      ? "knowledge_base_delete"
      : input.targetKind === "source_directory"
        ? "directory_delete"
        : "file_delete",
    sourceFilePublicIds,
    sourceLogicalPaths: input.sourceLogicalPaths,
    previousSourceLogicalPaths: [],
    directoryLogicalPaths: input.directoryLogicalPaths,
    searchSourceFilePublicIds: sourceFilePublicIds,
    graphSourceFilePublicIds: input.graphSourceFilePublicIds,
    graphEdgePublicIds: input.graphEdgePublicIds
  });
  const changedFacts = deletionFacts(input, sourceFilePublicIds);
  if (
    changedFacts.length > input.maximumChangedFacts
    || closure.dependencies.length > input.maximumDependencies
  ) throw releaseError("changed_set_limit");
  return {
    mode: input.targetKind === "knowledge_base" ? "direct" : "candidate",
    knowledgeBaseId: input.knowledgeBaseId,
    operationPublicId: input.operationPublicId,
    changedFacts,
    dependencies: closure.dependencies,
    affectedSourceFilePublicIds: closure.affectedSourceFilePublicIds,
    affectedLogicalPaths: closure.affectedLogicalPaths,
    affectedDirectoryPaths: closure.affectedDirectoryPaths
  };
}

export function createStorageVnextDeletionReleaseHandoff(releases: ReleasePort) {
  return {
    async apply(request: StorageVnextDeletionCandidatePlan & {
      createdAt: string;
      idempotency: { key: string; requestHash: string };
    }) {
      if (request.mode === "direct") {
        return {
          outcome: "direct" as const,
          releaseOperationPublicId: request.operationPublicId
        };
      }
      const existing = await releases.getLiveCandidate(request.knowledgeBaseId);
      if (existing) {
        if (existing.operationPublicId !== request.operationPublicId) {
          throw releaseError("release_candidate_busy");
        }
        await releases.addCandidateFacts({
          candidatePublicId: existing.publicId,
          changedFacts: request.changedFacts,
          dependencies: request.dependencies
        });
        return candidateResult(existing.publicId, request.operationPublicId);
      }
      const active = await releases.getActiveRoot(request.knowledgeBaseId);
      const expectedActiveRootPublicId = active?.publicId ?? null;
      const expectedActiveRevision = active?.revision ?? 0;
      const identity = candidateIdentity({
        knowledgeBaseId: request.knowledgeBaseId,
        operationPublicId: request.operationPublicId,
        expectedActiveRootPublicId,
        expectedActiveRevision
      });
      try {
        const candidate = await releases.createCandidate({
          publicId: identity.candidatePublicId,
          knowledgeBaseId: request.knowledgeBaseId,
          operationPublicId: request.operationPublicId,
          candidateRootPublicId: identity.candidateRootPublicId,
          expectedActiveRootPublicId,
          expectedActiveRevision,
          changedFacts: request.changedFacts,
          dependencies: request.dependencies,
          idempotency: request.idempotency,
          createdAt: request.createdAt
        });
        return candidateResult(candidate.publicId, request.operationPublicId);
      } catch (error) {
        if (!hasCode(error, "live_candidate_exists")) throw error;
        const winner = await releases.getLiveCandidate(request.knowledgeBaseId);
        if (!winner || winner.operationPublicId !== request.operationPublicId) {
          throw releaseError("release_candidate_busy");
        }
        await releases.addCandidateFacts({
          candidatePublicId: winner.publicId,
          changedFacts: request.changedFacts,
          dependencies: request.dependencies
        });
        return candidateResult(winner.publicId, request.operationPublicId);
      }
    }
  };
}

function deletionFacts(
  input: {
    targetKind: "source_file" | "source_directory" | "knowledge_base";
    targetPublicId: string;
  },
  sourceFilePublicIds: readonly string[]
): StorageVnextCandidateChangedFact[] {
  const facts: StorageVnextCandidateChangedFact[] = [];
  if (input.targetKind === "knowledge_base") {
    facts.push({
      kind: "knowledge_base",
      publicId: input.targetPublicId,
      change: "deleted"
    });
  } else if (input.targetKind === "source_directory") {
    facts.push({
      kind: "directory",
      publicId: input.targetPublicId,
      change: "deleted"
    });
  }
  for (const sourceFilePublicId of sourceFilePublicIds) {
    facts.push({ kind: "source_file", publicId: sourceFilePublicId, change: "deleted" });
  }
  return facts.sort((left, right) =>
    left.kind.localeCompare(right.kind, "en")
    || left.publicId.localeCompare(right.publicId, "en"));
}

function candidateIdentity(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  expectedActiveRootPublicId: string | null;
  expectedActiveRevision: number;
}) {
  const value = digest([
    "deletion-release-candidate-v1",
    input.knowledgeBaseId,
    input.operationPublicId,
    input.expectedActiveRootPublicId ?? "none",
    String(input.expectedActiveRevision)
  ]);
  return {
    candidatePublicId: `deletion-candidate-${value}`,
    candidateRootPublicId: `deletion-root-${value}`
  };
}

function candidateResult(candidatePublicId: string, operationPublicId: string) {
  return {
    outcome: "candidate" as const,
    candidatePublicId,
    releaseOperationPublicId: operationPublicId
  };
}

function assertPlanInput(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  targetPublicId: string;
  maximumChangedFacts: number;
  maximumDependencies: number;
}): void {
  if (
    !input.knowledgeBaseId
    || !input.operationPublicId
    || !input.targetPublicId
    || !Number.isSafeInteger(input.maximumChangedFacts)
    || input.maximumChangedFacts < 1
    || !Number.isSafeInteger(input.maximumDependencies)
    || input.maximumDependencies < 1
  ) throw releaseError("invalid_input");
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, "en"));
}

function digest(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function releaseError(code: string): Error {
  return Object.assign(new Error(`Storage vNext deletion release error: ${code}`), {
    code
  });
}
