import { buildDocumentTermCatalogPage,
  buildDocumentNavigationTermBucketResources,
  buildDocumentNavigationTermBucketRouterPage } from
  "../application/document-page-term-projection.js";
import { applyDocumentTermStableShardDelta } from
  "../application/document-term-stable-shard-delta.js";
import type { DocumentPublicationBasePage } from
  "../application/document-publication-job-ports.js";
import { documentDirectoryEntryId } from
  "../domain/document-directory-entry-identity.js";
import { DOCUMENT_TERM_BUCKETS, type DocumentTermBucket } from
  "../application/document-term-routing.js";
import type { createPostgresDocumentMachineProjectionReader } from
  "./postgres-document-machine-projection-reader.js";
import type { StorageVnextImmutableBodyStore } from
  "../../storage-vnext/ownership/s3-immutable-body-store.js";
import { scopeRenderError } from
  "./production-document-scope-renderer-support.js";

export type DocumentSourceScopeProjection = {
  project(input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    includedSourceRevisionPublicIds: readonly string[];
    excludedActiveSourceFilePublicIds: readonly string[];
    signal: AbortSignal;
  }): Promise<{
    pages: readonly {
      logicalPath: string;
      normalizedPath: string;
      entryKind: string;
      sourceFilePublicId: string | null;
      sourceRevisionPublicId: string | null;
      bytes: Uint8Array;
      checksumSha256: string;
      byteCount: number;
    }[];
    removedLogicalPaths: readonly string[];
    factCount: number;
  }>;
};

export type DocumentScopeRendererProjectionDependencies = {
  machineProjection: ReturnType<
    typeof createPostgresDocumentMachineProjectionReader
  >;
  objectBodies?: StorageVnextImmutableBodyStore;
  sourceProjection?: DocumentSourceScopeProjection;
  maximumRecordsPerShard: number;
  maximumShardBytes: number;
};

export function requireSourceProjection(input: {
  sourceProjection?: DocumentSourceScopeProjection;
}): DocumentSourceScopeProjection {
  if (!input.sourceProjection) {
    throw scopeRenderError("projection_scope_source_projection_missing");
  }
  return input.sourceProjection;
}

const CHECKSUM_FILTER_THRESHOLD = 32;

export async function selectChangedPages<TPage extends {
  logicalPath: string;
  checksumSha256: string;
}>(input: {
  machineProjection: ReturnType<typeof createPostgresDocumentMachineProjectionReader>;
  knowledgeBaseId: string;
  pages: readonly TPage[];
}): Promise<readonly TPage[]> {
  if (input.pages.length <= CHECKSUM_FILTER_THRESHOLD) return input.pages;
  const active = await input.machineProjection.readGeneratedPageChecksums({
    knowledgeBaseId: input.knowledgeBaseId,
    logicalPaths: input.pages.map((page) => page.logicalPath)
  });
  const checksumByPath = new Map(active.map((head) => [
    head.logicalPath, head.checksumSha256
  ]));
  return input.pages.filter((page) => checksumByPath.get(page.logicalPath)
    !== page.checksumSha256);
}

export async function projectTermCatalog(input: {
  input: DocumentScopeRendererProjectionDependencies;
  knowledgeBaseId: string;
  includedSourceRevisionPublicIds: readonly string[];
  excludedActiveSourceFilePublicIds: readonly string[];
  affectedTermBuckets?: readonly string[];
  planningMode?: "initial" | "delta" | "repair";
  basePages?: readonly DocumentPublicationBasePage[];
  checkpoint?: () => Promise<void>;
  signal?: AbortSignal;
}) {
  if (input.planningMode === "delta") {
    const affectedBuckets = [...new Set(input.affectedTermBuckets ?? [])]
      .sort();
    if (affectedBuckets.length === 0
      || affectedBuckets.some((bucket) =>
        !(DOCUMENT_TERM_BUCKETS as readonly string[]).includes(bucket))) {
      throw scopeRenderError("publication_delta_term_buckets_invalid");
    }
    const [baseBuckets, changed] = await Promise.all([
      readTermCatalogBaseBuckets(input),
      input.input.machineProjection.readNavigationTermCatalogDeltaState({
      knowledgeBaseId: input.knowledgeBaseId,
      buckets: affectedBuckets as DocumentTermBucket[],
      includedSourceRevisionPublicIds: input.includedSourceRevisionPublicIds,
      excludedActiveSourceFilePublicIds: input.excludedActiveSourceFilePublicIds
      })
    ]);
    const merged = new Set<DocumentTermBucket>(baseBuckets);
    for (const item of changed) {
      if (item.present) merged.add(item.bucket);
      else merged.delete(item.bucket);
    }
    const ordered = [...merged].sort();
    return {
      pages: [buildDocumentTermCatalogPage(ordered)],
      removedLogicalPaths: [] as string[],
      records: [] as Record<string, unknown>[],
      childDirectories: ordered.map((bucket) => ({
        scopePath: `_index/terms/${bucket}`,
        title: bucket,
        path: `_index/terms/${bucket}/index.json`
      })),
      navigationCandidateEntryIds: [
        documentDirectoryEntryId("file", "_index/terms/index.json"),
        ...changed.map(({ bucket }) => documentDirectoryEntryId(
          "directory", `_index/terms/${bucket}/index.md`
        ))
      ],
      factCount: ordered.length
    };
  }
  const state = await input.input.machineProjection.readNavigationTermCatalogState({
    knowledgeBaseId: input.knowledgeBaseId,
    includedSourceRevisionPublicIds: input.includedSourceRevisionPublicIds,
    excludedActiveSourceFilePublicIds: input.excludedActiveSourceFilePublicIds
  });
  return {
    pages: [buildDocumentTermCatalogPage(state.buckets)],
    removedLogicalPaths: [] as string[],
    records: [] as Record<string, unknown>[],
    childDirectories: state.buckets.map((bucket) => ({
      scopePath: `_index/terms/${bucket}`,
      title: bucket,
      path: `_index/terms/${bucket}/index.json`
    })),
    factCount: state.buckets.length
  };
}

