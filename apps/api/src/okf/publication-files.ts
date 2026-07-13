import {
  buildSearchIndex,
  applyPresentationSuggestions,
  bundleSchemaDescriptor,
  schemaReferenceDescriptor,
  DEFAULT_OKF_LOG_LIMITS,
  generatedConceptFrontmatter,
  knowledgeBaseTitle,
  prepareGeneratedMarkdownBody,
  rewriteSourceMarkdownLinks,
  renderOkfLog,
  renderGeneratedCitations,
  toBundleMarkdownHref,
  updateHistoryPageDescriptor,
  type IndexMetadata,
  type OkfLogEntry,
  type OkfLogLimits,
  type OkfLogMonthlySummary,
  type OkfGraphRelationship,
  type SourceMetadata,
  type SourceModelSuggestions
} from "@focowiki/okf";

export type BundleFileKind =
  | "page"
  | "index"
  | "log"
  | "history_page"
  | "schema"
  | "directory_index"
  | "directory_index_page"
  | "directory_index_map"
  | "index_catalog"
  | "manifest_index"
  | "manifest_index_shard"
  | "search_index"
  | "search_index_shard"
  | "link_index"
  | "link_index_shard"
  | "change_index"
  | "change_index_shard"
  | "graph_index"
  | "graph_manifest"
  | "graph_node_index"
  | "graph_edge_shard"
  | "graph_file"
  | "graph_community"
  | "graph_insight";

export type GeneratedPageSummary = {
  pagePath: string;
  fileId: string;
  graphRef?: string;
  metadata: SourceMetadata;
  suggestions: SourceModelSuggestions | null;
  graphLinks?: OkfGraphRelationship[];
};

export type GeneratedOkfFile = {
  logicalPath: string;
  sourceFileId: string | null;
  fileKind: BundleFileKind;
  content: string;
  metadata: SourceMetadata | null;
};

export type ManifestFileEntry = {
  path: string;
  content_type: string;
  title?: string;
  metadata?: IndexMetadata;
};

export type SearchIndexItem = ReturnType<typeof buildSearchIndex>["items"][number];

export type LinkIndexEntry = {
  from: string;
  to: string;
  label: string;
};

export type JsonCollectionShardDescriptor = {
  path: string;
  count: number;
};

export type PublicationLogHistory = {
  entries: OkfLogEntry[];
  summaries: OkfLogMonthlySummary[];
};

export type PublicationChangeSummary = {
  created: number;
  updated: number;
  moved: number;
  deleted: number;
  affectedDirectories: Array<{ path: string; changedFileCount: number }>;
};

export { applyPresentationSuggestions };

