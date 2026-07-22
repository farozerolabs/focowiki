import type {
  OrderedDirectoryEntry,
  OrderedDirectoryLeafLimits
} from "../../publication/ordered-directory-leaves.js";

export type PersistentDirectoryLeaf = {
  id: string;
  previousLeafId: string | null;
  nextLeafId: string | null;
  entries: OrderedDirectoryEntry[];
  revision: number;
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

export interface DirectoryNavigationRepository {
  applyEntry(input: {
    knowledgeBaseId: string;
    generationId: string;
    directoryPath: string;
    entryId: string;
    desiredEntry: OrderedDirectoryEntry | null;
    limits: OrderedDirectoryLeafLimits;
  }): Promise<DirectoryNavigationMutationResult>;

  applyEntries(input: {
    knowledgeBaseId: string;
    generationId: string;
    directoryPath: string;
    entries: Array<{
      entryId: string;
      desiredEntry: OrderedDirectoryEntry | null;
    }>;
    limits: OrderedDirectoryLeafLimits;
  }): Promise<DirectoryNavigationMutationResult>;

  getSummary(input: {
    knowledgeBaseId: string;
    generationId: string;
    directoryPath: string;
  }): Promise<DirectoryNavigationSummary | null>;
}