async function readTermCatalogBaseBuckets(
  input: Parameters<typeof projectTermCatalog>[0]
): Promise<DocumentTermBucket[]> {
  const page = input.basePages?.find((candidate) =>
    (candidate.logicalPath ?? candidate.normalizedPath)
      === "_index/terms/index.json" && candidate.action === "put");
  if (!page) return [];
  const value = await readVerifiedBaseJson(input, page, "term_catalog_base");
  if (!Array.isArray(value.buckets)) {
    throw scopeRenderError("term_catalog_base_buckets_invalid");
  }
  const buckets = value.buckets.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof (entry as Record<string, unknown>).bucket !== "string") {
      throw scopeRenderError("term_catalog_base_buckets_invalid");
    }
    return (entry as Record<string, unknown>).bucket as string;
  });
  if (buckets.some((bucket) =>
    !(DOCUMENT_TERM_BUCKETS as readonly string[]).includes(bucket))) {
    throw scopeRenderError("term_catalog_base_buckets_invalid");
  }
  return [...new Set(buckets as DocumentTermBucket[])].sort();
}

export async function projectTermBucket(input: {
  input: DocumentScopeRendererProjectionDependencies;
  knowledgeBaseId: string;
  bucket: DocumentTermBucket;
  includedSourceRevisionPublicIds: readonly string[];
  excludedActiveSourceFilePublicIds: readonly string[];
  affectedSourceFilePublicIds?: readonly string[];
  planningMode?: "initial" | "delta" | "repair";
  basePages?: readonly DocumentPublicationBasePage[];
  checkpoint?: () => Promise<void>;
  signal?: AbortSignal;
}) {
  if (input.planningMode === "delta") {
    const affected = [...new Set(
      input.affectedSourceFilePublicIds ?? []
    )].sort();
    if (affected.length === 0) {
      throw scopeRenderError("publication_delta_closure_incomplete");
    }
    const changed = await input.input.machineProjection
      .listNavigationTermDeltaRecords({
        knowledgeBaseId: input.knowledgeBaseId,
        bucket: input.bucket,
        affectedSourceFilePublicIds: affected,
        includedSourceRevisionPublicIds:
          input.includedSourceRevisionPublicIds
      });
    const base = await readTermBaseRouter(input);
    const delta = await applyDocumentTermStableShardDelta({
      bucket: input.bucket,
      base,
      changedRecords: changed.filter((record) =>
        Array.isArray(record.postings) && record.postings.length > 0),
      removedTerms: changed.filter((record) =>
        !Array.isArray(record.postings) || record.postings.length === 0)
        .flatMap((record) => typeof record.term === "string"
          ? [record.term] : []),
      maximumRecords: input.input.maximumRecordsPerShard,
      maximumBytes: input.input.maximumShardBytes,
      readRecords: (path) => readTermBaseRecords(input, path),
      ...(input.checkpoint ? { checkpoint: input.checkpoint } : {})
    });
    const routerPath = `_index/terms/${input.bucket}/index.json`;
    const changedPaths = [...new Set([
      ...delta.pages.map((page) => page.logicalPath),
      ...delta.removedPaths,
      routerPath
    ])];
    return {
      pages: delta.descriptors.length === 0 ? [] : [
        ...delta.pages,
        buildDocumentNavigationTermBucketRouterPage(
          input.bucket, delta.descriptors)
      ],
      descriptors: delta.descriptors,
      removedLogicalPaths: delta.descriptors.length === 0
        ? [...new Set([...delta.removedPaths, routerPath])].sort()
        : delta.removedPaths,
      navigationCandidateEntryIds: changedPaths.map((path) =>
        documentDirectoryEntryId("file", path)).sort(),
      records: changed
    };
  }
  const [records, previousPaths] = await Promise.all([
    input.input.machineProjection.listNavigationTermRecords({
      knowledgeBaseId: input.knowledgeBaseId,
      bucket: input.bucket,
      includedSourceRevisionPublicIds: input.includedSourceRevisionPublicIds,
      excludedActiveSourceFilePublicIds: input.excludedActiveSourceFilePublicIds
    }),
    input.input.machineProjection.listTermPartPaths({
      knowledgeBaseId: input.knowledgeBaseId,
      bucket: input.bucket
    })
  ]);
  return {
    ...buildDocumentNavigationTermBucketResources({
      bucket: input.bucket,
      records,
      previousPaths,
      maximumRecordsPerShard: input.input.maximumRecordsPerShard,
      maximumShardBytes: input.input.maximumShardBytes
    }),
    records
  };
}

