import { createHash } from "node:crypto";
import {
  portableGraphDirectoryPath,
  portableIndexDirectoryPath
} from "@focowiki/okf";
import type { StorageVnextImmutableObjectWriter } from "../../storage-vnext/ownership/immutable-object-writer.js";
import type { StorageVnextOwnershipRepository } from "../../storage-vnext/ownership/ports.js";
import type { DocumentProjectionScopeClaim } from "../application/document-scope-projector-runtime.js";
import type { DocumentPublicationImmutableScopeSnapshot } from "../application/document-publication-scope-generation-runtime.js";
import {
  normalizeDocumentPublicationScopeOutput,
  selectDocumentPublicationRemovedPaths
} from
  "../application/document-publication-scope-output.js";
import {
  validateDocumentProjectionScopeOutputOwnership
} from "../application/document-projection-path-ownership.js";
import type { createPostgresDocumentMachineProjectionReader } from "./postgres-document-machine-projection-reader.js";
import type { createPostgresDocumentDirectoryNavigation } from "./postgres-document-directory-navigation.js";
import type { OrderedDirectoryLeafLimits } from "../domain/document-directory-leaves.js";
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
import {
  projectTermBucket,
  projectTermCatalog,
  publicationScopeClaim,
  requireSourceProjection,
  selectChangedPages,
  type DocumentSourceScopeProjection
} from "./production-document-scope-renderer-helpers.js";
export type { DocumentSourceScopeProjection } from "./production-document-scope-renderer-helpers.js";
type DocumentScopeContributor = Readonly<{ sourceFilePublicId: string; sourceRevisionPublicId: string | null; requiredSequence: number }>;
type DocumentScopeRenderOptions = Readonly<{ pageIntegrityOverrides?:
  readonly DocumentPageIntegrityOverride[]; contributors?:
  readonly DocumentScopeContributor[] }>;
