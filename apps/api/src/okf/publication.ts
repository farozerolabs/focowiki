import { createHash, randomUUID } from "node:crypto";

import {
  buildIndexMetadataFields,
  extractMarkdownLinkEntries,
  resolveSourceMetadata,
  validateOkfBundle,
  normalizeGeneratedFileContent,
  type OkfGraphEdge,
  type OkfGraphLimits,
  type OkfGraphNode,
  type OkfLogLimits,
  type SourceMetadata,
  type SourceMetadataDefaults,
  type SourceModelSuggestions
} from "@focowiki/okf";
import { mapWithConcurrency, type CursorPage, type CursorPageRequest } from "../runtime/bounded.js";
import type {
  ReleaseChangeRecord,
  ReleaseChangeSummary,
  ReleaseMarkdownLinkRecord,
  ReleaseNavigationEntryRecord,
  ReusableReleasePageRecord
} from "../application/ports/release-publication-repository.js";
import type { StorageKeyspace } from "../storage/keys.js";
import type { StoredObject } from "../storage/s3.js";
import {
  applyPresentationSuggestions,
  normalizeLogLimits,
  pageToSearchIndexItem,
  renderIndexFile,
  renderIndexCatalogFile,
  renderLogFiles,
  renderPageFile,
  renderSchemaFiles,
  type BundleFileKind,
  type GeneratedOkfFile,
  type GeneratedPageSummary,
  type LinkIndexEntry,
  type ManifestFileEntry,
  type PublicationLogHistory,
  type SearchIndexItem
} from "./publication-files.js";
import {
  attachPublicationGraphToPage,
  resolvePublicationGraphState,
  writePublicationGraphFiles,
  type PublicationGraphState
} from "./publication-graph-files.js";
import { createJsonShardWriter, type JsonShardWriter } from "./publication-index-writer.js";
import {
  attachGraphLinksToSummary,
  readGraphLinks,
  type PublicationGraphNeighborhoodReader
} from "./publication-graph-link-reader.js";
import { writeDirectoryNavigationFiles } from "./directory-navigation-files.js";

export type SourceFileForPublication = {
  id: string;
  name: string;
  relativePath: string;
  generatedPath: string;
  objectKey: string;
  metadata: SourceMetadataDefaults;
  suggestions?: SourceModelSuggestions | null;
  publicationRequired?: boolean;
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

export type PreviousBundleFileForPublication = Omit<
  BundleFileDraft,
  "id" | "knowledgeBaseId" | "releaseId"
>;

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
  copyObject?: ((input: { sourceKey: string; destinationKey: string }) => Promise<void>) | undefined;
};

