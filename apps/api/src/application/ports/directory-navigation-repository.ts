import type {
  OrderedDirectoryEntry
} from "../../document-indexing/domain/document-directory-leaves.js";

export type PersistentDirectoryLeaf = {
  id: string;
  previousLeafId: string | null;
  nextLeafId: string | null;
  entries: OrderedDirectoryEntry[];
  revision: number;
  changedAt?: string;
};

export type DirectoryNavigationSummary = {
  directoryPath: string;
  entryCount: number;
  firstLeafId: string | null;
  revision: number;
};

export type DirectoryNavigationMutationResult = {
  changed: boolean;
  touchedLeaves: PersistentDirectoryLeaf[];
  removedLeafIds: string[];
  summary: DirectoryNavigationSummary;
};
