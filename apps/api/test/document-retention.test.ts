import { describe, expect, it, vi } from "vitest";
import { createDocumentRetention } from
  "../src/document-indexing/application/document-retention.js";

describe("document retention", () => {
  it("expires abandoned uploads and deletes retained completed job history", async () => {
    const expireSessions = vi.fn().mockResolvedValue(2);
    const deleteRetained = vi.fn().mockResolvedValue(3);
    const deleteExpired = vi.fn().mockResolvedValue(1);
    const retention = createDocumentRetention({
      uploads: { expireSessions },
      jobs: { deleteRetained },
      operationTombstones: { deleteExpired }
    });

    await expect(retention.run({
      now: "2026-08-15T12:00:00.000Z",
      retentionDays: 7,
      limit: 25
    })).resolves.toEqual({
      expiredUploadSessionCount: 2,
      deletedDocumentJobCount: 3,
      deletedOperationTombstoneCount: 1
    });
    expect(expireSessions).toHaveBeenCalledWith({
      expiredBefore: "2026-08-15T12:00:00.000Z",
      limit: 25
    });
    expect(deleteRetained).toHaveBeenCalledWith({
      terminalBefore: "2026-08-08T12:00:00.000Z",
      limit: 25
    });
    expect(deleteExpired).toHaveBeenCalledWith({
      expiredBefore: "2026-08-15T12:00:00.000Z",
      limit: 25
    });
  });

  it("does not hide one retention failure or starve the other owner", async () => {
    const failure = new Error("upload retention failed");
    const deleteRetained = vi.fn().mockResolvedValue(0);
    const retention = createDocumentRetention({
      uploads: { expireSessions: vi.fn().mockRejectedValue(failure) },
      jobs: { deleteRetained },
      operationTombstones: { deleteExpired: vi.fn().mockResolvedValue(0) }
    });

    await expect(retention.run({
      now: "2026-08-15T12:00:00.000Z",
      retentionDays: 7,
      limit: 25
    })).rejects.toBe(failure);
    expect(deleteRetained).toHaveBeenCalledOnce();
  });
});
