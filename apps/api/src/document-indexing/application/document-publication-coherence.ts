export function isDocumentPublicationGenerationCoherent(input: Readonly<{
  generationPublicId: string;
  targetFactEpoch: number;
  requiredScopeIdentities: readonly string[];
  scopes: readonly Readonly<{
    scopeIdentity: string;
    publicationGenerationPublicId: string | null;
    factEpoch: number | null;
    state: "waiting" | "running" | "completed" | "error";
  }>[];
}>): boolean {
  if (!input.generationPublicId
    || !Number.isSafeInteger(input.targetFactEpoch)
    || input.targetFactEpoch < 0) return false;
  const required = new Set(input.requiredScopeIdentities);
  if (required.size !== input.requiredScopeIdentities.length) return false;
  const byIdentity = new Map(input.scopes.map((scope) => [
    scope.scopeIdentity,
    scope
  ]));
  return byIdentity.size === input.scopes.length
    && byIdentity.size === required.size
    && [...required].every((identity) => {
      const scope = byIdentity.get(identity);
      return scope?.state === "completed"
        && scope.publicationGenerationPublicId === input.generationPublicId
        && scope.factEpoch === input.targetFactEpoch;
    });
}
