import { describe, expect, it, vi } from "vitest";
import type { LexicalTokenizer } from
  "../src/application/ports/lexical-tokenizer.js";
import type { OpenSearchClientPort } from
  "../src/infrastructure/opensearch/opensearch-client-port.js";
import { createOpenSearchBulkWriter } from
  "../src/infrastructure/opensearch/opensearch-bulk-writer.js";
import { createStorageVnextContentDocument } from
  "../src/storage-vnext/search/documents.js";

describe("OpenSearch bulk writer", () => {
  it("partitions writes by both document count and NDJSON bytes", async () => {
    const countClient = createClient();
    const countWriter = createWriter(countClient, {
      maximumDocuments: 2,
      maximumBytes: 100_000
    });

    await expect(countWriter({
      indexUid: "owned_candidate",
      documents: documents(5),
      correlation: "batch-a"
    })).resolves.toEqual({ state: "completed" });
    expect(countClient.bulk).toHaveBeenCalledTimes(3);

    const byteClient = createClient();
    const byteWriter = createWriter(byteClient, {
      maximumDocuments: 10,
      maximumBytes: 1_250
    });
    await byteWriter({
      indexUid: "owned_candidate",
      documents: documents(5),
      correlation: "batch-b"
    });

    expect(byteClient.bulk).toHaveBeenCalledTimes(5);
    for (const [request] of vi.mocked(byteClient.bulk).mock.calls) {
      const body = request.body as Record<string, unknown>[];
      expect(ndjsonBytes(body)).toBeLessThanOrEqual(1_250);
    }
  });

  it("retries only retryable items with deterministic identities", async () => {
    const client = createClient();
    const batch = documents(2);
    vi.mocked(client.bulk)
      .mockResolvedValueOnce(bulkResponse([
        item(201, batch[0]!.id),
        item(429, batch[1]!.id, "rejected_execution_exception")
      ]))
      .mockResolvedValueOnce(bulkResponse([item(200, batch[1]!.id)]));
    const sleep = vi.fn(async () => undefined);
    const write = createWriter(client, {
      maximumDocuments: 10,
      maximumBytes: 100_000,
      sleep
    });

    await write({
      indexUid: "owned_candidate",
      documents: batch,
      correlation: "batch-b"
    });

    expect(client.bulk).toHaveBeenCalledTimes(2);
    const retryBody = vi.mocked(client.bulk).mock.calls[1]![0].body as Array<
      Record<string, unknown>
    >;
    expect(retryBody).toHaveLength(2);
    expect(retryBody[0]).toEqual({
      index: { _index: "owned_candidate", _id: batch[1]!.id }
    });
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("fails terminal mapping and authentication item errors safely", async () => {
    for (const response of [
      bulkResponse([item(400, documents(1)[0]!.id, "strict_dynamic_mapping_exception")]),
      bulkResponse([item(403, documents(1)[0]!.id, "security_exception")])
    ]) {
      const client = createClient();
      vi.mocked(client.bulk).mockResolvedValueOnce(response);
      const write = createWriter(client);
      const error = await write({
        indexUid: "owned_candidate",
        documents: documents(1),
        correlation: "batch-terminal"
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ retryable: false });
      expect(JSON.stringify(error)).not.toContain("owned_candidate");
      expect(client.bulk).toHaveBeenCalledOnce();
    }
  });

  it("classifies whole-request failures without retrying terminal errors", async () => {
    const cases = [
      {
        error: responseError(401),
        code: "SEARCH_ENGINE_AUTHENTICATION_FAILED",
        retryable: false,
        calls: 1
      },
      {
        error: responseError(403),
        code: "SEARCH_ENGINE_AUTHORIZATION_FAILED",
        retryable: false,
        calls: 1
      },
      {
        error: responseError(408),
        code: "SEARCH_ENGINE_TIMEOUT",
        retryable: true,
        calls: 3
      },
      {
        error: responseError(429),
        code: "SEARCH_ENGINE_OVERLOADED",
        retryable: true,
        calls: 3
      },
      {
        error: responseError(503),
        code: "SEARCH_ENGINE_OVERLOADED",
        retryable: true,
        calls: 3
      },
      {
        error: new Error("connection failed"),
        code: "SEARCH_ENGINE_UNAVAILABLE",
        retryable: true,
        calls: 3
      }
    ] as const;

    for (const testCase of cases) {
      const client = createClient({
        bulk: vi.fn(async () => { throw testCase.error; })
      });
      const write = createWriter(client, {
        maximumAttempts: 3,
        sleep: vi.fn(async () => undefined)
      });

      const error = await write({
        indexUid: "owned_candidate",
        documents: documents(1),
        correlation: "batch-request-error"
      }).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        code: testCase.code,
        retryable: testCase.retryable
      });
      expect(client.bulk).toHaveBeenCalledTimes(testCase.calls);
      expect(JSON.stringify(error)).not.toContain("provider response detail");
    }
  });

  it("owns the retry budget and caps each request to the remaining deadline", async () => {
    const batch = documents(1);
    let now = 0;
    const client = createClient();
    vi.mocked(client.bulk)
      .mockRejectedValueOnce(responseError(503))
      .mockResolvedValueOnce(bulkResponse([item(201, batch[0]!.id)]));
    const write = createWriter(client, {
      maximumAttempts: 2,
      retryDelayMs: 20,
      deadlineMs: 50,
      now: () => now,
      sleep: vi.fn(async (milliseconds) => { now += milliseconds; })
    });

    await expect(write({
      indexUid: "owned_candidate",
      documents: batch,
      correlation: "batch-request-budget"
    })).resolves.toEqual({ state: "completed" });

    const calls = vi.mocked(client.bulk).mock.calls as unknown as Array<[
      Record<string, unknown>,
      { maxRetries: number; requestTimeout: number }
    ]>;
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]).toEqual({ maxRetries: 0, requestTimeout: 50 });
    expect(calls[1]![1]).toEqual({ maxRetries: 0, requestTimeout: 30 });
  });

  it("bounds retry attempts and concurrent bulk calls", async () => {
    let active = 0;
    let maximumActive = 0;
    const client = createClient({
      bulk: vi.fn(async (request: Record<string, unknown>) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        const body = request.body as Record<string, unknown>[];
        return bulkResponse(body.filter((_, index) => index % 2 === 0).map(
          (action) => item(503, String(
            (action.index as Record<string, unknown>)._id
          ), "unavailable_shards_exception")
        ));
      })
    });
    const write = createWriter(client, {
      maximumDocuments: 1,
      maximumBytes: 100_000,
      maximumInFlight: 2,
      maximumAttempts: 2,
      sleep: vi.fn(async () => undefined)
    });

    await expect(write({
      indexUid: "owned_candidate",
      documents: documents(4),
      correlation: "batch-bounded"
    })).rejects.toMatchObject({ retryable: true });
    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(client.bulk).toHaveBeenCalledTimes(4);
  });

  it("stops retrying when the total deadline is exhausted", async () => {
    const batch = documents(1);
    const client = createClient();
    vi.mocked(client.bulk).mockResolvedValue(bulkResponse([
      item(503, batch[0]!.id, "unavailable_shards_exception")
    ]));
    let now = 0;
    const write = createWriter(client, {
      maximumAttempts: 10,
      retryDelayMs: 30,
      deadlineMs: 50,
      now: () => now,
      sleep: vi.fn(async (milliseconds) => { now += milliseconds; })
    });

    await expect(write({
      indexUid: "owned_candidate",
      documents: batch,
      correlation: "batch-deadline"
    })).rejects.toMatchObject({
      code: "SEARCH_ENGINE_TIMEOUT",
      retryable: true
    });
    expect(client.bulk).toHaveBeenCalledTimes(2);
  });

  it("applies bounded jitter to retry delays", async () => {
    const batch = documents(1);
    const client = createClient();
    vi.mocked(client.bulk)
      .mockResolvedValueOnce(bulkResponse([
        item(429, batch[0]!.id, "rejected_execution_exception")
      ]))
      .mockResolvedValueOnce(bulkResponse([item(200, batch[0]!.id)]));
    const sleep = vi.fn(async () => undefined);
    const write = createWriter(client, {
      retryDelayMs: 100,
      sleep,
      random: () => 0
    });

    await write({
      indexUid: "owned_candidate",
      documents: batch,
      correlation: "batch-jitter"
    });

    expect(sleep).toHaveBeenCalledWith(75);
  });
});

