import { createHash } from "node:crypto";

type CountPair = Readonly<{ expected: number; actual: number }>;

export type DocumentPublicationValidationEvidence = Readonly<{
  scopeIdentity: string;
  sourceTargets: Readonly<{ checked: number; missing: number }>;
  linkTargets: Readonly<{ checked: number; missing: number }>;
  continuationChains: Readonly<{ checked: number; broken: number }>;
  navigation: CountPair;
  graph: Readonly<{ outgoing: number; incoming: number }>;
  indexes: CountPair;
  tombstones: CountPair;
  search: Readonly<{ expected: number; ready: number }>;
}>;

export function validateDocumentPublicationGeneration(input: Readonly<{
  generationPublicId: string;
  generationDocumentCount: number;
  includedFactCount: number;
  scopeCount: number;
  incompleteScopeCount: number;
  incompleteDependencyCount: number;
  putCount: number;
  deleteCount: number;
  unverifiedObjectCount: number;
  missingObjectReferenceCount: number;
  duplicatePathCount: number;
  duplicateDirectoryOwnerCount: number;
  scopes: readonly Readonly<{
    scopeIdentity: string;
    inputFingerprintSha256: string;
    outputFingerprintSha256: string;
    pages: readonly Readonly<{
      normalizedPath: string;
      action: "put" | "delete";
      checksumSha256: string | null;
    }>[];
  }>[];
  evidence: readonly DocumentPublicationValidationEvidence[];
}>) {
  validateBoundedInput(input);
  const failed = new Set<string>();
  if (input.generationDocumentCount !== input.includedFactCount) {
    failed.add("generation_membership");
  }
  if (input.incompleteScopeCount !== 0
    || input.scopes.length !== input.scopeCount) {
    failed.add("scope_completion");
  }
  if (input.incompleteDependencyCount !== 0) {
    failed.add("dependency_closure");
  }
  if (input.unverifiedObjectCount !== 0
    || input.missingObjectReferenceCount !== 0) {
    failed.add("object_integrity");
  }
  if (input.duplicatePathCount !== 0
    || input.duplicateDirectoryOwnerCount !== 0) {
    failed.add("owner_identity");
  }
  for (const evidence of input.evidence) validateEvidence(evidence, failed);
  const scopes = [...input.scopes].map((scope) => ({
    ...scope,
    pages: [...scope.pages].sort((left, right) =>
      bytewise(left.normalizedPath, right.normalizedPath))
  })).sort((left, right) => bytewise(left.scopeIdentity, right.scopeIdentity));
  const evidence = [...input.evidence].sort((left, right) =>
    bytewise(left.scopeIdentity, right.scopeIdentity));
  const failedChecks = [...failed].sort(bytewise);
  return {
    state: failedChecks.length === 0 ? "passed" as const : "failed" as const,
    failedChecks,
    checkedCount: input.scopeCount + input.putCount + input.deleteCount,
    outputFingerprintSha256: createHash("sha256").update(canonicalJson({
      generationPublicId: input.generationPublicId,
      documents: input.generationDocumentCount,
      puts: input.putCount,
      deletes: input.deleteCount,
      scopes,
      evidence
    })).digest("hex")
  };
}

function validateEvidence(
  evidence: DocumentPublicationValidationEvidence,
  failed: Set<string>
): void {
  if (evidence.sourceTargets.missing > 0) failed.add("source_targets");
  if (evidence.linkTargets.missing > 0) failed.add("link_targets");
  if (evidence.continuationChains.broken > 0) {
    failed.add("continuation_chains");
  }
  if (evidence.navigation.expected !== evidence.navigation.actual) {
    failed.add("navigation_coverage");
  }
  if (evidence.graph.outgoing !== evidence.graph.incoming) {
    failed.add("graph_direction_parity");
  }
  if (evidence.indexes.expected !== evidence.indexes.actual) {
    failed.add("index_coverage");
  }
  if (evidence.tombstones.expected !== evidence.tombstones.actual) {
    failed.add("tombstone_coverage");
  }
  if (evidence.search.expected !== evidence.search.ready) {
    failed.add("search_readiness");
  }
}

function validateBoundedInput(input: Readonly<{
  generationPublicId: string;
  scopeCount: number;
  scopes: readonly unknown[];
  evidence: readonly unknown[];
  [key: string]: unknown;
}>): void {
  if (!input.generationPublicId || input.scopeCount < 1
    || input.scopeCount > 10_000 || input.scopes.length > 10_000
    || input.evidence.length > 10_000) {
    throw validationError("publication_generation_validation_input_invalid");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => bytewise(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function validationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication validation error: ${code}`), {
    code
  });
}
