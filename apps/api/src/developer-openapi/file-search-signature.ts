import { createHash } from "node:crypto";
import type { BundleFileKind } from "../db/admin-repositories.js";
import type { GeneratedFileSearchScope } from "../search/generated-file-search-documents.js";
import { normalizeGeneratedFileSearchQuery } from "../search/generated-file-search-documents.js";
import type { GraphSearchDepth, GraphSearchMode } from "../search/graph-search-documents.js";

export function createDeveloperFileSearchCursorScope(input: {
  knowledgeBaseId: string;
  releaseId: string;
  query: string;
  scope: GeneratedFileSearchScope;
  fileKind: BundleFileKind | null;
  mode?: GraphSearchMode;
  graphDepth?: GraphSearchDepth;
  graphFanout?: number;
}): string {
  return [
    "developer-openapi:file-search",
    input.knowledgeBaseId,
    input.releaseId,
    input.mode ?? "hybrid",
    input.scope,
    input.fileKind ?? "all",
    String(input.graphDepth ?? 0),
    String(input.graphFanout ?? 0),
    hashSearchQuery(normalizeGeneratedFileSearchQuery(input.query))
  ].join(":");
}

function hashSearchQuery(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
