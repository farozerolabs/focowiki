export function normalizeMarkdownBody(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function normalizeSearchPhrase(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\u3000，,；;、。！？!?：:]+/gu, ",")
    .replace(/\s+/gu, " ")
    .replace(/\s*,\s*/gu, ",")
    .replace(/^,+|,+$/gu, "")
    .trim();
}

export function extractSubstantiveMarkdownBody(value: string): string {
  return normalizeMarkdownBody(value);
}

export function parseHeading(
  line: string
): { level: number; title: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line.trim());
  if (!match) return null;
  return {
    level: match[1]!.length,
    title: match[2]!.trim()
  };
}
