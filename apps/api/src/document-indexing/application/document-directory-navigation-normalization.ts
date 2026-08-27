import type { PersistentDirectoryLeaf } from
  "../../application/ports/directory-navigation-repository.js";
import type { DocumentDirectoryNavigationChange } from
  "./document-directory-navigation-state.js";
import type { OrderedDirectoryEntry } from
  "../domain/document-directory-leaves.js";

export function normalizeDocumentDirectoryNavigation(
  leaves: readonly PersistentDirectoryLeaf[]
): Readonly<{
  leaves: PersistentDirectoryLeaf[];
  repairedLeafIds: string[];
}> {
  const leafIds = new Set<string>();
  const entryIds = new Set<string>();
  const repairedLeafIds: string[] = [];
  const normalized = leaves.map((leaf, index) => {
    if (!leaf.id || leafIds.has(leaf.id)
      || !Number.isSafeInteger(leaf.revision) || leaf.revision < 1) {
      throw normalizationError("previous_state_invalid");
    }
    leafIds.add(leaf.id);
    for (const entry of leaf.entries) {
      if (!entry.id || entryIds.has(entry.id)) {
        throw normalizationError("previous_state_invalid");
      }
      entryIds.add(entry.id);
    }
    const previousLeafId = leaves[index - 1]?.id ?? null;
    const nextLeafId = leaves[index + 1]?.id ?? null;
    if (leaf.previousLeafId !== previousLeafId
      || leaf.nextLeafId !== nextLeafId) {
      repairedLeafIds.push(leaf.id);
    }
    return { ...leaf, previousLeafId, nextLeafId };
  });
  return { leaves: normalized, repairedLeafIds };
}

export function applyDocumentDirectoryNavigationRepairs(input: Readonly<{
  leaves: readonly PersistentDirectoryLeaf[];
  touchedLeafIds: readonly string[];
  repairedLeafIds: readonly string[];
  changedAt: string;
}>): Readonly<{
  leaves: PersistentDirectoryLeaf[];
  touchedLeafIds: string[];
}> {
  const touched = new Set(input.touchedLeafIds);
  const repaired = new Set(input.repairedLeafIds);
  return {
    leaves: input.leaves.map((leaf) =>
      repaired.has(leaf.id) && !touched.has(leaf.id)
        ? { ...leaf, revision: leaf.revision + 1, changedAt: input.changedAt }
        : leaf
    ),
    touchedLeafIds: [...new Set([
      ...input.touchedLeafIds,
      ...input.repairedLeafIds
    ])]
  };
}

export function buildDocumentDirectoryNavigationChanges(
  previous: readonly PersistentDirectoryLeaf[],
  desiredEntries: readonly OrderedDirectoryEntry[]
): DocumentDirectoryNavigationChange[] {
  const desiredById = new Map(desiredEntries.map((entry) => [entry.id, entry]));
  return [
    ...previous.flatMap((leaf) => leaf.entries)
      .filter((entry) => !desiredById.has(entry.id))
      .map((entry) => ({ entryId: entry.id, desiredEntry: null })),
    ...desiredEntries.map((entry) => ({ entryId: entry.id, desiredEntry: entry }))
  ].sort((left, right) => left.entryId.localeCompare(right.entryId, "en-US"));
}

function normalizationError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Document navigation normalization error: ${code}`),
    { code }
  );
}
