import { createHash } from "node:crypto";
import { portableGraphDirectoryPath, portableIndexDirectoryPath } from "@focowiki/okf";
import type { StorageVnextImmutableObjectWriter } from "../../storage-vnext/ownership/immutable-object-writer.js";
import type { StorageVnextOwnershipRepository } from "../../storage-vnext/ownership/ports.js";
import type { StorageVnextImmutableBodyStore } from "../../storage-vnext/ownership/s3-immutable-body-store.js";
import type { DocumentProjectionScopeClaim } from "../application/document-scope-projector-runtime.js";
import type { DocumentPublicationImmutableScopeSnapshot } from "../application/document-publication-scope-generation-runtime.js";
import { normalizeDocumentPublicationScopeOutput } from
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
import { storeDocumentProjectionPages } from
  "./production-document-scope-object-writer.js";
import { finalizeDocumentPublicationOutput } from
  "./production-document-publication-output.js";
export type { DocumentSourceScopeProjection } from "./production-document-scope-renderer-helpers.js";
type DocumentScopeContributor = Readonly<{ sourceFilePublicId: string; sourceRevisionPublicId: string | null; requiredSequence: number }>;
type DocumentScopeRenderOptions = Readonly<{ pageIntegrityOverrides?:
  readonly DocumentPageIntegrityOverride[]; contributors?:
  readonly DocumentScopeContributor[]; checkpoint?: () => Promise<void>;
  affectedSourceFilePublicIds?: readonly string[];
  planningMode?: "initial" | "delta" | "repair";
  baseDeterministicChangedAt?: string | null;
  affectedLogicalPaths?: readonly string[];
  basePages?: DocumentPublicationImmutableScopeSnapshot["basePages"] }>;
