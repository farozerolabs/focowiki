import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDocumentResourcePermits } from
  "../src/document-indexing/application/document-resource-permits.js";
import {
  deriveDocumentResourceCapacities,
  resolveDocumentFinalizationCapacity,
  resolveDocumentPublicationS3Capacities,
  resolveDocumentProjectionCapacities,
  resolveDocumentResourceLaneCapacities
} from
  "../src/document-indexing/application/document-resource-capacity.js";

describe("document resource permits", () => {
  it("derives provider capacities independently from the document window", () => {
    expect(deriveDocumentResourceCapacities({
      documentConcurrency: 24,
      sourceObjectReadConcurrency: 16,
      generationModelConcurrency: 10,
      graphRagConcurrency: 2,
      embeddingConcurrency: 6,
      databaseConnectionLimit: 12,
      searchConcurrency: 8
    })).toEqual({
      capacities: {
        s3_read: 16,
        generation_model: 10,
        embedding: 6,
        database_mutation: 11,
        generated_object_write: 16,
        search_provider: 8
      },
      maximumWaitersPerResource: 96
    });
    expect(resolveDocumentFinalizationCapacity({
      documentConcurrency: 24,
      databaseConnectionLimit: 12
    })).toBe(11);
    expect(resolveDocumentProjectionCapacities({ documentConcurrency: 24 }))
      .toEqual({ documentPreparation: 24, scopeProjection: 6 });
    expect(resolveDocumentProjectionCapacities({ documentConcurrency: 1 }))
      .toEqual({ documentPreparation: 1, scopeProjection: 1 });
    expect(resolveDocumentPublicationS3Capacities({
      documentConcurrency: 32,
      sourceObjectReadConcurrency: 12
    })).toEqual({ scopeProjection: 3, readsPerScope: 4 });
    expect(resolveDocumentPublicationS3Capacities({
      documentConcurrency: 32,
      sourceObjectReadConcurrency: 1
    })).toEqual({ scopeProjection: 1, readsPerScope: 1 });
  });

  it("bounds configured search concurrency by the active document window", () => {
    const input = {
      documentConcurrency: 24,
      sourceObjectReadConcurrency: 16,
      generationModelConcurrency: 10,
      graphRagConcurrency: 2,
      embeddingConcurrency: 6,
      databaseConnectionLimit: 12,
      searchConcurrency: 128
    };
    expect(resolveDocumentResourceLaneCapacities(input).search_transport)
      .toBe(24);
    expect(deriveDocumentResourceCapacities(input).capacities.search_provider)
      .toBe(24);
  });

  it("bounds the same provider while independent resources continue", async () => {
    const permits = createDocumentResourcePermits({
      capacities: {
        s3_read: 1,
        generation_model: 1,
        embedding: 1,
        database_mutation: 1,
        generated_object_write: 1,
        search_provider: 1
      },
      maximumWaitersPerResource: 10
    });
    const releaseFirst = deferred<void>();
    const events: string[] = [];
    const first = permits.run("generation_model", async () => {
      events.push("model:first:start");
      await releaseFirst.promise;
      events.push("model:first:end");
    });
    const second = permits.run("generation_model", async () => {
      events.push("model:second");
    });
    const s3 = permits.run("s3_read", async () => {
      events.push("s3");
    });

    await eventually(() => expect(events).toEqual(["model:first:start", "s3"]));
    releaseFirst.resolve();
    await Promise.all([first, second, s3]);

    expect(events).toEqual([
      "model:first:start",
      "s3",
      "model:first:end",
      "model:second"
    ]);
    expect(permits.snapshot().generation_model).toEqual({ active: 0, waiting: 0, capacity: 1 });
  });

  it("releases a permit after an operation fails", async () => {
    const permits = createDocumentResourcePermits({
      capacities: oneEach(),
      maximumWaitersPerResource: 2
    });

    await expect(permits.run("search_provider", async () => {
      throw new Error("provider failed");
    })).rejects.toThrow("provider failed");
    await expect(permits.run("search_provider", async () => "continued"))
      .resolves.toBe("continued");
  });

  it("bounds queued work so provider backpressure cannot grow memory without limit", async () => {
    const permits = createDocumentResourcePermits({
      capacities: oneEach(),
      maximumWaitersPerResource: 2
    });
    const releaseActive = deferred<void>();
    const active = permits.run("embedding", async () => {
      await releaseActive.promise;
    });
    await eventually(() => expect(permits.snapshot().embedding.active).toBe(1));

    const firstWaiting = permits.run("embedding", async () => undefined);
    const secondWaiting = permits.run("embedding", async () => undefined);
    await eventually(() => expect(permits.snapshot().embedding.waiting).toBe(2));

    await expect(permits.run("embedding", async () => undefined))
      .rejects.toThrow("Document resource waiter limit exceeded: embedding");
    expect(permits.snapshot().embedding).toEqual({ active: 1, waiting: 2, capacity: 1 });

    releaseActive.resolve();
    await Promise.all([active, firstWaiting, secondWaiting]);
    expect(permits.snapshot().embedding).toEqual({ active: 0, waiting: 0, capacity: 1 });
  });

  it("reports provider wait and service time without provider payloads", async () => {
    const metrics: unknown[] = [];
    const times = [1_000, 1_012, 1_057];
    const permits = createDocumentResourcePermits({
      capacities: oneEach(),
      maximumWaitersPerResource: 2,
      clockMs: () => times.shift()!,
      onMetric: (metric) => metrics.push(metric)
    });

    await permits.run("embedding", async () => "done");

    expect(metrics).toEqual([{
      resource: "embedding",
      waitTimeMs: 12,
      serviceTimeMs: 45,
      outcome: "success"
    }]);
  });

  it("guards fixed work and nested provider calls with bounded resource lanes", () => {
    const resources = readFileSync(resolve(
      import.meta.dirname,
      "../src/document-indexing/infrastructure/production-document-fixed-resources.ts"
    ), "utf8");
    const scheduler = readFileSync(resolve(
      import.meta.dirname,
      "../src/document-indexing/application/document-fixed-dag-scheduler.ts"
    ), "utf8");
    const resourceMap = readFileSync(resolve(
      import.meta.dirname,
      "../src/document-indexing/application/document-work-resource-map.ts"
    ), "utf8");
    const nestedHandlers = [
      "production-document-content-projection-work-handler.ts",
      "production-document-knowledge-projection-work-handler.ts",
      "production-document-publication-coordinator-runtime.ts",
      "production-document-semantic-search-projection.ts"
    ].map((file) => readFileSync(resolve(
      import.meta.dirname,
      "../src/document-indexing/infrastructure",
      file
    ), "utf8")).join("\n");
    expect(resources).toContain("createDocumentResourceLanes");
    expect(scheduler).toContain("tryAcquire(request.resourceLane)");
    for (const lane of [
      "postgres_s3", "coordination", "generation_model", "graphrag_adapter", "embedding",
      "search_transport", "projection", "activation", "cleanup"
    ]) {
      expect(`${resourceMap}\n${nestedHandlers}`, lane).toContain(`"${lane}"`);
    }
    const contentProjection = readFileSync(resolve(
      import.meta.dirname,
      "../src/document-indexing/infrastructure/production-document-content-projection-work-handler.ts"
    ), "utf8");
    expect(contentProjection).not.toContain("request.releasePrimaryLane();");
  });
});

function oneEach() {
  return {
    s3_read: 1,
    generation_model: 1,
    embedding: 1,
    database_mutation: 1,
    generated_object_write: 1,
    search_provider: 1
  } as const;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  assertion();
}
