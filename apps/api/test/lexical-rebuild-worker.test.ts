import { describe, expect, it, vi } from "vitest";
import type {
  LexicalRebuildWorkClaim,
  LexicalRebuildWorkRepository,
  LexicalRebuildWorkSource
} from "../src/application/ports/lexical-rebuild-work-repository.js";
import type { LexicalTokenizer } from "../src/application/ports/lexical-tokenizer.js";
import type { ResourceBudget } from "../src/runtime/resource-budget.js";
import { processLexicalRebuildClaims } from "../src/maintenance/lexical-rebuild-worker.js";
import {
  createLexicalSourceReader,
  type LexicalSourceRead
} from "../src/maintenance/lexical-source-reader.js";

describe("lexical source reader", () => {
  it("bounds simultaneous retained source bytes until callers release bodies", async () => {
    const resolvers: Array<(value: string) => void> = [];
    const getObjectText = vi.fn(() =>
      new Promise<string>((resolve) => {
        resolvers.push(resolve);
      })
    );
    const reader = createLexicalSourceReader({
      storage: { getObjectText },
      concurrency: 2,
      maxInFlightBytes: 10,
      maxObjectBytes: 100
    });

    const firstPromise = reader.read(source("source-1", 10));
    const secondPromise = reader.read(source("source-2", 10));
    await vi.waitFor(() => expect(getObjectText).toHaveBeenCalledTimes(1));

    resolvers[0]!("first");
    const first = await firstPromise;
    await Promise.resolve();
    expect(getObjectText).toHaveBeenCalledTimes(1);

    first.release();
    await vi.waitFor(() => expect(getObjectText).toHaveBeenCalledTimes(2));
    resolvers[1]!("second");
    const second = await secondPromise;
    second.release();
  });

  it("releases request slots after reads while retaining body byte reservations", async () => {
    const getObjectText = vi.fn(async () => "body");
    const reader = createLexicalSourceReader({
      storage: { getObjectText },
      concurrency: 2,
      maxInFlightBytes: 100,
      maxObjectBytes: 100
    });

    const reads = await Promise.all([
      reader.read(source("source-slot-1", 10)),
      reader.read(source("source-slot-2", 10)),
      reader.read(source("source-slot-3", 10))
    ]);

    expect(getObjectText).toHaveBeenCalledTimes(3);
    reads.forEach((read) => read.release());
  });

  it("retries transient source failures within a bounded read operation", async () => {
    const timeout = Object.assign(new Error("temporary timeout"), {
      name: "TimeoutError"
    });
    const getObjectText = vi.fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce("recovered");
    const sleep = vi.fn(async () => undefined);
    const reader = createLexicalSourceReader({
      storage: { getObjectText },
      concurrency: 1,
      maxInFlightBytes: 1_024,
      maxObjectBytes: 1_024,
      retry: {
        maxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 20,
        random: () => 0,
        sleep
      }
    });

    const result = await reader.read(source("source-retry", 100));

    expect(result.body).toBe("recovered");
    expect(result.retryCount).toBe(1);
    expect(getObjectText).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    result.release();
  });

  it("aborts a source read that exceeds its request deadline", async () => {
    const reader = createLexicalSourceReader({
      storage: {
        getObjectText: vi.fn((_key, options) =>
          new Promise<string | null>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          })
        )
      },
      concurrency: 1,
      maxInFlightBytes: 1_024,
      maxObjectBytes: 1_024,
      requestTimeoutMs: 5,
      retry: {
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1
      }
    });

    await expect(reader.read(source("source-timeout", 100))).rejects.toMatchObject({
      code: "LEXICAL_SOURCE_READ_TIMEOUT"
    });
  });

  it.each([
    [
      Object.assign(new Error("storage throttle detail"), {
        name: "SlowDown",
        $metadata: { httpStatusCode: 503 }
      }),
      "LEXICAL_SOURCE_READ_THROTTLED",
      "The source object service is temporarily busy"
    ],
    [
      Object.assign(new Error("storage service detail"), {
        name: "InternalError",
        $metadata: { httpStatusCode: 500 }
      }),
      "LEXICAL_SOURCE_READ_FAILED",
      "The source object could not be read"
    ]
  ])(
    "retries transient storage service errors and returns safe terminal evidence",
    async (failure, expectedCode, expectedMessage) => {
      const getObjectText = vi.fn().mockRejectedValue(failure);
      const reader = createLexicalSourceReader({
        storage: { getObjectText },
        concurrency: 1,
        maxInFlightBytes: 1_024,
        maxObjectBytes: 1_024,
        retry: {
          maxAttempts: 2,
          baseDelayMs: 1,
          maxDelayMs: 1,
          random: () => 0,
          sleep: async () => undefined
        }
      });

      await expect(reader.read(source("source-service-error", 100)))
        .rejects.toMatchObject({
          code: expectedCode,
          message: expectedMessage
        });
      expect(getObjectText).toHaveBeenCalledTimes(2);
    }
  );

  it("treats a missing source object as terminal without retrying", async () => {
    const getObjectText = vi.fn(async () => null);
    const reader = createLexicalSourceReader({
      storage: { getObjectText },
      concurrency: 1,
      maxInFlightBytes: 1_024,
      maxObjectBytes: 1_024,
      retry: {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        sleep: async () => undefined
      }
    });

    await expect(reader.read(source("source-missing", 100))).rejects.toMatchObject({
      code: "LEXICAL_SOURCE_OBJECT_UNAVAILABLE",
      message: "The source object is unavailable"
    });
    expect(getObjectText).toHaveBeenCalledOnce();
  });
});

