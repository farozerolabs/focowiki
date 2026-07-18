export type OrderedDirectoryEntry = {
  id: string;
  sortKey: string;
  name: string;
  targetPath: string;
  kind: "file" | "directory";
};

export type OrderedDirectoryLeaf = {
  id: string;
  entries: OrderedDirectoryEntry[];
};

export type OrderedDirectoryLeafLimits = {
  maxEntries: number;
  maxBytes: number;
  mergeBelowEntries: number;
};

export type OrderedDirectoryLeafMutation = {
  leaves: OrderedDirectoryLeaf[];
  touchedLeafIds: string[];
  removedLeafIds: string[];
};

export function insertDirectoryEntry(input: {
  leaves: OrderedDirectoryLeaf[];
  entry: OrderedDirectoryEntry;
  limits: OrderedDirectoryLeafLimits;
  createLeafId: () => string;
}): OrderedDirectoryLeafMutation {
  validateLimits(input.limits);
  const leaves = cloneAndValidate(input.leaves);
  if (leaves.some((leaf) => leaf.entries.some((entry) => entry.id === input.entry.id))) {
    return { leaves, touchedLeafIds: [], removedLeafIds: [] };
  }

  if (leaves.length === 0) {
    const leafId = input.createLeafId();
    return {
      leaves: [{ id: leafId, entries: [input.entry] }],
      touchedLeafIds: [leafId],
      removedLeafIds: []
    };
  }

  const leafIndex = findInsertionLeaf(leaves, input.entry);
  const target = leaves[leafIndex]!;
  target.entries.push(input.entry);
  target.entries.sort(compareEntries);
  const touched = new Set<string>([target.id]);
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

  return {
    leaves,
    touchedLeafIds: [...touched],
    removedLeafIds: []
  };
}

export function removeDirectoryEntry(input: {
  leaves: OrderedDirectoryLeaf[];
  entryId: string;
  limits: OrderedDirectoryLeafLimits;
}): OrderedDirectoryLeafMutation {
  validateLimits(input.limits);
  const leaves = cloneAndValidate(input.leaves);
  const leafIndex = leaves.findIndex((leaf) =>
    leaf.entries.some((entry) => entry.id === input.entryId)
  );
  if (leafIndex < 0) {
    return { leaves, touchedLeafIds: [], removedLeafIds: [] };
  }

  const target = leaves[leafIndex]!;
  target.entries = target.entries.filter((entry) => entry.id !== input.entryId);
  const touched = new Set<string>([target.id]);
  const removed: string[] = [];

  if (target.entries.length === 0 && leaves.length > 1) {
    removed.push(target.id);
    leaves.splice(leafIndex, 1);
    const neighbor = leaves[Math.min(leafIndex, leaves.length - 1)];
    if (neighbor) {
      touched.add(neighbor.id);
    }
  } else if (
    leaves.length > 1 &&
    target.entries.length < input.limits.mergeBelowEntries
  ) {
    const leftIndex = leafIndex > 0 ? leafIndex - 1 : leafIndex;
    const rightIndex = leafIndex > 0 ? leafIndex : leafIndex + 1;
    const left = leaves[leftIndex];
    const right = leaves[rightIndex];
    if (left && right) {
      const merged = [...left.entries, ...right.entries].sort(compareEntries);
      if (!leafExceedsLimits({ id: left.id, entries: merged }, input.limits)) {
        left.entries = merged;
        leaves.splice(rightIndex, 1);
        touched.add(left.id);
        removed.push(right.id);
      }
    }
  }

  return {
    leaves,
    touchedLeafIds: [...touched],
    removedLeafIds: removed
  };
}

export function directoryLeafByteSize(entries: OrderedDirectoryEntry[]): number {
  return Buffer.byteLength(JSON.stringify(entries), "utf8");
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
    if (left.length > limits.maxEntries || right.length > limits.maxEntries) {
      continue;
    }
    const leftBytes = directoryLeafByteSize(left);
    const rightBytes = directoryLeafByteSize(right);
    if (leftBytes > limits.maxBytes || rightBytes > limits.maxBytes) {
      continue;
    }
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
  entry: OrderedDirectoryEntry
): number {
  const index = leaves.findIndex((leaf) => {
    const last = leaf.entries.at(-1);
    return last ? compareEntries(entry, last) <= 0 : true;
  });
  return index < 0 ? leaves.length - 1 : index;
}

function cloneAndValidate(leaves: OrderedDirectoryLeaf[]): OrderedDirectoryLeaf[] {
  const ids = new Set<string>();
  const entryIds = new Set<string>();
  const cloned = leaves.map((leaf) => {
    if (ids.has(leaf.id)) {
      throw new Error(`Duplicate directory leaf ID: ${leaf.id}`);
    }
    ids.add(leaf.id);
    const entries = [...leaf.entries].sort(compareEntries);
    for (const entry of entries) {
      if (entryIds.has(entry.id)) {
        throw new Error(`Duplicate directory entry ID: ${entry.id}`);
      }
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
  return (
    leaf.entries.length > limits.maxEntries ||
    directoryLeafByteSize(leaf.entries) > limits.maxBytes
  );
}

function compareEntries(a: OrderedDirectoryEntry, b: OrderedDirectoryEntry): number {
  return a.sortKey.localeCompare(b.sortKey, "en") || a.id.localeCompare(b.id, "en");
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