export type PublishOkfReleaseInput = {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  knowledgeBaseDescription?: string | null;
  releaseId: string;
  generatedAt: string;
  pageSize: number;
  concurrency: number;
  log?: Partial<OkfLogLimits> | undefined;
  storage: OkfPublicationStorage;
  sourceFileCount: number;
  fetchSourcePage: (request: CursorPageRequest) => Promise<CursorPage<SourceFileForPublication>>;
  fetchNavigationEntryPage: (
    request: CursorPageRequest
  ) => Promise<CursorPage<ReleaseNavigationEntryRecord>>;
  fetchReleaseChangePage?: (
    request: CursorPageRequest
  ) => Promise<CursorPage<ReleaseChangeRecord>>;
  releaseChangeSummary?: ReleaseChangeSummary | undefined;
  fetchGraphNodePage?: ((request: CursorPageRequest) => Promise<CursorPage<OkfGraphNode>>) | undefined;
  fetchGraphEdgePage?: ((request: CursorPageRequest) => Promise<CursorPage<OkfGraphEdge>>) | undefined;
  fetchReusablePages?:
    | ((sourceFileIds: string[]) => Promise<ReusableReleasePageRecord[]>)
    | undefined;
  fetchSourceGraphNeighborhood?: PublicationGraphNeighborhoodReader | undefined;
  fetchGraphNeighborhood?: PublicationGraphNeighborhoodReader | undefined;
  materializeGraphProjection?: (() => Promise<void>) | undefined;
  fetchPublicationLogHistory?: ((request: {
    knowledgeBaseId: string;
    maxEntries: number;
  }) => Promise<PublicationLogHistory>) | undefined;
  persistBundleFiles: (files: BundleFileDraft[]) => Promise<void>;
  persistMarkdownLinks: (links: ReleaseMarkdownLinkRecord[]) => Promise<void>;
  copyReusableMarkdownLinks: (sourceFileIds: string[]) => Promise<void>;
  pruneInvalidSourceMarkdownLinks: (input: {
    plannedTargetPaths: string[];
    batchSize: number;
  }) => Promise<number>;
  fetchMarkdownLinkPage: (
    request: CursorPageRequest & { plannedTargetPaths: string[] }
  ) => Promise<CursorPage<LinkIndexEntry>>;
  materializeBundleTree: () => Promise<{ entryCount: number }>;
  onSourcePageStage?: (input: { sourceFileIds: string[]; stage: SourcePageStage }) => Promise<void>;
  dirtySourceFileIds?: string[] | undefined;
  indexShardSize?: number | undefined;
  linkIndexShardSize?: number | undefined;
  manifestShardSize?: number | undefined;
  rootSummaryLimit?: number | undefined;
  directoryIndexMaxEntries?: number | undefined;
  directoryIndexMaxBytes?: number | undefined;
  graph?: OkfGraphLimits | undefined;
};

type SourcePageStage = "bundle_generation" | "okf_validation" | "index_publication";

export type PublishOkfReleaseResult = {
  releaseId: string;
  bundleRootKey: string;
  fileCount: number;
  treeEntryCount: number;
  manifestChecksumSha256: string;
};

type GeneratedSourceFiles = {
  page: GeneratedOkfFile;
  summary: GeneratedPageSummary;
};

type PublishedSourcePage = {
  file: BundleFileDraft;
  summary: GeneratedPageSummary;
  links: ReleaseMarkdownLinkRecord[];
  reused: boolean;
};