export function renderPageFile(
  page: GeneratedPageSummary,
  body: string
): string {
  const prepared = prepareGeneratedMarkdownBody(body);
  const rewrittenBody = rewriteSourceMarkdownLinks(
    prepared.content,
    page.pagePath.replace(/^pages\//u, "")
  );
  return renderConceptFile(
    page.metadata,
    [
      rewrittenBody,
      "",
      ...renderRelatedLinks(page.graphLinks ?? []),
      ...(prepared.trailingCitations
        ? ["", prepared.trailingCitations]
        : renderCitations(page.metadata))
    ].join("\n")
  );
}

export function renderIndexFile(
  _pages: GeneratedPageSummary[],
  generatedAt: string,
  title: string,
  options: { includeGraph?: boolean; description?: string | null } = {}
): GeneratedOkfFile {
  const schema = bundleSchemaDescriptor(title);
  return {
    logicalPath: "index.md",
    sourceFileId: null,
    fileKind: "index",
    metadata: null,
    content: [
      "---",
      'okf_version: "0.1"',
      "---",
      `# ${knowledgeBaseTitle(title)}`,
      "",
      ...(options.description ? [options.description, ""] : []),
      `Generated at: ${generatedAt}`,
      "",
      "## Explore",
      "",
      "- [Browse documents](/pages/index.md) - Explore source-backed Markdown files by directory.",
      ...(options.includeGraph
        ? ["- [Relationship graph](/_graph/index.md) - Follow relationships between source-backed files."]
        : []),
      `- [${schema.title}](/${schema.path}) - Review concept metadata and navigation conventions.`,
      "- [Update history](/log.md) - Review bounded publication history.",
      "- [Machine-readable indexes](/_index/index.md) - Access generated manifests, search records, links, and changes."
    ].join("\n")
  };
}

export function renderLogFile(
  pages: GeneratedPageSummary[],
  totalPageCount: number,
  generatedAt: string,
  limits: OkfLogLimits,
  history: PublicationLogHistory,
  changes: PublicationChangeSummary
): GeneratedOkfFile {
  return renderLogFiles(pages, totalPageCount, generatedAt, limits, history, changes)[0]!;
}

export function renderLogFiles(
  pages: GeneratedPageSummary[],
  totalPageCount: number,
  generatedAt: string,
  limits: OkfLogLimits,
  history: PublicationLogHistory,
  changes: PublicationChangeSummary
): GeneratedOkfFile[] {
  const samples = pages.slice(0, 8);
  const currentPagePaths = new Set(pages.map((page) => page.pagePath));
  const directoryLinks = changes.affectedDirectories
    .filter((directory) =>
      Array.from(currentPagePaths).some((path) => path.startsWith(`${directory.path}/`))
    )
    .slice(0, 8)
    .map((directory) => ({
      path: `${directory.path}/index.md`,
      title: `${directory.path} (${directory.changedFileCount})`
    }));
  const currentEntries: OkfLogEntry[] = [
    {
      occurredAt: generatedAt,
      action: "Publication",
      message: [
        `Published ${totalPageCount} Markdown pages.`,
        `Created ${changes.created}, updated ${changes.updated}, moved ${changes.moved}, and deleted ${changes.deleted}.`
      ].join(" "),
      changedFileCount: changes.created + changes.updated + changes.moved + changes.deleted,
      links: directoryLinks.length > 0
        ? directoryLinks
        : samples.map((page) => ({
            path: page.pagePath,
            title: page.metadata.title
          }))
    }
  ];

  const historyPages = partitionLogEntries(history.entries, limits).map((entries, index, all) => {
    const page = index + 1;
    const descriptor = updateHistoryPageDescriptor(page);
    const metadata = {
      ...generatedConceptFrontmatter(descriptor),
      navigation_only: true
    };
    const navigation = [
      "[Update history root](/log.md)",
      index > 0 ? `[Previous page](/log-${String(page - 1).padStart(6, "0")}.md)` : null,
      index + 1 < all.length
        ? `[Next page](/log-${String(page + 1).padStart(6, "0")}.md)`
        : null
    ].filter((value): value is string => Boolean(value));
    return {
      logicalPath: descriptor.path,
      sourceFileId: null,
      fileKind: "history_page" as const,
      metadata,
      content: renderConceptFile(
        metadata,
        [
          `# ${descriptor.heading}`,
          "",
          navigation.join(" · "),
          "",
          stripLogHeading(renderOkfLog({
            entries,
            summaries: [],
            limits: { maxEntries: entries.length, maxBytes: limits.maxBytes }
          }))
        ].join("\n")
      )
    };
  });
  const firstHistoryLink = historyPages[0]
    ? `[Update history page 1](/${historyPages[0].logicalPath})`
    : null;
  const rootContent = renderOkfLog({
    entries: [...currentEntries, ...history.entries],
    summaries: history.summaries,
    limits: { ...limits, maxEntries: 1 }
  }).trimEnd();

  return [{
    logicalPath: "log.md",
    sourceFileId: null,
    fileKind: "log",
    metadata: null,
    content: [
      rootContent,
      ...(firstHistoryLink
        ? ["", `* **History**: Continue with ${firstHistoryLink}.`]
        : [])
    ].join("\n")
  }, ...historyPages];
}

function partitionLogEntries(entries: OkfLogEntry[], limits: OkfLogLimits): OkfLogEntry[][] {
  const pages: OkfLogEntry[][] = [];
  let current: OkfLogEntry[] = [];
  for (const entry of [...entries].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))) {
    const candidate = [...current, entry];
    const content = renderOkfLog({
      entries: candidate,
      summaries: [],
      limits: { maxEntries: candidate.length, maxBytes: Number.MAX_SAFE_INTEGER }
    });
    if (
      current.length > 0
      && (candidate.length > limits.maxEntries || Buffer.byteLength(content, "utf8") > limits.maxBytes)
    ) {
      pages.push(current);
      current = [entry];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

function stripLogHeading(content: string): string {
  return content.replace(/^# Directory Update Log\s*/u, "").trim();
}

export function renderSchemaFile(title: string): GeneratedOkfFile {
  const descriptor = bundleSchemaDescriptor(title);
  const metadata = generatedConceptFrontmatter(descriptor);

  return {
    logicalPath: "schema.md",
    sourceFileId: null,
    fileKind: "schema",
    metadata,
    content: renderConceptFile(
      metadata,
      [
        `# ${descriptor.heading}`,
        "",
        "## Normative OKF 0.1",
        "",
        "Every concept file includes parseable YAML frontmatter.",
        "",
        "Required fields:",
        "",
        "- type",
        "",
        "## Recommended OKF",
        "",
        "Recommended fields include `title`, `description`, `resource`, `tags`, and `timestamp`.",
        "",
        "## Producer Metadata",
        "",
        "Producer-defined metadata is preserved when it is safe and valid YAML.",
        "",
        "Detailed references:",
        "",
        "- [Browse documents](/pages/index.md) - Continue to source-backed Markdown evidence.",
        "- [Frontmatter](/schema-frontmatter.md)",
        "- [Navigation](/schema-navigation.md)",
        "- [Generated extensions](/schema-extensions.md)",
        "",
        "## Focowiki Extensions",
        "",
        "- Source-backed pages remain the final evidence for generated relationships.",
        "- `_graph/index.md` introduces the file graph.",
        "- `_graph/manifest.json` describes graph file counts and path patterns.",
        "- `_graph/nodes.jsonl` stores graph nodes directly or lists graph node shards.",
        "- `_graph/nodes/*.jsonl` stores sharded graph nodes when present.",
        "- `_graph/edges/*.jsonl` stores sharded graph edges.",
        "- Graph records resolve relationships to source-backed Markdown paths."
      ].join("\n")
    )
  };
}

export function renderSchemaFiles(title: string): GeneratedOkfFile[] {
  return [
    renderSchemaFile(title),
    schemaConceptFile(
      "schema-frontmatter.md",
      "Frontmatter",
      "Concept frontmatter requirements and recommendations.",
      [
        "# Frontmatter",
        "",
        "## Normative OKF 0.1",
        "",
        "The `type` field is required for every concept document.",
        "",
        "## Recommended OKF",
        "",
        "The `title`, `description`, `resource`, `tags`, and `timestamp` fields are recommended when known.",
        "",
        "## Producer Metadata",
        "",
        "Additional producer-defined fields remain available to consumers."
      ].join("\n")
    ),
    schemaConceptFile(
      "schema-navigation.md",
      "Navigation",
      "Directory indexes and progressive disclosure behavior.",
      [
        "# Navigation",
        "",
        "Every populated directory under `pages/` contains an `index.md` file.",
        "",
        "Index entries use generated concept titles and include concise descriptions when safe evidence is available.",
        "",
        "Large direct listings use linked `index-000001.md` pages and, when needed, `index-map-000001.md` pages.",
        "",
        "Navigation pages help readers discover source-backed Markdown files and do not represent source evidence."
      ].join("\n")
    ),
    schemaConceptFile(
      "schema-extensions.md",
      "Generated extensions",
      "Focowiki-generated machine-readable indexes and graph files.",
      [
        "# Generated extensions",
        "",
        "These resources belong to the Focowiki extension profile.",
        "",
        "The `_index/` directory contains manifests, search records, links, and change records.",
        "",
        "The `_graph/` directory contains file-linked graph nodes, edges, neighborhoods, and insights.",
        "",
        "The bundle-root `index.md` links to `_graph/index.md` whenever graph output is available.",
        "",
        "These files extend the bundle while preserving ordinary OKF concept and link semantics and real Markdown evidence paths."
      ].join("\n")
    )
  ];
}

export function renderIndexCatalogFile(): GeneratedOkfFile {
  return {
    logicalPath: "_index/index.md",
    sourceFileId: null,
    fileKind: "index_catalog",
    metadata: null,
    content: [
      "# Machine-readable indexes",
      "",
      "- [Browse documents](/pages/index.md) - Continue to source-backed Markdown evidence.",
      "- [Manifest](/_index/manifest.json) - List generated release files and safe concept metadata.",
      "- [Search index](/_index/search.json) - Discover source-backed concepts through generated search records.",
      "- [Link index](/_index/links.json) - Follow standard Markdown and graph-backed concept relationships.",
      "- [Release changes](/_index/changes.json) - Review created, updated, moved, and deleted concept paths."
    ].join("\n")
  };
}

function schemaConceptFile(
  logicalPath: string,
  title: string,
  description: string,
  body: string
): GeneratedOkfFile {
  const descriptor = schemaReferenceDescriptor({ path: logicalPath, title, description });
  const metadata = generatedConceptFrontmatter(descriptor);
  return {
    logicalPath: descriptor.path,
    sourceFileId: null,
    fileKind: "schema",
    metadata,
    content: renderConceptFile(
      metadata,
      body.replace(/^# .+$/u, `# ${descriptor.heading}`)
    )
  };
}

export function pageToSearchIndexItem(page: GeneratedPageSummary): SearchIndexItem {
  const item = buildSearchIndex(
    [{
      path: page.pagePath,
      fileId: page.fileId,
      ...(page.graphRef ? { graphRef: page.graphRef } : {}),
      title: page.metadata.title,
      ...(typeof page.metadata.description === "string" && page.metadata.description.trim()
        ? { description: page.metadata.description }
        : {}),
      tags: Array.isArray(page.metadata.tags) ? page.metadata.tags : [],
      keywords: readSuggestedStrings(page.suggestions?.keywords),
      metadata: page.metadata
    }],
    ""
  ).items[0];

  if (!item) {
    throw new Error("Search index item was not generated");
  }

  return item;
}

export function renderJsonCollectionRootFile<T>(input: {
  generatedAt: string;
  rootPath: string;
  rootKind: BundleFileKind;
  collectionKey: string;
  itemCount: number;
  shardSize: number;
  shards: JsonCollectionShardDescriptor[];
  inlineItems?: T[] | undefined;
}): GeneratedOkfFile {
  if (input.shards.length === 0) {
    return {
      logicalPath: input.rootPath,
      sourceFileId: null,
      fileKind: input.rootKind,
      metadata: null,
      content: stringifyJson({
        generated_at: input.generatedAt,
        [input.collectionKey]: input.inlineItems ?? []
      })
    };
  }

  return {
    logicalPath: input.rootPath,
    sourceFileId: null,
    fileKind: input.rootKind,
    metadata: null,
    content: stringifyJson({
      generated_at: input.generatedAt,
      mode: "sharded",
      collection: input.collectionKey,
      item_count: input.itemCount,
      shard_size: input.shardSize,
      shards: input.shards
    })
  };
}

export function renderJsonCollectionShardFile<T>(input: {
  logicalPath: string;
  shardKind: BundleFileKind;
  items: T[];
}): GeneratedOkfFile {
  return {
    logicalPath: input.logicalPath,
    sourceFileId: null,
    fileKind: input.shardKind,
    metadata: null,
    content: `${input.items.map((item) => JSON.stringify(item)).join("\n")}\n`
  };
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function normalizeLogLimits(limits: Partial<OkfLogLimits> | undefined): OkfLogLimits {
  const maxEntries = limits?.maxEntries;
  const maxBytes = limits?.maxBytes;

  return {
    maxEntries:
      typeof maxEntries === "number" && Number.isSafeInteger(maxEntries) && maxEntries > 0
        ? maxEntries
        : DEFAULT_OKF_LOG_LIMITS.maxEntries,
    maxBytes:
      typeof maxBytes === "number" && Number.isSafeInteger(maxBytes) && maxBytes > 0
        ? maxBytes
        : DEFAULT_OKF_LOG_LIMITS.maxBytes
  };
}

function renderCitations(metadata: SourceMetadata): string[] {
  const resource = typeof metadata.resource === "string" ? metadata.resource.trim() : "";
  return resource
    ? renderGeneratedCitations([{ label: "Source", target: resource }])
    : [];
}

function renderRelatedLinks(graphLinks: OkfGraphRelationship[]): string[] {
  const graphRelated = graphLinks
    .map((link) => {
      const title = escapeInlineMarkdown(cleanInlineGraphText(link.title) || "Related concept");
      const reason = cleanInlineGraphText(link.reason)
        || `Related through ${humanizeRelationshipType(link.relationType)}.`;
      return `- [${title}](${toBundleMarkdownHref(link.path)}) - ${escapeInlineMarkdown(reason)}`;
    });

  if (graphRelated.length > 0) {
    return ["", "## Related", "", ...graphRelated];
  }

  return [];
}

function cleanInlineGraphText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function humanizeRelationshipType(value: string): string {
  const normalized = cleanInlineGraphText(value.replace(/[_-]+/gu, " "));
  return normalized || "a documented relationship";
}

function escapeInlineMarkdown(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function renderConceptFile(metadata: SourceMetadata, body: string): string {
  return ["---", ...serializeYamlRecord(metadata), "---", body.trim()].join("\n").trimEnd();
}

function serializeYamlRecord(record: Record<string, unknown>): string[] {
  return Object.entries(record)
    .filter(([, value]) => value !== undefined)
    .flatMap(([key, value]) => serializeYamlField(key, value));
}

function serializeYamlField(key: string, value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.length === 0
      ? [`${key}: []`]
      : [`${key}:`, ...value.map((item) => `  - ${JSON.stringify(item)}`)];
  }

  return [`${key}: ${JSON.stringify(value)}`];
}


function readSuggestedStrings(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}
