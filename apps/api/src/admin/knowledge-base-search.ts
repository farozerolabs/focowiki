export type KnowledgeBaseSearchErrorCode =
  | "INVALID_KNOWLEDGE_BASE_SEARCH_QUERY"
  | "KNOWLEDGE_BASE_SEARCH_QUERY_TOO_LONG";

export type KnowledgeBaseSearchParseResult =
  | { ok: true; query: string | null }
  | { ok: false; code: KnowledgeBaseSearchErrorCode };

const KNOWLEDGE_BASE_SEARCH_MAX_LENGTH = 128;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export function readKnowledgeBaseSearchQuery(value: string | undefined): KnowledgeBaseSearchParseResult {
  const normalized = value?.trim() ?? "";

  if (!normalized) {
    return { ok: true, query: null };
  }

  if (normalized.length > KNOWLEDGE_BASE_SEARCH_MAX_LENGTH) {
    return { ok: false, code: "KNOWLEDGE_BASE_SEARCH_QUERY_TOO_LONG" };
  }

  if (CONTROL_CHARACTER_PATTERN.test(normalized)) {
    return { ok: false, code: "INVALID_KNOWLEDGE_BASE_SEARCH_QUERY" };
  }

  return { ok: true, query: normalized };
}

export function readKnowledgeBaseSearchQueryFromQuery(
  readQuery: (name: string) => string | undefined
): KnowledgeBaseSearchParseResult {
  return readKnowledgeBaseSearchQuery(readQuery("query"));
}