export function createProductionDocumentScopeRenderer(input: {
  machineProjection: ReturnType<typeof createPostgresDocumentMachineProjectionReader>;
  sourceProjection?: DocumentSourceScopeProjection;
  directoryNavigation?: ReturnType<typeof createPostgresDocumentDirectoryNavigation>;
  directoryLeafLimits?: OrderedDirectoryLeafLimits;
  rootLimits?: { rootSummaryLimit: number; okfLogMaxEntries: number;
    okfLogMaxBytes: number };
  objectWriter: StorageVnextImmutableObjectWriter;
  objectBodies?: StorageVnextImmutableBodyStore;
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
    if (scope.publicationGenerationPublicId && !options.planningMode) {
      throw scopeRenderError("publication_planning_mode_missing");
    }
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
    const excludedActiveSourceFilePublicIds = [
      ...new Set(options.affectedSourceFilePublicIds
        ?? contributors.map((contributor) => contributor.sourceFilePublicId))
    ].sort();
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
          ...(input.objectBodies ? { objectBodies: input.objectBodies } : {}),
          knowledgeBaseId: scope.knowledgeBaseId,
          scopePath: pageDirectory,
          ...(scope.publicationGenerationPublicId
            ? { publicationGenerationPublicId:
                scope.publicationGenerationPublicId } : {}),
          includedSourceRevisionPublicIds,
          excludedActiveSourceFilePublicIds,
          ...(options.affectedSourceFilePublicIds
            ? { affectedSourceFilePublicIds:
                options.affectedSourceFilePublicIds } : {}),
          ...(options.affectedLogicalPaths
            ? { affectedLogicalPaths: options.affectedLogicalPaths } : {}),
          ...(options.planningMode
            ? { planningMode: options.planningMode } : {}),
          ...(options.basePages ? { basePages: options.basePages } : {}),
          ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
          signal,
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
            excludedActiveSourceFilePublicIds,
            ...(options.affectedSourceFilePublicIds
              ? { affectedSourceFilePublicIds:
                  options.affectedSourceFilePublicIds } : {}),
            ...(options.planningMode
              ? { planningMode: options.planningMode } : {})
          })
      : graphDirectory
        ? await projectGraphDirectory({
            dependencies: input,
            knowledgeBaseId: scope.knowledgeBaseId,
            scopePath: graphDirectory,
            includedSourceRevisionPublicIds,
            excludedActiveSourceFilePublicIds,
            ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
            ...(options.planningMode
              ? { planningMode: options.planningMode } : {}),
            ...(options.baseDeterministicChangedAt
              ? { baseDeterministicChangedAt:
                  options.baseDeterministicChangedAt } : {}),
            ...(options.basePages ? { basePages: options.basePages } : {}),
            ...(options.affectedLogicalPaths
              ? { affectedLogicalPaths: options.affectedLogicalPaths } : {}),
            signal
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
            excludedActiveSourceFilePublicIds,
            ...(options.affectedSourceFilePublicIds
              ? { affectedSourceFilePublicIds:
                  options.affectedSourceFilePublicIds } : {}),
            ...(options.planningMode
              ? { planningMode: options.planningMode } : {}),
            ...(options.affectedLogicalPaths
              ? { affectedLogicalPaths: options.affectedLogicalPaths } : {})
          })
      : graphCatalog
        ? await projectGraphCatalog({
            dependencies: input,
            knowledgeBaseId: scope.knowledgeBaseId,
            ...(scope.publicationGenerationPublicId
              ? { publicationGenerationPublicId:
                  scope.publicationGenerationPublicId } : {}),
            includedSourceRevisionPublicIds,
            excludedActiveSourceFilePublicIds
          })
      : termCatalog
        ? await projectTermCatalog({
            input,
            knowledgeBaseId: scope.knowledgeBaseId,
            includedSourceRevisionPublicIds,
            excludedActiveSourceFilePublicIds,
            ...(scope.publicationGenerationPublicId
              ? { publicationGenerationPublicId:
                  scope.publicationGenerationPublicId } : {}),
            ...(options.planningMode
              ? { planningMode: options.planningMode } : {}),
            ...(options.basePages ? { basePages: options.basePages } : {}),
            ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
            signal
          })
      : indexCatalog
        ? await projectRoot({
            dependencies: input,
            knowledgeBaseId: scope.knowledgeBaseId,
            ...(scope.publicationGenerationPublicId
              ? { publicationGenerationPublicId:
                  scope.publicationGenerationPublicId } : {}),
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
            excludedActiveSourceFilePublicIds,
            ...(options.affectedSourceFilePublicIds
              ? { affectedSourceFilePublicIds:
                  options.affectedSourceFilePublicIds } : {}),
            ...(options.planningMode
              ? { planningMode: options.planningMode } : {}),
            ...(options.basePages ? { basePages: options.basePages } : {}),
            ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
            signal
          });
    await options.checkpoint?.();
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
      options: Pick<DocumentScopeRenderOptions,
        "contributors" | "checkpoint" | "affectedSourceFilePublicIds"
          | "planningMode" | "baseDeterministicChangedAt" | "basePages"
          | "affectedLogicalPaths"> = {}
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
      const stored = await storeDocumentProjectionPages({
        objectWriter: input.objectWriter,
        ...(input.ownership ? { ownership: input.ownership } : {}),
        scope,
        pages: pagesToStore,
        signal,
        clock,
        ...(options.checkpoint ? { checkpoint: options.checkpoint } : {})
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
      signal: AbortSignal,
      checkpoint: () => Promise<void> = async () => undefined
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
          verifiedReservations: [],
          storageRequests: zeroStorageRequests(),
          factCount: 0
        }
        : await renderer.render(scope, signal, {
            contributors,
            checkpoint,
            affectedSourceFilePublicIds:
              snapshot.affectedSourceFilePublicIds,
            planningMode: snapshot.planningMode,
            ...(snapshot.baseDeterministicChangedAt
              ? { baseDeterministicChangedAt:
                  snapshot.baseDeterministicChangedAt } : {}),
            ...(snapshot.affectedLogicalPaths
              ? { affectedLogicalPaths: snapshot.affectedLogicalPaths } : {}),
            basePages: snapshot.basePages
          });
      return finalizeDocumentPublicationOutput({
        snapshot,
        rendered,
        validationEvidence
      });
    }
  };
  return renderer;
}
