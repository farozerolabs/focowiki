import { createHash } from "node:crypto";
import {
  buildOkfGeneratedMetadata,
  portableMarkdownHref,
  renderMarkdownIdentityLabel,
  renderOkfLog,
  type OkfLogEntry
} from "@focowiki/okf";
import {
  renderDirectoryLeafMarkdown,
  renderDirectoryRootMarkdown,
  directoryLeafPath,
  type PortableDirectoryLeaf
} from "./document-directory-navigation-renderer.js";

type NavigationLeaf = PortableDirectoryLeaf & Readonly<{
  revision: number;
  changedAt?: string;
}>;

export function renderDocumentRootPage(input: {
  path: "index.md" | "log.md";
  knowledgeBase: {
    id: string;
    name: string;
    description: string | null;
    sourceFileCount: number;
    graphEdgeCount: number;
    changedAt?: string;
  };
  rootEntryCount: number;
  limits?: {
    rootSummaryLimit: number;
    okfLogMaxEntries: number;
    okfLogMaxBytes: number;
  };
  logEntries?: readonly OkfLogEntry[];
  currentLogEntry?: OkfLogEntry;
}) {
  return page(input.path, rootKind(input.path), renderRoot(input));
}

export function renderDocumentDirectoryPages(input: {
  directoryPath: string;
  entryCount: number;
  leaves: readonly NavigationLeaf[];
  title?: string;
  rootEntryKind?: string;
  leafEntryKind?: string;
  leafMetadataType?: string;
  changedAt?: string;
}): Array<ReturnType<typeof page>> {
  validateLeaves(input.leaves);
  return [
    page(`${input.directoryPath}/index.md`, input.rootEntryKind ?? "directory",
      renderDirectoryRootMarkdown({
        directoryPath: input.directoryPath,
        entryCount: input.entryCount,
        firstLeafId: input.leaves[0]?.id ?? null,
        ...(input.title ? { title: input.title } : {})
      })),
    ...input.leaves.map((leaf) => page(
      directoryLeafPath(input.directoryPath, leaf.id),
      input.leafEntryKind ?? "directory_leaf",
      renderDirectoryLeafMarkdown({
        directoryPath: input.directoryPath,
        leaf,
        ...(input.changedAt ? { changedAt: input.changedAt } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.leafMetadataType
          ? { metadataType: input.leafMetadataType } : {})
      })
    ))
  ];
}

export function renderDocumentDirectoryMutationPages(input: {
  directoryPath: string;
  entryCount: number;
  firstLeafId: string | null;
  touchedLeaves: readonly NavigationLeaf[];
  title?: string;
  rootEntryKind?: string;
  leafEntryKind?: string;
  leafMetadataType?: string;
  changedAt?: string;
}): Array<ReturnType<typeof page>> {
  validateLeavesForMutation(input.touchedLeaves);
  return [
    page(`${input.directoryPath}/index.md`, input.rootEntryKind ?? "directory",
      renderDirectoryRootMarkdown({
        directoryPath: input.directoryPath,
        entryCount: input.entryCount,
        firstLeafId: input.firstLeafId,
        ...(input.title ? { title: input.title } : {})
      })),
    ...input.touchedLeaves.map((leaf) => page(
      directoryLeafPath(input.directoryPath, leaf.id),
      input.leafEntryKind ?? "directory_leaf",
      renderDirectoryLeafMarkdown({
        directoryPath: input.directoryPath,
        leaf,
        ...(input.changedAt ? { changedAt: input.changedAt } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.leafMetadataType
          ? { metadataType: input.leafMetadataType } : {})
      })
    ))
  ];
}

export function selectDocumentDirectoryRefreshLeaves(input: {
  leaves: readonly NavigationLeaf[];
  touchedLeafIds: readonly string[];
  refreshedEntryIds: readonly string[];
  maintenanceRebuild: boolean;
}): readonly NavigationLeaf[] {
  const selectedIds = new Set(input.touchedLeafIds);
  if (input.maintenanceRebuild) {
    const refreshedEntryIds = new Set(input.refreshedEntryIds);
    for (const leaf of input.leaves) {
      if (leaf.entries.some((entry) => refreshedEntryIds.has(entry.id))) {
        selectedIds.add(leaf.id);
      }
    }
  }
  return input.leaves.filter((leaf) => selectedIds.has(leaf.id));
}

