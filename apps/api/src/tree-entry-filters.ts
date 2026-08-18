export type TreeEntryTypeFilter = "file" | "directory" | null;

export function readTreeEntryTypeFilter(value: string | undefined): TreeEntryTypeFilter | undefined {
  if (!value) {
    return null;
  }

  return value === "file" || value === "directory" ? value : undefined;
}
