import { createHash, randomUUID } from "node:crypto";

import {
  buildSearchIndex,
  resolveSourceMetadata,
  stringifyIndex,
  validateOkfBundle,
  type SourceMetadata,
  type SourceMetadataDefaults,
  type SourceModelSuggestions
} from "@focowiki/okf";
import { mapWithConcurrency, type CursorPage, type CursorPageRequest } from "../runtime/bounded.js";
import type { StorageKeyspace } from "../storage/keys.js";
import type { StoredObject } from "../storage/s3.js";

export type SourceFileForPublication = {
  id: string;
  originalName: string;
  objectKey: string;
  metadata: SourceMetadataDefaults;
  suggestions?: SourceModelSuggestions | null;
};

export type BundleFileDraft = {
  id: string;
  knowledgeBaseId: string;
  releaseId: string;
  sourceFileId: string | null;
  fileKind: BundleFileKind;
  logicalPath: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  okfType: string | null;
  title: string | null;
  description: string | null;
  tags: string[];
  frontmatter: Record<string, unknown>;
};

export type BundleFileKind =
  | "page"
  | "index"
  | "schema"
  | "manifest_index"
  | "search_index"
  | "link_index";

export type BundleTreeEntryDraft = {
  id: string;
  knowledgeBaseId: string;
  releaseId: string;
  parentPath: string;
  name: string;
  logicalPath: string;
  entryType: "directory" | "file";
  bundleFileId: string | null;
};

export type OkfPublicationStorage = {
  readonly keyspace: StorageKeyspace;
  getObjectText: (key: string) => Promise<string | null>;
  putObject: (object: StoredObject) => Promise<void>;
};

export type PublishOkfReleaseInput = {
  knowledgeBaseId: string;
  releaseId: string;
  taskId: string;
  generatedAt: string;
  pageSize: number;
  concurrency: number;
  storage: OkfPublicationStorage;
  fetchSourcePage: (
    request: CursorPageRequest
  ) => Promise<CursorPage<SourceFileForPublication>>;
  persistBundleFiles: (files: BundleFileDraft[]) => Promise<void>;
  persistBundleTreeEntries: (entries: BundleTreeEntryDraft[]) => Promise<void>;
};

export type PublishOkfReleaseResult = {
  releaseId: string;
  taskId: string;
  bundleRootKey: string;
  fileCount: number;
  treeEntryCount: number;
  manifestChecksumSha256: string;
};

type GeneratedPageSummary = {
  pagePath: string;
  metadata: SourceMetadata;
  suggestions: SourceModelSuggestions | null;
};

type GeneratedSourceFiles = {
  page: GeneratedOkfFile;
  summary: GeneratedPageSummary;
};

type PublicFilePlans = {
  bySourceId: Map<string, { publicFileName: string; pagePath: string }>;
  publicPaths: Set<string>;
};

type GeneratedOkfFile = {
  logicalPath: string;
  sourceFileId: string | null;
  fileKind: BundleFileKind;
  content: string;
  metadata: SourceMetadata | null;
};

type ManifestFileEntry = {
  path: string;
  content_type: string;
  title?: string;
};

type TreePublicationState = {
  seenDirectories: Set<string>;
  pendingEntries: BundleTreeEntryDraft[];
  entryCount: number;
};