async function readTermBaseRouter(
  input: Parameters<typeof projectTermBucket>[0]
) {
  const routerPath = `_index/terms/${input.bucket}/index.json`;
  const page = input.basePages?.find((candidate) =>
    (candidate.logicalPath ?? candidate.normalizedPath) === routerPath
      && candidate.action === "put");
  if (!page) return { resources: [] };
  const value = await readTermBaseJson(input, page);
  if (!Array.isArray(value.routes)) {
    throw scopeRenderError("term_delta_base_router_invalid");
  }
  return {
    resources: value.routes.map((route) => {
      if (!route || typeof route !== "object" || Array.isArray(route)) {
        throw scopeRenderError("term_delta_base_router_invalid");
      }
      const item = route as Record<string, unknown>;
      if (typeof item.path !== "string"
        || typeof item.firstTerm !== "string"
        || typeof item.lastTerm !== "string"
        || !Number.isSafeInteger(item.recordCount)) {
        throw scopeRenderError("term_delta_base_router_invalid");
      }
      const shard = input.basePages?.find((candidate) =>
        (candidate.logicalPath ?? candidate.normalizedPath) === item.path
          && candidate.action === "put");
      if (!shard || shard.byteCount === null) {
        throw scopeRenderError("term_delta_base_shard_missing");
      }
      return {
        path: item.path,
        firstKey: item.firstTerm,
        lastKey: item.lastTerm,
        recordCount: Number(item.recordCount),
        byteCount: shard.byteCount
      };
    })
  };
}

async function readTermBaseRecords(
  input: Parameters<typeof projectTermBucket>[0],
  path: string
): Promise<readonly Record<string, unknown>[]> {
  const page = input.basePages?.find((candidate) =>
    (candidate.logicalPath ?? candidate.normalizedPath) === path
      && candidate.action === "put");
  if (!page) throw scopeRenderError("term_delta_base_shard_missing");
  const value = await readTermBaseJson(input, page);
  if (!Array.isArray(value.terms)
    || value.terms.some((record) => !record || typeof record !== "object"
      || Array.isArray(record))) {
    throw scopeRenderError("term_delta_base_shard_invalid");
  }
  return value.terms as Record<string, unknown>[];
}

async function readTermBaseJson(
  input: Parameters<typeof projectTermBucket>[0],
  page: NonNullable<Parameters<typeof projectTermBucket>[0]["basePages"]>[number]
): Promise<Record<string, unknown>> {
  return readVerifiedBaseJson(input, page, "term_delta_base");
}

async function readVerifiedBaseJson(
  input: {
    input: DocumentScopeRendererProjectionDependencies;
    checkpoint?: () => Promise<void>;
    signal?: AbortSignal;
  },
  page: DocumentPublicationBasePage,
  errorPrefix: string
): Promise<Record<string, unknown>> {
  if (!input.input.objectBodies || !page.objectId || !page.storageKey
    || !page.checksumSha256 || page.byteCount === null || !page.contentType
    || !page.objectFormat) {
    throw scopeRenderError(`${errorPrefix}_object_unavailable`);
  }
  const bytes = await input.input.objectBodies.readVerified({
    descriptor: {
      objectId: page.objectId,
      storageKey: page.storageKey,
      checksum: page.checksumSha256,
      byteCount: page.byteCount,
      contentType: page.contentType,
      objectFormat: page.objectFormat as never
    },
    maximumBytes: Math.max(page.byteCount, 1),
    ...(input.signal ? { signal: input.signal } : {})
  });
  await input.checkpoint?.();
  const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw scopeRenderError(`${errorPrefix}_json_invalid`);
  }
  return value as Record<string, unknown>;
}
