export function normalizeGeneratedFileContent(path: string, content: string): string {
  if (!path.toLowerCase().endsWith(".md")) {
    return content;
  }

  return `${content.trimEnd()}\n`;
}