export async function publishOkfRelease(
  input: PublishOkfReleaseInput
): Promise<PublishOkfReleaseResult> {
  assertPositiveInteger(input.pageSize, "pageSize");
  assertPositiveInteger(input.concurrency, "concurrency");

  const bundleRootKey = input.storage.keyspace.releaseRootKey(
    input.knowledgeBaseId,
    input.releaseId
  );
  const pageIndexEntries: GeneratedPageSummary[] = [];
  const manifestEntries: ManifestFileEntry[] = [];
  const treeState: TreePublicationState = {
    seenDirectories: new Set(),
    pendingEntries: [],
    entryCount: 0
  };
  let fileCount = 0;
  let manifestChecksumSha256 = "";
  let cursor: string | null = null;
  const publicFilePlans = await collectPublicFilePlans(input);

  const nextFileId = (): string => {
    return `bundle-file-${randomUUID()}`;
  };

  do {
    const page = await input.fetchSourcePage({
      cursor,
      limit: input.pageSize
    });
    const plannedSources = page.items.map((source) => {
      const plan = publicFilePlans.bySourceId.get(source.id);

      if (!plan) {
        throw new Error(`Source file plan was not found: ${source.id}`);
      }

      return {
        source,
        publicFileName: plan.publicFileName
      };
    });
    const generatedFiles = await mapWithConcurrency(
      plannedSources,
      input.concurrency,
      async ({ source, publicFileName }) =>
        generateSourceFiles({
          source,
          publicFileName,
          publicPaths: publicFilePlans.publicPaths,
          storage: input.storage
        })
    );

    for (const generated of generatedFiles) {
      pageIndexEntries.push(generated.summary);
      const pageFile = await writeAndPersistBundleFile(input, nextFileId, generated.page);
      fileCount += 1;
      await registerPublishedFile(input, treeState, manifestEntries, pageFile);
    }

    cursor = page.nextCursor;
  } while (cursor);

  const fixedMarkdownFiles = [
    renderIndexFile(pageIndexEntries, input.generatedAt),
    renderSchemaFile()
  ];

  for (const file of fixedMarkdownFiles) {
    const persisted = await writeAndPersistBundleFile(input, nextFileId, file);
    fileCount += 1;
    await registerPublishedFile(input, treeState, manifestEntries, persisted);
  }

  const indexFiles = renderIndexFiles(pageIndexEntries, manifestEntries, input.generatedAt);
  for (const file of indexFiles) {
    const persisted = await writeAndPersistBundleFile(input, nextFileId, file);
    fileCount += 1;
    await registerPublishedFile(input, treeState, manifestEntries, persisted);

    if (file.logicalPath === "_index/manifest.json") {
      manifestChecksumSha256 = persisted.checksumSha256;
    }
  }

  await flushTreeEntries(input, treeState);

  return {
    releaseId: input.releaseId,
    taskId: input.taskId,
    bundleRootKey,
    fileCount,
    treeEntryCount: treeState.entryCount,
    manifestChecksumSha256
  };
}

async function generateSourceFiles(input: {
  source: SourceFileForPublication;
  publicFileName: string;
  publicPaths: Set<string>;
  storage: OkfPublicationStorage;
}): Promise<GeneratedSourceFiles> {
  const content = await input.storage.getObjectText(input.source.objectKey);

  if (content === null) {
    throw new Error(`Source object was not found: ${input.source.id}`);
  }

  const resolved = resolveSourceMetadata({
    fileName: input.source.originalName,
    content,
    metadata: input.source.metadata,
    suggestions: input.source.suggestions ?? null
  });
  const metadata = applyPresentationSuggestions(
    resolved.metadata,
    input.source.suggestions ?? null
  );
  const summary: GeneratedPageSummary = {
    pagePath: `pages/${input.publicFileName}`,
    metadata,
    suggestions: input.source.suggestions ?? null
  };

  return {
    summary,
    page: {
      logicalPath: summary.pagePath,
      sourceFileId: input.source.id,
      fileKind: "page",
      content: renderPageFile(summary, resolved.body, input.publicPaths),
      metadata
    }
  };
}

async function collectPublicFilePlans(input: PublishOkfReleaseInput): Promise<PublicFilePlans> {
  const publicFileNames = new Set<string>();
  const publicPaths = new Set(["index.md", "schema.md"]);
  const bySourceId = new Map<string, { publicFileName: string; pagePath: string }>();
  let cursor: string | null = null;

  do {
    const page = await input.fetchSourcePage({
      cursor,
      limit: input.pageSize
    });

    for (const source of page.items) {
      const publicFileName = normalizePublicMarkdownFileName(source.originalName);

      if (publicFileNames.has(publicFileName)) {
        throw new Error(`Duplicate source file name: ${source.originalName}`);
      }

      if (bySourceId.has(source.id)) {
        throw new Error(`Duplicate source file id: ${source.id}`);
      }

      const pagePath = `pages/${publicFileName}`;
      publicFileNames.add(publicFileName);
      publicPaths.add(pagePath);
      bySourceId.set(source.id, { publicFileName, pagePath });
    }

    cursor = page.nextCursor;
  } while (cursor);

  return { bySourceId, publicPaths };
}

