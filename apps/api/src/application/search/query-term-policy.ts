import type { LexicalTokenizer } from "../ports/lexical-tokenizer.js";

const MAXIMUM_TOKENIZER_TERMS = 64;
const MAXIMUM_EXECUTION_TERMS = 32;
const MAXIMUM_HAN_CODE_POINTS = 64;
const MAXIMUM_OTHER_CODE_POINTS = 128;

const QUERY_INTENT_TERMS = new Set([
  "a", "about", "an", "and", "are", "be", "been", "being", "define",
  "defined", "defines", "describe", "described", "describes", "did", "do",
  "does", "document", "documents", "explain", "explained", "explains",
  "file", "files", "find", "for", "from", "how", "in", "is", "must", "of",
  "often", "on", "or", "show", "shows", "source", "sources", "the", "to",
  "was", "were", "what", "when", "where", "which", "who", "why", "with",
  "为什么", "为何", "什么", "哪些", "如何", "怎么", "怎样", "是否",
  "文件", "文档", "内容", "主要", "属于", "类别", "相关", "对应", "哪个",
  "几年", "一次"
]);

export const SEARCH_QUERY_TERM_POLICY_VERSION =
  "search-query-terms-v1-dynamic-coverage";

export type SearchTermPlan = {
  fullQuestion: string;
  executionQuery: string;
  informativeTerms: readonly string[];
  minimumShouldMatch: number;
  relaxed: boolean;
};

export function createSearchTermPlan(input: {
  query: string;
  tokenizer: LexicalTokenizer;
  relaxed?: boolean;
}): SearchTermPlan {
  const fullQuestion = input.query.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!fullQuestion) throw new Error("Search query is empty");
  let sourceTerms: string[];
  try {
    sourceTerms = input.tokenizer.tokenizeQuery(
      fullQuestion,
      MAXIMUM_TOKENIZER_TERMS
    );
  } catch {
    throw new Error("Search query tokenization failed");
  }
  if (
    sourceTerms.length > MAXIMUM_TOKENIZER_TERMS
    || sourceTerms.some((term) => !term || /\s/u.test(term))
  ) throw new Error("Search query tokenization failed");

  const uniqueTerms = removeSubsumedNumbers(removeNegatedHanBaseTerms(
    fullQuestion,
    [...new Set(sourceTerms)]
  ));
  const informative = uniqueTerms.filter((term) =>
    !QUERY_INTENT_TERMS.has(term.toLocaleLowerCase("en-US"))
  );
  const prioritized = prioritizeMixedScriptTerms(
    informative.length > 0 ? informative : uniqueTerms,
    fullQuestion
  );
  const bounded = boundExecutionTerms(prioritized, fullQuestion);
  const terms = bounded.length > 0 ? bounded : [boundFallback(fullQuestion)];
  const minimumShouldMatch = input.relaxed
    ? 1
    : requiredTermCoverage(terms.length);
  return {
    fullQuestion,
    executionQuery: terms.join(" "),
    informativeTerms: Object.freeze(terms),
    minimumShouldMatch,
    relaxed: input.relaxed === true
  };
}

export function requiredTermCoverage(termCount: number): number {
  if (!Number.isSafeInteger(termCount) || termCount < 1) {
    throw new Error("Search term count is invalid");
  }
  if (termCount <= 2) return termCount;
  if (termCount <= 8) return 2;
  return Math.min(6, Math.max(2, Math.ceil(termCount * 0.3)));
}

function removeNegatedHanBaseTerms(
  query: string,
  terms: readonly string[]
): string[] {
  if (!query.includes("不存在")) return [...terms];
  return terms.filter((term) => term !== "存在");
}

function removeSubsumedNumbers(terms: readonly string[]): string[] {
  return terms.filter((term) =>
    !/^\p{N}+$/u.test(term)
    || !terms.some((candidate) => candidate !== term
      && /\p{L}/u.test(candidate) && candidate.includes(term))
  );
}

function prioritizeMixedScriptTerms(
  terms: readonly string[],
  query: string
): string[] {
  if (!/\p{Script=Han}/u.test(query) || !/\p{Script=Latin}/u.test(query)) {
    return [...terms];
  }
  const firstHan = terms.find((term) => /\p{Script=Han}/u.test(term));
  const latinTerms = terms.filter((term) => /\p{Script=Latin}/u.test(term));
  if (!firstHan || latinTerms.length === 0) return [...terms];
  const prioritized = /\p{Script=Han}/u.test(terms[0] ?? "")
    ? [firstHan, ...latinTerms]
    : [...latinTerms, firstHan];
  const selected = new Set(prioritized);
  return [...prioritized, ...terms.filter((term) => !selected.has(term))];
}

function boundExecutionTerms(
  terms: readonly string[],
  query: string
): string[] {
  const maximumCodePoints = /\p{Script=Han}/u.test(query)
    ? MAXIMUM_HAN_CODE_POINTS
    : MAXIMUM_OTHER_CODE_POINTS;
  const output: string[] = [];
  let codePoints = 0;
  for (const term of terms) {
    if (output.length >= MAXIMUM_EXECUTION_TERMS) break;
    const length = Array.from(term).length;
    if (length > maximumCodePoints - codePoints) continue;
    output.push(term);
    codePoints += length;
  }
  return output;
}

function boundFallback(query: string): string {
  const maximumCodePoints = /\p{Script=Han}/u.test(query)
    ? MAXIMUM_HAN_CODE_POINTS
    : MAXIMUM_OTHER_CODE_POINTS;
  const fallback = Array.from(query).slice(0, maximumCodePoints).join("").trim();
  if (!fallback) throw new Error("Search query is empty");
  return fallback;
}
