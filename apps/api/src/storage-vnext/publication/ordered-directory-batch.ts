import {
  compareOrderedDirectoryEntries,
  directoryLeafByteSize,
  type OrderedDirectoryEntry,
  type OrderedDirectoryEntryComparator,
  type OrderedDirectoryLeaf,
  type OrderedDirectoryLeafLimits,
  type OrderedDirectoryLeafMutation
} from "../../publication/ordered-directory-leaves.js";

export function insertOrderedDirectoryEntries(input: {
  leaves: OrderedDirectoryLeaf[];
  entries: readonly OrderedDirectoryEntry[];
  limits: OrderedDirectoryLeafLimits;
  createLeafId: () => string;
  compareEntries?: OrderedDirectoryEntryComparator;
}): OrderedDirectoryLeafMutation {
  validateLimits(input.limits);
  const compareEntries = input.compareEntries ?? compareOrderedDirectoryEntries;
  const leaves = cloneAndValidate(input.leaves, compareEntries);
  const entryIds = new Set(leaves.flatMap((leaf) =>
    leaf.entries.map((entry) => entry.id)));
  const touched = new Set<string>();

  for (const entry of input.entries) {
    if (entryIds.has(entry.id)) continue;
    entryIds.add(entry.id);

    if (leaves.length === 0) {
      const leafId = input.createLeafId();
      leaves.push({ id: leafId, entries: [entry] });
      touched.add(leafId);
      continue;
    }

    const leafIndex = findInsertionLeaf(leaves, entry, compareEntries);
    const target = leaves[leafIndex]!;
    const entryIndex = findEntryInsertionIndex(target.entries, entry, compareEntries);
    target.entries.splice(entryIndex, 0, entry);
    touched.add(target.id);
    let currentIndex = leafIndex;

    while (leafExceedsLimits(leaves[currentIndex]!, input.limits)) {
      const current = leaves[currentIndex]!;
      const splitIndex = chooseSplitIndex(current.entries, input.limits);
      const right: OrderedDirectoryLeaf = {
        id: input.createLeafId(),
        entries: current.entries.splice(splitIndex)
      };
      leaves.splice(currentIndex + 1, 0, right);
      touched.add(right.id);
      currentIndex += 1;
    }
  }

  return {
    leaves,
    touchedLeafIds: [...touched],
    removedLeafIds: []
  };
}

function chooseSplitIndex(
  entries: OrderedDirectoryEntry[],
  limits: OrderedDirectoryLeafLimits
): number {
  let bestIndex = Math.ceil(entries.length / 2);
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let index = 1; index < entries.length; index += 1) {
    const left = entries.slice(0, index);
    const right = entries.slice(index);
    if (left.length > limits.maxEntries || right.length > limits.maxEntries) continue;
    const leftBytes = directoryLeafByteSize(left);
    const rightBytes = directoryLeafByteSize(right);
    if (leftBytes > limits.maxBytes || rightBytes > limits.maxBytes) continue;
    const delta = Math.abs(leftBytes - rightBytes);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = index;
    }
  }
  if (!Number.isFinite(bestDelta)) {
    throw new Error("A directory entry exceeds the configured leaf byte limit");
  }
  return bestIndex;
}

function findInsertionLeaf(
  leaves: OrderedDirectoryLeaf[],
  entry: OrderedDirectoryEntry,
  compareEntries: OrderedDirectoryEntryComparator
): number {
  let low = 0;
  let high = leaves.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const last = leaves[middle]!.entries.at(-1);
    if (!last || compareEntries(entry, last) <= 0) high = middle;
    else low = middle + 1;
  }
  return Math.min(low, leaves.length - 1);
}

function findEntryInsertionIndex(
  entries: OrderedDirectoryEntry[],
  entry: OrderedDirectoryEntry,
  compareEntries: OrderedDirectoryEntryComparator
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareEntries(entry, entries[middle]!) <= 0) high = middle;
    else low = middle + 1;
  }
  return low;
}

function cloneAndValidate(
  leaves: OrderedDirectoryLeaf[],
  compareEntries: OrderedDirectoryEntryComparator
): OrderedDirectoryLeaf[] {
  const leafIds = new Set<string>();
  const entryIds = new Set<string>();
  const cloned = leaves.map((leaf) => {
    if (leafIds.has(leaf.id)) throw new Error(`Duplicate directory leaf ID: ${leaf.id}`);
    leafIds.add(leaf.id);
    const entries = [...leaf.entries].sort(compareEntries);
    for (const entry of entries) {
      if (entryIds.has(entry.id)) throw new Error(`Duplicate directory entry ID: ${entry.id}`);
      entryIds.add(entry.id);
    }
    return { id: leaf.id, entries };
  });
  const flattened = cloned.flatMap((leaf) => leaf.entries);
  for (let index = 1; index < flattened.length; index += 1) {
    if (compareEntries(flattened[index - 1]!, flattened[index]!) > 0) {
      throw new Error("Directory leaves are not globally ordered");
    }
  }
  return cloned;
}

function leafExceedsLimits(
  leaf: OrderedDirectoryLeaf,
  limits: OrderedDirectoryLeafLimits
): boolean {
  return leaf.entries.length > limits.maxEntries
    || directoryLeafByteSize(leaf.entries) > limits.maxBytes;
}

function validateLimits(limits: OrderedDirectoryLeafLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (limits.mergeBelowEntries >= limits.maxEntries) {
    throw new Error("mergeBelowEntries must be lower than maxEntries");
  }
}
