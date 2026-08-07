import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

type ContinuitySnapshot = {
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

let assertContinuity:
  | ((input: {
      before: ContinuitySnapshot;
      after: ContinuitySnapshot;
    }) => void)
  | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/search/provider-continuity.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      assertSearchProviderContinuity?: typeof assertContinuity;
    };
  assertContinuity = loaded.assertSearchProviderContinuity;
});

describe("search provider continuity Red contract", () => {
  it("allows only provider-owned search identity to change", () => {
    const before = snapshot();
    const after = {
      ...before,
      searchProvider: "opensearch" as const,
      searchProjectionHash: "opensearch-projection"
    };

    expect(() => verify(before, after)).not.toThrow();
  });

  it.each([
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
  ] as const)("rejects a changed %s", (field) => {
    const before = snapshot();
    const after = { ...before, [field]: `changed-${field}` };

    expect(() => verify(before, after)).toThrow(field);
  });
});

function verify(before: ContinuitySnapshot, after: ContinuitySnapshot): void {
  if (!assertContinuity) {
    throw new Error("Search provider continuity guard is unavailable");
  }
  assertContinuity({ before, after });
}

function snapshot(): ContinuitySnapshot {
  return {
    sourceRecordsHash: "source-records",
    generatedMarkdownHash: "generated-markdown",
    rootNavigationHash: "root-navigation",
    directoryNavigationHash: "directory-navigation",
    indexArtifactsHash: "index-artifacts",
    graphArtifactsHash: "graph-artifacts",
    graphFactsHash: "graph-facts",
    modelOutputHash: "model-output",
    adminContractHash: "admin-contract",
    developerOpenApiHash: "developer-openapi",
    searchProvider: "meilisearch",
    searchProjectionHash: "meilisearch-projection"
  };
}
