import {
  buildSearchIndex,
  buildGraphGeneratedFiles,
  buildGraphLinkIndexEntries,
  bundleSchemaTitle,
  DEFAULT_OKF_LOG_LIMITS,
  graphRefForFile,
  knowledgeBaseTitle,
  listPageRelatedGraphLinks,
  pageGraphRefForFile,
  prepareGeneratedMarkdownBody,
  renderOkfIndex,
  renderOkfLog,
  stringifyIndex,
  type IndexMetadata,
  type NormalizedOkfGraph,
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
  | "schema"
  | "manifest_index"
  | "search_index"
  | "link_index"
  | "graph_index"
  | "graph_manifest"
  | "graph_node_index"
  | "graph_edge_shard"
  | "graph_file";

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

export type PublicationLogHistory = {
  entries: OkfLogEntry[];
  summaries: OkfLogMonthlySummary[];
};

export type PublicationGraphFilesInput = {
  graph: NormalizedOkfGraph;
  generatedAt: string;
};

export function applyPresentationSuggestions(
  metadata: SourceMetadata,
  suggestions: SourceModelSuggestions | null
): SourceMetadata {
  if (typeof metadata.description === "string" && metadata.description.trim()) {
    return metadata;
  }

  const description = suggestions?.description.trim();
  return description ? { ...metadata, description } : metadata;
}

export function renderPageFile(
  page: GeneratedPageSummary,
  body: string,
  publicPaths: Set<string>,
  graph: NormalizedOkfGraph | null
): string {
  const prepared = prepareGeneratedMarkdownBody(body);
  return renderConceptFile(
    page.metadata,
    [
      prepared.content,
      "",
      ...renderRelatedLinks(publicPaths, page.graphLinks ?? [], graph),
      ...(prepared.trailingCitations
        ? ["", prepared.trailingCitations]
        : renderCitations(page.metadata))
    ].join("\n")
  );
}

export function renderIndexFile(
  pages: GeneratedPageSummary[],
  generatedAt: string,
  title: string
): GeneratedOkfFile {
  return {
    logicalPath: "index.md",
    sourceFileId: null,
    fileKind: "index",
    metadata: null,
    content: renderOkfIndex({
      title: knowledgeBaseTitle(title),
      generatedAt,
      pages: pages.map((page) => ({
        path: page.pagePath,
        title: page.metadata.title,
        type: page.metadata.type,
        ...(typeof page.metadata.description === "string" && page.metadata.description.trim()
          ? { description: page.metadata.description }
          : {})
      }))
    }).trimEnd()
  };
}

export function renderLogFile(
  pages: GeneratedPageSummary[],
  generatedAt: string,
  limits: OkfLogLimits,
  history: PublicationLogHistory
): GeneratedOkfFile {
  const currentEntries: OkfLogEntry[] = [
    {
      occurredAt: generatedAt,
      action: "Update",
      message: `Published ${pages.length} Markdown pages for this knowledge base.`,
      changedFileCount: pages.length
    },
    ...pages.map((page) => ({
      occurredAt: generatedAt,
      action: "Creation",
      message: `Added ${page.metadata.title}.`,
      changedFileCount: 1,
      links: [
        {
          path: page.pagePath,
          title: page.metadata.title
        }
      ]
    }))
  ];

  return {
    logicalPath: "log.md",
    sourceFileId: null,
    fileKind: "log",
    metadata: null,
    content: renderOkfLog({
      entries: [...currentEntries, ...history.entries],
      summaries: history.summaries,
      limits
    }).trimEnd()
  };
}

export function renderSchemaFile(title: string): GeneratedOkfFile {
  const metadata = {
    type: "schema",
    title: bundleSchemaTitle(title),
    description: `Schema reference for ${knowledgeBaseTitle(title)}`
  };

  return {
    logicalPath: "schema.md",
    sourceFileId: null,
    fileKind: "schema",
    metadata,
    content: renderConceptFile(
      metadata,
      [
        `# ${bundleSchemaTitle(title)}`,
        "",
        "Every non-reserved Markdown concept file includes parseable YAML frontmatter.",
        "",
        "Required fields:",
        "",
        "- type",
        "- title",
        "",
        "File graph:",
        "",
        "- Source-backed pages may include `fileId` and `graph` frontmatter fields.",
        "- `_graph/index.md` introduces the file graph.",
        "- `_graph/manifest.json` describes graph file counts and path patterns.",
        "- `_graph/nodes.jsonl` stores one graph node per line.",
        "- `_graph/edges/*.jsonl` stores sharded graph edges.",
        "- `_graph/by-file/{fileId}.json` stores bounded incoming and outgoing relationships."
      ].join("\n")
    )
  };
}

export function renderIndexFiles(
  pages: GeneratedPageSummary[],
  files: ManifestFileEntry[],
  generatedAt: string,
  graph: NormalizedOkfGraph | null = null
): GeneratedOkfFile[] {
  const searchIndex = buildSearchIndex(
    pages.map((page) => ({
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
    })),
    generatedAt
  );
  const linkIndex = {
    generated_at: generatedAt,
    links: [
      ...buildLinkEntries(pages),
      ...(graph ? buildGraphLinkIndexEntries(graph) : [])
    ].sort((left, right) =>
      `${left.from}\u0000${left.to}\u0000${left.label}`.localeCompare(
        `${right.from}\u0000${right.to}\u0000${right.label}`
      )
    )
  };
  const manifestIndex = {
    generated_at: generatedAt,
    files: [
      ...files.map((file) => ({
        path: file.path,
        content_type: file.content_type,
        ...(file.title ? { title: file.title } : {}),
        ...(file.metadata ? { metadata: file.metadata } : {})
      })),
      {
        path: "_index/manifest.json",
        content_type: "application/json; charset=utf-8"
      },
      {
        path: "_index/search.json",
        content_type: "application/json; charset=utf-8"
      },
      {
        path: "_index/links.json",
        content_type: "application/json; charset=utf-8"
      }
    ].sort((left, right) => left.path.localeCompare(right.path))
  };

  return [
    {
      logicalPath: "_index/manifest.json",
      sourceFileId: null,
      fileKind: "manifest_index",
      metadata: null,
      content: stringifyIndex(manifestIndex)
    },
    {
      logicalPath: "_index/search.json",
      sourceFileId: null,
      fileKind: "search_index",
      metadata: null,
      content: stringifyIndex(searchIndex)
    },
    {
      logicalPath: "_index/links.json",
      sourceFileId: null,
      fileKind: "link_index",
      metadata: null,
      content: stringifyIndex(linkIndex)
    }
  ];
}

export function renderGraphFiles(input: PublicationGraphFilesInput): GeneratedOkfFile[] {
  return buildGraphGeneratedFiles(input.graph, input.generatedAt).map((file) => ({
    logicalPath: file.path,
    sourceFileId: null,
    fileKind: file.kind,
    content: file.content,
    metadata: null
  }));
}

export function attachGraphToPage(
  page: GeneratedPageSummary,
  graph: NormalizedOkfGraph | null,
  publicPaths: Set<string>
): GeneratedPageSummary {
  const graphRef = graph?.nodesByFileId.has(page.fileId) ? graphRefForFile(page.fileId) : undefined;

  return {
    ...page,
    ...(graphRef ? { graphRef } : {}),
    metadata: graphRef
      ? {
          ...page.metadata,
          fileId: page.fileId,
          graph: pageGraphRefForFile(page.fileId)
        }
      : page.metadata,
    graphLinks:
      page.graphLinks && page.graphLinks.length > 0
        ? page.graphLinks
        : listPageRelatedGraphLinks(graph, page.fileId, publicPaths)
  };
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

function buildLinkEntries(pages: GeneratedPageSummary[]): Array<{
  from: string;
  to: string;
  label: string;
}> {
  const publicPaths = new Set(pages.flatMap((page) => [page.pagePath, "index.md", "log.md", "schema.md"]));
  const links = pages.flatMap((page) => [
    {
      from: "index.md",
      to: page.pagePath,
      label: page.metadata.title
    },
    {
      from: "log.md",
      to: page.pagePath,
      label: page.metadata.title
    },
    ...buildRelatedLinkEntries(page, publicPaths)
  ]);

  return links.sort((left, right) =>
    `${left.from}\u0000${left.to}\u0000${left.label}`.localeCompare(
      `${right.from}\u0000${right.to}\u0000${right.label}`
    )
  );
}

function buildRelatedLinkEntries(
  page: GeneratedPageSummary,
  publicPaths: Set<string>
): Array<{ from: string; to: string; label: string }> {
  return (page.graphLinks ?? [])
    .map((link) => ({
      from: page.pagePath,
      to: normalizePublicPathReference(link.path),
      label: link.title.trim()
    }))
    .filter((link) => link.to && link.label && publicPaths.has(link.to));
}

function renderCitations(metadata: SourceMetadata): string[] {
  const resource = typeof metadata.resource === "string" ? metadata.resource.trim() : "";
  return resource ? ["", "# Citations", "", `- ${resource}`] : [];
}

function renderRelatedLinks(
  publicPaths: Set<string>,
  graphLinks: OkfGraphRelationship[],
  graph: NormalizedOkfGraph | null
): string[] {
  const graphRelated = graphLinks
    .filter((link) => publicPaths.has(link.path))
    .map((link) => `- [${link.title}](${toMarkdownHref(link.path)}) - ${link.relationType}`);

  if (graph && graphRelated.length > 0) {
    return ["", "## Related", "", ...graphRelated];
  }

  return [];
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

function normalizePublicPathReference(path: string): string {
  let normalized = path.trim().replace(/^\/+/, "").replace(/#.*$/, "");

  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(normalized);

      if (next === normalized) {
        break;
      }

      normalized = next;
    } catch {
      break;
    }
  }

  return normalized;
}

function toMarkdownHref(path: string): string {
  return `/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function readSuggestedStrings(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}
