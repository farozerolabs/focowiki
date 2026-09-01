import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type {
  SearchProviderVectorDocument,
  SearchProviderVectorFamily,
  SearchProviderVectorPort
} from "../src/application/ports/search-provider-runtime.js";
import type { OpenSearchClientPort } from
  "../src/infrastructure/opensearch/opensearch-client-port.js";
import { createOpenSearchClient } from
  "../src/infrastructure/opensearch/opensearch-client.js";
import { createOpenSearchVectorPort } from
  "../src/infrastructure/opensearch/opensearch-vector-port.js";
import { createMeilisearchTransport } from
  "../src/infrastructure/meilisearch/meilisearch-transport.js";
import { createMeilisearchVectorPort } from
  "../src/infrastructure/meilisearch/meilisearch-vector-port.js";
import { createValidatedSearchProviderVectorPort } from
  "../src/semantic/vector/provider-contract.js";

const openSearchEndpoint = process.env.FOCOWIKI_TEST_OPENSEARCH_URL;
const expectedOpenSearchVersion = process.env.FOCOWIKI_TEST_OPENSEARCH_VERSION;
const runOwner = process.env.FOCOWIKI_TEST_OPENSEARCH_RUN_OWNER;
const meilisearchEndpoint = process.env.FOCOWIKI_TEST_MEILISEARCH_URL;
const meilisearchApiKey = process.env.FOCOWIKI_TEST_MEILISEARCH_API_KEY;
const hasOwnedTargets = Boolean(
  openSearchEndpoint
  && expectedOpenSearchVersion
  && meilisearchEndpoint
  && meilisearchApiKey
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner ?? "")
);
const describeProviderParity = hasOwnedTargets ? describe : describe.skip;

