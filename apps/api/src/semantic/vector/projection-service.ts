import type {
  SearchProviderOperationReceipt,
  SearchProviderVectorPort
} from "../../application/ports/search-provider-runtime.js";
import { sameSearchProviderVectorIndexDefinition } from
  "../../application/ports/search-provider-runtime.js";
import type { SemanticVectorProjectionPlan } from "./projection-planner.js";

export type SemanticVectorProjectionRepositoryPort = {
  listSourceDocuments(input: {
    knowledgeBaseId: string;
    semanticGenerationPublicId: string;
    sourceFilePublicId: string;
    limit: number;
  }): Promise<readonly { publicId: string; ownerPublicId: string }[]>;
  prepareImpacts(input: {
    plan: SemanticVectorProjectionPlan;
    preparedAt: string;
  }): Promise<{ prepared: number; deleted: number }>;
  confirmImpacts(input: {
    plan: SemanticVectorProjectionPlan;
    confirmedAt: string;
  }): Promise<boolean>;
};

export function createSemanticVectorProjectionService(input: {
  provider: SearchProviderVectorPort;
  repository: SemanticVectorProjectionRepositoryPort;
  isCurrent(plan: SemanticVectorProjectionPlan): Promise<boolean>;
  now?: () => string;
  maximumOperationPolls?: number;
  operationPollIntervalMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}) {
  const now = input.now ?? (() => new Date().toISOString());
  const maximumOperationPolls = input.maximumOperationPolls ?? 100;
  const operationPollIntervalMs = input.operationPollIntervalMs ?? 100;
  const wait = input.wait ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  if (!Number.isSafeInteger(maximumOperationPolls) || maximumOperationPolls < 1
    || maximumOperationPolls > 10_000
    || !Number.isSafeInteger(operationPollIntervalMs)
    || operationPollIntervalMs < 0 || operationPollIntervalMs > 30_000) {
    throw projectionError("semantic_vector_invalid_limits");
  }
  return {
    async apply(plan: SemanticVectorProjectionPlan) {
      await assertCurrent(input, plan);
      const prepared = await input.repository.prepareImpacts({
        plan,
        preparedAt: now()
      });
      if (prepared.prepared !== plan.desiredDocuments.length
        || prepared.deleted < 0
        || prepared.deleted > plan.providerDeleteDocumentIds.length) {
        throw projectionError("semantic_vector_repository_mismatch");
      }
      await assertCurrent(input, plan);
      const existing = await input.provider.getIndexDefinition({
        indexUid: plan.candidateIndexUid
      });
      if (existing === null) {
        try {
          await awaitReceipt(await input.provider.createIndex({
            indexUid: plan.candidateIndexUid,
            definition: plan.definition
          }));
        } catch (creationError) {
          let concurrentDefinition = null;
          try {
            concurrentDefinition = await input.provider.getIndexDefinition({
              indexUid: plan.candidateIndexUid
            });
          } catch {
            throw creationError;
          }
          if (concurrentDefinition === null
            || !sameSearchProviderVectorIndexDefinition(
              concurrentDefinition,
              plan.definition
            )) {
            throw creationError;
          }
        }
        await assertCurrent(input, plan);
      } else if (!sameSearchProviderVectorIndexDefinition(existing, plan.definition)) {
        throw projectionError("semantic_vector_mapping_mismatch");
      }
      if (plan.providerDocuments.length > 0) {
        await awaitReceipt(await input.provider.writeDocuments({
          indexUid: plan.candidateIndexUid,
          definition: plan.definition,
          documents: plan.providerDocuments,
          correlation: correlation(plan, "upsert")
        }));
        await assertCurrentOrCompensate(plan);
      }
      if (plan.providerDeleteDocumentIds.length > 0) {
        await awaitReceipt(await input.provider.deleteDocuments({
          indexUid: plan.candidateIndexUid,
          knowledgeBaseId: plan.knowledgeBaseId,
          semanticGenerationPublicId: plan.semanticGenerationPublicId,
          documentIds: plan.providerDeleteDocumentIds,
          correlation: correlation(plan, "delete")
        }));
        await assertCurrentOrCompensate(plan);
      }
      if (!await input.repository.confirmImpacts({ plan, confirmedAt: now() })) {
        await compensateLateUpserts(plan);
        throw projectionError("semantic_vector_superseded");
      }
      return plan.counters;
    }
  };

  async function awaitReceipt(receipt: SearchProviderOperationReceipt): Promise<void> {
    if (receipt.state === "completed") return;
    for (let poll = 0; poll < maximumOperationPolls; poll += 1) {
      const status = await input.provider.getOperation({
        operationRef: receipt.operationRef
      });
      if (status.state === "completed") return;
      if (status.state === "failed") {
        throw projectionError("semantic_vector_provider_failed");
      }
      await wait(operationPollIntervalMs);
    }
    throw projectionError("semantic_vector_provider_timeout");
  }

  async function assertCurrentOrCompensate(
    plan: SemanticVectorProjectionPlan
  ): Promise<void> {
    if (await input.isCurrent(plan)) return;
    await compensateLateUpserts(plan);
    throw projectionError("semantic_vector_superseded");
  }

  async function compensateLateUpserts(
    plan: SemanticVectorProjectionPlan
  ): Promise<void> {
    const documentIds = plan.providerDocuments.map((document) => document.id);
    if (documentIds.length === 0) return;
    try {
      await awaitReceipt(await input.provider.deleteDocuments({
        indexUid: plan.candidateIndexUid,
        knowledgeBaseId: plan.knowledgeBaseId,
        semanticGenerationPublicId: plan.semanticGenerationPublicId,
        documentIds,
        correlation: correlation(plan, "delete") + ":late-output"
      }));
    } catch {
      throw projectionError("semantic_vector_compensation_failed");
    }
  }
}

async function assertCurrent(
  input: { isCurrent(plan: SemanticVectorProjectionPlan): Promise<boolean> },
  plan: SemanticVectorProjectionPlan
): Promise<void> {
  if (!await input.isCurrent(plan)) {
    throw projectionError("semantic_vector_superseded");
  }
}

function correlation(
  plan: SemanticVectorProjectionPlan,
  action: "upsert" | "delete"
): string {
  return `${plan.candidateIndexUid}:${action}`;
}

function projectionError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Semantic vector projection failed: ${code}`), { code });
}
