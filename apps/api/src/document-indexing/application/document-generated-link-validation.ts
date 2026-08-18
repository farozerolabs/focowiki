import { posix } from "node:path";

const INTERNAL_IDENTITY = /(?:document-job|source-revision|generated-page-candidate|object-registration|provider-index)/iu;

export function validateDocumentGeneratedLinks(input: {
  pages: readonly {
    logicalPath: string;
    bytes: Uint8Array;
    contentType: string;
    allowUnresolved?: boolean;
  }[];
  activeLogicalPaths: readonly string[];
}): void {
  if (input.pages.length > 10_000 || input.activeLogicalPaths.length > 100_000) {
    throw linkValidationError("input_limit_exceeded");
  }
  const available = new Set([
    ...input.activeLogicalPaths,
    ...input.pages.map((page) => page.logicalPath)
  ].map(normalizeLogicalPath));
  for (const page of input.pages) {
    if (!page.logicalPath || page.bytes.byteLength > 268_435_456) {
      throw linkValidationError("page_invalid");
    }
    if (!page.contentType.startsWith("text/markdown")) continue;
    const markdown = new TextDecoder("utf-8", { fatal: true }).decode(page.bytes);
    for (const destination of markdownDestinations(markdown)) {
      if (INTERNAL_IDENTITY.test(destination)) {
        throw linkValidationError("internal_identity_leaked", page.logicalPath);
      }
      let logicalPath: string | null;
      try {
        logicalPath = localLogicalPath(destination, page.logicalPath);
      } catch (error) {
        if (page.allowUnresolved) continue;
        throw error;
      }
      if (logicalPath && !available.has(logicalPath) && !page.allowUnresolved) {
        throw linkValidationError(
          "generated_link_unresolved",
          page.logicalPath,
          logicalPath
        );
      }
    }
  }
}

export function collectDocumentGeneratedLinkPaths(
  pages: readonly {
    logicalPath: string;
    bytes: Uint8Array;
    contentType: string;
    allowUnresolved?: boolean;
  }[]
): string[] {
  if (pages.length > 10_000) throw linkValidationError("input_limit_exceeded");
  const paths = new Set<string>();
  for (const page of pages) {
    if (!page.contentType.startsWith("text/markdown")) continue;
    const markdown = new TextDecoder("utf-8", { fatal: true }).decode(page.bytes);
    for (const destination of markdownDestinations(markdown)) {
      let logicalPath: string | null;
      try {
        logicalPath = localLogicalPath(destination, page.logicalPath);
      } catch (error) {
        if (page.allowUnresolved) continue;
        throw error;
      }
      if (logicalPath) paths.add(logicalPath);
    }
  }
  return [...paths].sort(compareText);
}

export function validateDocumentProgressiveNavigation(input: {
  pages: readonly {
    logicalPath: string;
    bytes: Uint8Array;
    contentType: string;
    allowUnresolved?: boolean;
  }[];
  activeLogicalPaths: readonly string[];
}): void {
  const available = new Set([
    ...input.activeLogicalPaths,
    ...input.pages.map((page) => page.logicalPath)
  ].map(normalizeLogicalPath));
  for (const page of input.pages) {
    if (!page.contentType.startsWith("text/markdown") || page.allowUnresolved) continue;
    const path = normalizeLogicalPath(page.logicalPath);
    const markdown = new TextDecoder("utf-8", { fatal: true }).decode(page.bytes);
    const targets = new Set(markdownDestinations(markdown).flatMap((destination) => {
      const target = localLogicalPath(destination, page.logicalPath);
      return target ? [target] : [];
    }));
    const required = requiredNavigationTargets(path, targets);
    for (const target of required) {
      if (!targets.has(target) || !available.has(target)) {
        throw linkValidationError("progressive_navigation_incomplete",
          page.logicalPath, target);
      }
    }
  }
}

function markdownDestinations(markdown: string): string[] {
  const destinations: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1]?.[0] ?? null;
    if (marker) {
      fence = fence === null ? marker : fence === marker ? null : fence;
      continue;
    }
    if (fence !== null) continue;
    for (const match of line.matchAll(/!?(?:\[[^\]\n]*\])\((<?[^\s)>]+>?)/gu)) {
      if (match[1]) destinations.push(match[1]);
    }
    const definition = line.match(/^ {0,3}\[[^\]\n]+\]:\s*(<?[^\s>]+>?)/u)?.[1];
    if (definition) destinations.push(definition);
  }
  return destinations;
}

function requiredNavigationTargets(
  path: string,
  targets: ReadonlySet<string>
): string[] {
  if (path === "index.md") {
    return ["pages/index.md", "_index/index.md", "_graph/index.md", "log.md"];
  }
  if (path === "_index/index.md") {
    return ["index.md", "pages/index.md", "_graph/index.md", "_index/catalog.json"];
  }
  if (path === "_graph/index.md") {
    return ["index.md", "pages/index.md", "_index/index.md", "_graph/catalog.json"];
  }
  if (!/(?:^|\/)index(?:-[^/]+)?\.md$/u.test(path)) return [];
  const directoryPath = posix.dirname(path);
  const required = [
    "index.md", "pages/index.md", "_index/index.md", "_graph/index.md"
  ];
  if (posix.basename(path) !== "index.md") {
    required.push(`${directoryPath}/index.md`);
  } else {
    required.push(directoryPath === "pages" || directoryPath === "_index"
      || directoryPath === "_graph"
      ? "index.md" : `${posix.dirname(directoryPath)}/index.md`);
    if ([...targets].some((target) =>
      posix.dirname(target) === directoryPath
        && /^index-[^/]+\.md$/u.test(posix.basename(target)))) {
      required.push([...targets].find((target) =>
        posix.dirname(target) === directoryPath
          && /^index-[^/]+\.md$/u.test(posix.basename(target)))!);
    }
  }
  return [...new Set(required.map(normalizeLogicalPath))];
}

function localLogicalPath(destination: string, sourcePath: string): string | null {
  const raw = destination.replace(/^<|>$/gu, "");
  if (raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(raw)
    || raw.startsWith("#")) return null;
  const destinationPath = raw.split(/[?#]/u, 1)[0] ?? "";
  const value = destinationPath.startsWith("/")
    ? destinationPath.slice(1)
    : posix.normalize(posix.join(posix.dirname(sourcePath), destinationPath));
  if (!value) return null;
  if (value === ".." || value.startsWith("../") || value.startsWith("/")) {
    throw linkValidationError("generated_link_invalid", sourcePath);
  }
  try {
    return normalizeLogicalPath(decodeURIComponent(value));
  } catch {
    throw linkValidationError("generated_link_invalid");
  }
}

function normalizeLogicalPath(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function linkValidationError(
  code: string,
  resourcePath?: string,
  targetPath?: string
): Error & { code: string; resourcePath?: string; targetPath?: string } {
  return Object.assign(new Error(`Generated link validation error: ${code}`), {
    code,
    ...(resourcePath ? { resourcePath } : {}),
    ...(targetPath ? { targetPath } : {})
  });
}
