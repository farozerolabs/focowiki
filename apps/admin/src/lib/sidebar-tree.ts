import type { AdminSidebarTreeNode } from "@/components/app-sidebar";
import type { GeneratedTreeEntry, GeneratedTreeSearchResult } from "@/lib/admin-api";

export type TreePageState = {
  items: GeneratedTreeEntry[];
  nextCursor: string | null;
  isLoading: boolean;
};

export function buildSidebarTree(
  treePages: Record<string, TreePageState>,
  expandedDirectories: Set<string>,
  selectedFilePath: string,
  parentPath: string
): AdminSidebarTreeNode[] {
  const page = treePages[parentPath];

  if (!page) {
    return [];
  }

  return page.items.map((entry) => ({
    id: entry.id,
    name: entry.name,
    logicalPath: entry.logicalPath,
    entryType: entry.entryType,
    children:
      entry.entryType === "directory"
        ? buildSidebarTree(treePages, expandedDirectories, selectedFilePath, entry.logicalPath)
        : [],
    isExpanded: expandedDirectories.has(entry.logicalPath),
    isActive: selectedFilePath === entry.logicalPath,
    nextCursor: entry.entryType === "directory" ? treePages[entry.logicalPath]?.nextCursor ?? null : null,
    deletable: Boolean(entry.deletable),
    sourceDirectoryId: entry.sourceDirectoryId ?? null,
    sourceFileId: entry.sourceFileId ?? null,
    resourceRevision: entry.resourceRevision ?? null,
    descendantFileCount: entry.descendantFileCount ?? 0
  }));
}

export function buildSidebarSearchTree(
  results: GeneratedTreeSearchResult[],
  selectedFilePath: string
): AdminSidebarTreeNode[] {
  const nodes = new Map<string, AdminSidebarTreeNode>();
  const rootPaths = new Set<string>();

  for (const result of results) {
    const entries = [...result.ancestors, result.entry];

    for (const entry of entries) {
      let node = nodes.get(entry.logicalPath);

      if (!node) {
        node = createSearchNode(entry, selectedFilePath);
        nodes.set(entry.logicalPath, node);
      }

      const parentPath = entry.parentPath ?? readParentPath(entry.logicalPath);

      if (!parentPath) {
        rootPaths.add(entry.logicalPath);
        continue;
      }

      const parent = nodes.get(parentPath);
      if (parent && !parent.children.some((child) => child.logicalPath === node.logicalPath)) {
        parent.children.push(node);
      }
    }
  }

  return Array.from(rootPaths)
    .map((path) => nodes.get(path))
    .filter((node): node is AdminSidebarTreeNode => Boolean(node));
}

function readParentPath(logicalPath: string): string {
  const segments = logicalPath.split("/").filter(Boolean);
  return segments.slice(0, -1).join("/");
}

function createSearchNode(
  entry: GeneratedTreeEntry,
  selectedFilePath: string
): AdminSidebarTreeNode {
  return {
    id: entry.id,
    name: entry.name,
    logicalPath: entry.logicalPath,
    entryType: entry.entryType,
    children: [],
    isExpanded: true,
    isActive: selectedFilePath === entry.logicalPath,
    nextCursor: null,
    deletable: Boolean(entry.deletable),
    sourceDirectoryId: entry.sourceDirectoryId ?? null,
    sourceFileId: entry.sourceFileId ?? null,
    resourceRevision: entry.resourceRevision ?? null,
    descendantFileCount: entry.descendantFileCount ?? 0
  };
}
