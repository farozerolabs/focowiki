import type { StorageVnextGraphWritePort } from "../graph/ports.js";
import { deriveStorageVnextReleaseDependencyClosure } from
  "../release/dependency-closure.js";
import type {
  StorageVnextCandidateChangedFact,
  StorageVnextReleaseReadPort,
  StorageVnextReleaseWritePort
} from "../release/ports.js";
import {
  createStorageVnextReleaseCandidateIdentity,
  createStorageVnextPublicationWorkIdentity
} from "./identity.js";
import type { StorageVnextSourceReleaseHandoffPort } from "./ports.js";
import type { StorageVnextWorkflowWritePort } from "../workflow/ports.js";

type ReleasePort = Pick<
  StorageVnextReleaseReadPort & StorageVnextReleaseWritePort,
  "getActiveRoot" | "getLiveCandidate" | "createCandidate" | "addCandidateFacts"
>;

export function createStorageVnextSourceReleaseHandoff(input: {
  graph: Pick<StorageVnextGraphWritePort, "replaceSourceFileGraph">;
  releases: ReleasePort;
  workflow: Pick<StorageVnextWorkflowWritePort, "enqueue">;
  publicationDelayMilliseconds: number;
  resultRetentionMilliseconds: number;
}): StorageVnextSourceReleaseHandoffPort {
  validateDurations(input);
  return {
    async apply(request) {
      await input.graph.replaceSourceFileGraph({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicId: request.sourceFile.publicId,
        sourceRevisionPublicId: request.sourceRevisionPublicId,
        node: request.node,
        edges: request.edges
      });
      const changedFacts = deriveChangedFacts(request);
      const dependencies = deriveStorageVnextReleaseDependencyClosure({
        knowledgeBaseId: request.knowledgeBaseId,
        mutationKind: "graph_change",
        sourceFilePublicIds: [request.sourceFile.publicId],
        sourceLogicalPaths: [request.sourceFile.logicalPath],
        previousSourceLogicalPaths: [],
        directoryLogicalPaths: [],
        searchSourceFilePublicIds: [request.sourceFile.publicId],
        graphSourceFilePublicIds: [request.sourceFile.publicId],
        graphEdgePublicIds: request.edges.map((edge) => edge.publicId)
      }).dependencies;
      const existing = await input.releases.getLiveCandidate(request.knowledgeBaseId);
      if (existing) {
        await input.releases.addCandidateFacts({
          candidatePublicId: existing.publicId,
          changedFacts,
          dependencies
        });
        return candidateResult(existing);
      }

      const active = await input.releases.getActiveRoot(request.knowledgeBaseId);
      const expectedActiveRootPublicId = active?.publicId ?? null;
      const expectedActiveRevision = active?.revision ?? 0;
      const identity = createStorageVnextReleaseCandidateIdentity({
        knowledgeBaseId: request.knowledgeBaseId,
        activeRootPublicId: expectedActiveRootPublicId,
        activeRevision: expectedActiveRevision
      });
      const publication = createStorageVnextPublicationWorkIdentity({
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId: identity.candidatePublicId
      });
      const nextAttemptAt = input.publicationDelayMilliseconds === 0
        ? null
        : addMilliseconds(request.completedAt, input.publicationDelayMilliseconds);
      const work = await input.workflow.enqueue({
        publicId: publication.operationPublicId,
        knowledgeBaseId: request.knowledgeBaseId,
        kind: "publication",
        state: "queued",
        operationRevision: 1,
        settingsRevisionPublicId: request.settingsRevisionPublicId,
        attempt: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt,
        safeErrorCode: null,
        checkpoint: {
          phase: "planning",
          candidatePublicId: identity.candidatePublicId,
          candidateRootPublicId: identity.candidateRootPublicId,
          expectedActiveRevision
        },
        idempotency: {
          ...publication.idempotency,
          expiresAt: addMilliseconds(
            request.completedAt,
            input.resultRetentionMilliseconds
          )
        }
      });
      if (work.type !== "live" || work.work.publicId !== publication.operationPublicId) {
        throw handoffError("publication_work_terminal");
      }
      try {
        const created = await input.releases.createCandidate({
          publicId: identity.candidatePublicId,
          knowledgeBaseId: request.knowledgeBaseId,
          operationPublicId: publication.operationPublicId,
          candidateRootPublicId: identity.candidateRootPublicId,
          expectedActiveRootPublicId,
          expectedActiveRevision,
          changedFacts,
          dependencies,
          idempotency: publication.idempotency,
          createdAt: request.completedAt
        });
        return candidateResult(created);
      } catch (error) {
        if (!hasCode(error, "live_candidate_exists")) throw error;
        const winner = await input.releases.getLiveCandidate(request.knowledgeBaseId);
        if (!winner) throw error;
        await input.releases.addCandidateFacts({
          candidatePublicId: winner.publicId,
          changedFacts,
          dependencies
        });
        return candidateResult(winner);
      }
    }
  };
}

function validateDurations(input: {
  publicationDelayMilliseconds: number;
  resultRetentionMilliseconds: number;
}): void {
  if (
    !Number.isSafeInteger(input.publicationDelayMilliseconds)
    || input.publicationDelayMilliseconds < 0
    || !Number.isSafeInteger(input.resultRetentionMilliseconds)
    || input.resultRetentionMilliseconds < 1
  ) throw handoffError("invalid_configuration");
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw handoffError("invalid_timestamp");
  return new Date(value + milliseconds).toISOString();
}

function handoffError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Storage vNext source handoff error: ${code}`), { code });
}

function deriveChangedFacts(
  request: Parameters<StorageVnextSourceReleaseHandoffPort["apply"]>[0]
): StorageVnextCandidateChangedFact[] {
  return [
    {
      kind: "source_file",
      publicId: request.sourceFile.publicId,
      change: "updated"
    },
    ...request.edges.map((edge) => ({
      kind: "graph_edge" as const,
      publicId: edge.publicId,
      change: "updated" as const
    }))
  ];
}

function candidateResult(candidate: {
  publicId: string;
  operationPublicId: string;
}): {
  outcome: "candidate";
  candidatePublicId: string;
  releaseOperationPublicId: string;
} {
  return {
    outcome: "candidate",
    candidatePublicId: candidate.publicId,
    releaseOperationPublicId: candidate.operationPublicId
  };
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
