import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import type { SearchProviderQueryRequest } from
  "../../application/ports/search-provider-runtime.js";
import { createSearchTermPlan } from
  "../../application/search/query-term-policy.js";
const BLENDED_EVIDENCE_FAMILIES = [
  "exact", "text", "phrase", "typo", "jieba", "graph"
] as const;

export function normalizeMeilisearchQuery(input: {
  request: Pick<
    SearchProviderQueryRequest,
    "query" | "evidenceFamilies" | "matchingStrategy" | "relaxedTermCoverage"
  >;
  tokenizer?: LexicalTokenizer;
}): { query: string; matchingStrategy: "all" | "last" } {
  if (!input.tokenizer || !needsSharedTokenization(input.request.evidenceFamilies)) {
    return {
      query: input.request.query,
      matchingStrategy: input.request.matchingStrategy
    };
  }
  const blended = BLENDED_EVIDENCE_FAMILIES.every((family) =>
    input.request.evidenceFamilies.includes(family)
  );
  if (/\p{Script=Han}/u.test(input.request.query) && !blended) {
    return {
      query: input.request.query,
      matchingStrategy: blended ? "last" : input.request.matchingStrategy
    };
  }
  const plan = createSearchTermPlan({
    query: input.request.query,
    tokenizer: input.tokenizer,
    relaxed: input.request.relaxedTermCoverage === true
  });
  return {
    query: plan.executionQuery,
    matchingStrategy: plan.minimumShouldMatch === plan.informativeTerms.length
      ? "all"
      : "last"
  };
}

function needsSharedTokenization(
  families: SearchProviderQueryRequest["evidenceFamilies"]
): boolean {
  return families.some((family) => family !== "exact");
}
