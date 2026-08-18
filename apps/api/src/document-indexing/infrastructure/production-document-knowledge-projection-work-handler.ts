import type { StorageVnextImmutableObjectWriter } from "../../storage-vnext/ownership/immutable-object-writer.js";
import type { StorageVnextOwnershipRepository } from "../../storage-vnext/ownership/ports.js";
import type { DocumentKnowledgeProjectionManifest } from "../application/document-knowledge-projection-manifest.js";
import type { createDocumentResourceLanes } from "../application/document-resource-lanes.js";
import type { ClaimedDocumentArtifactWork } from "../application/document-work-port.js";
import type { createDocumentPageBaseLoader } from "./document-page-base-loader.js";
import type { createDocumentPreparedSourceLoader } from "./document-prepared-source-loader.js";
import type { createPostgresCandidateFileRelationRepository } from "./postgres-candidate-file-relation-repository.js";
import type { createPostgresDocumentGeneratedContext } from "./postgres-document-generated-context.js";
import type { createPostgresDocumentReceiptRepository } from "./postgres-document-receipt-repository.js";
import type { createPostgresDocumentWorkContext } from "./postgres-document-work-context.js";
import type { createPostgresGeneratedPageBaseRepository } from "./postgres-generated-page-base-repository.js";
import { createPostgresProjectionDirtyScopeRepository } from "./postgres-projection-dirty-scope-repository.js";
import { createPostgresDocumentProjectionFacts } from
  "./postgres-document-projection-facts.js";
import { createPostgresProjectionScopeContributions } from
  "./postgres-projection-scope-contributions.js";
import type { createPostgresDocumentArtifactWorkRepository } from
  "./postgres-document-artifact-work-repository.js";
import type { createPostgresScopedActivationOwnerRepository } from "./postgres-scoped-activation-owner-repository.js";
import type { createPostgresSearchFamilyRepository } from "./postgres-search-family-repository.js";
import type { createPostgresDocumentMachineProjectionReader } from
  "./postgres-document-machine-projection-reader.js";
import type { createProductionDocumentSemanticSearchProjection } from "./production-document-semantic-search-projection.js";
import type { createProductionDocumentPageBase } from "./production-document-page-base.js";
import {
  documentActivationOwnerRequests,
  documentProjectionAvailableSourceFileIds,
  documentProjectionGraphDirectoryPaths,
  documentProjectionActivationOwnerVersions,
  documentProjectionSourceFileIds,
  documentProjectionScopes,
  readDocumentRelationPlan,
  shouldProjectDocumentGraphDirectories,
  type DocumentRelationPlan
} from "./document-knowledge-projection-support.js";
import { storeDocumentProjectionManifest } from
  "./production-document-projection-manifest-store.js";
import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import { buildDocumentProjectionFact } from
  "./document-projection-persistence-plan.js";
import { classifyDocumentNavigationTerm } from
  "../application/document-term-routing.js";
import { posix } from "node:path";

