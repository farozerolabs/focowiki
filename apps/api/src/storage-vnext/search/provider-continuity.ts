export type SearchProviderContinuitySnapshot = {
  sourceRecordsHash: string;
  generatedMarkdownHash: string;
  rootNavigationHash: string;
  directoryNavigationHash: string;
  indexArtifactsHash: string;
  graphArtifactsHash: string;
  graphFactsHash: string;
  modelOutputHash: string;
  adminContractHash: string;
  developerOpenApiHash: string;
  searchProvider: "meilisearch" | "opensearch";
  searchProjectionHash: string;
};

const CONTINUITY_FIELDS = [
  "sourceRecordsHash",
  "generatedMarkdownHash",
  "rootNavigationHash",
  "directoryNavigationHash",
  "indexArtifactsHash",
  "graphArtifactsHash",
  "graphFactsHash",
  "modelOutputHash",
  "adminContractHash",
  "developerOpenApiHash"
] as const satisfies readonly (keyof SearchProviderContinuitySnapshot)[];

export function assertSearchProviderContinuity(input: {
  before: SearchProviderContinuitySnapshot;
  after: SearchProviderContinuitySnapshot;
}): void {
  for (const field of CONTINUITY_FIELDS) {
    if (input.before[field] !== input.after[field]) {
      throw new Error(`Search provider continuity violation: ${field}`);
    }
  }
}
