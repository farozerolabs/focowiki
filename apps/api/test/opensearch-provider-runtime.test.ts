import { describe, expect, it, vi } from "vitest";
import type { LexicalTokenizer } from
  "../src/application/ports/lexical-tokenizer.js";
import type { SearchProviderIndexDefinition } from
  "../src/application/ports/search-provider-runtime.js";
import type { OpenSearchClientPort } from
  "../src/infrastructure/opensearch/opensearch-client-port.js";
import { createOpenSearchProviderRuntime } from
  "../src/infrastructure/opensearch/opensearch-provider-runtime.js";

const definition: SearchProviderIndexDefinition = {
  primaryKey: "id",
  searchableAttributes: ["title", "logicalPath", "searchText"],
  filterableAttributes: ["knowledgeBaseId", "documentKind", "schemaVersion"],
  displayedAttributes: ["id", "knowledgeBaseId", "title", "searchText"],
  rankingRules: ["words", "typo", "proximity", "attribute", "exactness"],
  distinctAttribute: "sourceFilePublicId",
  maximumTotalHits: 2_000,
  searchCutoffMs: 1_000,
  typoDisabledAttributes: ["logicalPath"]
};

describe("OpenSearch provider runtime", () => {
  it("creates an immutable strict index and reads its stored definition", async () => {
    const client = createClient();
    const provider = createProvider(client);

    await expect(provider.admin.createIndex({
      indexUid: "owned_candidate_a",
      definition
    })).resolves.toEqual({ state: "completed" });
    expect(client.indices.create).toHaveBeenCalledWith(expect.objectContaining({
      index: "owned_candidate_a",
      body: expect.objectContaining({
        mappings: expect.objectContaining({ dynamic: "strict" })
      })
    }));

    vi.mocked(client.indices.getMapping).mockResolvedValue(mappingResponse(
      "owned_candidate_a"
    ));
    await expect(provider.admin.getIndexDefinition({
      indexUid: "owned_candidate_a"
    })).resolves.toEqual(definition);
    await expect(provider.admin.getIndex({
      indexUid: "owned_candidate_a"
    })).resolves.toEqual({
      indexUid: "owned_candidate_a",
      primaryKey: "id"
    });
  });

  it("scans immutable pages with provider-bound search_after continuations", async () => {
    const client = createClient();
    const provider = createProvider(client);
    vi.mocked(client.count).mockResolvedValue({ body: { count: 3 } });
    vi.mocked(client.search)
      .mockResolvedValueOnce(searchResponse([
        hit("doc-a", ["doc-a"]),
        hit("doc-b", ["doc-b"]),
        hit("doc-c", ["doc-c"])
      ]))
      .mockResolvedValueOnce(searchResponse([hit("doc-c", ["doc-c"])]));

    await expect(provider.validation.countDocuments({
      indexUid: "owned_candidate_a"
    })).resolves.toBe(3);
    const first = await provider.validation.scanDocuments({
      indexUid: "owned_candidate_a",
      continuation: null,
      limit: 2,
      fields: ["id", "title"]
    });
    expect(first.documents.map((document) => document.id)).toEqual([
      "doc-a", "doc-b"
    ]);
    expect(first.continuation).toEqual(expect.any(String));
    const second = await provider.validation.scanDocuments({
      indexUid: "owned_candidate_a",
      continuation: first.continuation,
      limit: 2,
      fields: ["id", "title"]
    });
    expect(second).toEqual({
      documents: [{ id: "doc-c", title: "doc-c" }],
      continuation: null
    });
    expect(client.search).toHaveBeenNthCalledWith(2, expect.objectContaining({
      index: "owned_candidate_a",
      body: expect.objectContaining({ search_after: ["doc-b"] })
    }));

    await expect(provider.validation.scanDocuments({
      indexUid: "owned_candidate_b",
      continuation: first.continuation,
      limit: 2,
      fields: ["id"]
    })).rejects.toMatchObject({ retryable: false });
  });

  it("deletes documents through typed filters and refreshes only on request", async () => {
    const client = createClient();
    const provider = createProvider(client);

    await expect(provider.write.deleteDocuments({
      indexUid: "owned_candidate_a",
      filters: {
        kind: "and",
        operands: [{
          kind: "equals",
          field: "knowledgeBaseId",
          value: "kb-a"
        }, {
          kind: "boolean",
          field: "visible",
          value: true
        }]
      },
      correlation: "delete-a"
    })).resolves.toEqual({ state: "completed" });
    expect(client.deleteByQuery).toHaveBeenCalledWith({
      index: "owned_candidate_a",
      body: {
        query: {
          bool: {
            filter: [
              { term: { knowledgeBaseId: "kb-a" } },
              { term: { visible: true } }
            ]
          }
        }
      },
      conflicts: "proceed",
      refresh: false
    });
    expect(client.indices.refresh).not.toHaveBeenCalled();
    await provider.write.refreshIndex({ indexUid: "owned_candidate_a" });
    expect(client.indices.refresh).toHaveBeenCalledOnce();
  });

  it("uses the configured poll interval for final refresh visibility", async () => {
    const client = createClient();
    vi.mocked(client.indices.exists)
      .mockResolvedValueOnce({ body: false })
      .mockResolvedValueOnce({ body: true });
    const sleep = vi.fn(async () => undefined);
    const provider = createProvider(client, { sleep });

    await provider.write.refreshIndex({ indexUid: "owned_candidate_a" });

    expect(client.indices.refresh).toHaveBeenCalledOnce();
    expect(client.indices.exists).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("closes its OpenSearch client", async () => {
    const client = createClient();
    const provider = createProvider(client);

    await provider.close();

    expect(client.close).toHaveBeenCalledOnce();
  });

  it("deletes only an exact owned index and converges when it is missing", async () => {
    const client = createClient();
    const provider = createProvider(client);
    await expect(provider.admin.deleteIndex({
      indexUid: "owned_candidate_a"
    })).resolves.toEqual({ state: "completed" });
    expect(client.indices.delete).toHaveBeenCalledWith({
      index: "owned_candidate_a"
    });

    vi.mocked(client.indices.delete).mockRejectedValueOnce(providerError(404));
    await expect(provider.admin.deleteIndex({
      indexUid: "owned_candidate_missing"
    })).resolves.toEqual({ state: "completed" });
  });

  it("maps least-privilege denial without exposing provider details", async () => {
    const client = createClient();
    vi.mocked(client.indices.create).mockRejectedValueOnce(providerError(403));
    const provider = createProvider(client);

    const error = await provider.admin.createIndex({
      indexUid: "outside_runtime_scope",
      definition
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "SEARCH_ENGINE_AUTHORIZATION_FAILED",
      retryable: false
    });
    expect(JSON.stringify(error)).not.toContain("do-not-expose");
  });

  it("rejects malformed provider responses without exposing their bodies", async () => {
    const client = createClient();
    const provider = createProvider(client);
    vi.mocked(client.search).mockResolvedValue({
      body: { hits: { hits: [{ _id: "secret-index", _source: {} }] } }
    });

    const error = await provider.validation.scanDocuments({
      indexUid: "owned_candidate_a",
      continuation: null,
      limit: 10,
      fields: ["id"]
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ retryable: false });
    expect(JSON.stringify(error)).not.toContain("secret-index");
  });
});

function createProvider(
  client: OpenSearchClientPort,
  dependencies: { sleep?: (milliseconds: number) => Promise<void> } = {}
) {
  return createOpenSearchProviderRuntime({
    client,
    tokenizer: tokenizer(),
    bulkLimits: {
      maximumDocuments: 100,
      maximumBytes: 1_000_000,
      maximumInFlight: 2,
      maximumAttempts: 3,
      retryDelayMs: 10,
      deadlineMs: 1_000
    },
    visibility: {
      pollIntervalMs: 250,
      deadlineMs: 1_000
    },
    query: { query: vi.fn() },
    ...dependencies
  });
}

function tokenizer(): LexicalTokenizer {
  return {
    contractVersion: "lexical-tokenizer-v1-test",
    tokenizeDocument: vi.fn(() => ["evidence"]),
    tokenizeQuery: vi.fn(() => ["query"])
  };
}

function createClient(): OpenSearchClientPort {
  return {
    info: vi.fn(async () => ({ body: {} })),
    bulk: vi.fn(async () => ({ body: { errors: false, items: [] } })),
    search: vi.fn(async () => searchResponse([])),
    count: vi.fn(async () => ({ body: { count: 0 } })),
    get: vi.fn(async () => ({ body: {} })),
    deleteByQuery: vi.fn(async () => ({ body: { deleted: 0 } })),
    indices: {
      exists: vi.fn(async () => ({ body: true })),
      create: vi.fn(async () => ({ body: { acknowledged: true } })),
      get: vi.fn(async () => ({ body: {} })),
      getMapping: vi.fn(async () => mappingResponse("owned_candidate_a")),
      putMapping: vi.fn(async () => ({ body: { acknowledged: true } })),
      getSettings: vi.fn(async () => ({ body: {} })),
      putSettings: vi.fn(async () => ({ body: { acknowledged: true } })),
      delete: vi.fn(async () => ({ body: { acknowledged: true } })),
      refresh: vi.fn(async () => ({ body: {} }))
    },
    close: vi.fn(async () => undefined)
  };
}

function mappingResponse(indexUid: string) {
  return {
    body: {
      [indexUid]: {
        mappings: {
          dynamic: "strict",
          _meta: {
            provider: "opensearch",
            tokenizerContractVersion: "lexical-tokenizer-v1-test",
            definition
          }
        }
      }
    }
  };
}

function searchResponse(hits: unknown[]) {
  return { body: { hits: { hits } } };
}

function hit(id: string, sort: unknown[]) {
  return { _id: id, _source: { id, title: id }, sort };
}

function providerError(statusCode: number) {
  return Object.assign(new Error("provider detail"), {
    meta: { statusCode, body: { secret: "do-not-expose" } }
  });
}