type PublicationIndexState = {
  rootSummaryLimit: number;
  rootSummaries: GeneratedPageSummary[];
  search: JsonShardWriter<SearchIndexItem>;
  links: JsonShardWriter<LinkIndexEntry>;
  changes: JsonShardWriter<ReleaseChangeRecord>;
  manifest: JsonShardWriter<ManifestFileEntry>;
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
  let fileCount = 0;
  let manifestChecksumSha256 = "";
  let cursor: string | null = null;
  const graphState = resolvePublicationGraphState(input);
  const dirtySourceFileIds = input.dirtySourceFileIds
    ? new Set(input.dirtySourceFileIds)
    : null;

  const nextFileId = (): string => `bundle-file-${randomUUID()}`;
  const persistAndRegisterFiles = async (
    files: GeneratedOkfFile[],
    options: { addToManifest: boolean } = { addToManifest: true }
  ): Promise<BundleFileDraft[]> => {
    const persisted = await writeAndPersistBundleFiles(input, nextFileId, files);
    fileCount += persisted.length;
    for (const file of persisted) {
      await registerPublishedFile(indexState, file, options);
    }
    return persisted;
  };
  const indexState = createPublicationIndexState({
    input,
    persistFiles: persistAndRegisterFiles
  });

  do {
    const page = await input.fetchSourcePage({
      cursor,
      limit: input.pageSize
    });
    const reusablePages = input.fetchReusablePages && dirtySourceFileIds
      ? await input.fetchReusablePages(
          page.items
            .filter((source) => !(source.publicationRequired ?? dirtySourceFileIds.has(source.id)))
            .map((source) => source.id)
        )
      : [];
    const reusableBySourceId = new Map(
      reusablePages.map((file) => [file.sourceFileId, file] as const)
    );
    const generatedSourceIds = page.items
      .filter((source) => {
        const reusable = reusableBySourceId.get(source.id);
        return !reusable || reusable.logicalPath !== source.generatedPath;
      })
      .map((source) => source.id);
    await input.onSourcePageStage?.({
      sourceFileIds: generatedSourceIds,
      stage: "bundle_generation"
    });
    const publishedPages: PublishedSourcePage[] = await mapWithConcurrency(
      page.items,
      input.concurrency,
      async (source) => {
        const reusable = reusableBySourceId.get(source.id);
        if (reusable && reusable.logicalPath === source.generatedPath) {
          const summary = await attachGraphLinksToSummary({
            summary: attachPublicationGraphToPage(
              summaryFromReusablePage(reusable),
              graphState
            ),
            graph: graphState,
            fetchGraphNeighborhood: input.fetchSourceGraphNeighborhood
          });
          return {
            file: await copyReusablePage({ input, nextFileId, source, reusable }),
            summary,
            links: [],
            reused: true
          };
        }
        const generated = await generateSourceFiles({
          source,
          storage: input.storage,
          graph: graphState,
          fetchGraphNeighborhood: input.fetchSourceGraphNeighborhood
        });
        return {
          file: await writeBundleFileObject(input, nextFileId, generated.page),
          summary: generated.summary,
          links: markdownLinksForGeneratedFile(generated.page),
          reused: false
        };
      }
    );

    await input.onSourcePageStage?.({
      sourceFileIds: generatedSourceIds,
      stage: "okf_validation"
    });
    for (const batch of chunk(publishedPages.map((item) => item.file), input.pageSize)) {
      await input.persistBundleFiles(batch);
    }
    for (const batch of chunk(publishedPages.flatMap((item) => item.links), input.pageSize)) {
      await input.persistMarkdownLinks(batch);
    }
    await input.copyReusableMarkdownLinks(
      publishedPages
        .filter((item) => item.reused)
        .map((item) => item.summary.fileId)
    );
    fileCount += publishedPages.length;
    for (const published of publishedPages) {
      await registerPageSummary(indexState, published.summary);
      await registerPublishedFile(indexState, published.file);
    }
    await input.onSourcePageStage?.({
      sourceFileIds: generatedSourceIds,
      stage: "index_publication"
    });

    cursor = page.nextCursor;
  } while (cursor);

  let changeCursor: string | null = null;
  do {
    const changePage: CursorPage<ReleaseChangeRecord> = input.fetchReleaseChangePage
      ? await input.fetchReleaseChangePage({ cursor: changeCursor, limit: input.pageSize })
      : { items: [], nextCursor: null };
    await indexState.changes.addMany(changePage.items);
    changeCursor = changePage.nextCursor;
  } while (changeCursor);

  await input.materializeGraphProjection?.();

  const logLimits = normalizeLogLimits(input.log);
  const logHistory = input.fetchPublicationLogHistory
    ? await input.fetchPublicationLogHistory({
        knowledgeBaseId: input.knowledgeBaseId,
        maxEntries: logLimits.maxEntries
      })
    : { entries: [], summaries: [] };
  const fixedMarkdownFiles = [
    renderIndexFile(
      indexState.rootSummaries,
      input.generatedAt,
      input.knowledgeBaseName,
      {
        includeGraph: graphState.available,
        ...(input.knowledgeBaseDescription === undefined
          ? {}
          : { description: input.knowledgeBaseDescription })
      }
    ),
    ...renderLogFiles(
      indexState.rootSummaries,
      input.sourceFileCount,
      input.generatedAt,
      logLimits,
      logHistory,
      input.releaseChangeSummary ?? emptyReleaseChangeSummary()
    ),
    ...renderSchemaFiles(input.knowledgeBaseName),
    renderIndexCatalogFile()
  ];

  await persistAndRegisterFiles(fixedMarkdownFiles);

  await writeDirectoryNavigationFiles({
    generatedAt: input.generatedAt,
    pageSize: input.pageSize,
    ...(input.directoryIndexMaxEntries === undefined
      ? {}
      : { maxEntriesPerPage: input.directoryIndexMaxEntries }),
    ...(input.directoryIndexMaxBytes === undefined
      ? {}
      : { maxBytesPerPage: input.directoryIndexMaxBytes }),
    fetchEntryPage: input.fetchNavigationEntryPage,
    writeFiles: async (files) => {
      await persistAndRegisterFiles(files);
    }
  });

  await writePublicationGraphFiles({
    generatedAt: input.generatedAt,
    pageSize: input.pageSize,
    concurrency: input.concurrency,
    graphState,
    fetchGraphNodePage: input.fetchGraphNodePage,
    fetchGraphEdgePage: input.fetchGraphEdgePage,
    fetchGraphNeighborhood: input.fetchGraphNeighborhood,
    writeFiles: async (files) => {
      await persistAndRegisterFiles(files);
    }
  });

  await persistAndRegisterFiles([
    await indexState.search.finishRoot(),
    await indexState.changes.finishRoot()
  ]);

  await streamMarkdownLinkIndex(input, indexState.links);
  await persistAndRegisterFiles([await indexState.links.finishRoot()]);

  const manifestRoot = await indexState.manifest.finishRoot();
  const persistedManifestRoot = await persistAndRegisterFiles([manifestRoot], { addToManifest: false });
  manifestChecksumSha256 = persistedManifestRoot[0]?.checksumSha256 ?? "";

  const tree = await input.materializeBundleTree();

  return {
    releaseId: input.releaseId,
    bundleRootKey,
    fileCount,
    treeEntryCount: tree.entryCount,
    manifestChecksumSha256
  };
}

