import type { UploadSessionStoragePort } from "../../application/ports/upload-session-storage.js";
import type { StorageAdapter } from "../../storage/s3.js";

export function createUploadSessionStoragePort(
  storage: StorageAdapter
): UploadSessionStoragePort {
  return {
    async putEntry(input) {
      const objectKey = storage.keyspace.uploadSessionEntryKey(
        input.knowledgeBaseId,
        input.sessionId,
        input.entryId
      );
      await storage.putObject({
        key: objectKey,
        body: input.bytes,
        contentType: "text/markdown; charset=utf-8"
      });
      return { objectKey };
    },
    async deleteObject(objectKey) {
      await storage.deleteObject?.(objectKey);
    },
    async deleteObjects(objectKeys) {
      if (objectKeys.length === 0) return;
      if (storage.deleteObjects) {
        await storage.deleteObjects(objectKeys);
        return;
      }
      await Promise.all(objectKeys.map((objectKey) => storage.deleteObject?.(objectKey)));
    }
  };
}
