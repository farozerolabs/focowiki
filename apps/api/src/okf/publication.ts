import { createHash, randomUUID } from "node:crypto";

import {
  buildIndexMetadataFields,
  resolveSourceMetadata,
  validateOkfBundle,
  type OkfGraphEdge,
  type OkfGraphLimits,
  type OkfGraphNode,
  type OkfGraphRelationship,
  type OkfLogLimits,
  type SourceMetadata,
  type SourceMetadataDefaults,
  type SourceModelSuggestions
} from "@focowiki/okf";
import { mapWithConcurrency, type CursorPage, type CursorPageRequest } from "../runtime/bounded.js";
import type { StorageKeyspace } from "../storage/keys.js";
import type { StoredObject } from "../storage/s3.js";
import {
  applyPresentationSuggestions,
  normalizeLogLimits,
  pageToLinkIndexEntries,
  pageToSearchIndexItem,
  renderIndexFile,
  renderLogFile,
  renderPageFile,
  renderSchemaFile,
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
  type PublicationGraphState,
  type PublicationPublicFilePlans
} from "./publication-graph-files.js";
import { copyForwardUnchangedPageFiles } from "./publication-copy-forward.js";
import { createJsonShardWriter, type JsonShardWriter } from "./publication-index-writer.js";
import { attachGraphLinksToSummary, readGraphLinks } from "./publication-graph-link-reader.js";
import { collectPublicFilePlans } from "./publication-public-file-plans.js";

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
};

export type PublishOkfReleaseInput = {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  releaseId: string;
  generatedAt: string;
  pageSize: number;
  concurrency: number;
  log?: Partial<OkfLogLimits> | undefined;
  storage: OkfPublicationStorage;
  fetchSourcePage: (request: CursorPageRequest) => Promise<CursorPage<SourceFileForPublication>>;
  fetchGraphNodePage?: ((request: CursorPageRequest) => Promise<CursorPage<OkfGraphNode>>) | undefined;
  fetchGraphEdgePage?: ((request: CursorPageRequest) => Promise<CursorPage<OkfGraphEdge>>) | undefined;
  fetchPreviousBundleFilePage?:
    | ((request: CursorPageRequest) => Promise<CursorPage<PreviousBundleFileForPublication>>)
    | undefined;
  fetchGraphNeighborhood?:
    | ((request: {
        sourceFileId: string;
        limit: number;
      }) => Promise<{ sourceFileId: string; relationships: OkfGraphRelationship[] }>)
    | undefined;
  fetchPublicationLogHistory?: ((request: {
    knowledgeBaseId: string;
    maxEntries: number;
  }) => Promise<PublicationLogHistory>) | undefined;
  persistBundleFiles: (files: BundleFileDraft[]) => Promise<void>;
  persistBundleTreeEntries: (entries: BundleTreeEntryDraft[]) => Promise<void>;
  onSourcePageStage?: (input: { sourceFileIds: string[]; stage: SourcePageStage }) => Promise<void>;
  dirtySourceFileIds?: string[] | undefined;
  indexShardSize?: number | undefined;
  linkIndexShardSize?: number | undefined;
  manifestShardSize?: number | undefined;
  rootSummaryLimit?: number | undefined;
  graph?: OkfGraphLimits | undefined;
};

type SourcePageStage = "bundle_generation" | "okf_validation" | "index_publication";

export type PublishOkfReleaseResult = {
  releaseId: string;
  bundleRootKey: string;
  fileCount: number;
  treeEntryCount: number;
  manifestChecksumSha256: string;
  generatedSourceFileOutputs: PublishedSourceFileOutput[];
};

export type PublishedSourceFileOutput = {
  sourceFileId: string;
  bundleFileId: string;
  logicalPath: string;
};

type GeneratedSourceFiles = {
  page: GeneratedOkfFile;
  summary: GeneratedPageSummary;
};

type PublicFilePlans = PublicationPublicFilePlans;