function createPublicationIndexState(input: {
  input: PublishOkfReleaseInput;
  persistFiles: (files: GeneratedOkfFile[], options?: { addToManifest: boolean }) => Promise<BundleFileDraft[]>;
}): PublicationIndexState {
  const rootSummaryLimit = normalizePositiveInteger(input.input.rootSummaryLimit, 500);

  return {
    rootSummaryLimit,
    rootSummaries: [],
    search: createJsonShardWriter<SearchIndexItem>({
      generatedAt: input.input.generatedAt,
      rootPath: "_index/search.json",
      shardDirectory: "_index/search",
      rootKind: "search_index",
      shardKind: "search_index_shard",
      collectionKey: "items",
      shardSize: normalizePositiveInteger(input.input.indexShardSize, Number.MAX_SAFE_INTEGER),
      persistFiles: async (files) => {
        await input.persistFiles(files);
      }
    }),
    links: createJsonShardWriter<LinkIndexEntry>({
      generatedAt: input.input.generatedAt,
      rootPath: "_index/links.json",
      shardDirectory: "_index/links",
      rootKind: "link_index",
      shardKind: "link_index_shard",
      collectionKey: "links",
      shardSize: normalizePositiveInteger(input.input.linkIndexShardSize, Number.MAX_SAFE_INTEGER),
      persistFiles: async (files) => {
        await input.persistFiles(files);
      }
    }),
    changes: createJsonShardWriter<ReleaseChangeRecord>({
      generatedAt: input.input.generatedAt,
      rootPath: "_index/changes.json",
      shardDirectory: "_index/changes",
      rootKind: "change_index",
      shardKind: "change_index_shard",
      collectionKey: "changes",
      shardSize: normalizePositiveInteger(input.input.indexShardSize, Number.MAX_SAFE_INTEGER),
      persistFiles: async (files) => {
        await input.persistFiles(files);
      }
    }),
    manifest: createJsonShardWriter<ManifestFileEntry>({
      generatedAt: input.input.generatedAt,
      rootPath: "_index/manifest.json",
      shardDirectory: "_index/manifest",
      rootKind: "manifest_index",
      shardKind: "manifest_index_shard",
      collectionKey: "files",
      shardSize: normalizePositiveInteger(input.input.manifestShardSize, Number.MAX_SAFE_INTEGER),
      persistFiles: async (files) => {
        await input.persistFiles(files, { addToManifest: false });
      }
    })
  };
}

