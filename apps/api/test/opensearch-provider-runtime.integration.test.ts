import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenSearchClientPort } from
  "../src/infrastructure/opensearch/opensearch-client-port.js";
import type {
  SearchProviderOperationReceipt,
  SearchProviderQueryRequest,
  SearchProviderRuntime
} from "../src/application/ports/search-provider-runtime.js";
import { createMeilisearchTransport } from
  "../src/infrastructure/meilisearch/meilisearch-transport.js";
import { createMeilisearchProviderRuntime } from
  "../src/infrastructure/meilisearch/meilisearch-provider-runtime.js";
import { createOpenSearchClient } from
  "../src/infrastructure/opensearch/opensearch-client.js";
import { createOpenSearchProviderRuntime } from
  "../src/infrastructure/opensearch/opensearch-provider-runtime.js";
import { createOpenSearchQueryPort } from
  "../src/infrastructure/opensearch/opensearch-query-runtime.js";
import { createNodeJiebaTokenizer } from
  "../src/infrastructure/tokenization/nodejieba-tokenizer.js";
import {
  createStorageVnextContentDocument,
  createStorageVnextGraphSeedDocument
} from "../src/storage-vnext/search/documents.js";
import { createStorageVnextSearchSettings } from
  "../src/storage-vnext/search/settings.js";

const endpoint = process.env.FOCOWIKI_TEST_OPENSEARCH_URL;
const expectedVersion = process.env.FOCOWIKI_TEST_OPENSEARCH_VERSION;
const runOwner = process.env.FOCOWIKI_TEST_OPENSEARCH_RUN_OWNER;
const openSearchUsername = process.env.FOCOWIKI_TEST_OPENSEARCH_USERNAME;
const openSearchPassword = process.env.FOCOWIKI_TEST_OPENSEARCH_PASSWORD;
const openSearchCaFile = process.env.FOCOWIKI_TEST_OPENSEARCH_CA_FILE;
const meilisearchEndpoint = process.env.FOCOWIKI_TEST_MEILISEARCH_URL;
const meilisearchApiKey = process.env.FOCOWIKI_TEST_MEILISEARCH_API_KEY;
const hasOwnedTarget = Boolean(
  endpoint
  && expectedVersion
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner ?? "")
);
const describeOwnedOpenSearch = hasOwnedTarget ? describe : describe.skip;

