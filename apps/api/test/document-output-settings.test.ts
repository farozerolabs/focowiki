import { describe, expect, it } from "vitest";
import { resolvePinnedDocumentOutputSettings } from
  "../src/document-indexing/application/document-output-settings.js";

describe("document output settings", () => {
  it("resolves generated, graph, and search settings from the pinned revision", () => {
    const settings = resolvePinnedDocumentOutputSettings({
      schemaVersion: "storage-vnext-settings-v1",
      version: 4,
      source: "admin",
      sections: {
        generated: {
          directoryIndexMaxEntries: 200,
          directoryIndexMaxBytes: 65_536,
          rootSummaryLimit: 200,
          okfLogMaxEntries: 200,
          okfLogMaxBytes: 65_536
        },
        graph: {
          candidateLimit: 128,
          acceptedEdgeLimit: 64,
          searchDefaultDepth: 1,
          searchMaxDepth: 2,
          searchDefaultFanout: 10,
          searchMaxFanout: 50,
          shardSize: 500,
          genericPhraseThreshold: 3
        },
        search: searchSettings(),
        semantic: semanticSettings()
      }
    });

    expect(settings.generated.directoryIndexMaxEntries).toBe(200);
    expect(settings.graph.shardSize).toBe(500);
    expect(settings.search.indexBatchDocumentCount).toBe(100);
    expect(settings.directoryLeafLimits).toEqual({
      maxEntries: 200,
      maxBytes: 65_536,
      mergeBelowEntries: 50
    });
  });

  it("rejects a pinned directory limit that cannot preserve split/merge invariants", () => {
    expect(() => resolvePinnedDocumentOutputSettings({
      schemaVersion: "storage-vnext-settings-v1",
      version: 1,
      source: "bootstrap",
      sections: {
        generated: {
          directoryIndexMaxEntries: 1,
          directoryIndexMaxBytes: 65_536,
          rootSummaryLimit: 200,
          okfLogMaxEntries: 200,
          okfLogMaxBytes: 65_536
        },
        graph: {
          candidateLimit: 128,
          acceptedEdgeLimit: 64,
          searchDefaultDepth: 1,
          searchMaxDepth: 2,
          searchDefaultFanout: 10,
          searchMaxFanout: 50,
          shardSize: 500,
          genericPhraseThreshold: 3
        },
        search: searchSettings(),
        semantic: semanticSettings()
      }
    })).toThrowError(expect.objectContaining({ code: "generated_settings_revision_invalid" }));
  });
});

function searchSettings() {
  return {
    requestTimeoutMs: 10_000,
    engineSearchCutoffMs: 5_000,
    overfetchFactor: 4,
    indexBatchDocumentCount: 100,
    indexBatchCompressedBytes: 1_048_576,
    maxInFlightTasks: 4,
    taskPollIntervalMs: 100,
    taskTimeoutMs: 30_000,
    maxAttempts: 4,
    retryDelayMs: 1_000,
    cleanupBatchSize: 100,
    cropLength: 1_000
  };
}

function semanticSettings() {
  return {
    maximumChunkCharacters: 8_000,
    maximumChunks: 32,
    maximumEvidenceTargets: 64,
    graphRagAdapterTimeoutMs: 30_000,
    searchLaneCutoffMs: 2_500,
    queryEmbeddingConcurrency: 4,
    queryEmbeddingCacheEntries: 1_000
  };
}
