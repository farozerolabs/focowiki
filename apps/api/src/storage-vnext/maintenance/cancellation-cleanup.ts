import { createHash } from "node:crypto";
import type { SemanticGenerationRepositoryPort } from
  "../../semantic/application/ports.js";
import type { StorageVnextReleaseWritePort } from "../release/ports.js";
import { createStorageVnextMaintenanceCandidatePublicId } from "./identity.js";

export function createStorageVnextMaintenanceCancellationCleanup(input: {
  semanticTerminal: Pick<
    SemanticGenerationRepositoryPort,
    "discardCandidateByOperation"
  >;
  releases: Pick<StorageVnextReleaseWritePort, "terminateCandidate">;
  resultRetentionMilliseconds: number;
}) {
  assertRetention(input.resultRetentionMilliseconds);
  return {
    async terminate(request: {
      knowledgeBaseId: string;
      operationPublicId: string;
      cancelledAt: string;
    }) {
      assertRequest(request);
      const semanticCandidate = await input.semanticTerminal
        .discardCandidateByOperation({
          knowledgeBaseId: request.knowledgeBaseId,
          operationPublicId: request.operationPublicId
        });
      const releaseCandidateTerminated = await input.releases.terminateCandidate({
        knowledgeBaseId: request.knowledgeBaseId,
        candidatePublicId: createStorageVnextMaintenanceCandidatePublicId(request),
        outcome: "superseded",
        reasonCode: "MAINTENANCE_CANCELLED",
        safeMessage: null,
        eventPublicId: eventPublicId(request.operationPublicId),
        eventExpiresAt: new Date(
          Date.parse(request.cancelledAt) + input.resultRetentionMilliseconds
        ).toISOString(),
        terminatedAt: request.cancelledAt
      });
      return { semanticCandidate, releaseCandidateTerminated };
    }
  };
}

function eventPublicId(operationPublicId: string): string {
  const digest = createHash("sha256")
    .update("storage-vnext-maintenance-cancellation-v1")
    .update("\0")
    .update(operationPublicId)
    .digest("hex");
  return `maintenance-cancellation-${digest}`;
}

function assertRequest(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  cancelledAt: string;
}): void {
  if (!input.knowledgeBaseId || !input.operationPublicId
    || !Number.isFinite(Date.parse(input.cancelledAt))) {
    throw cancellationError("invalid_input");
  }
}

function assertRetention(milliseconds: number): void {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw cancellationError("invalid_configuration");
  }
}

function cancellationError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Maintenance cancellation cleanup failed: ${code}`),
    { code }
  );
}
