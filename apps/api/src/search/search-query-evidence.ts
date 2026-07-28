import type { LexicalTokenizer } from "../application/ports/lexical-tokenizer.js";
import { normalizeSearchPhrase } from "./body-normalization.js";

export const SEARCH_QUERY_TERM_LIMIT = 32;
export const SEARCH_MULTI_TERM_MIN_COVERAGE = 0.6;

export type SearchQueryEvidence = {
  phrase: string;
  terms: string[];
  tokenizerContractVersion: string;
};

export function createSearchQueryEvidence(
  value: string,
  tokenizer: LexicalTokenizer
): SearchQueryEvidence {
  const phrase = normalizeSearchPhrase(value);
  const terms = uniqueTerms(
    tokenizer.tokenizeQuery(phrase, SEARCH_QUERY_TERM_LIMIT),
    SEARCH_QUERY_TERM_LIMIT
  );
  return {
    phrase,
    terms,
    tokenizerContractVersion: tokenizer.contractVersion
  };
}

function uniqueTerms(values: string[], limit: number): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeToken(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= limit) break;
  }
  const informative = output.filter((value) => !isSingleNumericFragment(value));
  return informative.length > 0 ? informative : output.slice(0, 1);
}

function normalizeToken(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").trim();
}

function isSingleNumericFragment(value: string): boolean {
  return /^\p{N}$/u.test(value);
}