function createWriter(
  client: OpenSearchClientPort,
  overrides: Partial<Parameters<typeof createOpenSearchBulkWriter>[0]["limits"]>
    & {
      sleep?: (milliseconds: number) => Promise<void>;
      now?: () => number;
      random?: () => number;
    } = {}
) {
  const { sleep, now, random = () => 0.5, ...limits } = overrides;
  return createOpenSearchBulkWriter({
    client,
    tokenizer: tokenizer(),
    limits: {
      maximumDocuments: 10,
      maximumBytes: 100_000,
      maximumInFlight: 2,
      maximumAttempts: 3,
      retryDelayMs: 10,
      deadlineMs: 1_000,
      ...limits
    },
    ...(sleep ? { sleep } : {}),
    ...(now ? { now } : {}),
    random
  });
}

function documents(count: number) {
  return Array.from({ length: count }, (_, index) =>
    createStorageVnextContentDocument({
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: `file-${index}`,
      sourceRevisionPublicId: `revision-${index}`,
      logicalPath: `pages/${index}.md`,
      fileKind: "markdown",
      title: `Document ${index}`,
      contentKind: "file",
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: "x".repeat(300)
    })
  );
}

function tokenizer(): LexicalTokenizer {
  return {
    contractVersion: "lexical-tokenizer-v1-test",
    tokenizeDocument: vi.fn(() => ["document", "evidence"]),
    tokenizeQuery: vi.fn(() => ["query"])
  };
}

function createClient(overrides: Partial<OpenSearchClientPort> = {}) {
  return {
    bulk: vi.fn(async (request: Record<string, unknown>) => {
      const body = request.body as Record<string, unknown>[];
      return bulkResponse(body.filter((_, index) => index % 2 === 0).map(
        (action) => item(201, String(
          (action.index as Record<string, unknown>)._id
        ))
      ));
    }),
    ...overrides
  } as unknown as OpenSearchClientPort;
}

function bulkResponse(items: unknown[]) {
  return { body: { errors: items.some((value) =>
    Number(((value as { index: { status: number } }).index.status)) >= 300
  ), items } };
}

function item(status: number, id: string, type?: string) {
  return {
    index: {
      _id: id,
      status,
      ...(type ? { error: { type, reason: "provider detail" } } : {})
    }
  };
}

function responseError(statusCode: number) {
  return Object.assign(new Error("provider response detail"), {
    meta: { statusCode }
  });
}

function ndjsonBytes(body: readonly Record<string, unknown>[]) {
  return Buffer.byteLength(body.map((value) => JSON.stringify(value)).join("\n") + "\n");
}
