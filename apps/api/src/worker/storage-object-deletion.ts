import type { StorageAdapter } from "../storage/s3.js";

export async function deleteStorageObjectBatch(input: {
  storage: StorageAdapter;
  objectKeys: string[];
  versionPurgeEnabled: boolean;
}): Promise<void> {
  if (input.objectKeys.length === 0) {
    return;
  }

  if (input.versionPurgeEnabled) {
    if (!input.storage.deleteObjectVersions) {
      throw new Error("Versioned object purge is not supported by the active storage adapter.");
    }
    await input.storage.deleteObjectVersions(input.objectKeys);
    return;
  }

  if (input.storage.deleteObjects) {
    await input.storage.deleteObjects(input.objectKeys);
    return;
  }

  if (!input.storage.deleteObject) {
    throw new Error("Object deletion is not supported by the active storage adapter.");
  }

  for (const objectKey of input.objectKeys) {
    await input.storage.deleteObject(objectKey);
  }
}