async function generateSourceFiles(input: {
  source: SourceFileForPublication;
  storage: OkfPublicationStorage;
  graph: PublicationGraphState;
  fetchGraphNeighborhood?: PublicationGraphNeighborhoodReader | undefined;
}): Promise<GeneratedSourceFiles> {
  const content = await input.storage.getObjectText(input.source.objectKey);

  if (content === null) {
    throw new Error(`Source object was not found: ${input.source.id}`);
  }

  const resolved = resolveSourceMetadata({
    fileName: input.source.name,
    content,
    metadata: input.source.metadata,
    suggestions: input.source.suggestions ?? null
  });
  const metadata = applyPresentationSuggestions(
    resolved.metadata,
    input.source.suggestions ?? null,
    {
      body: resolved.body,
      fileName: input.source.name
    }
  );
  const graphLinks = await readGraphLinks({
    graph: input.graph,
    sourceFileId: input.source.id,
    fetchGraphNeighborhood: input.fetchGraphNeighborhood
  });
  const summary = attachPublicationGraphToPage(
    {
      pagePath: input.source.generatedPath,
      fileId: input.source.id,
      metadata,
      suggestions: input.source.suggestions ?? null,
      graphLinks
    },
    input.graph
  );

  return {
    summary,
    page: {
      logicalPath: summary.pagePath,
      sourceFileId: input.source.id,
      fileKind: "page",
      content: renderPageFile(summary, resolved.body),
      metadata: summary.metadata
    }
  };
}

async function copyReusablePage(input: {
  input: PublishOkfReleaseInput;
  nextFileId: () => string;
  source: SourceFileForPublication;
  reusable: ReusableReleasePageRecord;
}): Promise<BundleFileDraft> {
  const objectKey = input.input.storage.keyspace.releaseBundleKey(
    input.input.knowledgeBaseId,
    input.input.releaseId,
    input.source.generatedPath
  );
  if (input.input.storage.copyObject) {
    await input.input.storage.copyObject({
      sourceKey: input.reusable.objectKey,
      destinationKey: objectKey
    });
  } else {
    const content = await input.input.storage.getObjectText(input.reusable.objectKey);
    if (content === null) {
      throw new Error(`Reusable page object was not found: ${input.source.id}`);
    }
    await input.input.storage.putObject({
      key: objectKey,
      body: content,
      contentType: input.reusable.contentType
    });
  }
  return {
    id: input.nextFileId(),
    knowledgeBaseId: input.input.knowledgeBaseId,
    releaseId: input.input.releaseId,
    sourceFileId: input.source.id,
    fileKind: "page",
    logicalPath: input.source.generatedPath,
    objectKey,
    contentType: input.reusable.contentType,
    sizeBytes: input.reusable.sizeBytes,
    checksumSha256: input.reusable.checksumSha256,
    okfType: input.reusable.okfType,
    title: input.reusable.title,
    description: input.reusable.description,
    tags: [...input.reusable.tags],
    frontmatter: { ...input.reusable.frontmatter }
  };
}

function summaryFromReusablePage(file: ReusableReleasePageRecord): GeneratedPageSummary {
  return {
    pagePath: file.logicalPath,
    fileId: file.sourceFileId,
    metadata: { ...file.frontmatter } as SourceMetadata,
    suggestions: null,
    graphLinks: []
  };
}

async function writeAndPersistBundleFiles(
  input: PublishOkfReleaseInput,
  nextFileId: () => string,
  files: GeneratedOkfFile[]
): Promise<BundleFileDraft[]> {
  if (files.length === 0) {
    return [];
  }

  const persisted = await mapWithConcurrency(files, input.concurrency, async (file) =>
    writeBundleFileObject(input, nextFileId, file)
  );
  for (const batch of chunk(persisted, input.pageSize)) {
    await input.persistBundleFiles(batch);
  }
  const links = files.flatMap(markdownLinksForGeneratedFile);
  for (const batch of chunk(links, input.pageSize)) {
    await input.persistMarkdownLinks(batch);
  }
  return persisted;
}