export function createProductionDocumentKnowledgeProjectionWorkHandler(input: {
  contexts: ReturnType<typeof createPostgresDocumentWorkContext>;
  preparedSources: ReturnType<typeof createDocumentPreparedSourceLoader>;
  receipts: ReturnType<typeof createPostgresDocumentReceiptRepository>;
  pageBase: ReturnType<typeof createProductionDocumentPageBase>;
  bases: ReturnType<typeof createPostgresGeneratedPageBaseRepository>;
  loadBase: ReturnType<typeof createDocumentPageBaseLoader>;
  relations: ReturnType<typeof createPostgresCandidateFileRelationRepository>;
  generatedContext: ReturnType<typeof createPostgresDocumentGeneratedContext>;
  machineProjection: ReturnType<typeof createPostgresDocumentMachineProjectionReader>;
  semanticSearch: ReturnType<
    typeof createProductionDocumentSemanticSearchProjection
  >;
  searchFamilies: ReturnType<typeof createPostgresSearchFamilyRepository>;
  dirtyScopes: ReturnType<typeof createPostgresProjectionDirtyScopeRepository>;
  projectionFacts: ReturnType<typeof createPostgresDocumentProjectionFacts>;
  scopeContributions: ReturnType<typeof createPostgresProjectionScopeContributions>;
  work: ReturnType<typeof createPostgresDocumentArtifactWorkRepository>;
  tokenizer: LexicalTokenizer;
  activationOwners: ReturnType<typeof createPostgresScopedActivationOwnerRepository>;
  objectWriter: StorageVnextImmutableObjectWriter;
  ownership: StorageVnextOwnershipRepository;
  lanes: ReturnType<typeof createDocumentResourceLanes>;
  now?: () => string;
}) {
  const clock = input.now ?? (() => new Date().toISOString());
  return async (request: {
    claimed: ClaimedDocumentArtifactWork;
    signal: AbortSignal;
    releasePrimaryLane(): void;
  }) => {
    const context = await input.contexts.read(request.claimed);
    const [currentBase, prepared, relationReceipt] = await input.lanes.run(
      "postgres_s3",
      () => Promise.all([
        input.pageBase({ claimed: request.claimed, signal: request.signal }),
        input.preparedSources({ claimed: request.claimed, signal: request.signal }),
        input.receipts.findForRevision({
          knowledgeBaseId: request.claimed.knowledgeBaseId,
          sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
          kind: "relation_reconciliation",
          key: "relationships"
        })
      ]),
      request.signal
    );
    const relationPlan = readDocumentRelationPlan(relationReceipt?.value);
    const renderableRelations = await input.relations.listRenderable({
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      currentSourceFilePublicId: request.claimed.sourceFilePublicId,
      currentSourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      affectedSourceFilePublicIds: relationPlan.affectedSourceFilePublicIds,
      limit: 10_000
    });
    const renderSourceIds = documentProjectionSourceFileIds({
      currentSourceFilePublicId: request.claimed.sourceFilePublicId,
      affectedSourceFilePublicIds: relationPlan.affectedSourceFilePublicIds,
      relations: renderableRelations
    });
    const sources = await input.lanes.run("postgres_s3", async () => {
      const storedBases = await input.bases.listForSources({
        knowledgeBaseId: request.claimed.knowledgeBaseId,
        sourceFilePublicIds: renderSourceIds,
        includeSourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
        limit: 10_000
      });
      const baseBySource = new Map(storedBases.map((base) => [
        base.sourceFilePublicId,
        base
      ]));
      const availableSourceIds = documentProjectionAvailableSourceFileIds({
        currentSourceFilePublicId: request.claimed.sourceFilePublicId,
        requestedSourceFilePublicIds: renderSourceIds,
        availableBaseSourceFilePublicIds: storedBases.map(
          (base) => base.sourceFilePublicId
        )
      });
      return Promise.all(availableSourceIds.map(async (sourceFilePublicId) => {
        if (sourceFilePublicId === request.claimed.sourceFilePublicId) {
          return currentBase.snapshot;
        }
        return input.loadBase({
          base: baseBySource.get(sourceFilePublicId)!,
          signal: request.signal
        });
      }));
    }, request.signal);
    const semanticSearch = await input.semanticSearch({
      claimed: request.claimed,
      context,
      prepared,
      sources,
      relations: renderableRelations,
      affectedSourceFilePublicIds: relationPlan.affectedSourceFilePublicIds,
      signal: request.signal
    });
    const projection = await renderProjection({
      input,
      request,
      prepared,
      sources,
      relations: renderableRelations,
      relationPlan
    });
    const persisted = await input.lanes.run("postgres_s3", () => persistProjection({
        input,
        request,
        context,
        projection,
        semanticSearch,
        relationPlan,
        currentBase: currentBase.snapshot,
        completedAt: clock()
      }), request.signal);
    const transitioned = await input.work.waitForProjectionWithMutation({
      publicId: request.claimed.publicId,
      workerId: request.claimed.leaseOwner,
      now: clock(),
      receipt: {
        kind: "generated_page",
        key: persisted.receipt.key,
        inputFingerprintSha256: request.claimed.inputFingerprintSha256,
        outputFingerprintSha256: persisted.receipt.outputFingerprintSha256,
        value: persisted.receipt.value
      },
      async apply(transaction) {
        await createPostgresDocumentProjectionFacts(transaction)
          .replaceRevision(persisted.projectionFact);
        const dirtyScopes = createPostgresProjectionDirtyScopeRepository(transaction);
        const scopeRows = [];
        for (const scope of persisted.scopes) {
          const marked = await dirtyScopes.markWithSequence({
            knowledgeBaseId: request.claimed.knowledgeBaseId,
            ...scope,
            requiredSequence: context.job.readinessSequence,
            nextEligibleAt: persisted.receipt.serviceEndedAt
          });
          scopeRows.push(marked);
        }
        await createPostgresProjectionScopeContributions(transaction).contribute({
          knowledgeBaseId: request.claimed.knowledgeBaseId,
          sourceFilePublicId: request.claimed.sourceFilePublicId,
          sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
          documentJobPublicId: request.claimed.documentJobPublicId,
          scopes: scopeRows
        });
      }
    });
    if (!transitioned) throw projectionError("document_projection_lease_lost");
    request.releasePrimaryLane();
    return {
      ...persisted.receipt,
      committedByHandler: true,
      disposition: "waiting_on_projection" as const
    };
  };
}

