import type { PersistentDirectoryLeaf } from
  "../../application/ports/directory-navigation-repository.js";
import {
  buildDirectoryLeaves,
  compareOrderedDirectoryEntries,
  insertDirectoryEntry,
  removeDirectoryEntry,
  type OrderedDirectoryEntry,
  type OrderedDirectoryLeafLimits
} from "../domain/document-directory-leaves.js";

export type DocumentDirectoryNavigationChange = {
  entryId: string;
  desiredEntry: OrderedDirectoryEntry | null;
};

export function reconcileDocumentDirectoryNavigation(input: {
  previous: readonly PersistentDirectoryLeaf[];
  changes: readonly DocumentDirectoryNavigationChange[];
  limits: OrderedDirectoryLeafLimits;
  createLeafId(): string;
  changedAt?: string;
  window?: Readonly<{
    totalEntryCount: number;
    firstLeafId: string | null;
  }>;
}): {
  leaves: PersistentDirectoryLeaf[];
  touchedLeafIds: string[];
  removedLeafIds: string[];
  entryCount: number;
  firstLeafId: string | null;
} {
  validatePrevious(input.previous, input.window !== undefined);
  validateChanges(input.changes);
  if (input.window && input.previous.length === 0
    && input.changes.length === 0) {
    return {
      leaves: [], touchedLeafIds: [], removedLeafIds: [],
      entryCount: input.window.totalEntryCount,
      firstLeafId: input.window.firstLeafId
    };
  }
  const leftBoundaryLeafId = input.window
    ? input.previous[0]?.previousLeafId ?? null : null;
  const rightBoundaryLeafId = input.window
    ? input.previous.at(-1)?.nextLeafId ?? null : null;
  let leaves = input.previous.map((leaf) => ({
    id: leaf.id,
    entries: leaf.entries.map((entry) => ({ ...entry }))
  }));
  const currentEntries = new Map(input.previous.flatMap((leaf) => leaf.entries)
    .map((entry) => [entry.id, entry]));
  const orderedChanges = input.changes.filter((change) => {
    const current = currentEntries.get(change.entryId);
    return change.desiredEntry === null
      ? current !== undefined
      : !current || JSON.stringify(current) !== JSON.stringify(change.desiredEntry);
  }).sort((left, right) => compareText(left.entryId, right.entryId));
  const additions = orderedChanges.flatMap((change) =>
    change.desiredEntry ? [change.desiredEntry] : [])
    .sort(compareOrderedDirectoryEntries);
  if (leaves.length === 0) {
    leaves = buildDirectoryLeaves({
      entries: additions,
      limits: input.limits,
      createLeafId: input.createLeafId
    });
  } else {
    for (const change of orderedChanges) {
      leaves = removeDirectoryEntry({
        leaves,
        entryId: change.entryId,
        limits: input.limits
      }).leaves;
    }
    const retainedLeafIds = new Set(leaves.map((leaf) => leaf.id));
    const reusableLeafIds = input.previous
      .filter((leaf) => !retainedLeafIds.has(leaf.id))
      .map((leaf) => leaf.id);
    for (const entry of additions) {
      leaves = insertDirectoryEntry({
        leaves,
        entry,
        limits: input.limits,
        createLeafId: () => reusableLeafIds.shift() ?? input.createLeafId()
      }).leaves;
    }
  }

  const previous = new Map(input.previous.map((leaf) => [leaf.id, leaf]));
  const finalLeaves = leaves.map<PersistentDirectoryLeaf>((leaf, index) => {
    const before = previous.get(leaf.id);
    const value = {
      id: leaf.id,
      previousLeafId: leaves[index - 1]?.id ?? leftBoundaryLeafId,
      nextLeafId: leaves[index + 1]?.id ?? rightBoundaryLeafId,
      entries: leaf.entries,
      revision: before?.revision ?? 0,
      ...(before?.changedAt ? { changedAt: before.changedAt } : {})
    };
    const changed = !before || !sameLeaf(before, value);
    return {
      ...value,
      revision: changed ? (before?.revision ?? 0) + 1 : before.revision,
      ...(changed && input.changedAt ? { changedAt: input.changedAt } : {})
    };
  });
  const finalIds = new Set(finalLeaves.map((leaf) => leaf.id));
  const localPreviousEntryCount = input.previous.reduce(
    (total, leaf) => total + leaf.entries.length, 0);
  const localFinalEntryCount = finalLeaves.reduce(
    (total, leaf) => total + leaf.entries.length, 0);
  const entryCount = input.window
    ? input.window.totalEntryCount - localPreviousEntryCount
      + localFinalEntryCount
    : localFinalEntryCount;
  const firstLeafId = leftBoundaryLeafId === null
    ? finalLeaves[0]?.id ?? rightBoundaryLeafId
    : input.window?.firstLeafId ?? finalLeaves[0]?.id ?? null;
  return {
    leaves: finalLeaves,
    touchedLeafIds: finalLeaves.filter((leaf) => {
      const before = previous.get(leaf.id);
      return !before || !sameLeaf(before, leaf);
    }).map((leaf) => leaf.id),
    removedLeafIds: input.previous.filter((leaf) => !finalIds.has(leaf.id))
      .map((leaf) => leaf.id).sort(compareText),
    entryCount,
    firstLeafId
  };
}

function sameLeaf(
  left: PersistentDirectoryLeaf,
  right: PersistentDirectoryLeaf
): boolean {
  return left.previousLeafId === right.previousLeafId
    && left.nextLeafId === right.nextLeafId
    && JSON.stringify(left.entries) === JSON.stringify(right.entries);
}

function validatePrevious(
  leaves: readonly PersistentDirectoryLeaf[],
  allowExternalBoundaries: boolean
): void {
  const leafIds = new Set<string>();
  const entryIds = new Set<string>();
  for (const [index, leaf] of leaves.entries()) {
    if (!leaf.id || leafIds.has(leaf.id)
      || (index > 0 && leaf.previousLeafId !== leaves[index - 1]!.id)
      || (index < leaves.length - 1
        && leaf.nextLeafId !== leaves[index + 1]!.id)
      || (!allowExternalBoundaries && index === 0
        && leaf.previousLeafId !== null)
      || (!allowExternalBoundaries && index === leaves.length - 1
        && leaf.nextLeafId !== null)
      || !Number.isSafeInteger(leaf.revision) || leaf.revision < 1) {
      throw navigationStateError("previous_state_invalid");
    }
    leafIds.add(leaf.id);
    for (const entry of leaf.entries) {
      if (!entry.id || entryIds.has(entry.id)) {
        throw navigationStateError("previous_state_invalid");
      }
      entryIds.add(entry.id);
    }
  }
}

function validateChanges(changes: readonly DocumentDirectoryNavigationChange[]): void {
  if (new Set(changes.map((change) => change.entryId)).size !== changes.length
    || changes.some((change) => !change.entryId
      || (change.desiredEntry !== null
        && change.desiredEntry.id !== change.entryId))) {
    throw navigationStateError("navigation_changes_invalid");
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function navigationStateError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document navigation state error: ${code}`), { code });
}
