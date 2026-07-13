export type GeneratedCitationValidationIssue = {
  line: number;
  message: string;
};

export function validateGeneratedCitationSection(
  markdown: string
): GeneratedCitationValidationIssue[] {
  const lines = markdown.split("\n");
  const headingIndexes = lines
    .map((line, index) => line.trim() === "# Citations" ? index : -1)
    .filter((index) => index >= 0);
  if (headingIndexes.length === 0) return [];

  const issues: GeneratedCitationValidationIssue[] = [];
  if (headingIndexes.length > 1) {
    issues.push({ line: headingIndexes[1]! + 1, message: "Generated Markdown has duplicate citation sections." });
  }
  const start = headingIndexes[0]!;
  let expected = 1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    const match = line.match(/^\[(\d+)\] \[[^\]]+\]\([^)]+\)$/u);
    if (!match || Number(match[1]) !== expected) {
      issues.push({
        line: index + 1,
        message: `Generated citation entry must use consecutive number ${expected}.`
      });
      continue;
    }
    expected += 1;
  }
  return issues;
}
