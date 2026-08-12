import { describe, expect, it, vi } from "vitest";
import { createStorageVnextMaintenanceCancellationCleanup } from
  "../src/storage-vnext/maintenance/cancellation-cleanup.js";
import { createStorageVnextMaintenanceCandidatePublicId } from
  "../src/storage-vnext/maintenance/identity.js";

describe("storage vNext maintenance cancellation cleanup", () => {
  it("discards semantic state and terminates the matching release candidate", async () => {
    const discardCandidateByOperation = vi.fn(async () => "deleted" as const);
    const terminateCandidate = vi.fn(async () => true);
    const cleanup = createStorageVnextMaintenanceCancellationCleanup({
      semanticTerminal: { discardCandidateByOperation },
      releases: { terminateCandidate },
      resultRetentionMilliseconds: 86_400_000
    });
    const request = {
      knowledgeBaseId: "kb-main",
      operationPublicId: "maintenance-main",
      cancelledAt: "2026-08-12T00:00:00.000Z"
    };

    await expect(cleanup.terminate(request)).resolves.toEqual({
      semanticCandidate: "deleted",
      releaseCandidateTerminated: true
    });
    expect(discardCandidateByOperation).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-main",
      operationPublicId: "maintenance-main"
    });
    expect(terminateCandidate).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-main",
      candidatePublicId: createStorageVnextMaintenanceCandidatePublicId(request),
      outcome: "superseded",
      reasonCode: "MAINTENANCE_CANCELLED",
      safeMessage: null,
      terminatedAt: request.cancelledAt,
      eventExpiresAt: "2026-08-13T00:00:00.000Z"
    }));
  });
});
