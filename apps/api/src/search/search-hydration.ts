import type {
  ActiveGenerationProjection
} from "../application/ports/active-generation-read-repository.js";
import type { SerializableJson } from "../application/ports/source-dispatch-repository.js";
import type { SearchRetrievalCandidate } from "./search-retrieval.js";

export type SearchHydrationRecord = {
  sourceFileId: string;
  sourceRevisionId: string;
  visible: boolean;
  fileId: string;
  recordId: string;
  logicalPath: string;
  title: string | null;
  summary: string | null;
  payload: SerializableJson;
};

export async function hydrateSearchCandidates(input: {
  generationId: string;
  candidates: SearchRetrievalCandidate[];
  limit: number;
  load: (sourceFileIds: string[]) => Promise<SearchHydrationRecord[]>;
}): Promise<{ items: ActiveGenerationProjection[] }> {
  assertLimit(input.limit);
  const uniqueCandidates = deduplicateCandidates(input.candidates);
  const records = await input.load(
    uniqueCandidates.map((candidate) => candidate.sourceFileId)
  );
  const bySourceFile = new Map(
    records
      .filter((record) => record.visible)
      .map((record) => [record.sourceFileId, record])
  );
  const items: ActiveGenerationProjection[] = [];

  for (const candidate of uniqueCandidates) {
    const record = bySourceFile.get(candidate.sourceFileId);
    if (!record || record.sourceRevisionId !== candidate.sourceRevisionId) continue;
    items.push({
      generationId: input.generationId,
      projectionKind: "search",
      recordId: record.recordId,
      sourceFileId: record.sourceFileId,
      relatedSourceFileId: null,
      path: record.logicalPath,
      parentPath: parentPath(record.logicalPath),
      sortKey: record.recordId,
      title: record.title,
      summary: candidate.summary ?? record.summary,
      score: candidate.fusedScore,
      payload: mergePayload(record.payload, {
        fileId: record.fileId,
        path: record.logicalPath,
        sourceUrl: candidate.sourceUrl,
        sourceRevisionId: record.sourceRevisionId,
        matchType: candidate.families.includes("graph")
          ? "graph_node"
          : "file_direct",
        matchFamilies: [...candidate.families]
      })
    });
    if (items.length >= input.limit) break;
  }

  return { items };
}

function deduplicateCandidates(
  candidates: SearchRetrievalCandidate[]
): SearchRetrievalCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.sourceFileId)) return false;
    seen.add(candidate.sourceFileId);
    return true;
  });
}

function mergePayload(
  value: SerializableJson,
  fields: Record<string, SerializableJson>
): SerializableJson {
  const base = value
    && typeof value === "object"
    && !Array.isArray(value)
    && !(value instanceof Date)
    ? value
    : {};
  return {
    ...base,
    ...fields
  };
}

function parentPath(value: string): string {
  const separator = value.lastIndexOf("/");
  return separator === -1 ? "" : value.slice(0, separator);
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Search hydration limit must be between 1 and 1000");
  }
}
