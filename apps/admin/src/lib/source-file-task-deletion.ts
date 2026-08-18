import type { SourceFileRecord } from "@/lib/admin-api";

export function isSourceFileTaskDeletionSelectable(file: SourceFileRecord): boolean {
  if (file.state === "processing" || file.state === "deleting") {
    return false;
  }
  return true;
}

export function getSelectableSourceFileIds(sourceFiles: SourceFileRecord[]): string[] {
  return sourceFiles.filter(isSourceFileTaskDeletionSelectable).map((file) => file.id);
}
