import type { BundleTreeEntryRecord } from "./db/admin-repositories.js";

export type TreeEntryTypeFilter = BundleTreeEntryRecord["entryType"] | null;

export function readTreeEntryTypeFilter(value: string | undefined): TreeEntryTypeFilter | undefined {
  if (!value) {
    return null;
  }

  return value === "file" || value === "directory" ? value : undefined;
}

export function createBundleTreeCursorScope(input: {
  knowledgeBaseId: string;
  releaseId: string;
  parentPath: string;
  entryType: TreeEntryTypeFilter;
  scopePrefix: string;
}): string {
  return [
    input.scopePrefix,
    input.knowledgeBaseId,
    input.releaseId,
    input.parentPath || "root",
    `entryType=${input.entryType ?? ""}`
  ].join(":");
}
