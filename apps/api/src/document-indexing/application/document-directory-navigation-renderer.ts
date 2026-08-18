import {
  portableMarkdownHref,
  renderMarkdownIdentityLabel
} from "@focowiki/okf";
import type { OrderedDirectoryEntry } from
  "../domain/document-directory-leaves.js";

export type PortableDirectoryLeaf = Readonly<{
  id: string;
  previousLeafId: string | null;
  nextLeafId: string | null;
  entries: readonly OrderedDirectoryEntry[];
}>;

export function renderDirectoryRootMarkdown(input: {
  directoryPath: string;
  entryCount: number;
  firstLeafId: string | null;
  title?: string;
}): string {
  const title = input.title ?? directoryTitle(input.directoryPath);
  const parent = parentDirectoryIndex(input.directoryPath);
  const currentPath = `${input.directoryPath}/index.md`;
  return [
    `# ${renderMarkdownIdentityLabel(title)}`,
    "",
    `[Parent directory](${portableMarkdownHref(currentPath, parent)})`,
    "",
    globalNavigation(currentPath),
    "",
    ...supplementalDirectoryLinks(input.directoryPath, currentPath),
    input.firstLeafId
      ? `[Browse entries](${portableMarkdownHref(currentPath,
        directoryLeafPath(input.directoryPath, input.firstLeafId))})`
      : "This directory has no published Markdown files.",
    ""
  ].join("\n");
}

function supplementalDirectoryLinks(
  directoryPath: string,
  currentPath: string
): string[] {
  if (directoryPath === "_index") {
    return [`[Index catalog](${portableMarkdownHref(
      currentPath, "_index/catalog.json")})`, ""];
  }
  if (directoryPath === "_graph") {
    return [`[Relationship catalog](${portableMarkdownHref(
      currentPath, "_graph/catalog.json")})`, ""];
  }
  return [];
}

export function renderDirectoryLeafMarkdown(input: {
  directoryPath: string;
  leaf: PortableDirectoryLeaf;
  changedAt?: string;
  title?: string;
  metadataType?: string;
}): string {
  const currentPath = directoryLeafPath(input.directoryPath, input.leaf.id);
  const navigation = [
    `[Directory index](${portableMarkdownHref(currentPath,
      `${input.directoryPath}/index.md`)})`,
    input.leaf.previousLeafId
      ? `[Previous](${portableMarkdownHref(currentPath,
        directoryLeafPath(input.directoryPath, input.leaf.previousLeafId))})`
      : null,
    input.leaf.nextLeafId
      ? `[Next](${portableMarkdownHref(currentPath,
        directoryLeafPath(input.directoryPath, input.leaf.nextLeafId))})`
      : null
  ].filter((value): value is string => Boolean(value)).join(" · ");
  const entries = input.leaf.entries.map((entry) =>
    `- [${renderMarkdownIdentityLabel(entry.name)}](${portableMarkdownHref(
      currentPath, entry.targetPath)})`
  );
  const pageTitle = `${input.title ?? directoryTitle(input.directoryPath)} entries`;
  return [
    "---",
    "type: navigation",
    `title: ${JSON.stringify(pageTitle)}`,
    "navigation_only: true",
    "---",
    `# ${renderMarkdownIdentityLabel(pageTitle)}`,
    "",
    navigation,
    "",
    globalNavigation(currentPath),
    "",
    ...entries,
    ""
  ].join("\n");
}

function globalNavigation(currentPath: string): string {
  return [
    `[Knowledge base](${portableMarkdownHref(currentPath, "index.md")})`,
    `[Documents](${portableMarkdownHref(currentPath, "pages/index.md")})`,
    `[Machine-readable indexes](${portableMarkdownHref(
      currentPath, "_index/index.md")})`,
    `[Relationship graph](${portableMarkdownHref(currentPath, "_graph/index.md")})`
  ].join(" · ");
}

export function directoryLeafPath(directoryPath: string, leafId: string): string {
  return `${directoryPath}/index-${encodeURIComponent(leafId)}.md`;
}

function directoryTitle(directoryPath: string): string {
  return directoryPath === "pages" ? "Documents"
    : directoryPath.split("/").at(-1) ?? "Documents";
}

function parentDirectoryIndex(directoryPath: string): string {
  if (directoryPath === "pages" || directoryPath === "_index"
    || directoryPath === "_graph") return "index.md";
  const segments = directoryPath.split("/");
  segments.pop();
  return segments.length === 0 ? "index.md" : `${segments.join("/")}/index.md`;
}
