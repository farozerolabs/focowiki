import type { UploadSessionRepository } from "../application/ports/upload-session-repository.js";
import type { UploadSessionStoragePort } from "../application/ports/upload-session-storage.js";

export async function runUploadSessionExpirationSlice(input: {
  repository: Pick<
    UploadSessionRepository,
    | "expireSessions"
    | "listStagingObjectsForCleanup"
    | "completeStagingObjectCleanup"
  >;
  storage: Pick<UploadSessionStoragePort, "deleteObjects">;
  now: string;
  limit: number;
}): Promise<{ expiredSessions: number; deletedObjects: number }> {
  const sessions = await input.repository.expireSessions({
    now: input.now,
    limit: input.limit
  });
  const stagingObjects = await input.repository.listStagingObjectsForCleanup({
    limit: input.limit
  });
  await input.storage.deleteObjects(stagingObjects.map((object) => object.objectKey));
  await input.repository.completeStagingObjectCleanup({
    objects: stagingObjects,
    completedAt: input.now
  });
  return {
    expiredSessions: sessions.length,
    deletedObjects: stagingObjects.length
  };
}
