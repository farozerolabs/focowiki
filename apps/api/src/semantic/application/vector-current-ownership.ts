import type { StorageVnextCatalogRepository } from
  "../../storage-vnext/catalog/ports.js";
import type { SemanticVectorProjectionPlan } from
  "../vector/projection-planner.js";

type CatalogPort = Pick<StorageVnextCatalogRepository,
  "getSourceFile" | "getCurrentSourceRevision">;

export async function semanticVectorPlanSourcesAreCurrent(
  catalog: CatalogPort,
  plan: SemanticVectorProjectionPlan,
  isOwnedCandidate?: (plan: SemanticVectorProjectionPlan) => Promise<boolean>
): Promise<boolean> {
  const sources = new Map<string, string>();
  for (const document of plan.desiredDocuments) {
    const prior = sources.get(document.sourceFilePublicId);
    if (prior && prior !== document.sourceRevisionPublicId) return false;
    sources.set(document.sourceFilePublicId, document.sourceRevisionPublicId);
  }
  let hasCandidate = false;
  for (const [sourceFilePublicId, sourceRevisionPublicId] of sources) {
    const [source, current] = await Promise.all([
      catalog.getSourceFile({
        knowledgeBaseId: plan.knowledgeBaseId,
        publicId: sourceFilePublicId,
        visibility: "current"
      }),
      catalog.getCurrentSourceRevision({
        knowledgeBaseId: plan.knowledgeBaseId,
        sourceFilePublicId
      })
    ]);
    if (!source) return false;
    if (!current || current.publicId !== sourceRevisionPublicId) hasCandidate = true;
  }
  return !hasCandidate || await isOwnedCandidate?.(plan) === true;
}
