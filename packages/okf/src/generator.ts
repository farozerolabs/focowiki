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

export type MarkdownSourceInput = {
  fileName: string;
  content: string;
  suggestions?: SourceModelSuggestions | null;
};

export type SourceModelSuggestions = {
  description: string;
  headings: string[];
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
};

export type GeneratedOkfBundle = {
  generatedAt: string;
  files: OkfBundleFile[];
};

type GeneratedPage = {
  sourceFileName: string;
  pagePath: string;
  sourcePath: string;
  metadata: SourceMetadata;
  body: string;
  suggestions: SourceModelSuggestions | null;
};

export function generateOkfBundle(input: GenerateOkfBundleInput): GeneratedOkfBundle {
  const publicFileNames = new Set<string>();
  const pages = input.sources.map((source) => {
    const resolved = resolveSourceMetadata({
      ...source,
      defaults: input.defaults
    });
    const publicFileName = normalizePublicMarkdownFileName(source.fileName);

    if (publicFileNames.has(publicFileName)) {
      throw new Error(`Duplicate source file name: ${source.fileName}`);
    }

    publicFileNames.add(publicFileName);

    return {
      sourceFileName: source.fileName,
      pagePath: `pages/${publicFileName}`,
      sourcePath: `sources/${publicFileName}`,
      metadata: applyPresentationSuggestions(resolved.metadata, source.suggestions ?? null),
      body: resolved.body,
      suggestions: source.suggestions ?? null
    };
  });

  const markdownFiles: OkfBundleFile[] = [
    {
      path: "index.md",
      content: renderIndex(pages, input.generatedAt)
    },
    {
      path: "schema.md",
      content: renderConceptFile(
        {
          type: "schema",
          title: "Focowiki bundle schema",
          description: "Generated schema reference for this OKF-style bundle"
        },
        [
          "# Focowiki bundle schema",
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
        content: renderPage(page)
      },
      {
        path: page.sourcePath,
        content: renderSource(page)
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

function renderIndex(pages: GeneratedPage[], generatedAt: string): string {
  return [
    "# Focowiki knowledge base",
    "",
    `Generated at: ${generatedAt}`,
    "",
    "## Pages",
    "",
    ...pages.map(
      (page) =>
        `- [${page.metadata.title}](${toMarkdownHref(page.pagePath)}) - [Source: ${page.sourceFileName}](${toMarkdownHref(page.sourcePath)})`
    )
  ].join("\n");
}

function renderPage(page: GeneratedPage): string {
  return renderConceptFile(
    page.metadata,
    [
      page.body,
      "",
      `[Source: ${page.sourceFileName}](${toMarkdownHref(page.sourcePath)})`,
      ...renderRelatedLinks(page.suggestions),
      ...renderCitations(page.metadata)
    ].join("\n")
  );
}

function renderSource(page: GeneratedPage): string {
  const resource = typeof page.metadata.resource === "string" ? page.metadata.resource : undefined;
  const metadata: SourceMetadata = resource
    ? {
        type: "source",
        title: page.sourceFileName,
        resource
      }
    : {
        type: "source",
        title: page.sourceFileName
      };

  return renderConceptFile(
    metadata,
    [
      `# ${page.sourceFileName}`,
      "",
      `[Generated page](${toMarkdownHref(page.pagePath)})`,
      ...(resource ? ["", "## Resource", "", resource] : [])
    ].join("\n")
  );
}

function renderCitations(metadata: SourceMetadata): string[] {
  if (typeof metadata.resource !== "string" || !metadata.resource.trim()) {
    return [];
  }

  return ["", "# Citations", "", `- ${metadata.resource.trim()}`];
}

function toSearchIndexSource(page: GeneratedPage): SearchIndexSource {
  return {
    path: page.pagePath,
    title: page.metadata.title,
    ...(typeof page.metadata.description === "string"
      ? { description: page.metadata.description }
      : {}),
    tags: Array.isArray(page.metadata.tags) ? page.metadata.tags : [],
    keywords: readSuggestedStrings(page.suggestions?.keywords)
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

function renderRelatedLinks(suggestions: SourceModelSuggestions | null): string[] {
  const links = (suggestions?.related_links ?? [])
    .map((link) => ({
      path: normalizePublicPathReference(link.path),
      title: link.title.trim()
    }))
    .filter((link) => link.path && link.title)
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
