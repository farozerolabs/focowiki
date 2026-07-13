import { normalizeSourceRelativePath } from "./source-path.js";

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/u;
const REFERENCE_DEFINITION_PATTERN = /^( {0,3}\[[^\]\n]+\]:\s*)(<?[^>\s]+>?)(.*)$/u;
const INLINE_LINK_PATTERN = /(!?\[[^\]\n]*\]\()([^\s)]+)([^\n)]*\))/gu;

export function rewriteSourceMarkdownLinks(
  markdown: string,
  sourceRelativePath: string
): string {
  const source = normalizeSourceRelativePath(sourceRelativePath);
  const sourceDirectory = source.relativePath.includes("/")
    ? source.relativePath.slice(0, source.relativePath.lastIndexOf("/"))
    : "";
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
      if (definition) {
        const destination = definition[2] ?? "";
        return `${definition[1] ?? ""}${rewriteDestination(destination, sourceDirectory)}${definition[3] ?? ""}`;
      }

      return rewriteOutsideInlineCode(line, (segment) =>
        segment.replace(
          INLINE_LINK_PATTERN,
          (_match, prefix: string, destination: string, suffix: string) =>
            `${prefix}${rewriteDestination(destination, sourceDirectory)}${suffix}`
        )
      );
    })
    .join("\n");
}

export function resolveSourceMarkdownLinkDestination(
  destination: string,
  sourceRelativePath: string
): string {
  const source = normalizeSourceRelativePath(sourceRelativePath);
  const sourceDirectory = source.relativePath.includes("/")
    ? source.relativePath.slice(0, source.relativePath.lastIndexOf("/"))
    : "";

  return rewriteDestination(destination, sourceDirectory);
}

function rewriteOutsideInlineCode(
  line: string,
  rewrite: (segment: string) => string
): string {
  let output = "";
  let offset = 0;
  let codeDelimiter: string | null = null;

  while (offset < line.length) {
    const tickStart = line.indexOf("`", offset);
    if (tickStart < 0) {
      const remainder = line.slice(offset);
      return output + (codeDelimiter ? remainder : rewrite(remainder));
    }
    let tickEnd = tickStart + 1;
    while (line[tickEnd] === "`") tickEnd += 1;
    const delimiter = line.slice(tickStart, tickEnd);
    const text = line.slice(offset, tickStart);
    output += codeDelimiter ? text : rewrite(text);
    output += delimiter;
    if (!codeDelimiter) codeDelimiter = delimiter;
    else if (codeDelimiter === delimiter) codeDelimiter = null;
    offset = tickEnd;
  }
  return output;
}

function rewriteDestination(destination: string, sourceDirectory: string): string {
  const wrapped = destination.startsWith("<") && destination.endsWith(">");
  const raw = wrapped ? destination.slice(1, -1) : destination;
  const rewritten = rewriteLocalMarkdownPath(raw, sourceDirectory);
  return wrapped ? `<${rewritten}>` : rewritten;
}

function rewriteLocalMarkdownPath(value: string, sourceDirectory: string): string {
  if (!value || value.startsWith("#") || hasUriScheme(value)) return value;
  const splitAt = firstSuffixIndex(value);
  const rawPath = splitAt < 0 ? value : value.slice(0, splitAt);
  const suffix = splitAt < 0 ? "" : value.slice(splitAt);
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return value;
  }
  if (decodedPath.startsWith("/pages/")) return value;

  const sourcePath = decodedPath.startsWith("/")
    ? decodedPath.slice(1)
    : joinRelativePath(sourceDirectory, decodedPath);
  if (!sourcePath || !sourcePath.toLowerCase().endsWith(".md")) return value;

  try {
    const normalized = normalizeSourceRelativePath(sourcePath);
    const target = normalized.relativePath
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    return `/pages/${target}${suffix}`;
  } catch {
    return value;
  }
}

function joinRelativePath(base: string, relative: string): string {
  const segments = base ? base.split("/") : [];
  for (const segment of relative.replace(/^\.\//u, "").split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      if (segments.length === 0) return "";
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function hasUriScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith("//");
}

function firstSuffixIndex(value: string): number {
  const query = value.indexOf("?");
  const fragment = value.indexOf("#");
  if (query < 0) return fragment;
  if (fragment < 0) return query;
  return Math.min(query, fragment);
}
