import type { DocumentPublicationScopeNode } from
  "./document-publication-planner.js";

export function eligibleDocumentPublicationScopes(input: Readonly<{
  scopes: readonly DocumentPublicationScopeNode[];
  completedScopeIdentities: ReadonlySet<string>;
  runningScopeIdentities: ReadonlySet<string>;
  limit: number;
}>): readonly DocumentPublicationScopeNode[] {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1
    || input.limit > 256) {
    throw new Error("DOCUMENT_PUBLICATION_DAG_LIMIT_INVALID");
  }
  return input.scopes.filter((scope) =>
    !input.completedScopeIdentities.has(scope.identity)
      && !input.runningScopeIdentities.has(scope.identity)
      && scope.dependsOn.every((dependency) =>
        input.completedScopeIdentities.has(dependency)))
    .slice(0, input.limit);
}