async function writeBundleFileObject(
  input: PublishOkfReleaseInput,
  nextFileId: () => string,
  file: GeneratedOkfFile
): Promise<BundleFileDraft> {
  const normalizedFile = {
    ...file,
    content: normalizeGeneratedFileContent(file.logicalPath, file.content)
  };
  validateGeneratedFile(normalizedFile);

  const objectKey = input.storage.keyspace.releaseBundleKey(
    input.knowledgeBaseId,
    input.releaseId,
    normalizedFile.logicalPath
  );
  const contentType = contentTypeForPath(normalizedFile.logicalPath);
  await input.storage.putObject({
    key: objectKey,
    body: normalizedFile.content,
    contentType
  });

  const persisted = createBundleFileDraft({
    id: nextFileId(),
    knowledgeBaseId: input.knowledgeBaseId,
    releaseId: input.releaseId,
    logicalPath: normalizedFile.logicalPath,
    sourceFileId: normalizedFile.sourceFileId,
    fileKind: normalizedFile.fileKind,
    objectKey,
    contentType,
    content: normalizedFile.content,
    metadata: normalizedFile.metadata
  });
  return persisted;
}

async function registerPublishedFile(
  indexState: PublicationIndexState,
  file: BundleFileDraft,
  options: { addToManifest: boolean } = { addToManifest: true }
): Promise<void> {
  if (options.addToManifest) {
    await indexState.manifest.add(manifestEntryFromBundleFile(file));
  }
}

async function registerPageSummary(
  indexState: PublicationIndexState,
  summary: GeneratedPageSummary
): Promise<void> {
  if (indexState.rootSummaries.length < indexState.rootSummaryLimit) {
    indexState.rootSummaries.push(summary);
  }
  await indexState.search.add(pageToSearchIndexItem(summary));
}

function markdownLinksForGeneratedFile(file: GeneratedOkfFile): ReleaseMarkdownLinkRecord[] {
  return extractMarkdownLinkEntries({ path: file.logicalPath, content: file.content }).map((link) => ({
    ...link,
    sourceFileId: file.sourceFileId,
    navigationOnly: file.fileKind !== "page"
  }));
}

async function streamMarkdownLinkIndex(
  input: PublishOkfReleaseInput,
  writer: JsonShardWriter<LinkIndexEntry>
): Promise<void> {
  const plannedTargetPaths = ["_index/links.json", "_index/manifest.json"];
  await input.pruneInvalidSourceMarkdownLinks({
    plannedTargetPaths,
    batchSize: input.pageSize
  });
  let cursor: string | null = null;
  do {
    const page = await input.fetchMarkdownLinkPage({
      cursor,
      limit: input.pageSize,
      plannedTargetPaths
    });
    await writer.addMany(page.items);
    cursor = page.nextCursor;
  } while (cursor);
}

function manifestEntryFromBundleFile(file: BundleFileDraft): ManifestFileEntry {
  const metadata = file.fileKind === "page"
    ? buildIndexMetadataFields(file.frontmatter).metadata
    : undefined;

  return {
    path: file.logicalPath,
    content_type: file.contentType,
    ...(file.title ? { title: file.title } : {}),
    ...(metadata ? { metadata } : {})
  };
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

function contentTypeForPath(path: string): string {
  if (path.endsWith(".jsonl")) {
    return "application/x-ndjson; charset=utf-8";
  }

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

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function emptyReleaseChangeSummary(): ReleaseChangeSummary {
  return {
    created: 0,
    updated: 0,
    moved: 0,
    deleted: 0,
    affectedDirectories: []
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }

  return batches;
}
