const SELECTIVE_EXACT_MATCH_MIN_CHARACTERS = 24;

export function isSelectiveExactMatch(input: {
  hasVisibleExactMatch: boolean;
  phrase: string;
}): boolean {
  return input.hasVisibleExactMatch
    && Array.from(input.phrase.trim()).length >= SELECTIVE_EXACT_MATCH_MIN_CHARACTERS;
}
