import { describe, expect, it, vi } from "vitest";
import { createStorageVnextMaintenanceCancellationCleanup } from
  "../src/storage-vnext/maintenance/cancellation-cleanup.js";

describe("storage vNext maintenance cancellation cleanup", () => {
  it("terminates unfinished document maintenance without a release candidate", async () => {
    const terminate = vi.fn(async () => undefined);
    const cleanup = createStorageVnextMaintenanceCancellationCleanup({
      documents: { terminate }
    });
    const request = {
      knowledgeBaseId: "kb-main",
      operationPublicId: "maintenance-main",
      cancelledAt: "2026-08-12T00:00:00.000Z"
    };

    await expect(cleanup.terminate(request)).resolves.toBeUndefined();
    expect(terminate).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-main",
      operationPublicId: "maintenance-main",
      outcome: "superseded"
    });
  });
});