describeProviderParity("semantic vector provider exact-oracle parity", () => {
  const suffix = `${runOwner}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const openSearchIndexUid = `focowiki_vector_os_${suffix}`;
  const meilisearchIndexUid = `focowiki_vector_meili_${suffix}`;
  const openSearchClient = createOpenSearchClient({
    config: {
      provider: "opensearch",
      endpoint: openSearchEndpoint ?? "http://127.0.0.1:1",
      indexPrefix: "focowiki_vector_parity",
      auth: { mode: "none" },
      tls: {}
    },
    requestTimeoutMs: 3_000,
    maxAttempts: 2
  }) as unknown as OpenSearchClientPort;
  const providers: readonly [
    { readonly indexUid: string; readonly port: SearchProviderVectorPort },
    { readonly indexUid: string; readonly port: SearchProviderVectorPort }
  ] = [{
    indexUid: openSearchIndexUid,
    port: createValidatedSearchProviderVectorPort(createOpenSearchVectorPort({
      client: openSearchClient,
      maximumAttempts: 2,
      retryDelayMs: 20
    }))
  }, {
    indexUid: meilisearchIndexUid,
    port: createValidatedSearchProviderVectorPort(createMeilisearchVectorPort({
      transport: createMeilisearchTransport({
        endpoint: meilisearchEndpoint ?? "http://127.0.0.1:1",
        apiKey: meilisearchApiKey ?? "unused-test-key",
        timeoutMs: 3_000,
        maxAttempts: 2,
        retryDelayMs: 20
      })
    }))
  }];

  afterAll(async () => {
    await Promise.all(providers.map(async ({ port, indexUid }) => {
      await settle(port, await port.deleteIndex({
        indexUid,
        correlation: `vector-oracle-cleanup-${indexUid}`
      })).catch(() => undefined);
    }));
    await openSearchClient.close();
  }, 30_000);

  it("matches exact cosine ordering for every public vector family", async () => {
    const documents = vectorDocuments();
    for (const { port, indexUid } of providers) {
      await settle(port, await port.createIndex({ indexUid, definition }));
      await settle(port, await port.writeDocuments({
        indexUid,
        definition,
        documents,
        correlation: `vector-oracle-${indexUid}`
      }));
      await waitForVisibleDocuments(port, indexUid, documents.length);
    }

    for (const family of definition.families) {
      const expected = exactOracle(documents, family, queryVector);
      for (const { port, indexUid } of providers) {
        const result = await port.query({
          indexUid,
          knowledgeBaseId: knowledgeBaseId,
          semanticGenerationPublicId: semanticGenerationPublicId,
          embeddingConfigurationRevisionPublicId: embeddingRevisionPublicId,
          family,
          fileKind: "page",
          dimension: definition.dimension,
          vector: queryVector,
          limit: expected.length,
          deadlineMs: 3_000
        });
        const actual = result.hits.map((hit) => hit.documentId);
        expect(recall(actual, expected), `${indexUid}:${family}`).toBe(1);
        expect(actual, `${indexUid}:${family}`).toEqual(expected);
      }
    }
  }, 60_000);
});

const knowledgeBaseId = "kb-vector-parity";
const semanticGenerationPublicId = "semantic-vector-parity";
const embeddingRevisionPublicId = "embedding-vector-parity";
const queryVector = [1, 0, 0, 0] as const;
const definition = {
  schemaVersion: "focowiki-semantic-vector-v1",
  dimension: 4,
  similarity: "cosine" as const,
  families: ["content", "entity", "relationship", "community"] as const,
  mappingFingerprintSha256: "d".repeat(64)
};

function vectorDocuments(): readonly SearchProviderVectorDocument[] {
  const vectors = [
    [1, 0, 0, 0],
    [0.9, 0.1, 0, 0],
    [0.8, 0.2, 0, 0],
    [0.7, 0.3, 0, 0]
  ] as const;
  return definition.families.flatMap((family) => vectors.map((vector, index) => ({
    id: `${family}-${index + 1}`,
    knowledgeBaseId,
    semanticGenerationPublicId,
    ownerPublicId: `${family}-owner-${index + 1}`,
    family,
    sourceFilePublicId: `${family}-file-${index + 1}`,
    sourceRevisionPublicId: `${family}-revision-${index + 1}`,
    embeddingConfigurationRevisionPublicId: embeddingRevisionPublicId,
    evidenceTargetPath: `pages/${family}-${index + 1}.md`,
    sourceExcerpt: `${family} evidence ${index + 1}`,
    fileKind: "page",
    vector
  })));
}

function exactOracle(
  documents: readonly SearchProviderVectorDocument[],
  family: SearchProviderVectorFamily,
  query: readonly number[]
): string[] {
  return documents.filter((document) => document.family === family)
    .map((document) => ({ id: document.id, score: cosine(document.vector, query) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map((item) => item.id);
}

function cosine(left: readonly number[], right: readonly number[]): number {
  const dot = left.reduce((sum, value, index) => sum + value * right[index]!, 0);
  const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
  return dot / (leftNorm * rightNorm);
}

function recall(actual: readonly string[], expected: readonly string[]): number {
  const actualIds = new Set(actual);
  return expected.filter((id) => actualIds.has(id)).length / expected.length;
}

async function settle(
  port: SearchProviderVectorPort,
  receipt: Awaited<ReturnType<SearchProviderVectorPort["createIndex"]>>
): Promise<void> {
  if (receipt.state === "completed") return;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = await port.getOperation({ operationRef: receipt.operationRef });
    if (status.state === "completed") return;
    if (status.state === "failed") {
      throw new Error(`Vector provider operation failed: ${status.errorCode}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Vector provider operation did not complete");
}

async function waitForVisibleDocuments(
  port: SearchProviderVectorPort,
  indexUid: string,
  expectedCount: number
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const count = await port.count({
      indexUid,
      knowledgeBaseId,
      semanticGenerationPublicId
    });
    if (count === expectedCount) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Vector provider documents did not become visible");
}
