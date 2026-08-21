import { createHash } from "node:crypto";
import {
  portableGraphDirectoryPath,
  portableIndexDirectoryPath
} from "@focowiki/okf";
import type { StorageVnextImmutableObjectWriter } from
  "../../storage-vnext/ownership/immutable-object-writer.js";
import type { StorageVnextOwnershipRepository } from
  "../../storage-vnext/ownership/ports.js";
import type { DocumentProjectionScopeClaim } from
  "../application/document-scope-projector-runtime.js";
import {
  buildDocumentNavigationTermBucketResources,
  buildDocumentTermCatalogPage
} from
  "../application/document-page-term-projection.js";
import type { DocumentTermBucket } from
  "../application/document-term-routing.js";
import type { createPostgresDocumentMachineProjectionReader } from
  "./postgres-document-machine-projection-reader.js";
import type { createPostgresProjectionScopeSnapshot } from
  "./postgres-projection-scope-snapshot.js";
import type { createPostgresProjectionScopeContributions } from
  "./postgres-projection-scope-contributions.js";
import type { createPostgresDocumentDirectoryNavigation } from
  "./postgres-document-directory-navigation.js";
import type { OrderedDirectoryLeafLimits } from
  "../domain/document-directory-leaves.js";
import { MAXIMUM_PROJECTION_SCOPE_CONTRIBUTORS_PER_RENDER } from
  "../domain/document-projection-limits.js";
import {
  materializeMachineDirectoryNavigation,
  materializePerFileGraphDirectoryNavigation,
  materializeRootExtensionNavigation,
  materializeSemanticDirectoryNavigation,
  projectRoot,
  projectSemanticDirectory
} from "./production-document-scope-navigation.js";
import {
  projectGraphCatalog,
  projectGraphDirectory,
  projectPerFileGraph,
  projectPerFileGraphDirectory
} from "./production-document-scope-graph.js";
import {
  projectDocumentPageDirectoryScope,
  type DocumentPageIntegrityOverride
} from "./production-document-page-directory-scope.js";
import {
  canonicalJson,
  graphDirectoryScope,
  latestContributors,
  pageDirectoryScope,
  perFileGraphDirectoryScope,
  perFileGraphSourceId,
  scopeRenderError,
  semanticDirectoryScope,
  sourceFileScope,
  termBucket,
  validateScopeRendererConfiguration,
  writeAttemptId,
  zeroStorageRequests
} from "./production-document-scope-renderer-support.js";

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

