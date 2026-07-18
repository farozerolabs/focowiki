export type GeneratedFileSearchScope = "all" | "path" | "metadata";

const MAX_QUERY_LENGTH = 4_000;

export function normalizeGeneratedFileSearchQuery(value: string): string {
  return value
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US")
    .slice(0, MAX_QUERY_LENGTH);
}
