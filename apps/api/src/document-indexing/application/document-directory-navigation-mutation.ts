import type { PersistentDirectoryLeaf } from
  "../../application/ports/directory-navigation-repository.js";

export type DocumentDirectoryNavigationMutation = {
  directoryPath: string;
  touchedLeaves: readonly PersistentDirectoryLeaf[];
  removedLeafIds: readonly string[];
};

export function validateDocumentDirectoryNavigationMutations(
  mutations: readonly DocumentDirectoryNavigationMutation[]
): void {
  if (mutations.length > 256
    || new Set(mutations.map((item) => item.directoryPath)).size
      !== mutations.length) {
    throw navigationMutationError("mutation_set_invalid");
  }
  for (const mutation of mutations) {
    const touchedIds = new Set(mutation.touchedLeaves.map((leaf) => leaf.id));
    if (!mutation.directoryPath || mutation.directoryPath.startsWith("/")
      || mutation.directoryPath.includes("..")
      || touchedIds.size !== mutation.touchedLeaves.length
      || new Set(mutation.removedLeafIds).size !== mutation.removedLeafIds.length
      || mutation.removedLeafIds.some((leafId) => touchedIds.has(leafId))
      || mutation.touchedLeaves.some((leaf) => !leaf.id
        || leaf.entries.length < 1 || leaf.entries.length > 10_000)) {
      throw navigationMutationError("mutation_invalid");
    }
  }
}

function navigationMutationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document navigation mutation error: ${code}`), { code });
}