async function writeAndPersistBundleFile(
  input: PublishOkfReleaseInput,
  nextFileId: () => string,
  file: GeneratedOkfFile
): Promise<BundleFileDraft> {
  validateGeneratedFile(file);

  const objectKey = input.storage.keyspace.releaseBundleKey(
    input.knowledgeBaseId,
    input.releaseId,
    file.logicalPath
  );
  const contentType = contentTypeForPath(file.logicalPath);
  await input.storage.putObject({
    key: objectKey,
    body: file.content,
    contentType
  });

  const persisted = createBundleFileDraft({
    id: nextFileId(),
    knowledgeBaseId: input.knowledgeBaseId,
    releaseId: input.releaseId,
    logicalPath: file.logicalPath,
    sourceFileId: file.sourceFileId,
    fileKind: file.fileKind,
    objectKey,
    contentType,
    content: file.content,
    metadata: file.metadata
  });
  await input.persistBundleFiles([persisted]);
  return persisted;
}

async function registerPublishedFile(
  input: PublishOkfReleaseInput,
  treeState: TreePublicationState,
  manifestEntries: ManifestFileEntry[],
  file: BundleFileDraft
): Promise<void> {
  manifestEntries.push({
    path: file.logicalPath,
    content_type: file.contentType,
    ...(file.title ? { title: file.title } : {})
  });

  queueTreeEntries(input, treeState, file);

  if (treeState.pendingEntries.length >= input.pageSize) {
    await flushTreeEntries(input, treeState);
  }
}

function queueTreeEntries(
  input: PublishOkfReleaseInput,
  treeState: TreePublicationState,
  file: BundleFileDraft
): void {
  const logicalPath = normalizeTreeLogicalPath(file.logicalPath);
  const segments = logicalPath.split("/");

  for (let index = 0; index < segments.length - 1; index += 1) {
    const directoryPath = segments.slice(0, index + 1).join("/");

    if (treeState.seenDirectories.has(directoryPath)) {
      continue;
    }

    treeState.seenDirectories.add(directoryPath);
    treeState.pendingEntries.push({
      id: `bundle-tree-entry-${randomUUID()}`,
      knowledgeBaseId: input.knowledgeBaseId,
      releaseId: input.releaseId,
      entryType: "directory",
      parentPath: segments.slice(0, index).join("/"),
      name: segments[index] ?? "",
      logicalPath: directoryPath,
      bundleFileId: null
    });
  }

  treeState.pendingEntries.push({
    id: `bundle-tree-entry-${randomUUID()}`,
    knowledgeBaseId: input.knowledgeBaseId,
    releaseId: input.releaseId,
    entryType: "file",
    parentPath: segments.slice(0, -1).join("/"),
    name: segments.at(-1) ?? "",
    logicalPath,
    bundleFileId: file.id
  });
}

async function flushTreeEntries(
  input: PublishOkfReleaseInput,
  treeState: TreePublicationState
): Promise<void> {
  if (treeState.pendingEntries.length === 0) {
    return;
  }

  for (const batch of chunk(treeState.pendingEntries, input.pageSize)) {
    await input.persistBundleTreeEntries(batch);
    treeState.entryCount += batch.length;
  }

  treeState.pendingEntries = [];
}

function validateGeneratedFile(file: GeneratedOkfFile): void {
  if (!file.logicalPath.endsWith(".md")) {
    return;
  }

  validateOkfBundle([
    {
      path: file.logicalPath,
      content: file.content
    }
  ]);
}

function createBundleFileDraft(input: {
  id: string;
  knowledgeBaseId: string;
  releaseId: string;
  logicalPath: string;
  sourceFileId: string | null;
  fileKind: BundleFileKind;
  objectKey: string;
  contentType: string;
  content: string;
  metadata: SourceMetadata | null;
}): BundleFileDraft {
  const metadata = input.metadata;
  const tags = Array.isArray(metadata?.tags) ? metadata.tags : [];

  return {
    id: input.id,
    knowledgeBaseId: input.knowledgeBaseId,
    releaseId: input.releaseId,
    sourceFileId: input.sourceFileId,
    fileKind: input.fileKind,
    logicalPath: input.logicalPath,
    objectKey: input.objectKey,
    contentType: input.contentType,
    sizeBytes: new TextEncoder().encode(input.content).byteLength,
    checksumSha256: sha256(input.content),
    okfType: typeof metadata?.type === "string" ? metadata.type : null,
    title: typeof metadata?.title === "string" ? metadata.title : null,
    description: typeof metadata?.description === "string" ? metadata.description : null,
    tags,
    frontmatter: metadata ? { ...metadata } : {}
  };
}

