export type TreeEntryTypeFilter = "file" | "directory" | null;

export function readTreeEntryTypeFilter(value: string | undefined): TreeEntryTypeFilter | undefined {
  if (!value) {
    return null;
  }

  return value === "file" || value === "directory" ? value : undefined;
}

export function createGeneratedTreeCursorScope(input: {
  knowledgeBaseId: string;
  generationId: string | null;
  parentPath: string;
  entryType: TreeEntryTypeFilter;
  scopePrefix: string;
  query?: string | null;
}): string {
  return [
    input.scopePrefix,
    input.knowledgeBaseId,
    input.generationId ?? "active",
    input.parentPath || "root",
    `entryType=${input.entryType ?? ""}`,
    ...(input.query ? [`query=${input.query}`] : [])
  ].join(":");
}
