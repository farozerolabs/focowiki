export const SEARCH_QUERY_MIN_CHARACTERS = 2;
export const SEARCH_QUERY_MAX_CHARACTERS = 512;
export const SEARCH_QUERY_MAX_BYTES = 2_048;
export const SEARCH_RESULT_DEFAULT_LIMIT = 10;
export const SEARCH_RESULT_MAX_LIMIT = 50;
export const SEARCH_RERANK_DEFAULT_TOP_K = 30;
export const SEARCH_RERANK_MAX_TOP_K = 50;
export const SEARCH_RERANK_DEFAULT_SCORE_THRESHOLD = 0.35;

export type SearchQueryValidationError =
  | "required"
  | "too_short"
  | "too_long"
  | "unsafe_control";

export type SearchQueryValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: SearchQueryValidationError };

export type SearchRequestControls = {
  limit: number;
  rerank: boolean;
  rerankTopK: number | null;
  rerankScoreThreshold: number | null;
};

export type SearchRequestControlResult =
  | { ok: true; value: SearchRequestControls }
  | { ok: false; error: "invalid_limit" | "invalid_rerank_controls" };

const graphemeSegmenter = new Intl.Segmenter("und", {
  granularity: "grapheme"
});

export function normalizeAndValidateSearchQuery(
  input: string | undefined
): SearchQueryValidationResult {
  const raw = input ?? "";
  if (containsUnsafeControlCharacter(raw)) {
    return { ok: false, error: "unsafe_control" };
  }
  const value = raw.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!value) return { ok: false, error: "required" };
  const characters = [...graphemeSegmenter.segment(value)].length;
  if (characters < SEARCH_QUERY_MIN_CHARACTERS) {
    return { ok: false, error: "too_short" };
  }
  if (
    characters > SEARCH_QUERY_MAX_CHARACTERS
    || Buffer.byteLength(value, "utf8") > SEARCH_QUERY_MAX_BYTES
  ) return { ok: false, error: "too_long" };
  return { ok: true, value };
}

export function parseSearchRequestControls(input: {
  limit?: string | undefined;
  rerank?: string | undefined;
  rerankTopK?: string | undefined;
  rerankScoreThreshold?: string | undefined;
}): SearchRequestControlResult {
  const limit = parseInteger(
    input.limit,
    SEARCH_RESULT_DEFAULT_LIMIT,
    1,
    SEARCH_RESULT_MAX_LIMIT
  );
  if (limit === null) return { ok: false, error: "invalid_limit" };
  const rerank = parseBoolean(input.rerank);
  if (rerank === null) return { ok: false, error: "invalid_rerank_controls" };
  const suppliedTopK = supplied(input.rerankTopK);
  const suppliedThreshold = supplied(input.rerankScoreThreshold);
  if (!rerank && (suppliedTopK || suppliedThreshold)) {
    return { ok: false, error: "invalid_rerank_controls" };
  }
  if (!rerank) {
    return {
      ok: true,
      value: {
        limit,
        rerank: false,
        rerankTopK: null,
        rerankScoreThreshold: null
      }
    };
  }
  const rerankTopK = parseInteger(
    input.rerankTopK,
    Math.max(SEARCH_RERANK_DEFAULT_TOP_K, limit),
    1,
    SEARCH_RERANK_MAX_TOP_K
  );
  const rerankScoreThreshold = parseFiniteNumber(
    input.rerankScoreThreshold,
    SEARCH_RERANK_DEFAULT_SCORE_THRESHOLD,
    0,
    1
  );
  if (
    rerankTopK === null
    || rerankTopK < limit
    || rerankScoreThreshold === null
  ) return { ok: false, error: "invalid_rerank_controls" };
  return {
    ok: true,
    value: { limit, rerank, rerankTopK, rerankScoreThreshold }
  };
}

function containsUnsafeControlCharacter(value: string): boolean {
  return /[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/u.test(value);
}

function supplied(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function parseBoolean(value: string | undefined): boolean | null {
  if (!supplied(value)) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number | null {
  if (!supplied(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function parseFiniteNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number | null {
  if (!supplied(value)) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}
