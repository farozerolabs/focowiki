import type {
  StorageVnextPublicationSnapshotPort
} from "../publication/projection-loader.js";

export function createStorageVnextMaintenanceRebuildSnapshot(
  snapshot: StorageVnextPublicationSnapshotPort
): StorageVnextPublicationSnapshotPort {
  return {
    readBaseNavigationProfile: snapshot.readBaseNavigationProfile.bind(snapshot),
    readKnowledgeBaseCounts: snapshot.readKnowledgeBaseCounts.bind(snapshot),
    readDirectoryDescendantFileCounts:
      snapshot.readDirectoryDescendantFileCounts.bind(snapshot),
    async readDirectoryLeaves(input) {
      return emptyWhenObjectMissing(() => snapshot.readDirectoryLeaves(input));
    },
    async readExtensionNavigationLeaves(input) {
      return emptyWhenObjectMissing(() => snapshot.readExtensionNavigationLeaves(input));
    },
    listExtensionNavigationShards:
      snapshot.listExtensionNavigationShards.bind(snapshot),
    async readProjectionRecords(input) {
      return emptyWhenObjectMissing(() => snapshot.readProjectionRecords(input));
    },
    listAffectedObsoletePaths: snapshot.listAffectedObsoletePaths.bind(snapshot),
    async listProjectionShards(input) {
      return emptyWhenObjectMissing(() => snapshot.listProjectionShards(input));
    },
    listExtensionCatalogPaths: snapshot.listExtensionCatalogPaths.bind(snapshot),
    summarizeCandidate: snapshot.summarizeCandidate.bind(snapshot)
  };
}

async function emptyWhenObjectMissing<T>(read: () => Promise<readonly T[]>):
Promise<readonly T[]> {
  try {
    return await read();
  } catch (error) {
    if (!hasCode(error, "object_missing")) throw error;
    return [];
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}
