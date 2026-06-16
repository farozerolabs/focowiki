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
  resolveSourceMetadata,
  type SourceMetadata,
  type SourceMetadataDefaults
} from "./metadata.js";
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
  metadata: SourceMetadata;
  body: string;
  suggestions: SourceModelSuggestions | null;
};

export function generateOkfBundle(input: GenerateOkfBundleInput): GeneratedOkfBundle {
  const publicFileNames = new Set<string>();
  const pages = input.sources.map((source) => {
    const resolved = resolveSourceMetadata({
      ...source,
      defaults: input.defaults,
      suggestions: source.suggestions ?? null
    });
    const publicFileName = normalizePublicMarkdownFileName(source.fileName);

    if (publicFileNames.has(publicFileName)) {
      throw new Error(`Duplicate source file name: ${source.fileName}`);
    }

    publicFileNames.add(publicFileName);

    return {
      pagePath: `pages/${publicFileName}`,
      metadata: applyPresentationSuggestions(resolved.metadata, source.suggestions ?? null),
      body: resolved.body,
      suggestions: source.suggestions ?? null
    };
  });
  const publicPaths = new Set([
    "index.md",
    "log.md",
    "schema.md",
    ...pages.map((page) => page.pagePath)
  ]);

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
          "- title"
        ].join("\n")
      )
    },
    ...pages.flatMap((page) => [
      {
        path: page.pagePath,
        content: renderPage(page, publicPaths)
      }
    ])
  ];
  const searchSources = pages.map(toSearchIndexSource);
  const linkIndexFile = {
    path: "_index/links.json",
    content: stringifyIndex(buildLinkIndex(markdownFiles, input.generatedAt))
  };
  const searchIndexFile = {
    path: "_index/search.json",
    content: stringifyIndex(buildSearchIndex(searchSources, input.generatedAt))
  };
  const manifestFiles: BundleFileForIndex[] = [
    ...markdownFiles,
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
    files: [...markdownFiles, manifestIndexFile, searchIndexFile, linkIndexFile]
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

function renderPage(page: GeneratedPage, publicPaths: Set<string>): string {
  return renderConceptFile(
    page.metadata,
    [
      page.body,
      "",
      ...renderRelatedLinks(page.suggestions, publicPaths),
      ...renderCitations(page.metadata, page.body)
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

function applyPresentationSuggestions(
  metadata: SourceMetadata,
  suggestions: SourceModelSuggestions | null
): SourceMetadata {
  if (typeof metadata.description === "string" && metadata.description.trim()) {
    return metadata;
  }

  const description = suggestions?.description.trim();
  return description ? { ...metadata, description } : metadata;
}

function renderRelatedLinks(
  suggestions: SourceModelSuggestions | null,
  publicPaths: Set<string>
): string[] {
  const links = (suggestions?.related_links ?? [])
    .map((link) => ({
      path: normalizePublicPathReference(link.path),
      title: link.title.trim()
    }))
    .filter((link) => link.path && link.title && publicPaths.has(link.path))
    .map((link) => `- [${link.title}](${toMarkdownHref(link.path)})`);

  return links.length > 0 ? ["", "## Related", "", ...links] : [];
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