describeOwnedOpenSearch("OpenSearch provider runtime integration", () => {
  const tokenizer = createNodeJiebaTokenizer();
  const definition = createStorageVnextSearchSettings({ searchCutoffMs: 1_000 });
  let lastResponseFailure: unknown = null;
  const rawClient = createOpenSearchClient({
    config: openSearchIntegrationConfig("focowiki_integration"),
    requestTimeoutMs: 3_000,
    maxAttempts: 3
  });
  rawClient.on("response", (error, result) => {
    if (!error) return;
    lastResponseFailure = {
      message: error instanceof Error ? error.message : "unknown",
      body: (result as { body?: unknown } | undefined)?.body ?? null
    };
  });
  const client = rawClient as unknown as OpenSearchClientPort;
  const provider = createOpenSearchProviderRuntime({
    client,
    tokenizer,
    bulkLimits: {
      maximumDocuments: 2,
      maximumBytes: 256_000,
      maximumInFlight: 2,
      maximumAttempts: 3,
      retryDelayMs: 25,
      deadlineMs: 10_000
    },
    visibility: { pollIntervalMs: 25, deadlineMs: 10_000 },
    query: createOpenSearchQueryPort({
      client,
      tokenizer,
      maximumResultWindow: definition.maximumTotalHits,
      engineSearchCutoffMs: definition.searchCutoffMs
    })
  });
  const indexUid = `focowiki_it_${runOwner}_${randomUUID()
    .replaceAll("-", "").slice(0, 12)}`;
  const partialFailureIndexUid = `${indexUid}_partial`;

  beforeAll(async () => {
    await provider.admin.deleteIndex({ indexUid });
    await provider.admin.deleteIndex({ indexUid: partialFailureIndexUid });
  });

  afterAll(async () => {
    await provider.admin.deleteIndex({ indexUid }).catch(() => undefined);
    await provider.admin.deleteIndex({
      indexUid: partialFailureIndexUid
    }).catch(() => undefined);
    await provider.close();
  });

  it("runs the standard provider lifecycle without optional plugins", async () => {
    await expect(provider.admin.health()).resolves.toEqual({
      available: true,
      version: expectedVersion
    });

    await expect(provider.admin.createIndex({ indexUid, definition }))
      .resolves.toEqual({ state: "completed" });
    await expect(provider.admin.getIndex({ indexUid })).resolves.toEqual({
      indexUid,
      primaryKey: "id"
    });
    await expect(provider.admin.getIndexDefinition({ indexUid }))
      .resolves.toEqual(definition);
    await expect(provider.admin.updateIndexDefinition({ indexUid, definition }))
      .resolves.toEqual({ state: "completed" });

    const documents = integrationDocuments();

    await expect(provider.write.writeDocuments({
      indexUid,
      documents,
      correlation: "integration-write"
    })).resolves.toEqual({ state: "completed" });
    await provider.write.refreshIndex({ indexUid });
    await expect(provider.validation.countDocuments({ indexUid })).resolves.toBe(4);

    const chinese = await provider.query.query(queryRequest({
      indexUid,
      query: "劳动合同",
      limit: 5
    })).catch((error: unknown) => {
      throw new Error(
        `OpenSearch integration query failed: ${JSON.stringify(lastResponseFailure)}`,
        { cause: error }
      );
    });
    expect(chinese.hits).toHaveLength(1);
    expect(chinese.hits[0]).toMatchObject({
      sourceFilePublicId: "file-contract",
      logicalPath: "pages/labor/contract.md"
    });
    expect(chinese.hits[0]?.snippets.length).toBeGreaterThan(0);

    const firstPage = await provider.query.query(queryRequest({
      indexUid,
      query: "employment",
      limit: 1
    }));
    expect(firstPage.hits).toHaveLength(1);
    expect(firstPage.continuation).toEqual(expect.any(String));
    const secondPage = await provider.query.query(queryRequest({
      indexUid,
      query: "employment",
      limit: 1,
      continuation: firstPage.continuation
    }));
    expect(secondPage.hits).toHaveLength(1);
    expect(secondPage.hits[0]?.sourceFilePublicId)
      .not.toBe(firstPage.hits[0]?.sourceFilePublicId);

    const firstScan = await provider.validation.scanDocuments({
      indexUid,
      continuation: null,
      limit: 2,
      fields: ["id", "sourceFilePublicId", "title"]
    });
    expect(firstScan.documents).toHaveLength(2);
    expect(firstScan.continuation).toEqual(expect.any(String));
    const secondScan = await provider.validation.scanDocuments({
      indexUid,
      continuation: firstScan.continuation,
      limit: 2,
      fields: ["id", "sourceFilePublicId", "title"]
    });
    expect(secondScan.documents).toHaveLength(2);
    expect(secondScan.continuation).toBeNull();

    await expect(provider.admin.createIndex({
      indexUid: partialFailureIndexUid,
      definition
    })).resolves.toEqual({ state: "completed" });
    const partial = await client.bulk({
      body: [{
        index: { _index: partialFailureIndexUid, _id: "valid" }
      }, {
        id: "valid",
        knowledgeBaseId: "kb-opensearch-integration"
      }, {
        index: { _index: partialFailureIndexUid, _id: "invalid" }
      }, {
        id: "invalid",
        unexpectedField: "strict mapping must reject this"
      }]
    });
    const partialBody = partial.body as {
      errors?: boolean;
      items?: Array<{ index?: { status?: number } }>;
    };
    expect(partialBody.errors).toBe(true);
    expect(partialBody.items?.map((item) => item.index?.status)).toEqual([201, 400]);

    await expect(provider.write.deleteDocuments({
      indexUid,
      documentIds: [documents[1]!.id],
      correlation: "integration-delete-one"
    })).resolves.toEqual({ state: "completed" });
    await provider.write.refreshIndex({ indexUid });
    await expect(provider.validation.countDocuments({ indexUid })).resolves.toBe(3);
    await expect(provider.write.deleteDocuments({
      indexUid,
      filters: {
        kind: "equals",
        field: "knowledgeBaseId",
        value: "kb-opensearch-integration"
      },
      correlation: "integration-delete-scope"
    })).resolves.toEqual({ state: "completed" });
    await provider.write.refreshIndex({ indexUid });
    await expect(provider.validation.countDocuments({ indexUid })).resolves.toBe(0);

    await expect(provider.admin.deleteIndex({ indexUid }))
      .resolves.toEqual({ state: "completed" });
    await expect(provider.admin.getIndex({ indexUid })).resolves.toBeNull();
    await expect(provider.admin.deleteIndex({ indexUid }))
      .resolves.toEqual({ state: "completed" });

    const unavailableClient = createOpenSearchClient({
      config: {
        provider: "opensearch",
        endpoint: "http://127.0.0.1:1",
        indexPrefix: "focowiki_integration",
        auth: { mode: "none" },
        tls: {}
      },
      requestTimeoutMs: 100,
      maxAttempts: 1
    }) as unknown as OpenSearchClientPort;
    const unavailableProvider = createOpenSearchProviderRuntime({
      client: unavailableClient,
      tokenizer,
      bulkLimits: {
        maximumDocuments: 1,
        maximumBytes: 1_000,
        maximumInFlight: 1,
        maximumAttempts: 1,
        retryDelayMs: 0,
        deadlineMs: 100
      },
      visibility: { pollIntervalMs: 10, deadlineMs: 100 },
      query: createOpenSearchQueryPort({
        client: unavailableClient,
        tokenizer,
        maximumResultWindow: 10,
        engineSearchCutoffMs: 50
      })
    });
    await expect(unavailableProvider.admin.health()).rejects.toMatchObject({
      code: "SEARCH_ENGINE_UNAVAILABLE",
      retryable: true
    });
    await unavailableProvider.close();
  }, 120_000);
});

