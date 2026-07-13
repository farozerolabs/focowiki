import matter from "gray-matter";
import {
  buildIndexMetadataFields,
  type IndexMetadata,
  type IndexMetadataFields
} from "./index-metadata.js";
import { normalizeGeneratedLogicalPath } from "./source-path.js";

export type BundleFileForIndex = {
  path: string;
  content: string;
};

export type SearchIndexSource = {
  path: string;
  fileId?: string;
  graphRef?: string;
  title: string;
  description?: string;
  tags: string[];
  keywords?: string[];
  metadata?: Record<string, unknown>;
};

export type ManifestIndex = {
  generated_at: string;
  files: Array<{
    path: string;
    content_type: string;
    title?: string;
    metadata?: IndexMetadata;
  }>;
};

export type SearchIndex = {
  generated_at: string;
  items: Array<{
    path: string;
    fileId?: string;
    graphRef?: string;
    type?: string;
    title: string;
    description?: string;
    resource?: string;
    timestamp?: string;
    tags: string[];
    keywords: string[];
    metadata?: IndexMetadata;
  }>;
};

export type LinkIndex = {
  generated_at: string;
    links: Array<{
      from: string;
      to: string;
      label: string;
      relation_type?: string;
      weight?: number;
      source?: string;
      reason?: string;
    }>;
};

export type MarkdownLinkIndexEntry = {
  from: string;
  to: string;
  label: string;
};

const MARKDOWN_LINK_PATTERN = /(?<!!)\[([^\]\n]+)\]\((?:<([^>\n]+)>|([^\s)\n]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/gu;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/u;

export function buildManifestIndex(
  files: BundleFileForIndex[],
  generatedAt: string
): ManifestIndex {
  return {
    generated_at: generatedAt,
    files: files
      .map((file) => {
        const metadata = readMarkdownIndexMetadata(file);
        const entry = {
          path: file.path,
          content_type: contentTypeForPath(file.path)
        };

        return {
          ...entry,
          ...(metadata.title ? { title: metadata.title } : {}),
          ...(metadata.metadata ? { metadata: metadata.metadata } : {})
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path))
  };
}

export function buildSearchIndex(
  sources: SearchIndexSource[],
  generatedAt: string
): SearchIndex {
  return {
    generated_at: generatedAt,
    items: sources
      .map((source) => {
        const metadata = buildIndexMetadataFields(source.metadata ?? {});
        const title = metadata.title ?? source.title;
        const description = metadata.description ?? source.description;
        const tags = metadata.tags ?? source.tags;
        const keywordInput = {
          title,
          ...(description ? { description } : {}),
          tags,
          ...(source.keywords ? { keywords: source.keywords } : {})
        };

        return {
          path: source.path,
          ...(source.fileId ? { fileId: source.fileId } : {}),
          ...(source.graphRef ? { graphRef: source.graphRef } : {}),
          ...(metadata.type ? { type: metadata.type } : {}),
          title,
          ...(description ? { description } : {}),
          ...(metadata.resource ? { resource: metadata.resource } : {}),
          ...(metadata.timestamp ? { timestamp: metadata.timestamp } : {}),
          tags,
          keywords: buildKeywords(keywordInput),
          ...(metadata.metadata ? { metadata: metadata.metadata } : {})
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path))
  };
}

export function buildLinkIndex(files: BundleFileForIndex[], generatedAt: string): LinkIndex {
  const publicPaths = new Set(files.map((file) => file.path));
  const links = files
    .flatMap(extractMarkdownLinkEntries)
    .filter((link) => publicPaths.has(link.to));

  return {
    generated_at: generatedAt,
    links: links.sort((left, right) =>
      `${left.from}\u0000${left.to}\u0000${left.label}`.localeCompare(
        `${right.from}\u0000${right.to}\u0000${right.label}`
      )
    )
  };
}

export function extractMarkdownLinkEntries(file: BundleFileForIndex): MarkdownLinkIndexEntry[] {
  if (!file.path.endsWith(".md")) {
    return [];
  }

  const links: MarkdownLinkIndexEntry[] = [];
  let activeFence: string | null = null;
  for (const line of file.content.split("\n")) {
    const fence = line.match(FENCE_PATTERN)?.[1] ?? null;
    if (fence) {
      if (!activeFence) activeFence = fence[0] ?? null;
      else if (fence[0] === activeFence) activeFence = null;
      continue;
    }
    if (activeFence) continue;

    const searchable = removeInlineCode(line);
    for (const match of searchable.matchAll(MARKDOWN_LINK_PATTERN)) {
      const label = (match[1] ?? "").trim();
      const target = match[2] ?? match[3] ?? "";
      const normalized = normalizeLinkTarget(file.path, target);
      if (label && normalized) {
        links.push({ from: file.path, to: normalized, label });
      }
    }
  }

  return uniqueLinks(links);
}

export function stringifyIndex(index: ManifestIndex | SearchIndex | LinkIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

function readMarkdownIndexMetadata(file: BundleFileForIndex): IndexMetadataFields {
  if (!file.path.endsWith(".md")) {
    return {};
  }

  if (file.path === "index.md" || file.path === "log.md") {
    return {};
  }

  const parsed = matter(file.content);
  const metadata = buildIndexMetadataFields(parsed.data);

  return file.path.startsWith("pages/") ? metadata : metadata.title ? { title: metadata.title } : {};
}

function contentTypeForPath(path: string): string {
  if (path.endsWith(".jsonl")) {
    return "application/x-ndjson; charset=utf-8";
  }

  if (path.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }

  return "text/markdown; charset=utf-8";
}

function buildKeywords(source: {
  title: string;
  description?: string;
  tags: string[];
  keywords?: string[];
}): string[] {
  return unique([
    ...tokenize(source.title),
    ...tokenize(source.description ?? ""),
    ...source.tags.flatMap(tokenize),
    ...(source.keywords ?? []).flatMap(tokenize)
  ]);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function removeInlineCode(line: string): string {
  return line.replace(/`+[^`]*`+/gu, "");
}

function normalizeLinkTarget(fromPath: string, target: string): string | null {
  if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("//")) {
    return null;
  }

  const suffixIndex = firstSuffixIndex(target);
  let normalized = suffixIndex < 0 ? target : target.slice(0, suffixIndex);

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

  if (!normalized || normalized.includes("\\")) {
    return null;
  }

  const baseSegments = normalized.startsWith("/")
    ? []
    : fromPath.split("/").slice(0, -1);
  for (const segment of normalized.replace(/^\/+/, "").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (baseSegments.length === 0) return null;
      baseSegments.pop();
      continue;
    }
    baseSegments.push(segment);
  }

  if (baseSegments.length === 0) {
    return null;
  }

  try {
    return normalizeGeneratedLogicalPath(baseSegments.join("/"));
  } catch {
    return null;
  }
}

function firstSuffixIndex(value: string): number {
  const query = value.indexOf("?");
  const fragment = value.indexOf("#");
  if (query < 0) return fragment;
  if (fragment < 0) return query;
  return Math.min(query, fragment);
}

function uniqueLinks(links: MarkdownLinkIndexEntry[]): MarkdownLinkIndexEntry[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.from}\u0000${link.to}\u0000${link.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
