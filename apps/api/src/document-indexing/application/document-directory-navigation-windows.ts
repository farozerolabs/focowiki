import type { PersistentDirectoryLeaf } from
  "../../application/ports/directory-navigation-repository.js";
import {
  reconcileDocumentDirectoryNavigation,
  type DocumentDirectoryNavigationChange
} from "./document-directory-navigation-state.js";
import {
  compareOrderedDirectoryEntries,
  type OrderedDirectoryEntry,
  type OrderedDirectoryLeafLimits
} from "../domain/document-directory-leaves.js";

type BoundedNavigationDelta = Readonly<{
  mode: "window";
  leaves: readonly PersistentDirectoryLeaf[];
  totalEntryCount: number;
  firstLeafId: string | null;
}> | Readonly<{
  mode: "windows";
  windows: readonly (readonly PersistentDirectoryLeaf[])[];
  totalEntryCount: number;
  firstLeafId: string | null;
}>;

export function reconcileDocumentDirectoryNavigationDelta(input: {
  previous: readonly PersistentDirectoryLeaf[];
  changes: readonly DocumentDirectoryNavigationChange[];
  delta: BoundedNavigationDelta | null;
  limits: OrderedDirectoryLeafLimits;
  changedAt: string;
  createLeafId(): string;
}) {
  if (input.delta?.mode === "windows") {
    return reconcileDocumentDirectoryNavigationWindows({
      previousWindows: input.delta.windows,
      changes: input.changes,
      window: input.delta,
      limits: input.limits,
      changedAt: input.changedAt,
      createLeafId: input.createLeafId
    });
  }
  return reconcileDocumentDirectoryNavigation({
    previous: input.previous,
    changes: input.changes,
    ...(input.delta ? { window: input.delta } : {}),
    limits: input.limits,
    changedAt: input.changedAt,
    createLeafId: input.createLeafId
  });
}

export function partitionDocumentDirectoryNavigationWindows(
  leaves: readonly PersistentDirectoryLeaf[]
): PersistentDirectoryLeaf[][] {
  const windows: PersistentDirectoryLeaf[][] = [];
  for (const leaf of leaves) {
    const current = windows.at(-1);
    const previous = current?.at(-1);
    if (!previous) {
      windows.push([leaf]);
      continue;
    }
    const linkedFromPrevious = previous.nextLeafId === leaf.id;
    const linkedFromCurrent = leaf.previousLeafId === previous.id;
    if (linkedFromPrevious !== linkedFromCurrent) {
      throw navigationWindowError("previous_state_invalid");
    }
    if (linkedFromPrevious) current!.push(leaf);
    else windows.push([leaf]);
  }
  return windows;
}

export function reconcileDocumentDirectoryNavigationWindows(input: {
  previousWindows: readonly (readonly PersistentDirectoryLeaf[])[];
  changes: readonly DocumentDirectoryNavigationChange[];
  limits: OrderedDirectoryLeafLimits;
  createLeafId(): string;
  changedAt?: string;
  window: Readonly<{
    totalEntryCount: number;
    firstLeafId: string | null;
  }>;
}): ReturnType<typeof reconcileDocumentDirectoryNavigation> {
  validateChanges(input.changes);
  const windows = input.previousWindows.length > 0
    ? input.previousWindows.map((window) => [...window]) : [[]];
  const leafIds = new Set<string>();
  const entryWindows = new Map<string, number>();
  for (const [windowIndex, window] of windows.entries()) {
    validateWindow(window);
    for (const leaf of window) {
      if (leafIds.has(leaf.id)) {
        throw navigationWindowError("previous_state_invalid");
      }
      leafIds.add(leaf.id);
      for (const entry of leaf.entries) {
        if (entryWindows.has(entry.id)) {
          throw navigationWindowError("previous_state_invalid");
        }
        entryWindows.set(entry.id, windowIndex);
      }
    }
  }
  const changesByWindow = windows.map(() =>
    [] as DocumentDirectoryNavigationChange[]);
  for (const change of input.changes) {
    const existingWindow = entryWindows.get(change.entryId);
    const desiredWindow = change.desiredEntry
      ? findDesiredWindow(windows, change.desiredEntry) : undefined;
    if (existingWindow !== undefined && existingWindow !== desiredWindow) {
      changesByWindow[existingWindow]!.push({
        entryId: change.entryId, desiredEntry: null
      });
    }
    if (desiredWindow !== undefined) {
      changesByWindow[desiredWindow]!.push({
        entryId: change.entryId, desiredEntry: change.desiredEntry
      });
    }
  }
  const previousEntryCount = countEntries(windows.flat());
  const leaves: PersistentDirectoryLeaf[] = [];
  const touchedLeafIds: string[] = [];
  const removedLeafIds: string[] = [];
  let firstLeafId = input.window.firstLeafId;
  for (const [index, previous] of windows.entries()) {
    const result = reconcileDocumentDirectoryNavigation({
      previous,
      changes: changesByWindow[index]!,
      limits: input.limits,
      createLeafId: input.createLeafId,
      ...(input.changedAt ? { changedAt: input.changedAt } : {}),
      window: {
        totalEntryCount: countEntries(previous),
        firstLeafId: input.window.firstLeafId
      }
    });
    if (previous[0]?.previousLeafId === null) firstLeafId = result.firstLeafId;
    leaves.push(...result.leaves);
    touchedLeafIds.push(...result.touchedLeafIds);
    removedLeafIds.push(...result.removedLeafIds);
  }
  return {
    leaves,
    touchedLeafIds,
    removedLeafIds: removedLeafIds.sort(compareText),
    entryCount: input.window.totalEntryCount - previousEntryCount
      + countEntries(leaves),
    firstLeafId
  };
}

function findDesiredWindow(
  windows: readonly (readonly PersistentDirectoryLeaf[])[],
  entry: OrderedDirectoryEntry
): number {
  if (windows.length === 1 && windows[0]!.length === 0) return 0;
  const index = windows.findIndex((window) => {
    const last = window.at(-1)?.entries.at(-1);
    return last ? compareOrderedDirectoryEntries(entry, last) <= 0 : false;
  });
  return index >= 0 ? index : windows.length - 1;
}

function validateWindow(window: readonly PersistentDirectoryLeaf[]): void {
  for (const [index, leaf] of window.entries()) {
    if (!leaf.id || !Number.isSafeInteger(leaf.revision) || leaf.revision < 1
      || (index > 0 && leaf.previousLeafId !== window[index - 1]!.id)
      || (index < window.length - 1
        && leaf.nextLeafId !== window[index + 1]!.id)) {
      throw navigationWindowError("previous_state_invalid");
    }
  }
}

function validateChanges(
  changes: readonly DocumentDirectoryNavigationChange[]
): void {
  if (new Set(changes.map((change) => change.entryId)).size !== changes.length
    || changes.some((change) => !change.entryId
      || (change.desiredEntry !== null
        && change.desiredEntry.id !== change.entryId))) {
    throw navigationWindowError("navigation_changes_invalid");
  }
}

function countEntries(leaves: readonly PersistentDirectoryLeaf[]): number {
  return leaves.reduce((total, leaf) => total + leaf.entries.length, 0);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function navigationWindowError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document navigation window error: ${code}`), {
    code
  });
}
