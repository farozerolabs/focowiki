import { buildDocumentTermCatalogPage,
  buildDocumentNavigationTermBucketResources } from
  "../application/document-page-term-projection.js";
import type { DocumentPublicationImmutableScopeSnapshot } from
  "../application/document-publication-scope-generation-runtime.js";
import type { DocumentProjectionScopeClaim } from
  "../application/document-scope-projector-runtime.js";
import type { DocumentTermBucket } from
  "../application/document-term-routing.js";
import type { createPostgresDocumentMachineProjectionReader } from
  "./postgres-document-machine-projection-reader.js";
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
  sourceProjection?: DocumentSourceScopeProjection;
  maximumRecordsPerShard: number;
  maximumShardBytes: number;
};

export function publicationScopeClaim(
  snapshot: DocumentPublicationImmutableScopeSnapshot
): DocumentProjectionScopeClaim {
  if (snapshot.scopeKind === "validation") {
    throw scopeRenderError("projection_validation_scope_not_renderable");
  }
  return {
    publicId: snapshot.publicId,
    knowledgeBaseId: snapshot.knowledgeBaseId,
    kind: snapshot.scopeKind as DocumentProjectionScopeClaim["kind"],
    key: snapshot.scopeKey,
    requiredSequence: snapshot.targetFactEpoch,
    renderedSequence: snapshot.scopeGeneration,
    deterministicEventTime: snapshot.deterministicChangedAt
  };
}
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
}) {
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
export async function projectTermBucket(input: {
  input: DocumentScopeRendererProjectionDependencies;
  knowledgeBaseId: string;
  bucket: DocumentTermBucket;
  includedSourceRevisionPublicIds: readonly string[];
  excludedActiveSourceFilePublicIds: readonly string[];
}) {
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