export function createProductionDocumentScopeRenderer(input: {
  machineProjection: ReturnType<typeof createPostgresDocumentMachineProjectionReader>;
  sourceProjection?: DocumentSourceScopeProjection;
  directoryNavigation?: ReturnType<typeof createPostgresDocumentDirectoryNavigation>;
  directoryLeafLimits?: OrderedDirectoryLeafLimits;
  rootLimits?: { rootSummaryLimit: number; okfLogMaxEntries: number;
    okfLogMaxBytes: number };
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
    options: DocumentScopeRenderOptions = {}
  ) {
    const deterministicEventTime = scope.deterministicEventTime ?? clock();
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
    const coveredContributors = options.contributors ?? [];
    const contributors = latestContributors(coveredContributors);
    const includedSourceRevisionPublicIds = contributors.flatMap((contributor) =>
      contributor.sourceRevisionPublicId
        ? [contributor.sourceRevisionPublicId] : []);
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
          ...(scope.publicationGenerationPublicId
            ? { publicationGenerationPublicId:
                scope.publicationGenerationPublicId } : {}),
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
            ...(scope.publicationGenerationPublicId
              ? { publicationGenerationPublicId:
                  scope.publicationGenerationPublicId } : {}),
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
            changedAt: deterministicEventTime
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
          changedAt: deterministicEventTime
        })
      : pageDirectory
      ? await materializeMachineDirectoryNavigation({
          dependencies: input,
          scope,
          directoryPath: portableIndexDirectoryPath(pageDirectory),
          projected,
          changedAt: deterministicEventTime,
          removeWhenEmpty: pageDirectory !== "pages"
        })
      : semanticDirectory
        ? await materializeSemanticDirectoryNavigation({
            dependencies: input,
            scope,
            directoryPath: semanticDirectory,
            projected: projected as Awaited<
              ReturnType<typeof projectSemanticDirectory>
            >,
            changedAt: deterministicEventTime
          })
      : graphDirectory
        ? await materializeMachineDirectoryNavigation({
            dependencies: input,
            scope,
            directoryPath: portableGraphDirectoryPath(graphDirectory),
            projected,
            changedAt: deterministicEventTime,
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
            changedAt: deterministicEventTime
          })
      : termCatalog
        ? await materializeMachineDirectoryNavigation({
            dependencies: input,
            scope,
            directoryPath: "_index/terms",
            projected,
            changedAt: deterministicEventTime,
            title: "Navigation terms"
          })
      : bucket
        ? await materializeMachineDirectoryNavigation({
            dependencies: input,
            scope,
            directoryPath: `_index/terms/${bucket}`,
            projected,
            changedAt: deterministicEventTime,
            title: `${bucket} terms`,
            removeWhenEmpty: true
          })
        : {
            pages: projected.pages,
            removedLogicalPaths: projected.removedLogicalPaths,
            navigationMutations: []
          };
    validateDocumentProjectionScopeOutputOwnership({
      scope,
      pages: materialized.pages,
      removedLogicalPaths: materialized.removedLogicalPaths,
      navigationMutations: materialized.navigationMutations
    });
    return {
      ...materialized,
      factCount: "factCount" in projected
        ? projected.factCount : projected.records.length
    };
  }
  const renderer = {
    async project(
      scope: DocumentProjectionScopeClaim,
      options: DocumentScopeRenderOptions = {}
    ) {
      const projected = await project(
        scope,
        new AbortController().signal,
        options
      );
      if (!projected) throw scopeRenderError("projection_scope_not_materialized");
      return projected;
    },
    async render(
      scope: DocumentProjectionScopeClaim,
      signal: AbortSignal,
      options: Pick<DocumentScopeRenderOptions, "contributors"> = {}
    ) {
      const materialized = await project(scope, signal, options);
      if (!materialized) {
        return {
          outputFingerprintSha256: createHash("sha256")
            .update(canonicalJson({
              kind: scope.kind,
              key: scope.key,
              renderedSequence: scope.renderedSequence,
              deterministicEventTime: scope.deterministicEventTime ?? null,
              contributors: options.contributors ?? []
            })).digest("hex"),
          factCount: options.contributors?.length ?? 0,
          pages: [],
          removedNormalizedPaths: [],
          navigationMutations: [],
          storageRequests: zeroStorageRequests(),
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
    },
    async renderPublication(
      snapshot: DocumentPublicationImmutableScopeSnapshot,
      signal: AbortSignal
    ) {
      const validationEvidence = {
        scopeIdentity: snapshot.scopeIdentity,
        memberCount: snapshot.members.length,
        basePageCount: snapshot.basePages.length
      };
      if (snapshot.scopeKind === "validation") {
        const normalized = normalizeDocumentPublicationScopeOutput({
          scope: { kind: "validation", key: snapshot.scopeKey },
          inputSnapshotFingerprintSha256:
            snapshot.inputSnapshotFingerprintSha256,
          rendererContractVersion: snapshot.rendererContractVersion,
          pages: [], navigationMutations: [], validationEvidence
        });
        return { ...normalized, verifiedReservations: [] };
      }
      const scope = publicationScopeClaim(snapshot);
      const contributors = snapshot.members.flatMap((member) => member.sourceFilePublicId ? [{
          sourceFilePublicId: member.sourceFilePublicId,
          sourceRevisionPublicId: member.kind === "source_revision"
            ? member.publicId : null,
          requiredSequence: Number(member.version)
        }] : []);
      const sourceTombstone = snapshot.scopeKind === "source"
        && snapshot.members.some((member) =>
          member.kind === "tombstone"
            && member.sourceFilePublicId === snapshot.scopeKey)
        && !snapshot.members.some((member) =>
          member.kind === "source_revision"
            && member.sourceFilePublicId === snapshot.scopeKey);
      const rendered = sourceTombstone ? {
          pages: [],
          removedNormalizedPaths: [],
          navigationMutations: [],
          verifiedReservations: []
        }
        : await renderer.render(scope, signal, { contributors });
      const removedNormalizedPaths = selectDocumentPublicationRemovedPaths({
        basePages: snapshot.basePages,
        renderedPaths: rendered.pages.map((page) => page.normalizedPath),
        explicitRemovedPaths: rendered.removedNormalizedPaths,
        deleteOmittedBasePages: snapshot.scopeKind === "source"
      });
      const pages = [
        ...rendered.pages.map((page) => ({
          logicalPath: page.logicalPath,
          normalizedPath: page.normalizedPath,
          action: "put" as const,
          entryKind: page.entryKind,
          objectId: page.objectId,
          checksumSha256: page.checksumSha256,
          byteCount: page.byteCount
        })),
        ...removedNormalizedPaths.map((normalizedPath) => ({
          logicalPath: normalizedPath,
          normalizedPath,
          action: "delete" as const,
          entryKind: null,
          objectId: null,
          checksumSha256: null,
          byteCount: null
        }))
      ];
      const normalized = normalizeDocumentPublicationScopeOutput({
        scope: {
          kind: snapshot.scopeKind as DocumentProjectionScopeClaim["kind"],
          key: snapshot.scopeKey
        },
        sourceFilePublicId: snapshot.scopeKind === "source"
          ? snapshot.scopeKey : null,
        inputSnapshotFingerprintSha256:
          snapshot.inputSnapshotFingerprintSha256,
        rendererContractVersion: snapshot.rendererContractVersion,
        pages,
        navigationMutations: rendered.navigationMutations.map(
          (mutation, order) => ({
            directoryPath: mutation.directoryPath,
            order,
            action: "upsert" as const,
            mutation
          })
        ),
        validationEvidence
      });
      return {
        ...normalized,
        verifiedReservations: rendered.verifiedReservations
      };
    }
  };
  return renderer;
}