function page(logicalPath: string, entryKind: string, content: string) {
  const bytes = Buffer.from(content, "utf8");
  return {
    logicalPath,
    normalizedPath: logicalPath.toLocaleLowerCase("en-US"),
    entryKind,
    sourceFilePublicId: null,
    sourceRevisionPublicId: null,
    bytes,
    byteCount: bytes.byteLength,
    checksumSha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function rootKind(path: string): string {
  if (path === "log.md") return "log";
  return "index";
}

function renderRoot(input: Parameters<typeof renderDocumentRootPage>[0]): string {
  const title = renderMarkdownIdentityLabel(input.knowledgeBase.name);
  const changedAt = input.knowledgeBase.changedAt;
  if (input.path === "index.md") {
    const metadata = buildOkfGeneratedMetadata({
      ownership: "focowiki",
      artifactKind: "bundle_root",
      metadata: {}
    });
    const description = input.knowledgeBase.description
      ? truncateText(input.knowledgeBase.description,
          input.limits?.rootSummaryLimit ?? Number.MAX_SAFE_INTEGER)
      : null;
    return markdown([
      "---", ...frontmatterLines(metadata), "---", `# ${title}`, "",
      ...(description ? [description, ""] : []),
      "## Explore", "",
      `- [Browse documents](${portableMarkdownHref("index.md", "pages/index.md")}) - ${input.rootEntryCount} top-level entries.`,
      `- [Relationship graph](${portableMarkdownHref("index.md", "_graph/index.md")}) - ${input.knowledgeBase.graphEdgeCount} accepted relationships.`,
      `- [Update history](${portableMarkdownHref("index.md", "log.md")})`,
      `- [Machine-readable indexes](${portableMarkdownHref("index.md", "_index/index.md")})`,
      ""
    ]);
  }
  if (input.path === "log.md") {
    const limits = input.limits ?? {
      rootSummaryLimit: 500,
      okfLogMaxEntries: 100,
      okfLogMaxBytes: 65_536
    };
    const current: OkfLogEntry = input.currentLogEntry ?? {
      occurredAt: changedAt ?? new Date(0).toISOString(),
      action: "Updated pages",
      message: `The bundle contains ${input.knowledgeBase.sourceFileCount} Markdown pages.`
    };
    return renderOkfLog({
      entries: [current, ...(input.logEntries ?? [])]
        .slice(0, limits.okfLogMaxEntries),
      limits: {
        maxEntries: limits.okfLogMaxEntries,
        maxBytes: limits.okfLogMaxBytes
      }
    });
  }
  throw navigationError("root_page_path_invalid");
}

function truncateText(value: string, maximumCharacters: number): string {
  const characters = [...value];
  return characters.length <= maximumCharacters
    ? value : `${characters.slice(0, maximumCharacters).join("")}…`;
}

function markdown(lines: string[]): string {
  return lines.join("\n");
}

function frontmatterLines(metadata: Record<string, unknown>): string[] {
  return Object.entries(metadata).flatMap(([key, value]) =>
    value === undefined ? [] : [`${key}: ${JSON.stringify(value)}`]);
}

function validateLeaves(values: readonly NavigationLeaf[]): void {
  const ids = new Set<string>();
  for (const [index, leaf] of values.entries()) {
    if (!leaf.id || ids.has(leaf.id)
      || leaf.previousLeafId !== (values[index - 1]?.id ?? null)
      || leaf.nextLeafId !== (values[index + 1]?.id ?? null)) {
      throw navigationError("leaf_chain_invalid");
    }
    ids.add(leaf.id);
  }
}

function validateLeavesForMutation(values: readonly NavigationLeaf[]): void {
  const ids = new Set<string>();
  for (const leaf of values) {
    if (!leaf.id || ids.has(leaf.id) || leaf.entries.length === 0) {
      throw navigationError("leaf_mutation_invalid");
    }
    ids.add(leaf.id);
  }
}

function navigationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document navigation error: ${code}`), { code });
}