const hasParityTarget = hasOwnedTarget && Boolean(
  meilisearchEndpoint && meilisearchApiKey
);
const describeProviderParity = hasParityTarget ? describe : describe.skip;

describeProviderParity("real search provider retrieval parity", () => {
  const tokenizer = createNodeJiebaTokenizer();
  const definition = createStorageVnextSearchSettings({ searchCutoffMs: 1_000 });
  const suffix = `${runOwner}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const openSearchIndexUid = `focowiki_parity_os_${suffix}`;
  const meilisearchIndexUid = `focowiki_parity_meili_${suffix}`;
  const openSearchClient = createOpenSearchClient({
    config: openSearchIntegrationConfig("focowiki_parity"),
    requestTimeoutMs: 3_000,
    maxAttempts: 2
  }) as unknown as OpenSearchClientPort;
  const openSearch = createOpenSearchProviderRuntime({
    client: openSearchClient,
    tokenizer,
    bulkLimits: {
      maximumDocuments: 2,
      maximumBytes: 256_000,
      maximumInFlight: 2,
      maximumAttempts: 2,
      retryDelayMs: 20,
      deadlineMs: 10_000
    },
    visibility: { pollIntervalMs: 20, deadlineMs: 10_000 },
    query: createOpenSearchQueryPort({
      client: openSearchClient,
      tokenizer,
      maximumResultWindow: definition.maximumTotalHits,
      engineSearchCutoffMs: definition.searchCutoffMs
    })
  });
  const meilisearch = createMeilisearchProviderRuntime(createMeilisearchTransport({
    endpoint: meilisearchEndpoint ?? "http://127.0.0.1:1",
    apiKey: meilisearchApiKey ?? "unused-test-key",
    timeoutMs: 3_000,
    maxAttempts: 2,
    retryDelayMs: 20
  }));

  afterAll(async () => {
    await settleProviderOperation(
      openSearch,
      await openSearch.admin.deleteIndex({ indexUid: openSearchIndexUid })
    ).catch(() => undefined);
    await settleProviderOperation(
      meilisearch,
      await meilisearch.admin.deleteIndex({ indexUid: meilisearchIndexUid })
    ).catch(() => undefined);
    await openSearch.close();
  }, 30_000);

  it("meets shared recall, NDCG, tie, pagination, and typed-query contracts", async () => {
    const documents = integrationDocuments();
    for (const [provider, indexUid] of [
      [openSearch, openSearchIndexUid],
      [meilisearch, meilisearchIndexUid]
    ] as const) {
      await settleProviderOperation(provider, await provider.admin.createIndex({
        indexUid,
        definition
      }));
      await settleProviderOperation(provider, await provider.admin.updateIndexDefinition({
        indexUid,
        definition
      }));
      await settleProviderOperation(provider, await provider.write.writeDocuments({
        indexUid,
        documents,
        correlation: `provider-parity-${provider.kind}`
      }));
      await provider.write.refreshIndex({ indexUid });
      await expect(provider.validation.countDocuments({ indexUid }))
        .resolves.toBe(documents.length);
    }

    const cases = [
      { family: "exact-title", query: "Employment Policy", expected: "file-policy" },
      { family: "path", query: "pages/labor/contract.md", expected: "file-contract" },
      { family: "late-body", query: "workplace evidence", expected: "file-policy" },
      { family: "multi-term", query: "employment policy evidence", expected: "file-policy" },
      { family: "phrase", query: "employment policy", expected: "file-policy" },
      { family: "latin-typo", query: "employmnt policy", expected: "file-policy" },
      { family: "chinese", query: "用人单位解除劳动合同", expected: "file-contract" },
      { family: "mixed-script", query: "劳动合同 employment", expected: "file-contract" },
      { family: "graph", query: "contract relationship", expected: "file-graph" },
      { family: "ranking", query: "employment contract", expected: "file-contract" }
    ];

    for (const queryCase of cases) {
      const openSearchResult = await openSearch.query.query(parityQueryRequest({
        indexUid: openSearchIndexUid,
        query: queryCase.query,
        limit: 3
      }));
      const meilisearchResult = await meilisearch.query.query(parityQueryRequest({
        indexUid: meilisearchIndexUid,
        query: queryCase.query,
        limit: 3
      })).catch((error: unknown) => {
        throw new Error(`Meilisearch parity query failed: ${queryCase.family}`, {
          cause: error
        });
      });
      const openSearchIds = openSearchResult.hits.map((hit) => hit.sourceFilePublicId);
      const meilisearchIds = meilisearchResult.hits.map((hit) => hit.sourceFilePublicId);
      expect(ndcgForExpected(openSearchIds, queryCase.expected), queryCase.family)
        .toBeGreaterThanOrEqual(0.63);
      expect(ndcgForExpected(meilisearchIds, queryCase.expected), queryCase.family)
        .toBeGreaterThanOrEqual(0.63);
      expect(overlapRatio(openSearchIds, meilisearchIds), queryCase.family)
        .toBeGreaterThanOrEqual(0.5);
    }

    for (const [provider, indexUid] of [
      [openSearch, openSearchIndexUid],
      [meilisearch, meilisearchIndexUid]
    ] as const) {
      const tiedRequest = parityQueryRequest({ indexUid, query: "employment", limit: 3 });
      const first = await provider.query.query(tiedRequest);
      const replay = await provider.query.query(tiedRequest);
      expect(replay.hits.map((hit) => hit.documentId))
        .toEqual(first.hits.map((hit) => hit.documentId));

      const firstPage = await provider.query.query(parityQueryRequest({
        indexUid,
        query: "employment",
        limit: 1
      }));
      expect(firstPage.continuation).toEqual(expect.any(String));
      const secondPage = await provider.query.query(parityQueryRequest({
        indexUid,
        query: "employment",
        limit: 1,
        continuation: firstPage.continuation
      }));
      expect(secondPage.hits[0]?.sourceFilePublicId)
        .not.toBe(firstPage.hits[0]?.sourceFilePublicId);

      const injected = await provider.query.query(parityQueryRequest({
        indexUid,
        query: "\" OR *:*",
        limit: 3
      }));
      expect(injected.hits.every((hit) =>
        hit.document.knowledgeBaseId === "kb-opensearch-integration"
      )).toBe(true);
    }
  }, 120_000);
});

async function settleProviderOperation(
  provider: SearchProviderRuntime,
  receipt: SearchProviderOperationReceipt
): Promise<void> {
  if (receipt.state === "completed") return;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const status = await provider.operations.getOperation({
      operationRef: receipt.operationRef
    });
    if (status.state === "completed") return;
    if (status.state === "failed") {
      throw new Error(`Provider operation failed: ${status.errorCode}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Provider operation did not complete");
}

function parityQueryRequest(input: {
  indexUid: string;
  query: string;
  limit: number;
  continuation?: string | null;
}): SearchProviderQueryRequest {
  return {
    ...queryRequest(input),
    evidenceFamilies: ["exact", "text", "phrase", "typo", "jieba", "graph"]
  };
}

function ndcgForExpected(ids: readonly string[], expected: string): number {
  const rank = ids.indexOf(expected);
  return rank < 0 ? 0 : 1 / Math.log2(rank + 2);
}

function overlapRatio(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const denominator = Math.max(1, Math.min(leftSet.size, rightSet.size));
  return [...leftSet].filter((value) => rightSet.has(value)).length / denominator;
}

function openSearchIntegrationConfig(indexPrefix: string) {
  const configuredBasicAuth = Boolean(openSearchUsername || openSearchPassword);
  if (configuredBasicAuth && (!openSearchUsername || !openSearchPassword)) {
    throw new Error("OpenSearch integration basic authentication is incomplete");
  }
  if (openSearchCaFile) statSync(openSearchCaFile);
  return {
    provider: "opensearch" as const,
    endpoint: endpoint ?? "http://127.0.0.1:1",
    indexPrefix,
    auth: configuredBasicAuth
      ? {
          mode: "basic" as const,
          username: openSearchUsername!,
          password: openSearchPassword!
        }
      : { mode: "none" as const },
    tls: openSearchCaFile ? { caFile: openSearchCaFile } : {}
  };
}

function queryRequest(input: {
  indexUid: string;
  query: string;
  limit: number;
  continuation?: string | null;
}) {
  return {
    indexUid: input.indexUid,
    query: input.query,
    evidenceFamilies: ["exact", "text", "phrase", "typo", "jieba"] as const,
    filters: {
      kind: "equals" as const,
      field: "knowledgeBaseId" as const,
      value: "kb-opensearch-integration"
    },
    searchFields: ["title", "logicalPath", "searchText", "rankingTerms"],
    returnFields: [
      "id", "schemaVersion", "documentKind", "contentKind",
      "knowledgeBaseId", "sourceFilePublicId", "sourceRevisionPublicId",
      "logicalPath", "fileKind", "title", "segmentOrdinal",
      "headingAncestors", "searchText", "rankingTerms"
    ],
    limit: input.limit,
    continuation: input.continuation ?? null,
    cropLength: 200,
    deadlineMs: 2_000,
    matchingStrategy: "last" as const,
    distinctBy: "sourceFilePublicId" as const
  };
}

function integrationDocuments() {
  return [
    createStorageVnextContentDocument({
      knowledgeBaseId: "kb-opensearch-integration",
      sourceFilePublicId: "file-contract",
      sourceRevisionPublicId: "revision-contract",
      logicalPath: "pages/labor/contract.md",
      fileKind: "markdown",
      title: "劳动合同 Employment Contract",
      contentKind: "file",
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: "劳动合同解除规则与 employment policy evidence"
    }),
    createStorageVnextContentDocument({
      knowledgeBaseId: "kb-opensearch-integration",
      sourceFilePublicId: "file-contract",
      sourceRevisionPublicId: "revision-contract",
      logicalPath: "pages/labor/contract.md",
      fileKind: "markdown",
      title: "劳动合同解除",
      contentKind: "segment",
      segmentOrdinal: 0,
      headingAncestors: ["解除"],
      searchText: "用人单位解除劳动合同需要符合程序"
    }),
    createStorageVnextContentDocument({
      knowledgeBaseId: "kb-opensearch-integration",
      sourceFilePublicId: "file-policy",
      sourceRevisionPublicId: "revision-policy",
      logicalPath: "pages/employment/policy.md",
      fileKind: "markdown",
      title: "Employment Policy",
      contentKind: "file",
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: "employment policy and workplace evidence"
    }),
    createStorageVnextGraphSeedDocument({
      knowledgeBaseId: "kb-opensearch-integration",
      sourceFilePublicId: "file-graph",
      sourceRevisionPublicId: "revision-graph",
      logicalPath: "pages/graph.md",
      title: "Contract relationship",
      searchText: "employment contract relationship",
      rankingTerms: ["employment", "contract"]
    })
  ];
}
