import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import type { SearchProviderQueryRequest } from
  "../../application/ports/search-provider-runtime.js";

const MAXIMUM_TOKENIZER_TERMS = 64;
const MAXIMUM_EXECUTION_TERMS = 32;
const MAXIMUM_HAN_CODE_POINTS = 64;
const MAXIMUM_OTHER_CODE_POINTS = 128;
const BLENDED_EVIDENCE_FAMILIES = [
  "exact", "text", "phrase", "typo", "jieba", "graph"
] as const;
const QUERY_INTENT_TERMS = new Set([
  "a", "about", "an", "and", "are", "be", "been", "being", "define",
  "defined", "defines", "describe", "described", "describes", "did", "do",
  "does", "document", "documents", "explain", "explained", "explains",
  "file", "files", "find", "for", "from", "how", "in", "is", "must", "of",
  "often", "on", "or", "show", "shows", "source", "sources", "the", "to",
  "was", "were",
  "what", "when", "where", "which", "who", "why", "with",
  "为什么", "为何", "什么", "哪些", "如何", "怎么", "怎样", "是否",
  "文件", "文档", "内容", "主要", "属于", "类别", "相关", "对应", "哪个",
  "几年", "一次"
]);

export function normalizeMeilisearchQuery(input: {
  request: Pick<
    SearchProviderQueryRequest,
    "query" | "evidenceFamilies" | "matchingStrategy"
  >;
  tokenizer?: LexicalTokenizer;
}): { query: string; matchingStrategy: "all" | "last" } {
  if (!input.tokenizer || !needsSharedTokenization(input.request.evidenceFamilies)) {
    return {
      query: input.request.query,
      matchingStrategy: input.request.matchingStrategy
    };
  }
  const terms = removeNegatedHanBaseTerms(
    input.request.query,
    tokenize(input.tokenizer, input.request.query)
  );
  const withoutSubsumedNumbers = terms.filter((term) =>
    !/^\p{N}+$/u.test(term)
    || !terms.some((candidate) => candidate !== term
      && /\p{L}/u.test(candidate) && candidate.includes(term))
  );
  const meaningful = withoutSubsumedNumbers.filter((term) =>
    !QUERY_INTENT_TERMS.has(term)
  );
  const executionTerms = meaningful.length > 0
    ? meaningful
    : withoutSubsumedNumbers;
  const query = boundExecutionTerms(executionTerms, input.request.query);
  const blended = BLENDED_EVIDENCE_FAMILIES.every((family) =>
    input.request.evidenceFamilies.includes(family)
  );
  return {
    query,
    matchingStrategy: blended ? "last" : input.request.matchingStrategy
  };
}

function needsSharedTokenization(
  families: SearchProviderQueryRequest["evidenceFamilies"]
): boolean {
  return families.some((family) => family !== "exact");
}

function removeNegatedHanBaseTerms(
  query: string,
  terms: readonly string[]
): string[] {
  if (!query.normalize("NFKC").includes("不存在")) return [...terms];
  return terms.filter((term) => term !== "存在");
}

function tokenize(tokenizer: LexicalTokenizer, query: string): string[] {
  let terms: string[];
  try {
    terms = tokenizer.tokenizeQuery(query, MAXIMUM_TOKENIZER_TERMS);
  } catch {
    throw new Error("Meilisearch query tokenization failed");
  }
  if (
    terms.length > MAXIMUM_TOKENIZER_TERMS
    || terms.some((term) => !term || /\s/u.test(term))
  ) throw new Error("Meilisearch query tokenization failed");
  return [...new Set(terms)];
}

function boundExecutionTerms(terms: readonly string[], fallback: string): string {
  const maximumCodePoints = /\p{Script=Han}/u.test(fallback)
    ? MAXIMUM_HAN_CODE_POINTS
    : MAXIMUM_OTHER_CODE_POINTS;
  const output: string[] = [];
  let codePoints = 0;
  for (const sourceTerm of terms) {
    if (output.length >= MAXIMUM_EXECUTION_TERMS) break;
    const remaining = maximumCodePoints - codePoints;
    if (remaining <= 0) break;
    const term = Array.from(sourceTerm).slice(0, remaining).join("");
    if (!term) continue;
    output.push(term);
    codePoints += Array.from(term).length;
  }
  return output.join(" ") || fallback;
}
