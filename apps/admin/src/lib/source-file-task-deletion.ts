import type { SourceFileRecord } from "@/lib/admin-api";

export function isSourceFileTaskDeletionSelectable(file: SourceFileRecord): boolean {
  if (file.state === "running" || file.state === "pending_publication") {
    return false;
  }
  return true;
}

export function getSelectableSourceFileIds(sourceFiles: SourceFileRecord[]): string[] {
  return sourceFiles.filter(isSourceFileTaskDeletionSelectable).map((file) => file.id);
}
