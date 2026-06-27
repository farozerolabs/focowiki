import { createHash } from "node:crypto";
import type { SourceFileListFilters } from "../db/admin-repositories.js";

export function createSourceFileCursorScope(
  knowledgeBaseId: string,
  filters: SourceFileListFilters
): string {
  return [
    "source-files",
    knowledgeBaseId,
    `filters=${createSourceFileFilterSignature(filters)}`
  ].join(":");
}

export function createSourceFileFilterSignature(filters: SourceFileListFilters): string {
  const payload = JSON.stringify({
    fileNameQuery: filters.fileNameQuery ?? null,
    fileIdQuery: filters.fileIdQuery ?? null,
    processingStatus: filters.processingStatus ?? null,
    processingStage: filters.processingStage ?? null,
    modelInvocationStatus: filters.modelInvocationStatus ?? null,
    generatedOutputStatus: filters.generatedOutputStatus ?? null,
    startedFrom: filters.startedFrom ?? null,
    startedTo: filters.startedTo ?? null,
    endedFrom: filters.endedFrom ?? null,
    endedTo: filters.endedTo ?? null,
    errorState: filters.errorState ?? null,
    errorCodeQuery: filters.errorCodeQuery ?? null,
    actionState: filters.actionState ?? null
  });

  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}
