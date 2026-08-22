import { createHash } from "node:crypto";
import type { createDocumentResourceLanes } from "../application/document-resource-lanes.js";
import type { ClaimedDocumentArtifactWork } from "../application/document-work-port.js";
import type { createDocumentPageBaseLoader } from "./document-page-base-loader.js";
import type { createDocumentPreparedSourceLoader } from "./document-prepared-source-loader.js";
import type { createPostgresCandidateFileRelationRepository } from "./postgres-candidate-file-relation-repository.js";
import type { createPostgresDocumentReceiptRepository } from "./postgres-document-receipt-repository.js";
import type { createPostgresDocumentWorkContext } from "./postgres-document-work-context.js";
import type { createPostgresGeneratedPageBaseRepository } from "./postgres-generated-page-base-repository.js";
import { createPostgresDocumentProjectionFacts } from
  "./postgres-document-projection-facts.js";
import type { createPostgresDocumentArtifactWorkRepository } from
  "./postgres-document-artifact-work-repository.js";
import type { createProductionDocumentSemanticSearchProjection } from "./production-document-semantic-search-projection.js";
import type { createProductionDocumentPageBase } from "./production-document-page-base.js";
import {
  documentProjectionAvailableSourceFileIds,
  documentProjectionRenderableSourceFileIds,
  readDocumentRelationPlan,
  type DocumentRelationPlan
} from "./document-knowledge-projection-support.js";
import type { LexicalTokenizer } from
  "../../application/ports/lexical-tokenizer.js";
import { buildDocumentProjectionFact } from
  "./document-projection-persistence-plan.js";
import {
  documentSourcePathRewrites,
  renderAffectedDocumentSourcePages
} from "../application/document-affected-source-pages.js";
import { allocatePostgresDocumentFactEpoch } from
  "./postgres-document-publication-repository.js";

export function createProductionDocumentKnowledgeProjectionWorkHandler(input: {
  contexts: ReturnType<typeof createPostgresDocumentWorkContext>;
  preparedSources: ReturnType<typeof createDocumentPreparedSourceLoader>;
  receipts: ReturnType<typeof createPostgresDocumentReceiptRepository>;
  pageBase: ReturnType<typeof createProductionDocumentPageBase>;
  bases: ReturnType<typeof createPostgresGeneratedPageBaseRepository>;
  loadBase: ReturnType<typeof createDocumentPageBaseLoader>;
  relations: ReturnType<typeof createPostgresCandidateFileRelationRepository>;
  semanticSearch: ReturnType<
    typeof createProductionDocumentSemanticSearchProjection
  >;
  work: ReturnType<typeof createPostgresDocumentArtifactWorkRepository>;
  tokenizer: LexicalTokenizer;
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
    const receivedRelationPlan = readDocumentRelationPlan(relationReceipt?.value);
    const relationPlan: DocumentRelationPlan = {
      ...receivedRelationPlan,
      relationPublicIds: receivedRelationPlan.relationPublicIds
        ?? await input.relations.listPublicIdsForPairs({
          knowledgeBaseId: request.claimed.knowledgeBaseId,
          pairPublicIds: receivedRelationPlan.pairPublicIds,
          limit: 10_000
        })
    };
    const renderableRelations = await input.relations.listRenderable({
      knowledgeBaseId: request.claimed.knowledgeBaseId,
      currentSourceFilePublicId: request.claimed.sourceFilePublicId,
      currentSourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
      affectedSourceFilePublicIds: [request.claimed.sourceFilePublicId],
      limit: 10_000
    });
    const renderSourceIds = documentProjectionRenderableSourceFileIds({
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
        sources,
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
        await createPostgresDocumentProjectionFacts(transaction)
          .replaceGeneratedPageIntegrity({
            knowledgeBaseId: request.claimed.knowledgeBaseId,
            pages: persisted.generatedPageFacts
          });
        await allocatePostgresDocumentFactEpoch({
          transaction,
          knowledgeBaseId: request.claimed.knowledgeBaseId,
          mutationPublicId: request.claimed.documentJobPublicId,
          sourceFilePublicId: request.claimed.sourceFilePublicId,
          sourceRevisionPublicId: request.claimed.sourceRevisionPublicId,
          factKind: projectionFactKind({
            operationKind: context.job.operationKind,
            priorActiveSourceRevisionPublicId:
              context.source.priorActiveSourceRevisionPublicId
          }),
          createdAt: persisted.receipt.serviceEndedAt
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
  return { relations: input.relations };
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
  sources: Awaited<ReturnType<ReturnType<typeof createDocumentPageBaseLoader>>>[];
  currentBase: Awaited<ReturnType<ReturnType<typeof createDocumentPageBaseLoader>>>;
  completedAt: string;
}) {
  const generatedPages = renderAffectedDocumentSourcePages({
    sources: input.sources,
    renderSourceFilePublicIds: [input.request.claimed.sourceFilePublicId],
    relations: input.projection.relations,
    sourcePathRewrites: documentSourcePathRewrites(input.sources)
  });
  const currentGeneratedPage = generatedPages.find((page) =>
    page.sourceFilePublicId === input.request.claimed.sourceFilePublicId);
  if (!currentGeneratedPage) {
    throw projectionError("document_projection_generated_page_missing");
  }
  const projectionFact = buildDocumentProjectionFact({
    knowledgeBaseId: input.request.claimed.knowledgeBaseId,
    sourceFilePublicId: input.request.claimed.sourceFilePublicId,
    sourceRevisionPublicId: input.request.claimed.sourceRevisionPublicId,
    source: input.context.source,
    base: input.currentBase,
    generatedPage: currentGeneratedPage,
    tokenizer: input.input.tokenizer,
    relationPublicIds: input.projection.relations.map((relation) =>
      relation.publicId),
    relations: input.projection.relations
  });
  const outputFingerprintSha256 = createHash("sha256").update(JSON.stringify({
    sourceRevisionPublicId: input.request.claimed.sourceRevisionPublicId,
    generatedPageChecksumSha256: currentGeneratedPage.checksumSha256,
    relationPublicIds: input.projection.relations.map((relation) =>
      relation.publicId).sort()
  })).digest("hex");
  const receipt = {
    key: "closure",
    outputFingerprintSha256,
    value: {
      schemaVersion: "document-publication-fact-receipt-v1",
      sourceFilePublicId: input.request.claimed.sourceFilePublicId,
      sourceRevisionPublicId: input.request.claimed.sourceRevisionPublicId
    },
    serviceEndedAt: input.completedAt
  };
  const sourceRevisionByFileId = new Map(input.sources.map((source) => [
    source.sourceFilePublicId,
    source.sourceRevisionPublicId
  ]));
  const generatedPageFacts = generatedPages.map((page) => ({
    sourceRevisionPublicId: sourceRevisionByFileId.get(page.sourceFilePublicId)!,
    checksumSha256: page.checksumSha256,
    byteCount: page.byteCount
  }));
  return { receipt, projectionFact, generatedPageFacts };
}
function projectionError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document knowledge projection error: ${code}`), {
    code
  });
}

function projectionFactKind(input: Readonly<{
  operationKind: string;
  priorActiveSourceRevisionPublicId: string | null;
}>): "create" | "replace" | "move" | "delete" | "repair" {
  if (["source_file_move", "source_directory_move"]
    .includes(input.operationKind)) return "move";
  if (input.operationKind === "deletion") return "delete";
  if (input.operationKind === "maintenance") return "repair";
  if (input.operationKind === "source_replace"
    || input.priorActiveSourceRevisionPublicId) return "replace";
  return "create";
}
