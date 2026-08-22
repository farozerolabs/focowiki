import { createHash } from "node:crypto";

export type DocumentProjectionInvariantDiagnostic = Readonly<{
  invariantCode: string;
  normalizedPath: string | null;
  normalizedPathSha256: string;
  ownerScopeIdentities: readonly string[];
  factEpoch: number | null;
  scopeGenerations: readonly number[];
  checksums: readonly string[];
  tracePublicId: string | null;
}>;

export function createDocumentProjectionInvariantDiagnostic(input: Readonly<{
  invariantCode: string;
  normalizedPath: string;
  ownerScopeIdentities: readonly string[];
  factEpoch?: number | null;
  scopeGenerations?: readonly number[];
  checksums?: readonly string[];
  tracePublicId?: string | null;
}>): DocumentProjectionInvariantDiagnostic {
  const path = bounded(input.normalizedPath, 512);
  return {
    invariantCode: bounded(input.invariantCode, 128) ?? "projection_invariant",
    normalizedPath: path,
    normalizedPathSha256: createHash("sha256")
      .update(input.normalizedPath).digest("hex"),
    ownerScopeIdentities: uniqueBounded(
      input.ownerScopeIdentities,
      2,
      256
    ),
    factEpoch: safeInteger(input.factEpoch),
    scopeGenerations: [...new Set((input.scopeGenerations ?? [])
      .filter((value) => Number.isSafeInteger(value) && value >= 0))]
      .slice(0, 2),
    checksums: [...new Set((input.checksums ?? [])
      .filter((value) => /^[0-9a-f]{64}$/u.test(value)))]
      .slice(0, 2),
    tracePublicId: bounded(input.tracePublicId ?? null, 128)
  };
}

function uniqueBounded(
  values: readonly string[],
  limit: number,
  maximumLength: number
): string[] {
  return [...new Set(values.map((value) => bounded(value, maximumLength))
    .filter((value): value is string => value !== null))].slice(0, limit);
}

function bounded(value: string | null, maximumLength: number): string | null {
  if (typeof value !== "string" || value.length < 1) return null;
  return value.length <= maximumLength ? value : null;
}

function safeInteger(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : null;
}
