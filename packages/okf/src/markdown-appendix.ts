export type PreparedGeneratedMarkdownBody = {
  content: string;
  trailingCitations: string | null;
};

export function prepareGeneratedMarkdownBody(body: string): PreparedGeneratedMarkdownBody {
  let lines = body.trimEnd().split(/\r?\n/);
  let trailingCitations: string | null = null;

  const citationsStart = findTrailingHeading(lines, "citations");

  if (citationsStart !== null) {
    trailingCitations = lines.slice(citationsStart).join("\n").trimEnd();
    lines = lines.slice(0, citationsStart);
  }

  const relatedStart = findTrailingHeading(lines, "related");

  if (relatedStart !== null) {
    lines = lines.slice(0, relatedStart);
  }

  return {
    content: lines.join("\n").trimEnd(),
    trailingCitations
  };
}

function findTrailingHeading(lines: string[], expectedTitle: string): number | null {
  const headingStart = findLastMarkdownHeading(lines);

  if (headingStart === null) {
    return null;
  }

  const title = readHeadingTitle(lines[headingStart]);
  return title === expectedTitle ? headingStart : null;
}

function findLastMarkdownHeading(lines: string[]): number | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (readHeadingTitle(lines[index])) {
      return index;
    }
  }

  return null;
}

function readHeadingTitle(line: string | undefined): string | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line?.trim() ?? "");
  return match?.[2]?.trim().toLowerCase() || null;
}
