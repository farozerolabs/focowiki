export type FileTreeSearchErrorCode =
  | "FILE_TREE_SEARCH_QUERY_REQUIRED"
  | "FILE_TREE_SEARCH_QUERY_TOO_SHORT"
  | "FILE_TREE_SEARCH_QUERY_TOO_LONG"
  | "INVALID_FILE_TREE_SEARCH";

export type FileTreeSearchParseResult =
  | { ok: true; query: string }
  | { ok: false; code: FileTreeSearchErrorCode };

const SEARCH_QUERY_MIN_LENGTH = 2;
const SEARCH_QUERY_MAX_LENGTH = 160;

export function readFileTreeSearchQuery(value: string | undefined): FileTreeSearchParseResult {
  const query = value?.trim() ?? "";

  if (!query) {
    return { ok: false, code: "FILE_TREE_SEARCH_QUERY_REQUIRED" };
  }

  if (query.length < SEARCH_QUERY_MIN_LENGTH) {
    return { ok: false, code: "FILE_TREE_SEARCH_QUERY_TOO_SHORT" };
  }

  if (query.length > SEARCH_QUERY_MAX_LENGTH) {
    return { ok: false, code: "FILE_TREE_SEARCH_QUERY_TOO_LONG" };
  }

  if (containsUnsafeControlCharacter(query)) {
    return { ok: false, code: "INVALID_FILE_TREE_SEARCH" };
  }

  return { ok: true, query };
}

function containsUnsafeControlCharacter(value: string): boolean {
  return /[\u0000-\u001F\u007F]/u.test(value);
}
