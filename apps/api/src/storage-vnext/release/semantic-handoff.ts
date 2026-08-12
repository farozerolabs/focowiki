import type { StorageVnextCatalogRepository } from "../catalog/ports.js";
import {
  deriveStorageVnextReleaseDependencyClosure,
  deriveStorageVnextSemanticChangedFacts,
  includeStorageVnextNavigationProfileUpgrade,
  includeStorageVnextSemanticDependencyClosure
} from "./dependency-closure.js";
import {
  MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH,
  type StorageVnextCandidateChangedFact,
  type StorageVnextCandidateDependency,
  type StorageVnextReleaseReadPort,
  type StorageVnextReleaseWritePort
} from "./ports.js";
import type { StorageVnextWorkflowWritePort } from "../workflow/ports.js";
import {
  createStorageVnextPublicationWorkIdentity,
  createStorageVnextReleaseCandidateIdentity
} from "../source-processing/identity.js";
import type { SemanticAffectedClosure } from
  "../../semantic/domain/contracts.js";

type ReleasePort = Pick<
  StorageVnextReleaseReadPort & StorageVnextReleaseWritePort,
  "getActiveRoot" | "getLiveCandidate" | "createCandidate" | "addCandidateFacts"
>;

export function createStorageVnextSemanticPublicationHandoff(input: {
  catalog: Pick<StorageVnextCatalogRepository, "getSourceFile">;
  releases: ReleasePort;
  workflow: Pick<StorageVnextWorkflowWritePort, "enqueue" | "rescheduleQueued">;
  resultRetentionMilliseconds: number;
}) {
  assertDuration(input.resultRetentionMilliseconds, false);
  return {
    async apply(request: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      operationPublicId: string;
      closure: SemanticAffectedClosure;
      settingsRevisionPublicId: string;
      publicationDelayMilliseconds: number;
      publicationMaximumDelayMilliseconds?: number;
      completedAt: string;
    }): Promise<{ candidatePublicId: string }> {
      assertDuration(request.publicationDelayMilliseconds, true);
      const publicationMaximumDelayMilliseconds =
        request.publicationMaximumDelayMilliseconds
        ?? request.publicationDelayMilliseconds;
      assertDuration(publicationMaximumDelayMilliseconds, true);
      if (publicationMaximumDelayMilliseconds < request.publicationDelayMilliseconds) {
        throw handoffError("semantic_publication_duration_invalid");
      }
      const source = await input.catalog.getSourceFile({
        knowledgeBaseId: request.knowledgeBaseId,
        publicId: request.sourceFilePublicId,
        visibility: "current"
      });
      if (!source || request.closure.knowledgeBaseId !== request.knowledgeBaseId) {
        throw handoffError("semantic_publication_source_unavailable");
      }
      const base = deriveStorageVnextReleaseDependencyClosure({
        knowledgeBaseId: request.knowledgeBaseId,
        mutationKind: "graph_change",
        sourceFilePublicIds: request.closure.sourceFilePublicIds,
        sourceLogicalPaths: [source.logicalPath],
        previousSourceLogicalPaths: [],
        directoryLogicalPaths: [],
        searchSourceFilePublicIds: request.closure.sourceFilePublicIds,
        graphSourceFilePublicIds: [
          ...request.closure.sourceFilePublicIds,
          ...request.closure.affectedFileNeighborPublicIds
        ],
        graphEdgePublicIds: []
      });
      const closure = includeStorageVnextSemanticDependencyClosure({
        base,
        semantic: request.closure
      });
      const changedFacts = deriveStorageVnextSemanticChangedFacts({
        semantic: request.closure,
        change: "updated"
      });
      const existingFactBatches = createFactBatches(
        changedFacts,
        closure.dependencies
      );
      const existing = await input.releases.getLiveCandidate(request.knowledgeBaseId);
      if (existing) {
        await addFactBatches(input.releases, existing.publicId, existingFactBatches);
        await coalesceQueuedPublication({
          workflow: input.workflow,
          operationPublicId: existing.operationPublicId,
          candidateCreatedAt: existing.createdAt,
          completedAt: request.completedAt,
          quietWindowMilliseconds: request.publicationDelayMilliseconds,
          maximumDelayMilliseconds: publicationMaximumDelayMilliseconds
        });
        return { candidatePublicId: existing.publicId };
      }
      const active = await input.releases.getActiveRoot(request.knowledgeBaseId);
      const expectedActiveRootPublicId = active?.publicId ?? null;
      const expectedActiveRevision = active?.revision ?? 0;
      const dependencies = includeStorageVnextNavigationProfileUpgrade({
        knowledgeBaseId: request.knowledgeBaseId,
        navigationProfileVersion: active?.navigationProfileVersion ?? null,
        dependencies: closure.dependencies
      });
      const creationFactBatches = createFactBatches(changedFacts, dependencies);
      const targetOperationPublicId =
        `semantic-publication-target:${request.settingsRevisionPublicId}`;
      const identity = createStorageVnextReleaseCandidateIdentity({
        knowledgeBaseId: request.knowledgeBaseId,
        activeRootPublicId: expectedActiveRootPublicId,
        activeRevision: expectedActiveRevision,
        triggerOperationPublicId: targetOperationPublicId
      });
      const publication = createStorageVnextPublicationWorkIdentity({
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId: identity.candidatePublicId,
        triggerOperationPublicId: targetOperationPublicId
      });
      const nextAttemptAt = request.publicationDelayMilliseconds === 0
        ? null
        : addMilliseconds(request.completedAt, request.publicationDelayMilliseconds);
      const work = await input.workflow.enqueue({
        publicId: publication.operationPublicId,
        knowledgeBaseId: request.knowledgeBaseId,
        kind: "publication",
        searchProviderKind: null,
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
        throw handoffError("semantic_publication_work_terminal");
      }
      try {
        const firstBatch = creationFactBatches[0]!;
        const candidate = await input.releases.createCandidate({
          publicId: identity.candidatePublicId,
          knowledgeBaseId: request.knowledgeBaseId,
          operationPublicId: publication.operationPublicId,
          candidateRootPublicId: identity.candidateRootPublicId,
          expectedActiveRootPublicId,
          expectedActiveRevision,
          changedFacts: firstBatch.changedFacts,
          dependencies: firstBatch.dependencies,
          idempotency: publication.idempotency,
          createdAt: request.completedAt
        });
        await addFactBatches(
          input.releases,
          candidate.publicId,
          creationFactBatches.slice(1)
        );
        return { candidatePublicId: candidate.publicId };
      } catch (error) {
        if (!hasCode(error, "live_candidate_exists")) throw error;
        const winner = await input.releases.getLiveCandidate(request.knowledgeBaseId);
        if (!winner) throw error;
        await addFactBatches(
          input.releases,
          winner.publicId,
          existingFactBatches
        );
        await coalesceQueuedPublication({
          workflow: input.workflow,
          operationPublicId: winner.operationPublicId,
          candidateCreatedAt: winner.createdAt,
          completedAt: request.completedAt,
          quietWindowMilliseconds: request.publicationDelayMilliseconds,
          maximumDelayMilliseconds: publicationMaximumDelayMilliseconds
        });
        return { candidatePublicId: winner.publicId };
      }
    }
  };
}

