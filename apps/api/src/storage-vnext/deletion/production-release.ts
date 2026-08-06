import { createHash } from "node:crypto";
import type {
  StorageVnextCandidateDelta,
  StorageVnextReleaseReadPort,
  StorageVnextReleaseWritePort
} from "../release/ports.js";
import {
  MAX_STORAGE_VNEXT_CANDIDATE_CHANGED_FACTS,
  MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES
} from "../release/ports.js";
import type { StorageVnextLiveWork } from "../workflow/ports.js";
import {
  createStorageVnextDeletionReleaseHandoff,
  planStorageVnextDeletionCandidate
} from "./deletion-release.js";
import type { StorageVnextDeletionKind } from "./ports.js";

export type StorageVnextDeletionReleaseScope = {
  sourceFilePublicIds: readonly string[];
  sourceLogicalPaths: readonly string[];
  directoryLogicalPaths: readonly string[];
  graphSourceFilePublicIds: readonly string[];
  graphEdgePublicIds: readonly string[];
};

type ReleasePort = Pick<
  StorageVnextReleaseReadPort & StorageVnextReleaseWritePort,
  | "getActiveRoot"
  | "getLiveCandidate"
  | "createCandidate"
  | "addCandidateFacts"
  | "activateCandidate"
  | "terminateCandidate"
>;

export type StorageVnextDeletionReleaseScopePort = {
  findActivated(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
  }): Promise<{
    releaseRootPublicId: string;
    searchProjectionPublicId: string;
  } | null>;
  read(input: {
    knowledgeBaseId: string;
    targetKind: StorageVnextDeletionKind;
    targetPublicId: string;
    normalizedPath: string | null;
    maximumSources: number;
    maximumGraphEdges: number;
  }): Promise<StorageVnextDeletionReleaseScope>;
};

export function createStorageVnextDeletionProductionRelease(input: {
  scope: StorageVnextDeletionReleaseScopePort;
  releases: ReleasePort;
  processor: {
    publish(input: {
      knowledgeBaseId: string;
      candidatePublicId: string;
      operationPublicId: string;
      signal: AbortSignal;
    }): Promise<{ searchProjectionPublicId: string }>;
  };
  clock(): string;
  rollbackRetentionMilliseconds: number;
  resultRetentionMilliseconds: number;
  maximumChangedFacts?: number;
  maximumDependencies?: number;
}) {
  const maximumChangedFacts = input.maximumChangedFacts
    ?? MAX_STORAGE_VNEXT_CANDIDATE_CHANGED_FACTS;
  const maximumDependencies = input.maximumDependencies
    ?? MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES;
  validateConfiguration({
    maximumChangedFacts,
    maximumDependencies,
    rollbackRetentionMilliseconds: input.rollbackRetentionMilliseconds,
    resultRetentionMilliseconds: input.resultRetentionMilliseconds
  });
  const handoff = createStorageVnextDeletionReleaseHandoff(input.releases);

  return {
    async prepare(
      work: StorageVnextLiveWork
    ): Promise<Record<string, boolean | number | string | null>> {
      assertDeletionWork(work);
      if (work.checkpoint.releaseActivated === true) return {};
      const targetKind = deletionKind(work.checkpoint.targetKind);
      if (targetKind === "knowledge_base") return { releaseActivated: true };

      const recovered = await input.scope.findActivated({
        knowledgeBaseId: work.knowledgeBaseId,
        operationPublicId: work.publicId
      });
      if (recovered) {
        return {
          releaseActivated: true,
          releaseRootPublicId: recovered.releaseRootPublicId,
          searchProjectionPublicId: recovered.searchProjectionPublicId
        };
      }

      let candidate = await input.releases.getLiveCandidate(work.knowledgeBaseId);
      if (!candidate) {
        const targetPublicId = requiredString(work.checkpoint.targetPublicId);
        const normalizedPath = nullableString(work.checkpoint.normalizedPath);
        const scope = await input.scope.read({
          knowledgeBaseId: work.knowledgeBaseId,
          targetKind,
          targetPublicId,
          normalizedPath,
          maximumSources: maximumChangedFacts,
          maximumGraphEdges: maximumDependencies
        });
        const plan = planStorageVnextDeletionCandidate({
          knowledgeBaseId: work.knowledgeBaseId,
          operationPublicId: work.publicId,
          targetKind,
          targetPublicId,
          ...scope,
          maximumChangedFacts,
          maximumDependencies
        });
        const createdAt = input.clock();
        assertTimestamp(createdAt);
        await handoff.apply({
          ...plan,
          createdAt,
          idempotency: work.idempotency
        });
        candidate = await input.releases.getLiveCandidate(work.knowledgeBaseId);
      }
      requireOwnedCandidate(candidate, work);
      try {
        const controller = new AbortController();
        const published = await input.processor.publish({
          knowledgeBaseId: work.knowledgeBaseId,
          candidatePublicId: candidate.publicId,
          operationPublicId: work.publicId,
          signal: controller.signal
        });
        const activatedAt = input.clock();
        assertTimestamp(activatedAt);
        const activation = await input.releases.activateCandidate({
          knowledgeBaseId: work.knowledgeBaseId,
          candidatePublicId: candidate.publicId,
          expectedActiveRootPublicId: candidate.expectedActiveRootPublicId,
          expectedActiveRevision: candidate.expectedActiveRevision,
          searchProjectionPublicId: published.searchProjectionPublicId,
          rollbackExpiresAt: candidate.expectedActiveRootPublicId
            ? addMilliseconds(activatedAt, input.rollbackRetentionMilliseconds)
            : null,
          eventPublicId: eventPublicId(work.publicId, "activated"),
          eventExpiresAt: addMilliseconds(
            activatedAt,
            input.resultRetentionMilliseconds
          ),
          activatedAt
        });
        if (activation.outcome === "activated") {
          return {
            releaseActivated: true,
            releaseRootPublicId: activation.snapshot.releaseRootPublicId,
            searchProjectionPublicId: published.searchProjectionPublicId
          };
        }
        if (activation.outcome === "stale") {
          await input.releases.terminateCandidate({
            knowledgeBaseId: work.knowledgeBaseId,
            candidatePublicId: candidate.publicId,
            outcome: "superseded",
            reasonCode: "DELETION_RELEASE_SUPERSEDED",
            safeMessage: null,
            eventPublicId: eventPublicId(work.publicId, "superseded"),
            eventExpiresAt: addMilliseconds(
              activatedAt,
              input.resultRetentionMilliseconds
            ),
            terminatedAt: activatedAt
          });
        }
        throw productionReleaseError(
          activation.outcome === "rollback_pending"
            ? "rollback_pending"
            : activation.outcome === "stale"
              ? "release_stale"
              : "candidate_not_ready"
        );
      } catch (error) {
        const live = await input.releases.getLiveCandidate(work.knowledgeBaseId);
        if (live?.publicId === candidate.publicId
          && live.operationPublicId === work.publicId) {
          const terminatedAt = input.clock();
          assertTimestamp(terminatedAt);
          await input.releases.terminateCandidate({
            knowledgeBaseId: work.knowledgeBaseId,
            candidatePublicId: candidate.publicId,
            outcome: "failed",
            reasonCode: "DELETION_RELEASE_FAILED",
            safeMessage: null,
            eventPublicId: eventPublicId(work.publicId, `failed-${work.attempt}`),
            eventExpiresAt: addMilliseconds(
              terminatedAt,
              input.resultRetentionMilliseconds
            ),
            terminatedAt
          });
        }
        throw error;
      }
    }
  };
}

