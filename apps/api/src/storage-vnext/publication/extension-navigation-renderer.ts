import {
  renderMarkdownIdentityLabel,
  toBundleMarkdownHref
} from "@focowiki/okf";
import type { PersistentDirectoryLeaf } from
  "../../application/ports/directory-navigation-repository.js";

const GLOBAL_NAVIGATION = [
  ["Knowledge base", "index.md"],
  ["Documents", "pages/index.md"],
  ["Machine-readable indexes", "_index/index.md"],
  ["Relationship graph", "_graph/index.md"]
] as const;

export function renderExtensionLandingMarkdown(input: {
  rootPath: "_index" | "_graph";
  families: readonly { label: string; path: string }[];
}): string {
  const machineIndex = input.rootPath === "_index";
  const title = machineIndex ? "Machine-readable indexes" : "Relationship graph";
  const fixed = machineIndex
    ? [`[Projection catalog](${toBundleMarkdownHref("_index/catalog.json")})`]
    : [`[Machine-readable graph catalog](${toBundleMarkdownHref("_index/catalog.json")})`];
  return [
    `# ${title}`,
    "",
    ...fixed.map((link) => `- ${link}`),
    ...input.families.map((family) =>
      `- [${renderMarkdownIdentityLabel(family.label)}](${toBundleMarkdownHref(family.path)})`),
    `- [Browse source-backed files](${toBundleMarkdownHref("pages/index.md")})`,
    `- [Knowledge base](${toBundleMarkdownHref("index.md")})`,
    machineIndex
      ? `- [Relationship graph](${toBundleMarkdownHref("_graph/index.md")})`
      : `- [Machine-readable indexes](${toBundleMarkdownHref("_index/index.md")})`,
    ...(!machineIndex ? [
      "",
      "Use the graph navigation to discover related source-backed files.",
      "Relationships are navigation hints; open the linked source Markdown files to verify context and evidence."
    ] : []),
    ""
  ].join("\n");
}

export function renderExtensionFamilyMarkdown(input: {
  directoryPath: string;
  versionPath: string;
}): string {
  const title = extensionTitle(input.directoryPath);
  return navigationMarkdown({
    type: "extension-family-index",
    title: `${title} index`,
    heading: title,
    navigation: [
      `[Parent directory](${toBundleMarkdownHref(parentIndexPath(input.directoryPath))})`,
      `[Version 1](${toBundleMarkdownHref(`${input.versionPath}/index.md`)})`
    ]
  });
}

export function renderExtensionResourceRootMarkdown(input: {
  directoryPath: string;
  entryCount: number;
  firstLeafId: string | null;
}): string {
  const title = extensionTitle(input.directoryPath);
  return navigationMarkdown({
    type: "extension-resource-index",
    title: `${title} resources`,
    heading: `${title} resources`,
    entryCount: input.entryCount,
    navigation: [
      `[Parent directory](${toBundleMarkdownHref(parentIndexPath(input.directoryPath))})`,
      input.firstLeafId
        ? `[Browse entries](${toBundleMarkdownHref(extensionLeafPath(
          input.directoryPath,
          input.firstLeafId
        ))})`
        : "This resource directory is empty."
    ]
  });
}

export function renderExtensionLeafMarkdown(input: {
  directoryPath: string;
  leaf: PersistentDirectoryLeaf;
}): string {
  const title = extensionTitle(input.directoryPath);
  const navigation = [
    `[Directory index](${toBundleMarkdownHref(`${input.directoryPath}/index.md`)})`,
    input.leaf.previousLeafId
      ? `[Previous](${toBundleMarkdownHref(extensionLeafPath(
        input.directoryPath,
        input.leaf.previousLeafId
      ))})`
      : null,
    input.leaf.nextLeafId
      ? `[Next](${toBundleMarkdownHref(extensionLeafPath(
        input.directoryPath,
        input.leaf.nextLeafId
      ))})`
      : null
  ].filter((value): value is string => Boolean(value));
  const entries = input.leaf.entries.map((entry) => {
    const resource = `[${renderMarkdownIdentityLabel(entry.name)}](${toBundleMarkdownHref(
      entry.targetPath
    )})`;
    return entry.evidencePath
      ? `- ${resource} · [Source](${toBundleMarkdownHref(entry.evidencePath)})`
      : `- ${resource}`;
  });
  return navigationMarkdown({
    type: "extension-resource-index-page",
    title: `${title} resources`,
    heading: `${title} resources`,
    leafId: input.leaf.id,
    entryCount: input.leaf.entries.length,
    navigation,
    entries
  });
}

export function extensionLeafPath(directoryPath: string, leafId: string): string {
  return `${directoryPath}/index-${encodeURIComponent(leafId)}.md`;
}

function navigationMarkdown(input: {
  type: string;
  title: string;
  heading: string;
  leafId?: string;
  entryCount?: number;
  navigation: readonly string[];
  entries?: readonly string[];
}): string {
  return [
    "---",
    `type: ${JSON.stringify(input.type)}`,
    `title: ${JSON.stringify(input.title)}`,
    "navigation_only: true",
    ...(input.leafId ? [`leaf_id: ${JSON.stringify(input.leafId)}`] : []),
    ...(input.entryCount === undefined ? [] : [`entry_count: ${input.entryCount}`]),
    "---",
    `# ${renderMarkdownIdentityLabel(input.heading)}`,
    "",
    input.navigation.join(" · "),
    "",
    globalNavigation(),
    "",
    ...(input.entries ?? []),
    ""
  ].join("\n");
}

function globalNavigation(): string {
  return GLOBAL_NAVIGATION.map(([label, path]) =>
    `[${label}](${toBundleMarkdownHref(path)})`).join(" · ");
}

function parentIndexPath(directoryPath: string): string {
  const segments = directoryPath.split("/");
  segments.pop();
  return `${segments.join("/")}/index.md`;
}

function extensionTitle(directoryPath: string): string {
  const name = directoryPath.split("/").at(-1) ?? "Resources";
  return name === "v1"
    ? `${directoryPath.split("/").at(-2) ?? "Resources"} v1`
    : name;
}
