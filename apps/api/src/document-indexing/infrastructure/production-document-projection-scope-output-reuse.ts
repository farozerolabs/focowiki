import type { DocumentProjectionScopeOutput } from
  "./postgres-projection-scope-output-repository.js";

export function reuseDocumentProjectionScopeOutput(
  output: DocumentProjectionScopeOutput
) {
  return {
    outputFingerprintSha256: output.outputFingerprintSha256,
    pages: output.pages,
    removedNormalizedPaths: output.removedNormalizedPaths,
    navigationMutations: output.navigationMutations,
    verifiedReservations: [] as const,
    storageRequests: {
      put: 0,
      head: 0,
      verification: 0,
      attemptedBytes: 0,
      retries: 0,
      latencyMilliseconds: 0
    },
    factCount: output.pages.length + output.removedNormalizedPaths.length,
    renderStartedAt: output.createdAt
  };
}