function renderIndexFile(pages: GeneratedPageSummary[], generatedAt: string): GeneratedOkfFile {
  return {
    logicalPath: "index.md",
    sourceFileId: null,
    fileKind: "index",
    metadata: null,
    content: [
      "# Focowiki knowledge base",
      "",
      `Generated at: ${generatedAt}`,
      "",
      "## Pages",
      "",
      ...pages.map((page) => `- [${page.metadata.title}](${toMarkdownHref(page.pagePath)})`)
    ].join("\n")
  };
}

function renderSchemaFile(): GeneratedOkfFile {
  const metadata = {
    type: "schema",
    title: "Focowiki bundle schema",
    description: "Generated schema reference for this OKF-style bundle"
  };

  return {
    logicalPath: "schema.md",
    sourceFileId: null,
    fileKind: "schema",
    metadata,
    content: renderConceptFile(
      metadata,
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
  };
}

function renderIndexFiles(
  pages: GeneratedPageSummary[],
  files: ManifestFileEntry[],
  generatedAt: string
): GeneratedOkfFile[] {
  const searchIndex = buildSearchIndex(
    pages.map((page) => ({
      path: page.pagePath,
      title: page.metadata.title,
      ...(typeof page.metadata.description === "string"
        ? { description: page.metadata.description }
        : {}),
      tags: Array.isArray(page.metadata.tags) ? page.metadata.tags : [],
      keywords: readSuggestedStrings(page.suggestions?.keywords)
    })),
    generatedAt
  );
  const linkIndex = {
    generated_at: generatedAt,
    links: buildLinkEntries(pages)
  };
  const manifestIndex = {
    generated_at: generatedAt,
    files: [
      ...files.map((file) => ({
        path: file.path,
        content_type: file.content_type,
        ...(file.title ? { title: file.title } : {})
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

function normalizeTreeLogicalPath(rawPath: string): string {
  const decoded = decodeTreeLogicalPath(rawPath).replace(/^\/+|\/+$/g, "");
  const segments = decoded.split("/");

  if (segments.length === 0 || segments.some((segment) => !isSafeTreeSegment(segment))) {
    throw new Error("Bundle tree logical path must be a safe relative path");
  }

  return segments.join("/");
}

function isSafeTreeSegment(segment: string): boolean {
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

function decodeTreeLogicalPath(value: string): string {
  let decoded = value.trim();

  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(decoded);

      if (next === decoded) {
        break;
      }

      decoded = next;
    } catch {
      throw new Error("Bundle tree logical path must be URI-decodable");
    }
  }

  return decoded;
}

function buildLinkEntries(pages: GeneratedPageSummary[]): Array<{
  from: string;
  to: string;
  label: string;
}> {
  const publicPaths = new Set(pages.flatMap((page) => [page.pagePath, "index.md", "schema.md"]));
  const links = pages.flatMap((page) => [
    {
      from: "index.md",
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
  return (page.suggestions?.related_links ?? [])
    .map((link) => ({
      from: page.pagePath,
      to: normalizePublicPathReference(link.path),
      label: link.title.trim()
    }))
    .filter((link) => link.to && link.label && publicPaths.has(link.to));
}

function renderPageFile(
  page: GeneratedPageSummary,
  body: string,
  publicPaths: Set<string>
): string {
  return renderConceptFile(
    page.metadata,
    [
      body.trim(),
      "",
      ...renderRelatedLinks(page.suggestions, publicPaths),
      ...renderCitations(page.metadata)
    ].join("\n")
  );
}

function renderCitations(metadata: SourceMetadata): string[] {
  const resource = typeof metadata.resource === "string" ? metadata.resource.trim() : "";
  return resource ? ["", "# Citations", "", `- ${resource}`] : [];
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
      : [`${key}:`, ...value.map((item) => `  - ${serializeYamlScalar(item)}`)];
  }

  return [`${key}: ${serializeYamlScalar(value)}`];
}

function serializeYamlScalar(value: unknown): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return JSON.stringify(value);
  }

  return JSON.stringify(value);
}

function normalizePublicMarkdownFileName(fileName: string): string {
  const normalized = fileName.trim();

  if (!normalized.toLowerCase().endsWith(".md") || !isSafeTreeSegment(normalized)) {
    throw new Error("Source file name must be a safe Markdown file name");
  }

  return normalized;
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

function contentTypeForPath(path: string): string {
  return path.endsWith(".json")
    ? "application/json; charset=utf-8"
    : "text/markdown; charset=utf-8";
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }

  return batches;
}