describe("lexical rebuild claim processing", () => {
  it("isolates one derivation failure and commits the other readable source", async () => {
    const claims = [claim("source-good"), claim("source-bad")];
    const sources = [
      source("source-good", 100, "# Good\n\nReadable evidence."),
      source("source-bad", 100, "# Bad\n\nBAD_DERIVATION")
    ];
    const persisted: string[][] = [];
    const retries: Array<{ sourceIds: string[]; stage: string }> = [];
    const metrics: unknown[] = [];
    const repository = repositoryStub({
      loadSources: async () => sources,
      persistBatch: async (input) => {
        persisted.push(input.results.map((result) => result.claim.sourceFileId));
      },
      retry: async (input) => {
        retries.push({
          sourceIds: input.claims.map((item) => item.sourceFileId),
          stage: input.stage
        });
      }
    });
    const tokenizer: LexicalTokenizer = {
      contractVersion: "test-tokenizer-v1",
      tokenizeDocument(value, limit) {
        if (value.includes("BAD_DERIVATION")) {
          throw new Error("fixture derivation failure");
        }
        return (value.toLowerCase().match(/[a-z]+/gu) ?? []).slice(0, limit);
      },
      tokenizeQuery(value, limit) {
        return this.tokenizeDocument(value, limit);
      }
    };

    const result = await processLexicalRebuildClaims({
      repository,
      sourceReader: {
        updateLimits() {},
        async read(item): Promise<LexicalSourceRead> {
          return {
            source: item,
            body: item.sourceFileId === "source-bad"
              ? "# Bad\n\nBAD_DERIVATION"
              : "# Good\n\nReadable evidence.",
            bytes: item.sizeBytes,
            latencyMs: 1,
            retryCount: 0,
            release() {}
          };
        }
      },
      tokenizer,
      databaseWriteBudget: immediateBudget(),
      workerId: "worker-1",
      claims,
      databaseBatchSize: 10,
      retryDelayMs: 1_000,
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 15_000,
      onMetrics(value) {
        metrics.push(value);
      }
    });

    expect(result).toEqual({ completed: 1, retried: 1 });
    expect(persisted).toEqual([["source-good"]]);
    expect(retries).toEqual([
      { sourceIds: ["source-bad"], stage: "derive" }
    ]);
    expect(metrics).toEqual([
      expect.objectContaining({
        claimed: 2,
        sourceReadCount: 2,
        sourceReadBytes: 200,
        sourceReadLatencyAverageMs: 1,
        sourceReadLatencyMaximumMs: 1,
        deriveCount: 1,
        databaseBatchCount: 1,
        completed: 1,
        retried: 1
      })
    ]);
  });

  it("releases every source body after each committed database micro-batch", async () => {
    const claims = Array.from({ length: 100 }, (_, index) =>
      claim(`source-bounded-${index}`)
    );
    const sources = claims.map((item) => source(item.sourceFileId, 1_024));
    let retainedBytes = 0;
    let peakRetainedBytes = 0;
    const committedRetainedBytes: number[] = [];
    const repository = repositoryStub({
      loadSources: async () => sources,
      persistBatch: async () => {
        committedRetainedBytes.push(retainedBytes);
      }
    });
    const tokenizer: LexicalTokenizer = {
      contractVersion: "test-tokenizer-v1",
      tokenizeDocument(value, limit) {
        return (value.toLowerCase().match(/[a-z0-9-]+/gu) ?? []).slice(0, limit);
      },
      tokenizeQuery(value, limit) {
        return this.tokenizeDocument(value, limit);
      }
    };

    const result = await processLexicalRebuildClaims({
      repository,
      sourceReader: {
        updateLimits() {},
        async read(item): Promise<LexicalSourceRead> {
          retainedBytes += item.sizeBytes;
          peakRetainedBytes = Math.max(peakRetainedBytes, retainedBytes);
          let released = false;
          return {
            source: item,
            body: `# ${item.title}\n\nBounded source evidence.`,
            bytes: item.sizeBytes,
            latencyMs: 1,
            retryCount: 0,
            release() {
              if (released) return;
              released = true;
              retainedBytes -= item.sizeBytes;
            }
          };
        }
      },
      tokenizer,
      databaseWriteBudget: immediateBudget(),
      workerId: "worker-bounded",
      claims,
      databaseBatchSize: 5,
      retryDelayMs: 1_000,
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 15_000
    });

    expect(result).toEqual({ completed: 100, retried: 0 });
    expect(committedRetainedBytes).toHaveLength(20);
    expect(committedRetainedBytes.every((bytes) => bytes <= 5 * 1_024)).toBe(true);
    expect(peakRetainedBytes).toBe(5 * 1_024);
    expect(retainedBytes).toBe(0);
  });

  it.each([
    ["40001", "LEXICAL_DATABASE_SERIALIZATION_RETRY"],
    ["40P01", "LEXICAL_DATABASE_DEADLOCK_RETRY"]
  ])(
    "retries a PostgreSQL %s conflict with safe diagnostic evidence",
    async (postgresCode, expectedErrorCode) => {
      const currentClaim = claim(`source-database-${postgresCode}`);
      const retries: Array<{ errorCode: string; stage: string; sourceIds: string[] }> = [];
      const budget = immediateBudget();
      const recordRetry = vi.spyOn(budget, "recordRetry");
      const repository = repositoryStub({
        loadSources: async () => [source(currentClaim.sourceFileId, 100)],
        persistBatch: async () => {
          throw Object.assign(new Error("database transaction conflict"), {
            code: postgresCode
          });
        },
        retry: async (input) => {
          retries.push({
            errorCode: input.errorCode,
            stage: input.stage,
            sourceIds: input.claims.map((item) => item.sourceFileId)
          });
        }
      });

      const result = await processLexicalRebuildClaims({
        repository,
        sourceReader: {
          updateLimits() {},
          async read(item): Promise<LexicalSourceRead> {
            return {
              source: item,
              body: "# Retry\n\nDatabase conflict evidence.",
              bytes: item.sizeBytes,
              latencyMs: 1,
              retryCount: 0,
              release() {}
            };
          }
        },
        tokenizer: {
          contractVersion: "test-tokenizer-v1",
          tokenizeDocument(value, limit) {
            return (value.toLowerCase().match(/[a-z]+/gu) ?? []).slice(0, limit);
          },
          tokenizeQuery(value, limit) {
            return this.tokenizeDocument(value, limit);
          }
        },
        databaseWriteBudget: budget,
        workerId: "worker-database-retry",
        claims: [currentClaim],
        databaseBatchSize: 10,
        retryDelayMs: 1_000,
        leaseDurationMs: 30_000,
        heartbeatIntervalMs: 15_000
      });

      expect(result).toEqual({ completed: 0, retried: 1 });
      expect(recordRetry).toHaveBeenCalledOnce();
      expect(retries).toEqual([
        {
          errorCode: expectedErrorCode,
          stage: "database_write",
          sourceIds: [currentClaim.sourceFileId]
        }
      ]);
    }
  );
});

