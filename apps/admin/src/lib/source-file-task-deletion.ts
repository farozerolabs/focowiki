import type { SourceFileRecord } from "@/lib/admin-api";

export function isSourceFileTaskDeletionSelectable(file: SourceFileRecord): boolean {
  if (file.processingStatus === "running") {
    return false;
  }

  if (file.processingStatus === "completed") {
    return file.generatedOutputStatus === "visible" || Boolean(file.generatedFileAvailable);
  }

  return true;
}

export function getSelectableSourceFileIds(sourceFiles: SourceFileRecord[]): string[] {
  return sourceFiles.filter(isSourceFileTaskDeletionSelectable).map((file) => file.id);
}
