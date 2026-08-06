const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/u;
const INLINE_LINK_PATTERN = /!?\[([^\]\n]*)\]\((<?[^\s)]+>?)([^\n)]*)\)/gu;
const REFERENCE_DEFINITION_PATTERN =
  /^( {0,3}\[([^\]\n]+)\]:\s*)(<?[^>\s]+>?)(.*)$/u;
const FULL_REFERENCE_LINK_PATTERN = /!?\[([^\]\n]*)\]\[([^\]\n]*)\]/gu;
const SHORTCUT_REFERENCE_LINK_PATTERN = /!?\[([^\]\n]+)\](?![\[(])/gu;

export function removeDeletedSourceMarkdownLinks(
  markdown: string,
  removedSourceLogicalPaths: readonly string[]
): string {
  if (removedSourceLogicalPaths.length === 0) return markdown;
  const removed = new Set(removedSourceLogicalPaths);
  const removedReferenceLabels = collectRemovedReferenceLabels(markdown, removed);
  let activeFence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const fence = line.match(FENCE_PATTERN)?.[1] ?? null;
      if (fence) {
        if (!activeFence) activeFence = fence[0] ?? null;
        else if (fence[0] === activeFence) activeFence = null;
        return line;
      }
      if (activeFence) return line;
      const definition = line.match(REFERENCE_DEFINITION_PATTERN);
      if (
        definition
        && removedReferenceLabels.has(normalizeReferenceLabel(definition[2] ?? ""))
      ) return "";
      return replaceOutsideInlineCode(line, (segment) => {
        const withoutInlineLinks = segment.replace(
          INLINE_LINK_PATTERN,
          (match, label: string, destination: string) =>
            removed.has(generatedPath(destination)) ? label : match
        );
        const withoutFullReferences = withoutInlineLinks.replace(
          FULL_REFERENCE_LINK_PATTERN,
          (match, label: string, reference: string) =>
            removedReferenceLabels.has(normalizeReferenceLabel(reference || label))
              ? label
              : match
        );
        return withoutFullReferences.replace(
          SHORTCUT_REFERENCE_LINK_PATTERN,
          (match, label: string) =>
            removedReferenceLabels.has(normalizeReferenceLabel(label)) ? label : match
        );
      });
    })
    .join("\n");
}

function collectRemovedReferenceLabels(
  markdown: string,
  removedSourceLogicalPaths: ReadonlySet<string>
): Set<string> {
  const labels = new Set<string>();
  let activeFence: string | null = null;
  for (const line of markdown.split("\n")) {
    const fence = line.match(FENCE_PATTERN)?.[1] ?? null;
    if (fence) {
      if (!activeFence) activeFence = fence[0] ?? null;
      else if (fence[0] === activeFence) activeFence = null;
      continue;
    }
    if (activeFence) continue;
    const definition = line.match(REFERENCE_DEFINITION_PATTERN);
    if (
      definition
      && removedSourceLogicalPaths.has(generatedPath(definition[3] ?? ""))
    ) labels.add(normalizeReferenceLabel(definition[2] ?? ""));
  }
  return labels;
}

function normalizeReferenceLabel(label: string): string {
  return label.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function generatedPath(destination: string): string {
  const unwrapped = destination.startsWith("<") && destination.endsWith(">")
    ? destination.slice(1, -1)
    : destination;
  const path = unwrapped.split(/[?#]/u, 1)[0] ?? "";
  try {
    const decoded = decodeURIComponent(path);
    return decoded.startsWith("/") ? decoded.slice(1) : decoded;
  } catch {
    return "";
  }
}

function replaceOutsideInlineCode(
  line: string,
  replace: (segment: string) => string
): string {
  let output = "";
  let offset = 0;
  let codeDelimiter: string | null = null;
  while (offset < line.length) {
    const tickStart = line.indexOf("`", offset);
    if (tickStart < 0) {
      const remainder = line.slice(offset);
      return output + (codeDelimiter ? remainder : replace(remainder));
    }
    let tickEnd = tickStart + 1;
    while (line[tickEnd] === "`") tickEnd += 1;
    const delimiter = line.slice(tickStart, tickEnd);
    const text = line.slice(offset, tickStart);
    output += codeDelimiter ? text : replace(text);
    output += delimiter;
    if (!codeDelimiter) codeDelimiter = delimiter;
    else if (codeDelimiter === delimiter) codeDelimiter = null;
    offset = tickEnd;
  }
  return output;
}