type TreePublicationState = {
  seenDirectories: Set<string>;
  pendingEntries: BundleTreeEntryDraft[];
  entryCount: number;
};

type PublicationIndexState = {
  rootSummaryLimit: number;
  rootSummaries: GeneratedPageSummary[];
  search: JsonShardWriter<SearchIndexItem>;
  links: JsonShardWriter<LinkIndexEntry>;
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
  const treeState: TreePublicationState = {
    seenDirectories: new Set(),
    pendingEntries: [],
    entryCount: 0
  };
  let fileCount = 0;
  let manifestChecksumSha256 = "";
  let cursor: string | null = null;
  const generatedSourceFileOutputs: PublishedSourceFileOutput[] = [];
  const publicFilePlans = await collectPublicFilePlans(input);
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
      await registerPublishedFile(input, treeState, indexState, file, options);
    }
    return persisted;
  };
  const indexState = createPublicationIndexState({
    input,
    treeState,
    persistFiles: persistAndRegisterFiles
  });
  const copiedSourceFileIds = await copyForwardUnchangedPageFiles({
    publication: input,
    nextFileId,
    publicFilePlans,
    treeState,
    registerPublishedFile: (file, nextTreeState) =>
      registerPublishedFile(input, nextTreeState, indexState, file),
    registerPageSummary: async (summary) =>
      registerPageSummary(
        indexState,
        publicFilePlans.publicPaths,
        await attachGraphLinksToSummary({
          summary,
          graph: graphState,
          publicFilePlans,
          fetchGraphNeighborhood: input.fetchGraphNeighborhood,
          fetchGraphEdgePage: input.fetchGraphEdgePage,
          pageSize: input.pageSize
        })
      )
  });
  fileCount += copiedSourceFileIds.size;

  do {
    const page = await input.fetchSourcePage({
      cursor,
      limit: input.pageSize
    });
    const plannedSources = page.items.flatMap((source) => {
      if (copiedSourceFileIds.has(source.id)) {
        return [];
      }

      if (dirtySourceFileIds && !dirtySourceFileIds.has(source.id)) {
        return [];
      }

      const plan = publicFilePlans.bySourceId.get(source.id);

      if (!plan) {
        throw new Error(`Source file plan was not found: ${source.id}`);
      }

      return [{
        source,
        publicFileName: plan.publicFileName
      }];
    });
    const pageSourceIds = plannedSources.map(({ source }) => source.id);
    await input.onSourcePageStage?.({ sourceFileIds: pageSourceIds, stage: "bundle_generation" });
    const generatedFiles = await mapWithConcurrency(
      plannedSources,
      input.concurrency,
      async ({ source, publicFileName }) =>
        generateSourceFiles({
          source,
          publicFileName,
          publicPaths: publicFilePlans.publicPaths,
          storage: input.storage,
          graph: graphState,
          publicFilePlans,
          fetchGraphNeighborhood: input.fetchGraphNeighborhood,
          fetchGraphEdgePage: input.fetchGraphEdgePage,
          pageSize: input.pageSize
        })
    );

    await input.onSourcePageStage?.({ sourceFileIds: pageSourceIds, stage: "okf_validation" });
    const pageFiles = await writeAndPersistBundleFiles(
      input,
      nextFileId,
      generatedFiles.map((generated) => generated.page)
    );
    fileCount += pageFiles.length;
    for (const [index, pageFile] of pageFiles.entries()) {
      const generated = generatedFiles[index];
      if (!generated) {
        throw new Error("Generated page summary was not found for persisted page");
      }
      if (pageFile.sourceFileId) {
        generatedSourceFileOutputs.push({
          sourceFileId: pageFile.sourceFileId,
          bundleFileId: pageFile.id,
          logicalPath: pageFile.logicalPath
        });
      }
      await registerPageSummary(indexState, publicFilePlans.publicPaths, generated.summary);
      await registerPublishedFile(input, treeState, indexState, pageFile);
    }
    await input.onSourcePageStage?.({ sourceFileIds: pageSourceIds, stage: "index_publication" });

    cursor = page.nextCursor;
  } while (cursor);

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
      input.knowledgeBaseName
    ),
    renderLogFile(
      indexState.rootSummaries,
      input.generatedAt,
      logLimits,
      logHistory
    ),
    renderSchemaFile(input.knowledgeBaseName)
  ];

  await persistAndRegisterFiles(fixedMarkdownFiles);

  await writePublicationGraphFiles({
    generatedAt: input.generatedAt,
    pageSize: input.pageSize,
    concurrency: input.concurrency,
    plans: publicFilePlans,
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
    await indexState.links.finishRoot()
  ]);

  const manifestRoot = await indexState.manifest.finishRoot();
  const persistedManifestRoot = await persistAndRegisterFiles([manifestRoot], { addToManifest: false });
  manifestChecksumSha256 = persistedManifestRoot[0]?.checksumSha256 ?? "";

  await flushTreeEntries(input, treeState);

  return {
    releaseId: input.releaseId,
    bundleRootKey,
    fileCount,
    treeEntryCount: treeState.entryCount,
    manifestChecksumSha256,
    generatedSourceFileOutputs
  };
}