type FactBatch = {
  changedFacts: readonly StorageVnextCandidateChangedFact[];
  dependencies: readonly StorageVnextCandidateDependency[];
};

function createFactBatches(
  changedFacts: readonly StorageVnextCandidateChangedFact[],
  dependencies: readonly StorageVnextCandidateDependency[]
): FactBatch[] {
  const batches: FactBatch[] = [];
  const length = Math.max(changedFacts.length, dependencies.length, 1);
  for (
    let offset = 0;
    offset < length;
    offset += MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH
  ) {
    batches.push({
      changedFacts: changedFacts.slice(
        offset,
        offset + MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH
      ),
      dependencies: dependencies.slice(
        offset,
        offset + MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH
      )
    });
  }
  return batches;
}

async function addFactBatches(
  releases: Pick<StorageVnextReleaseWritePort, "addCandidateFacts">,
  candidatePublicId: string,
  batches: readonly FactBatch[]
): Promise<void> {
  for (const batch of batches) {
    await releases.addCandidateFacts({
      candidatePublicId,
      changedFacts: batch.changedFacts,
      dependencies: batch.dependencies
    });
  }
}

async function coalesceQueuedPublication(input: {
  workflow: Pick<StorageVnextWorkflowWritePort, "rescheduleQueued">;
  operationPublicId: string;
  candidateCreatedAt: string;
  completedAt: string;
  quietWindowMilliseconds: number;
  maximumDelayMilliseconds: number;
}): Promise<void> {
  if (input.quietWindowMilliseconds === 0) return;
  const quietEdge = addMilliseconds(
    input.completedAt,
    input.quietWindowMilliseconds
  );
  const maximumEdge = addMilliseconds(
    input.candidateCreatedAt,
    input.maximumDelayMilliseconds
  );
  await input.workflow.rescheduleQueued({
    publicId: input.operationPublicId,
    nextAttemptAt: Date.parse(quietEdge) <= Date.parse(maximumEdge)
      ? quietEdge
      : maximumEdge
  });
}

function assertDuration(value: number, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw handoffError("semantic_publication_duration_invalid");
  }
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw handoffError("semantic_publication_clock_invalid");
  return new Date(value + milliseconds).toISOString();
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function handoffError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Semantic publication handoff failed: ${code}`), {
    code
  });
}
