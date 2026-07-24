import { describe, expect, it, vi } from "vitest";
import type { UploadSessionRepository } from "../src/application/ports/upload-session-repository.js";
import type { UploadSessionStoragePort } from "../src/application/ports/upload-session-storage.js";
import { runUploadSessionExpirationSlice } from "../src/maintenance/upload-session-expiration.js";

describe("upload session expiration", () => {
  it("expires a bounded session batch and completes durable staged-object cleanup", async () => {
    const expireSessions = vi.fn(async () => [
      "upload-session-one",
      "upload-session-two"
    ]);
    const listStagingObjectsForCleanup = vi.fn(async () => [
      { sessionId: "upload-session-one", objectKey: "staging/one" },
      { sessionId: "upload-session-one", objectKey: "staging/two" }
    ]);
    const completeStagingObjectCleanup = vi.fn(async () => undefined);
    const deleteObjects = vi.fn(async () => undefined);

    const result = await runUploadSessionExpirationSlice({
      repository: {
        expireSessions,
        listStagingObjectsForCleanup,
        completeStagingObjectCleanup
      } as Pick<
        UploadSessionRepository,
        | "expireSessions"
        | "listStagingObjectsForCleanup"
        | "completeStagingObjectCleanup"
      >,
      storage: { deleteObjects } as Pick<UploadSessionStoragePort, "deleteObjects">,
      now: "2026-07-24T00:00:00.000Z",
      limit: 100
    });

    expect(expireSessions).toHaveBeenCalledWith({
      now: "2026-07-24T00:00:00.000Z",
      limit: 100
    });
    expect(listStagingObjectsForCleanup).toHaveBeenCalledWith({ limit: 100 });
    expect(deleteObjects).toHaveBeenCalledWith(["staging/one", "staging/two"]);
    expect(completeStagingObjectCleanup).toHaveBeenCalledWith({
      objects: [
        { sessionId: "upload-session-one", objectKey: "staging/one" },
        { sessionId: "upload-session-one", objectKey: "staging/two" }
      ],
      completedAt: "2026-07-24T00:00:00.000Z"
    });
    expect(result).toEqual({ expiredSessions: 2, deletedObjects: 2 });
  });

  it("keeps staged-object cleanup pending when storage deletion fails", async () => {
    const completeStagingObjectCleanup = vi.fn(async () => undefined);
    const deleteObjects = vi.fn(async () => {
      throw new Error("storage unavailable");
    });

    await expect(runUploadSessionExpirationSlice({
      repository: {
        expireSessions: vi.fn(async () => ["upload-session-one"]),
        listStagingObjectsForCleanup: vi.fn(async () => [
          { sessionId: "upload-session-one", objectKey: "staging/one" }
        ]),
        completeStagingObjectCleanup
      } as Pick<
        UploadSessionRepository,
        | "expireSessions"
        | "listStagingObjectsForCleanup"
        | "completeStagingObjectCleanup"
      >,
      storage: { deleteObjects } as Pick<UploadSessionStoragePort, "deleteObjects">,
      now: "2026-07-24T00:00:00.000Z",
      limit: 100
    })).rejects.toThrow("storage unavailable");

    expect(completeStagingObjectCleanup).not.toHaveBeenCalled();
  });
});