async function renderProjection(input: {
  input: Parameters<typeof createProductionDocumentKnowledgeProjectionWorkHandler>[0];
  request: { claimed: ClaimedDocumentArtifactWork; signal: AbortSignal };
  prepared: Awaited<ReturnType<ReturnType<typeof createDocumentPreparedSourceLoader>>>;
  sources: Awaited<ReturnType<ReturnType<typeof createDocumentPageBaseLoader>>>[];
  relations: Awaited<ReturnType<ReturnType<typeof createPostgresCandidateFileRelationRepository>["listRenderable"]>>;
  relationPlan: DocumentRelationPlan;
}) {
  const prior = await input.input.generatedContext.readActiveSourcePresentation({
    knowledgeBaseId: input.request.claimed.knowledgeBaseId,
    sourceFilePublicId: input.request.claimed.sourceFilePublicId
  });
  const sourceFilePublicIds = documentProjectionSourceFileIds({
    currentSourceFilePublicId: input.request.claimed.sourceFilePublicId,
    affectedSourceFilePublicIds: input.relationPlan.affectedSourceFilePublicIds,
    relations: input.relations
  });
  const graphSourceFilePublicIds = input.relationPlan.affectedSourceFilePublicIds;
  const graphDirectoryPaths = documentProjectionGraphDirectoryPaths({
    enabled: shouldProjectDocumentGraphDirectories({
      relationCount: input.relations.length,
      affectedSourceFileCount: graphSourceFilePublicIds.length,
      hasPriorPresentation: prior !== null
    }),
    currentSourceFilePublicId: input.request.claimed.sourceFilePublicId,
    affectedSourceFilePublicIds: graphSourceFilePublicIds,
    sourcePaths: input.sources.map((source) => ({
      sourceFilePublicId: source.sourceFilePublicId,
      logicalPath: source.logicalPath
    })),
    ...(prior ? { priorCurrentLogicalPath: prior.logicalPath } : {})
  });
  const directoryPaths = [...new Set([
    ...pageDirectoryAncestors(`pages/${input.prepared.context.source.logicalPath}`),
    ...(prior ? pageDirectoryAncestors(`pages/${prior.logicalPath}`) : [])
  ])].sort();
  return {
    sourceFilePublicIds,
    navigationMutations: [],
    relationPublicIds: input.relations.map((relation) => relation.publicId),
    relations: input.relations,
    graphDirectoryPaths,
    directoryPaths
  };
}