export function createProductionDocumentScopeRenderer(input: {
  snapshots: ReturnType<typeof createPostgresProjectionScopeSnapshot>;
  machineProjection: ReturnType<typeof createPostgresDocumentMachineProjectionReader>;
  scopeContributions: ReturnType<typeof createPostgresProjectionScopeContributions>;
  sourceProjection?: DocumentSourceScopeProjection;
  directoryNavigation?: ReturnType<typeof createPostgresDocumentDirectoryNavigation>;
  directoryLeafLimits?: OrderedDirectoryLeafLimits;
  rootLimits?: {
    rootSummaryLimit: number;
    okfLogMaxEntries: number;
    okfLogMaxBytes: number;
  };
  objectWriter: StorageVnextImmutableObjectWriter;
  ownership?: StorageVnextOwnershipRepository;
  maximumRecordsPerShard: number;
  maximumShardBytes: number;
  now?: () => string;
}) {
  validateScopeRendererConfiguration(input);
  const clock = input.now ?? (() => new Date().toISOString());
  async function project(
    scope: DocumentProjectionScopeClaim,
    signal: AbortSignal,
    options: Readonly<{
      pageIntegrityOverrides?: readonly DocumentPageIntegrityOverride[];
    }> = {}
  ) {
    const sourceFile = sourceFileScope(scope);
    const bucket = termBucket(scope);
    const pageDirectory = pageDirectoryScope(scope);
    const semanticDirectory = semanticDirectoryScope(scope);
    const graphDirectory = graphDirectoryScope(scope);
    const perFileGraphDirectory = perFileGraphDirectoryScope(scope);
    const graphCatalog = scope.kind === "_graph" && scope.key === "catalog";
    const termCatalog = scope.kind === "_index" && scope.key === "term-catalog";
    const indexCatalog = scope.kind === "root" && scope.key === "index";
    const perFileGraphSource = perFileGraphSourceId(scope);
    if (!sourceFile && !bucket && !pageDirectory && !semanticDirectory
      && !graphDirectory
      && !perFileGraphDirectory
      && !graphCatalog
      && !termCatalog && !indexCatalog && !perFileGraphSource) {
      return null;
    }
    const coveredContributors = await input.scopeContributions.listCovered({
      scopePublicId: scope.publicId,
      renderedSequence: scope.renderedSequence,
      limit: MAXIMUM_PROJECTION_SCOPE_CONTRIBUTORS_PER_RENDER
    });
    const contributors = latestContributors(coveredContributors);
    const includedSourceRevisionPublicIds = contributors.map((contributor) =>
      contributor.sourceRevisionPublicId);
    const excludedActiveSourceFilePublicIds = contributors.map((contributor) =>
      contributor.sourceFilePublicId);
    const projected = sourceFile
      ? await requireSourceProjection(input).project({
          knowledgeBaseId: scope.knowledgeBaseId,
          sourceFilePublicId: sourceFile,
          includedSourceRevisionPublicIds,
          excludedActiveSourceFilePublicIds,
          signal
        })
      : pageDirectory
      ? await projectDocumentPageDirectoryScope({
          machineProjection: input.machineProjection,
          knowledgeBaseId: scope.knowledgeBaseId,
          scopePath: pageDirectory,
          includedSourceRevisionPublicIds,
          excludedActiveSourceFilePublicIds,
          pageIntegrityOverrides: options.pageIntegrityOverrides ?? [],
          maximumRecordsPerShard: input.maximumRecordsPerShard,
          maximumShardBytes: input.maximumShardBytes
        })
      : semanticDirectory
        ? await projectSemanticDirectory({
            dependencies: input,
            knowledgeBaseId: scope.knowledgeBaseId,
            scopePath: semanticDirectory,
            includedSourceRevisionPublicIds,
            excludedActiveSourceFilePublicIds
          })
      : graphDirectory
        ? await projectGraphDirectory({
            dependencies: input,
            knowledgeBaseId: scope.knowledgeBaseId,
            scopePath: graphDirectory,
            includedSourceRevisionPublicIds,
            excludedActiveSourceFilePublicIds
          })
      : perFileGraphDirectory
        ? await projectPerFileGraphDirectory({
            dependencies: input,
            knowledgeBaseId: scope.knowledgeBaseId,
            scopePath: perFileGraphDirectory,
            includedSourceRevisionPublicIds,
            excludedActiveSourceFilePublicIds
          })
      : graphCatalog
        ? await projectGraphCatalog({
            dependencies: input,
            knowledgeBaseId: scope.knowledgeBaseId,
            includedSourceRevisionPublicIds,
            excludedActiveSourceFilePublicIds
          })
      : termCatalog
        ? await projectTermCatalog({
            input,
            knowledgeBaseId: scope.knowledgeBaseId,
            includedSourceRevisionPublicIds,
            excludedActiveSourceFilePublicIds
          })
      : indexCatalog
        ? await projectRoot({
            dependencies: input,
            knowledgeBaseId: scope.knowledgeBaseId,
            includedSourceRevisionPublicIds,
            excludedActiveSourceFilePublicIds,
            changedAt: clock()
          })
      : perFileGraphSource
        ? await projectPerFileGraph({
            dependencies: input,
            knowledgeBaseId: scope.knowledgeBaseId,
            sourceFilePublicId: perFileGraphSource,
            includedSourceRevisionPublicIds,
            excludedActiveSourceFilePublicIds
          })
        : await projectTermBucket({
            input,
            knowledgeBaseId: scope.knowledgeBaseId,
            bucket: bucket!,
            includedSourceRevisionPublicIds,
            excludedActiveSourceFilePublicIds
          });
    const materialized = indexCatalog
      ? await materializeRootExtensionNavigation({
          dependencies: input,
          scope,
          projected: projected as Awaited<ReturnType<typeof projectRoot>>,
          changedAt: clock()
        })
      : pageDirectory
      ? await materializeMachineDirectoryNavigation({
          dependencies: input,
          scope,
          directoryPath: portableIndexDirectoryPath(pageDirectory),
          projected,
          changedAt: clock()
        })
      : semanticDirectory
        ? await materializeSemanticDirectoryNavigation({
            dependencies: input,
            scope,
            directoryPath: semanticDirectory,
            projected: projected as Awaited<
              ReturnType<typeof projectSemanticDirectory>
            >,
            changedAt: clock()
          })
      : graphDirectory
        ? await materializeMachineDirectoryNavigation({
            dependencies: input,
            scope,
            directoryPath: portableGraphDirectoryPath(graphDirectory),
            projected,
            changedAt: clock(),
            removeWhenEmpty: true
          })
      : perFileGraphDirectory
        ? await materializePerFileGraphDirectoryNavigation({
            dependencies: input,
            scope,
            scopePath: perFileGraphDirectory,
            projected: projected as Awaited<ReturnType<
              typeof projectPerFileGraphDirectory
            >>,
            changedAt: clock()
          })
      : termCatalog
        ? await materializeMachineDirectoryNavigation({
            dependencies: input,
            scope,
            directoryPath: "_index/terms",
            projected,
            changedAt: clock(),
            title: "Navigation terms"
          })
      : bucket
        ? await materializeMachineDirectoryNavigation({
            dependencies: input,
            scope,
            directoryPath: `_index/terms/${bucket}`,
            projected,
            changedAt: clock(),
            title: `${bucket} terms`,
            removeWhenEmpty: true
          })
        : {
            pages: projected.pages,
            removedLogicalPaths: projected.removedLogicalPaths,
            navigationMutations: []
          };
    return {
      ...materialized,
      factCount: "factCount" in projected
        ? projected.factCount : projected.records.length
    };
  }
  return {
    async project(scope: DocumentProjectionScopeClaim, options: Readonly<{
      pageIntegrityOverrides?: readonly DocumentPageIntegrityOverride[];
    }> = {}) {
      const projected = await project(
        scope,
        new AbortController().signal,
        options
      );
      if (!projected) throw scopeRenderError("projection_scope_not_materialized");
      return projected;
    },
    async render(scope: DocumentProjectionScopeClaim, signal: AbortSignal) {
      const materialized = await project(scope, signal);
      if (!materialized) {
        return {
          ...await input.snapshots.render(scope),
          verifiedReservations: []
        };
      }
      const pagesToStore = await selectChangedPages({
        machineProjection: input.machineProjection,
        knowledgeBaseId: scope.knowledgeBaseId,
        pages: materialized.pages
      });
      const settled = await Promise.allSettled(pagesToStore.map(async (page) => {
        if (signal.aborted) throw scopeRenderError("projection_scope_aborted");
        const writeAttemptPublicId = writeAttemptId(
          scope,
          page.normalizedPath,
          page.checksumSha256
        );
        const result = await input.objectWriter.putVerified({
          bytes: page.bytes,
          objectFormat: page.normalizedPath.endsWith(".json")
            ? "okf-generated-json-v1" : "okf-generated-markdown-v1",
          writeAttemptPublicId,
          createdAt: clock(),
          retainVerifiedReservation: input.ownership !== undefined,
          signal
        });
        if (result.checksum !== page.checksumSha256
          || result.byteCount !== page.byteCount) {
          throw scopeRenderError("projection_scope_object_mismatch");
        }
        return { page, result, writeAttemptPublicId };
      }));
      const failed = settled.find((item) => item.status === "rejected");
      if (failed) {
        const releases = await Promise.allSettled(settled.flatMap((item) =>
          item.status === "fulfilled" && input.ownership
            ? [input.ownership.releaseVerifiedReservation({
                objectId: item.value.result.objectId,
                writeAttemptPublicId: item.value.writeAttemptPublicId
              })]
            : []));
        const releaseErrors = releases.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []);
        if (releaseErrors.length > 0) {
          throw new AggregateError(
            [failed.reason, ...releaseErrors],
            "Projection render and verified reservation release failed"
          );
        }
        throw failed.reason;
      }
      const stored = settled.map((item) => {
        if (item.status !== "fulfilled") throw item.reason;
        return item.value;
      });
      const pages = stored.map(({ page, result }) => ({
        logicalPath: page.logicalPath,
        normalizedPath: page.normalizedPath,
        entryKind: page.entryKind,
        sourceFilePublicId: page.sourceFilePublicId,
        sourceRevisionPublicId: page.sourceRevisionPublicId,
        objectId: result.objectId,
        checksumSha256: result.checksum,
        byteCount: result.byteCount
      }));
      const removedNormalizedPaths = materialized.removedLogicalPaths.map((path) =>
        path.toLocaleLowerCase("en-US"));
      const storageRequests = stored.reduce((total, item) => ({
        put: total.put + item.result.requests.put,
        head: total.head + item.result.requests.head,
        verification: total.verification + item.result.requests.verification,
        attemptedBytes: total.attemptedBytes
          + item.result.requests.attemptedBytes,
        retries: total.retries + item.result.requests.retries,
        latencyMilliseconds: total.latencyMilliseconds
          + item.result.requests.latencyMilliseconds
      }), zeroStorageRequests());
      return {
        outputFingerprintSha256: createHash("sha256")
          .update(canonicalJson({ pages, removedNormalizedPaths }))
          .digest("hex"),
        pages,
        removedNormalizedPaths,
        navigationMutations: materialized.navigationMutations,
        verifiedReservations: stored.map(({ result, writeAttemptPublicId }) => ({
          objectId: result.objectId,
          writeAttemptPublicId
        })),
        storageRequests,
        factCount: materialized.factCount
      };
    }
  };
}

function requireSourceProjection(input: {
  sourceProjection?: DocumentSourceScopeProjection;
}): DocumentSourceScopeProjection {
  if (!input.sourceProjection) {
    throw scopeRenderError("projection_scope_source_projection_missing");
  }
  return input.sourceProjection;
}

const CHECKSUM_FILTER_THRESHOLD = 32;

async function selectChangedPages<TPage extends {
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

async function projectTermCatalog(input: {
  input: Parameters<typeof createProductionDocumentScopeRenderer>[0];
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
async function projectTermBucket(input: {
  input: Parameters<typeof createProductionDocumentScopeRenderer>[0];
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
