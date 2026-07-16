const MAX_SEARCH_QUERY_TERMS = 8;
const MIN_SPLIT_TERM_LENGTH = 2;

export function createSearchQueryTerms(value: string): string[] {
  const normalized = value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  const splitTerms = [...new Set(normalized.split(" ").filter(Boolean))];
  const meaningfulTerms = splitTerms.filter(
    (term) => Array.from(term).length >= MIN_SPLIT_TERM_LENGTH
  );
  const terms = meaningfulTerms.length > 0 ? meaningfulTerms : [normalized];

  return terms.slice(0, MAX_SEARCH_QUERY_TERMS);
}