function createPublicationIndexState(input: {
  input: PublishOkfReleaseInput;
  treeState: TreePublicationState;
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
  publicFileName: string;
  publicPaths: Set<string>;
  storage: OkfPublicationStorage;
  graph: PublicationGraphState;
  publicFilePlans: PublicFilePlans;
  fetchGraphNeighborhood:
    | ((request: {
        sourceFileId: string;
        limit: number;
      }) => Promise<{ sourceFileId: string; relationships: OkfGraphRelationship[] }>)
    | undefined;
  fetchGraphEdgePage?: ((request: CursorPageRequest) => Promise<CursorPage<OkfGraphEdge>>) | undefined;
  pageSize: number;
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
  const graphLinks = await readGraphLinks({
    graph: input.graph,
    sourceFileId: input.source.id,
    publicFilePlans: input.publicFilePlans,
    fetchGraphNeighborhood: input.fetchGraphNeighborhood,
    fetchGraphEdgePage: input.fetchGraphEdgePage,
    pageSize: input.pageSize
  });
  const summary = attachPublicationGraphToPage(
    {
      pagePath: `pages/${input.publicFileName}`,
      fileId: input.source.id,
      metadata,
      suggestions: input.source.suggestions ?? null,
      graphLinks
    },
    input.graph,
    input.publicPaths
  );

  return {
    summary,
    page: {
      logicalPath: summary.pagePath,
      sourceFileId: input.source.id,
      fileKind: "page",
      content: renderPageFile(summary, resolved.body, input.publicPaths, null),
      metadata: summary.metadata
    }
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
  return persisted;
}

async function writeBundleFileObject(
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
  return persisted;
}

async function registerPublishedFile(
  input: PublishOkfReleaseInput,
  treeState: TreePublicationState,
  indexState: PublicationIndexState,
  file: BundleFileDraft,
  options: { addToManifest: boolean } = { addToManifest: true }
): Promise<void> {
  if (options.addToManifest) {
    await indexState.manifest.add(manifestEntryFromBundleFile(file));
  }

  queueTreeEntries(input, treeState, file);

  if (treeState.pendingEntries.length >= input.pageSize) {
    await flushTreeEntries(input, treeState);
  }
}

async function registerPageSummary(
  indexState: PublicationIndexState,
  publicPaths: Set<string>,
  summary: GeneratedPageSummary
): Promise<void> {
  if (indexState.rootSummaries.length < indexState.rootSummaryLimit) {
    indexState.rootSummaries.push(summary);
  }
  await indexState.search.add(pageToSearchIndexItem(summary));
  await indexState.links.addMany(pageToLinkIndexEntries(summary, publicPaths));
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

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }

  return batches;
}
