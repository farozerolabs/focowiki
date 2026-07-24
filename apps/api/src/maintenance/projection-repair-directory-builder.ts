import { createHash } from "node:crypto";
import type {
  PersistentDirectoryLeaf
} from "../application/ports/directory-navigation-repository.js";
import {
  compareOrderedDirectoryEntries,
  directoryLeafByteSize,
  type OrderedDirectoryEntry
} from "../publication/ordered-directory-leaves.js";

export function createProjectionRepairDirectoryStream(input: {
  directoryPath: string;
  limits: {
    maxEntries: number;
    maxBytes: number;
  };
  writeLeaf: (leaf: PersistentDirectoryLeaf) => Promise<void>;
}) {
  validateLimits(input.limits);
  let currentEntries: OrderedDirectoryEntry[] = [];
  let pendingLeaf: PersistentDirectoryLeaf | null = null;
  let previousEntry: OrderedDirectoryEntry | null = null;
  let entryCount = 0;
  let leafCount = 0;
  let firstLeafId: string | null = null;
  let finished = false;
  const leafIdPrefix = createDirectoryLeafIdPrefix(input.directoryPath);

  async function add(entry: OrderedDirectoryEntry): Promise<void> {
    if (finished) throw new Error("Directory stream is already finished");
    if (
      previousEntry
      && compareOrderedDirectoryEntries(previousEntry, entry) >= 0
    ) {
      throw new Error("Directory entries must be strictly ordered");
    }
    assertEntryFits(entry, input.limits.maxBytes);
    const candidate = [...currentEntries, entry];
    if (
      currentEntries.length > 0
      && (
        candidate.length > input.limits.maxEntries
        || directoryLeafByteSize(candidate) > input.limits.maxBytes
      )
    ) {
      await sealCurrentLeaf();
      currentEntries = [entry];
    } else {
      currentEntries = candidate;
    }
    previousEntry = entry;
    entryCount += 1;
  }

  async function finish(): Promise<{
    entryCount: number;
    leafCount: number;
    firstLeafId: string | null;
  }> {
    if (finished) throw new Error("Directory stream is already finished");
    finished = true;
    if (currentEntries.length > 0) await sealCurrentLeaf();
    if (pendingLeaf) {
      await input.writeLeaf(pendingLeaf);
      pendingLeaf = null;
    }
    return { entryCount, leafCount, firstLeafId };
  }

  async function sealCurrentLeaf(): Promise<void> {
    if (currentEntries.length === 0) return;
    const id = `${leafIdPrefix}-${String(leafCount).padStart(6, "0")}`;
    const leaf: PersistentDirectoryLeaf = {
      id,
      previousLeafId: pendingLeaf?.id ?? null,
      nextLeafId: null,
      entries: currentEntries,
      revision: 1
    };
    if (pendingLeaf) {
      await input.writeLeaf({ ...pendingLeaf, nextLeafId: id });
    }
    pendingLeaf = leaf;
    firstLeafId ??= id;
    leafCount += 1;
    currentEntries = [];
  }

  return { add, finish };
}

function createDirectoryLeafIdPrefix(directoryPath: string): string {
  const digest = createHash("sha256").update(directoryPath).digest("hex").slice(0, 16);
  return `directory-leaf-${digest}`;
}

function assertEntryFits(entry: OrderedDirectoryEntry, maxBytes: number): void {
  if (directoryLeafByteSize([entry]) > maxBytes) {
    throw new Error("A directory entry exceeds the configured leaf byte limit");
  }
}

function validateLimits(limits: { maxEntries: number; maxBytes: number }): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
}
