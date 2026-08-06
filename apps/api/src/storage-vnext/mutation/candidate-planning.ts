import { createHash } from "node:crypto";
import { deriveStorageVnextReleaseDependencyClosure } from
  "../release/dependency-closure.js";
import type {
  StorageVnextCandidateChangedFact,
  StorageVnextCandidateDependency,
  StorageVnextReleaseReadPort,
  StorageVnextReleaseWritePort
} from "../release/ports.js";

export type StorageVnextMutationCandidatePlan = {
  knowledgeBaseId: string;
  operationPublicId: string;
  changedFacts: readonly StorageVnextCandidateChangedFact[];
  dependencies: readonly StorageVnextCandidateDependency[];
  affectedSourceFilePublicIds: readonly string[];
  affectedLogicalPaths: readonly string[];
  affectedDirectoryPaths: readonly string[];
  unifiedSearchSourceFilePublicIds: readonly string[];
};

type ReleasePort = Pick<
  StorageVnextReleaseReadPort & StorageVnextReleaseWritePort,
  "getActiveRoot" | "getLiveCandidate" | "createCandidate" | "addCandidateFacts"
>;

export function planStorageVnextMutationCandidate(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  mutationKind: "metadata" | "replacement" | "rename" | "move";
  targetKind: "knowledge_base" | "source_file" | "source_directory";
  targetPublicId: string;
  candidateRevisionPublicId?: string;
  sourceFilePublicIds: readonly string[];
  sourceLogicalPaths: readonly string[];
  previousSourceLogicalPaths: readonly string[];
  directoryLogicalPaths: readonly string[];
  graphSourceFilePublicIds: readonly string[];
  graphEdgePublicIds: readonly string[];
  maximumChangedFacts: number;
  maximumDependencies: number;
}): StorageVnextMutationCandidatePlan {
  assertPlanInput(input);
  const unifiedSearchSourceFilePublicIds = stableUnique([
    ...input.sourceFilePublicIds,
    ...input.graphSourceFilePublicIds
  ]);
  const closure = deriveStorageVnextReleaseDependencyClosure({
    knowledgeBaseId: input.knowledgeBaseId,
    mutationKind: input.mutationKind === "metadata"
      ? "search_change"
      : input.mutationKind,
    sourceFilePublicIds: input.sourceFilePublicIds,
    sourceLogicalPaths: input.sourceLogicalPaths,
    previousSourceLogicalPaths: input.previousSourceLogicalPaths,
    directoryLogicalPaths: input.directoryLogicalPaths,
    searchSourceFilePublicIds: unifiedSearchSourceFilePublicIds,
    graphSourceFilePublicIds: input.graphSourceFilePublicIds,
    graphEdgePublicIds: input.graphEdgePublicIds
  });
  const changedFacts = deriveChangedFacts(input);
  if (changedFacts.length > input.maximumChangedFacts
    || closure.dependencies.length > input.maximumDependencies) {
    throw planningError("changed_set_limit");
  }
  return {
    knowledgeBaseId: input.knowledgeBaseId,
    operationPublicId: input.operationPublicId,
    changedFacts,
    dependencies: closure.dependencies,
    affectedSourceFilePublicIds: closure.affectedSourceFilePublicIds,
    affectedLogicalPaths: closure.affectedLogicalPaths,
    affectedDirectoryPaths: closure.affectedDirectoryPaths,
    unifiedSearchSourceFilePublicIds
  };
}

export function createStorageVnextMutationReleaseHandoff(releases: ReleasePort) {
  return {
    async apply(request: StorageVnextMutationCandidatePlan & {
      createdAt: string;
      idempotency: { key: string; requestHash: string };
    }) {
      const existing = await releases.getLiveCandidate(request.knowledgeBaseId);
      if (existing) {
        if (existing.operationPublicId !== request.operationPublicId) {
          throw planningError("release_candidate_busy");
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
          throw planningError("release_candidate_busy");
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

function deriveChangedFacts(input: {
  targetKind: "knowledge_base" | "source_file" | "source_directory";
  targetPublicId: string;
  sourceFilePublicIds: readonly string[];
  candidateRevisionPublicId?: string;
}): StorageVnextCandidateChangedFact[] {
  const facts: StorageVnextCandidateChangedFact[] = [];
  if (input.targetKind === "knowledge_base") {
    facts.push({ kind: "knowledge_base", publicId: input.targetPublicId, change: "updated" });
  } else if (input.targetKind === "source_directory") {
    facts.push({ kind: "directory", publicId: input.targetPublicId, change: "updated" });
  }
  for (const sourceFilePublicId of stableUnique(input.sourceFilePublicIds)) {
    facts.push({ kind: "source_file", publicId: sourceFilePublicId, change: "updated" });
  }
  if (input.targetKind === "source_file" && input.sourceFilePublicIds.length === 0) {
    facts.push({ kind: "source_file", publicId: input.targetPublicId, change: "updated" });
  }
  if (input.candidateRevisionPublicId) {
    facts.push({
      kind: "source_revision",
      publicId: input.candidateRevisionPublicId,
      change: "created"
    });
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
    "mutation-release-candidate-v1",
    input.knowledgeBaseId,
    input.operationPublicId,
    input.expectedActiveRootPublicId ?? "none",
    String(input.expectedActiveRevision)
  ]);
  return {
    candidatePublicId: `mutation-candidate-${value}`,
    candidateRootPublicId: `mutation-root-${value}`
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
  if (!input.knowledgeBaseId || !input.operationPublicId || !input.targetPublicId
    || !Number.isSafeInteger(input.maximumChangedFacts)
    || input.maximumChangedFacts < 1
    || !Number.isSafeInteger(input.maximumDependencies)
    || input.maximumDependencies < 1) {
    throw planningError("invalid_input");
  }
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

function planningError(code: string): Error {
  return Object.assign(new Error(`Storage vNext mutation planning error: ${code}`), {
    code
  });
}
