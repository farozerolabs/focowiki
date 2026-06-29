import matter from "gray-matter";
import {
  buildLinkIndex,
  buildManifestIndex,
  buildSearchIndex,
  stringifyIndex,
  type BundleFileForIndex,
  type SearchIndexSource
} from "./indexes.js";
import {
  buildGraphGeneratedFiles,
  buildGraphLinkIndexEntries,
  graphRefForFile,
  listPageRelatedGraphLinks,
  normalizeOkfGraph,
  pageGraphRefForFile,
  type OkfGraphInput,
  type OkfGraphRelationship,
  type NormalizedOkfGraph
} from "./graph.js";
import {
  resolveSourceMetadata,
  type SourceMetadata,
  type SourceMetadataDefaults
} from "./metadata.js";
import { prepareGeneratedMarkdownBody } from "./markdown-appendix.js";
import { applyPresentationSuggestions } from "./presentation-suggestions.js";
import {
  DEFAULT_OKF_LOG_LIMITS,
  renderOkfIndex,
  renderOkfLog,
  type OkfLogEntry,
  type OkfLogLimits,
  type OkfLogMonthlySummary
} from "./reserved-files.js";
import { bundleSchemaTitle, knowledgeBaseTitle } from "./titles.js";

export type MarkdownSourceInput = {
  id?: string;
  fileName: string;
  content: string;
  suggestions?: SourceModelSuggestions | null;
};

export type SourceModelSuggestions = {
  title: string;
  type: string;
  description: string;
  tags: string[];
  related_links: Array<{
    path: string;
    title: string;
  }>;
  keywords: string[];
};

export type OkfBundleFile = {
  path: string;
  content: string;
};

export type GenerateOkfBundleInput = {
  sources: MarkdownSourceInput[];
  defaults: SourceMetadataDefaults;
  generatedAt: string;
  title?: string;
  graph?: OkfGraphInput;
  log?: {
    entries?: OkfLogEntry[];
    summaries?: OkfLogMonthlySummary[];
    limits?: Partial<OkfLogLimits>;
  };
};

export type GeneratedOkfBundle = {
  generatedAt: string;
  files: OkfBundleFile[];
};

type GeneratedPage = {
  pagePath: string;
  fileId?: string;
  graphRef?: string;
  metadata: SourceMetadata;
  body: string;
  suggestions: SourceModelSuggestions | null;
  graphLinks: OkfGraphRelationship[];
};

export function generateOkfBundle(input: GenerateOkfBundleInput): GeneratedOkfBundle {
  const publicFileNames = new Set<string>();
  const graph = normalizeOkfGraph(input.graph);
  const pages: GeneratedPage[] = input.sources.map((source) => {
    const resolved = resolveSourceMetadata({
      ...source,
      defaults: input.defaults,
      suggestions: source.suggestions ?? null
    });
    const publicFileName = uniquePublicMarkdownFileName({
      fileName: normalizePublicMarkdownFileName(source.fileName),
      discriminator: source.id?.trim() || String(publicFileNames.size + 1),
      usedNames: publicFileNames
    });

    publicFileNames.add(publicFileName);
    const pagePath = `pages/${publicFileName}`;
    const fileId = source.id?.trim() || undefined;
    const graphRef = fileId && graph?.nodesByFileId.has(fileId) ? graphRefForFile(fileId) : undefined;

    return {
      pagePath,
      ...(fileId ? { fileId } : {}),
      ...(graphRef ? { graphRef } : {}),
      metadata: applyGraphMetadata(
        applyPresentationSuggestions(resolved.metadata, source.suggestions ?? null),
        fileId,
        graphRef
      ),
      body: resolved.body,
      suggestions: source.suggestions ?? null,
      graphLinks: []
    };
  });
  const publicPaths = new Set([
    "index.md",
    "log.md",
    "schema.md",
    ...pages.map((page) => page.pagePath)
  ]);
  for (const page of pages) {
    page.graphLinks = listPageRelatedGraphLinks(graph, page.fileId, publicPaths);
  }

  const markdownFiles: OkfBundleFile[] = [
    {
      path: "index.md",
      content: renderIndex(pages, input.generatedAt, input.title)
    },
    {
      path: "log.md",
      content: renderLog(pages, input.generatedAt, input.log)
    },
    {
      path: "schema.md",
      content: renderConceptFile(
        {
          type: "schema",
          title: bundleSchemaTitle(input.title),
          description: `Schema reference for ${knowledgeBaseTitle(input.title)}`
        },
        [
          `# ${bundleSchemaTitle(input.title)}`,
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
          "- `_graph/nodes.jsonl` stores graph nodes directly or lists graph node shards.",
          "- `_graph/nodes/*.jsonl` stores sharded graph nodes when present.",
          "- `_graph/edges/*.jsonl` stores sharded graph edges.",
          "- `_graph/by-file/{fileId}.json` stores bounded incoming and outgoing relationships."
        ].join("\n")
      )
    },
    ...pages.flatMap((page) => [
      {
        path: page.pagePath,
        content: renderPage(page, publicPaths, graph)
      }
    ])
  ];
  const graphFiles = graph ? buildGraphGeneratedFiles(graph, input.generatedAt) : [];
  const searchSources = pages.map(toSearchIndexSource);
  const linkIndexFile = {
    path: "_index/links.json",
    content: stringifyIndex(
      graph
        ? {
            generated_at: input.generatedAt,
            links: [
              ...buildLinkIndex(markdownFiles, input.generatedAt).links,
              ...buildGraphLinkIndexEntries(graph)
            ].sort((left, right) =>
              `${left.from}\u0000${left.to}\u0000${left.label}`.localeCompare(
                `${right.from}\u0000${right.to}\u0000${right.label}`
              )
            )
          }
        : buildLinkIndex(markdownFiles, input.generatedAt)
    )
  };
  const searchIndexFile = {
    path: "_index/search.json",
    content: stringifyIndex(buildSearchIndex(searchSources, input.generatedAt))
  };
  const manifestFiles: BundleFileForIndex[] = [
    ...markdownFiles,
    ...graphFiles,
    {
      path: "_index/manifest.json",
      content: ""
    },
    searchIndexFile,
    linkIndexFile
  ];
  const manifestIndexFile = {
    path: "_index/manifest.json",
    content: stringifyIndex(buildManifestIndex(manifestFiles, input.generatedAt))
  };

  return {
    generatedAt: input.generatedAt,
    files: [...markdownFiles, ...graphFiles, manifestIndexFile, searchIndexFile, linkIndexFile]
  };
}