async function persistProjection(input: {
  input: Parameters<typeof createProductionDocumentKnowledgeProjectionWorkHandler>[0];
  request: { claimed: ClaimedDocumentArtifactWork; signal: AbortSignal };
  context: Awaited<ReturnType<ReturnType<typeof createPostgresDocumentWorkContext>["read"]>>;
  projection: Awaited<ReturnType<typeof renderProjection>>;
  semanticSearch: Awaited<ReturnType<ReturnType<
    typeof createProductionDocumentSemanticSearchProjection
  >>>;
  relationPlan: DocumentRelationPlan;
  currentBase: Awaited<ReturnType<ReturnType<typeof createDocumentPageBaseLoader>>>;
  completedAt: string;
}) {
  const projectionFact = buildDocumentProjectionFact({
    knowledgeBaseId: input.request.claimed.knowledgeBaseId,
    sourceFilePublicId: input.request.claimed.sourceFilePublicId,
    sourceRevisionPublicId: input.request.claimed.sourceRevisionPublicId,
    source: input.context.source,
    base: input.currentBase,
    tokenizer: input.input.tokenizer,
    relationPublicIds: input.projection.relationPublicIds,
    relations: input.projection.relations
  });
  const priorTermState = await input.input.machineProjection
    .readNavigationTermBucketState({
      knowledgeBaseId: input.request.claimed.knowledgeBaseId,
      affectedSourceFilePublicIds: [input.request.claimed.sourceFilePublicId]
    });
  const termBuckets = [...new Set([
    ...priorTermState.affectedBuckets,
    ...projectionFact.navigationTerms.map((term) =>
      classifyDocumentNavigationTerm(term.term))
  ])].sort();
  const staged = {
    pageCandidates: [],
    removedNormalizedPaths: []
  };
  const families = await input.input.searchFamilies.listAcknowledged({
    knowledgeBaseId: input.request.claimed.knowledgeBaseId,
    sourceRevisionPublicId: input.request.claimed.sourceRevisionPublicId
  });
  const graphSourceFilePublicIds = input.projection.relationPublicIds.length > 0
    || input.relationPlan.affectedSourceFilePublicIds.length > 1
    ? input.relationPlan.affectedSourceFilePublicIds
    : [];
  const scopes = documentProjectionScopes({
    relationPublicIds: input.projection.relationPublicIds,
    graphSourceFilePublicIds,
    sourceFilePublicIds: input.projection.sourceFilePublicIds,
    directoryPaths: input.projection.directoryPaths,
    graphDirectoryPaths: input.projection.graphDirectoryPaths,
    navigationMutations: input.projection.navigationMutations,
    pages: staged.pageCandidates,
    termBuckets
  });
  const ownerRequests = documentActivationOwnerRequests({
    sourceFilePublicId: input.request.claimed.sourceFilePublicId,
    sourceRevisionPublicId: input.request.claimed.sourceRevisionPublicId,
    pairPublicIds: input.relationPlan.pairPublicIds,
    familyPublicIds: families.map((family) => family.publicId),
    pageCandidates: staged.pageCandidates,
    removedPaths: staged.removedNormalizedPaths,
    navigationMutations: input.projection.navigationMutations
  });
  const versions = await input.input.activationOwners.readVersions({
    knowledgeBaseId: input.request.claimed.knowledgeBaseId,
    owners: ownerRequests
  });
  const manifest: DocumentKnowledgeProjectionManifest = {
    schemaVersion: "document-knowledge-projection-manifest-v1",
    knowledgeBaseId: input.request.claimed.knowledgeBaseId,
    documentJobPublicId: input.request.claimed.documentJobPublicId,
    sourceFilePublicId: input.request.claimed.sourceFilePublicId,
    sourceRevisionPublicId: input.request.claimed.sourceRevisionPublicId,
    readinessSequence: input.context.job.readinessSequence,
    presentation: {
      logicalPath: input.currentBase.logicalPath,
      normalizedPath: input.context.source.normalizedPath,
      title: input.currentBase.title,
      metadata: input.currentBase.metadata,
      modelSuggestions: input.currentBase.modelSuggestions ?? null
    },
    affectedSourceFilePublicIds: input.relationPlan.affectedSourceFilePublicIds,
    relationPublicIds: input.projection.relationPublicIds,
    searchFamilyPublicIds: families.map((family) => family.publicId),
    relationshipSearchDocumentPublicIds:
      input.semanticSearch.relationshipSearchDocumentPublicIds,
    pageCandidates: staged.pageCandidates,
    removedPageNormalizedPaths: staged.removedNormalizedPaths,
    navigationMutations: input.projection.navigationMutations,
    dirtyScopes: scopes,
    activationOwners: documentProjectionActivationOwnerVersions({
      owners: ownerRequests,
      versions
    }),
    projectedAt: input.completedAt
  };
  const receipt = await storeDocumentProjectionManifest({
    manifest,
    objectWriter: input.input.objectWriter,
    ownership: input.input.ownership,
    signal: input.request.signal
  });
  return { receipt, scopes, projectionFact };
}

function pageDirectoryAncestors(pagePath: string): string[] {
  const directories = [posix.dirname(pagePath)];
  while (directories.at(-1) !== "pages") {
    directories.push(posix.dirname(directories.at(-1)!));
  }
  return directories.reverse();
}
function projectionError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document knowledge projection error: ${code}`), {
    code
  });
}