function claim(sourceFileId: string): LexicalRebuildWorkClaim {
  return {
    knowledgeBaseId: "kb-1",
    targetGenerationId: "generation-1",
    sourceFileId,
    sourceRevisionId: `revision-${sourceFileId}`,
    logicalPath: `pages/${sourceFileId}.md`,
    leaseToken: `lease-${sourceFileId}`,
    attemptCount: 0,
    maxAttempts: 3,
    settingsRevision: 1,
    settings: {
      concurrency: 2,
      sourceReadConcurrency: 2,
      databaseWriteConcurrency: 1,
      claimBatchSize: 10,
      databaseBatchSize: 10,
      maxInFlightSourceBytes: 5 * 1_024
    }
  };
}

function source(
  sourceFileId: string,
  sizeBytes: number,
  _body = "# Document"
): LexicalRebuildWorkSource {
  return {
    ...claim(sourceFileId),
    relativePath: `${sourceFileId}.md`,
    objectKey: `source/${sourceFileId}`,
    sizeBytes,
    checksumSha256: sourceFileId.padEnd(64, "0").slice(0, 64),
    title: sourceFileId,
    summary: null,
    sourceUrl: null,
    metadata: {},
    suggestions: null
  };
}

function repositoryStub(
  overrides: Partial<LexicalRebuildWorkRepository>
): LexicalRebuildWorkRepository {
  return {
    planNext: async () => null,
    claimBatch: async () => [],
    loadSources: async () => [],
    heartbeat: async () => 0,
    persistBatch: async () => undefined,
    retry: async () => undefined,
    claimFinalization: async () => null,
    listProgress: async () => [],
    ...overrides
  };
}

function immediateBudget(): ResourceBudget {
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      return operation();
    },
    recordRetry() {},
    snapshot() {
      return {
        concurrency: 1,
        active: 0,
        waiting: 0,
        started: 0,
        completed: 0,
        failed: 0,
        retries: 0,
        saturationCount: 0,
        saturated: false,
        utilization: 0,
        totalWaitMs: 0,
        maxWaitMs: 0,
        averageWaitMs: 0,
        totalRunMs: 0,
        maxRunMs: 0,
        averageRunMs: 0,
        throughputPerSecond: 0
      };
    }
  };
}