function renderIndex(pages: GeneratedPage[], generatedAt: string, title?: string): string {
  return renderOkfIndex({
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
  }).trimEnd();
}

function renderLog(
  pages: GeneratedPage[],
  generatedAt: string,
  log: GenerateOkfBundleInput["log"]
): string {
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

  return renderOkfLog({
    entries: [...currentEntries, ...(log?.entries ?? [])],
    summaries: log?.summaries ?? [],
    limits: log?.limits ?? DEFAULT_OKF_LOG_LIMITS
  }).trimEnd();
}

function renderPage(
  page: GeneratedPage,
  publicPaths: Set<string>,
  graph: NormalizedOkfGraph | null
): string {
  const body = prepareGeneratedMarkdownBody(page.body);
  return renderConceptFile(
    page.metadata,
    [
      body.content,
      "",
      ...renderRelatedLinks(publicPaths, page.graphLinks, graph),
      ...(body.trailingCitations
        ? ["", body.trailingCitations]
        : renderCitations(page.metadata, body.content))
    ].join("\n")
  );
}

function renderCitations(metadata: SourceMetadata, body: string): string[] {
  if (typeof metadata.resource !== "string" || !metadata.resource.trim()) {
    return [];
  }

  if (/^#\s+Citations\s*$/im.test(body)) {
    return [];
  }

  return ["", "# Citations", "", `- ${metadata.resource.trim()}`];
}

function toSearchIndexSource(page: GeneratedPage): SearchIndexSource {
  return {
    path: page.pagePath,
    ...(page.fileId ? { fileId: page.fileId } : {}),
    ...(page.graphRef ? { graphRef: page.graphRef } : {}),
    title: page.metadata.title,
    ...(typeof page.metadata.description === "string" && page.metadata.description.trim()
      ? { description: page.metadata.description }
      : {}),
    tags: Array.isArray(page.metadata.tags) ? page.metadata.tags : [],
    keywords: readSuggestedStrings(page.suggestions?.keywords),
    metadata: page.metadata
  };
}

function renderConceptFile(metadata: SourceMetadata, body: string): string {
  return matter.stringify(body.trim(), metadata).trimEnd();
}

function normalizePublicMarkdownFileName(fileName: string): string {
  const normalized = fileName.trim();

  if (!normalized.toLowerCase().endsWith(".md") || !isSafePublicPathSegment(normalized)) {
    throw new Error("Source file name must be a safe Markdown file name");
  }

  return normalized;
}

function uniquePublicMarkdownFileName(input: {
  fileName: string;
  discriminator: string;
  usedNames: Set<string>;
}): string {
  if (!input.usedNames.has(input.fileName)) return input.fileName;

  const suffix = safeFileNameSuffix(input.discriminator) || "duplicate";
  const baseName = input.fileName.slice(0, -".md".length);
  let candidate = `${baseName}--${suffix}.md`;
  let counter = 2;

  while (input.usedNames.has(candidate)) {
    candidate = `${baseName}--${suffix}-${counter}.md`;
    counter += 1;
  }

  return candidate;
}

function safeFileNameSuffix(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

function isSafePublicPathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("..") &&
    !segment.includes("\\") &&
    !segment.includes("/") &&
    !/[\u0000-\u001F\u007F]/.test(segment)
  );
}

function applyGraphMetadata(
  metadata: SourceMetadata,
  fileId: string | undefined,
  graphRef: string | undefined
): SourceMetadata {
  return {
    ...metadata,
    ...(fileId ? { fileId } : {}),
    ...(graphRef ? { graph: pageGraphRefForFile(fileId ?? "") } : {})
  };
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

function toMarkdownHref(path: string): string {
  return `/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function readSuggestedStrings(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}