function requireOwnedCandidate(
  candidate: StorageVnextCandidateDelta | null,
  work: StorageVnextLiveWork
): asserts candidate is StorageVnextCandidateDelta {
  if (
    !candidate
    || candidate.knowledgeBaseId !== work.knowledgeBaseId
    || candidate.operationPublicId !== work.publicId
  ) throw productionReleaseError("candidate_conflict");
}

function assertDeletionWork(work: StorageVnextLiveWork): void {
  if (work.kind !== "deletion" || work.state !== "running") {
    throw productionReleaseError("invalid_work");
  }
}

function deletionKind(value: unknown): StorageVnextDeletionKind {
  if (
    value !== "source_file"
    && value !== "source_directory"
    && value !== "knowledge_base"
  ) throw productionReleaseError("invalid_checkpoint");
  return value;
}

function requiredString(value: unknown): string {
  if (
    typeof value !== "string"
    || !value
    || Buffer.byteLength(value) > 4_096
    || value.includes("\0")
  ) throw productionReleaseError("invalid_checkpoint");
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : requiredString(value);
}

function validateConfiguration(input: {
  maximumChangedFacts: number;
  maximumDependencies: number;
  rollbackRetentionMilliseconds: number;
  resultRetentionMilliseconds: number;
}): void {
  if (
    !Number.isSafeInteger(input.maximumChangedFacts)
    || input.maximumChangedFacts < 1
    || input.maximumChangedFacts > MAX_STORAGE_VNEXT_CANDIDATE_CHANGED_FACTS
    || !Number.isSafeInteger(input.maximumDependencies)
    || input.maximumDependencies < 1
    || input.maximumDependencies > MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES
    || !Number.isSafeInteger(input.rollbackRetentionMilliseconds)
    || input.rollbackRetentionMilliseconds < 1
    || !Number.isSafeInteger(input.resultRetentionMilliseconds)
    || input.resultRetentionMilliseconds < 1
  ) throw productionReleaseError("invalid_configuration");
}

function eventPublicId(operationPublicId: string, outcome: string): string {
  return `deletion-release-event-${createHash("sha256")
    .update(`${operationPublicId}\0${outcome}`)
    .digest("hex")}`;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function assertTimestamp(value: string): void {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw productionReleaseError("invalid_clock");
  }
}

function productionReleaseError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext deletion production release error: ${code}`),
    { code }
  );
}
