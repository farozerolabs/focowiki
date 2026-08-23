import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type FieldConsumer = {
  id: string;
  adminTokens: readonly string[];
  source: string;
  tokens: readonly string[];
};

const apiSource = resolve(import.meta.dirname, "../src");
const adminPanel = readFileSync(resolve(
  import.meta.dirname,
  "../../admin/src/components/settings-panel.tsx"
), "utf8");

const consumers: readonly FieldConsumer[] = [
  ...rateLimitConsumers("adminLogin", "admin/security.ts"),
  ...rateLimitConsumers("adminApi", "admin/security.ts"),
  ...rateLimitConsumers("publicOpenApi", "developer-openapi/security.ts"),
  worker("sourceFileConcurrency", "document-indexing/infrastructure/production-runtime.ts", "settings.sourceFileConcurrency"),
  {
    id: "worker.s3Concurrency",
    adminTokens: ["s3Concurrency"],
    source: "document-indexing/infrastructure/production-runtime.ts",
    tokens: ["settings.sourceObjectReadConcurrency"]
  },
  worker("jobMaxAttempts", "document-indexing/application/document-worker-settings.ts", "jobMaxAttempts"),
  worker("jobRetryDelayMs", "document-indexing/application/document-worker-settings.ts", "jobRetryDelayMs"),
  worker("completedJobRetentionDays", "document-indexing/infrastructure/production-background-runtime.ts", "workerConfig.completedJobRetentionDays"),
  generated("directoryIndexMaxEntries", "document-indexing/application/document-output-settings.ts", "directoryIndexMaxEntries"),
  generated("directoryIndexMaxBytes", "document-indexing/application/document-output-settings.ts", "directoryIndexMaxBytes"),
  generated("rootSummaryLimit", "document-indexing/infrastructure/production-document-fixed-processor.ts", "generated.rootSummaryLimit"),
  generated("okfLogMaxEntries", "document-indexing/infrastructure/production-document-fixed-processor.ts", "generated.okfLogMaxEntries"),
  generated("okfLogMaxBytes", "document-indexing/infrastructure/production-document-fixed-processor.ts", "generated.okfLogMaxBytes"),
  graph("candidateLimit", "document-indexing/infrastructure/production-document-relation-reconcile-work-handler.ts", "settings.graph.candidateLimit"),
  graph("acceptedEdgeLimit", "document-indexing/infrastructure/production-document-relation-reconcile-work-handler.ts", "settings.graph.acceptedEdgeLimit"),
  graph("searchDefaultDepth", "developer-openapi/file-search-filters.ts", "graphSettings?.searchDefaultDepth"),
  graph("searchMaxDepth", "developer-openapi/file-search-filters.ts", "graphSettings?.searchMaxDepth"),
  graph("searchDefaultFanout", "developer-openapi/file-search-filters.ts", "graphSettings?.searchDefaultFanout"),
  graph("searchMaxFanout", "developer-openapi/file-search-filters.ts", "graphSettings?.searchMaxFanout"),
  graph("shardSize", "document-indexing/infrastructure/production-document-fixed-processor.ts", "graphConfig.shardSize"),
  graph("genericPhraseThreshold", "document-indexing/infrastructure/production-document-relation-reconcile-work-handler.ts", "settings.graph.genericPhraseThreshold"),
  maintenance("reconciliationEnabled", "document-indexing/application/document-maintenance-phase-runner.ts", "reconciliationEnabled"),
  maintenance("scanBatchSize", "document-indexing/infrastructure/production-background-runtime.ts", ")).scanBatchSize"),
  maintenance("maxAttempts", "storage-vnext/api/admin-maintenance-application.ts", "maintenance.maxAttempts"),
  maintenance("retryDelayMs", "document-indexing/infrastructure/production-background-runtime.ts", "maintenance.retryDelayMs"),
  maintenance("hardDeleteConcurrency", "document-indexing/infrastructure/production-background-runtime.ts", "maintenance.hardDeleteConcurrency"),
  maintenance("hardDeleteDatabaseBatchSize", "document-indexing/infrastructure/production-background-runtime.ts", "maintenance.hardDeleteDatabaseBatchSize"),
  maintenance("hardDeleteObjectBatchSize", "document-indexing/infrastructure/production-background-runtime.ts", "maintenance.hardDeleteObjectBatchSize"),
  maintenance("hardDeleteMaxAttempts", "storage-vnext/api/postgres-admin-mutation.ts", "maintenance.hardDeleteMaxAttempts"),
  maintenance("hardDeleteRetryDelayMs", "document-indexing/infrastructure/production-background-runtime.ts", "maintenance.hardDeleteRetryDelayMs"),
  maintenance("hardDeleteFailedRetentionDays", "document-indexing/infrastructure/production-background-runtime.ts", "maintenance.hardDeleteFailedRetentionDays"),
  search("requestTimeoutMs", "main.ts", "snapshot.search.requestTimeoutMs"),
  search("engineSearchCutoffMs", "runtime/search-provider.ts", "settings.engineSearchCutoffMs"),
  search("overfetchFactor", "main.ts", "snapshot.search.overfetchFactor"),
  search("indexBatchDocumentCount", "runtime/search-provider.ts", "settings.indexBatchDocumentCount"),
  search("indexBatchCompressedBytes", "runtime/search-provider.ts", "settings.indexBatchCompressedBytes"),
  search("maxInFlightTasks", "runtime/search-provider.ts", "settings.maxInFlightTasks"),
  search("taskPollIntervalMs", "runtime/search-provider.ts", "settings.taskPollIntervalMs"),
  search("taskTimeoutMs", "runtime/search-provider.ts", "settings.taskTimeoutMs"),
  search("maxAttempts", "runtime/search-provider.ts", "input.settings.maxAttempts"),
  search("retryDelayMs", "runtime/search-provider.ts", "input.settings.retryDelayMs"),
  search("cleanupBatchSize", "document-indexing/infrastructure/production-background-runtime.ts", "search.cleanupBatchSize"),
  search("cropLength", "main.ts", "snapshot.search.cropLength"),
  semantic("maximumChunkCharacters", "document-indexing/infrastructure/production-document-graphrag-work-handler.ts", "outputSettings.semantic.maximumChunkCharacters"),
  semantic("maximumChunks", "document-indexing/infrastructure/production-document-graphrag-work-handler.ts", "outputSettings.semantic.maximumChunks"),
  semantic("maximumEvidenceTargets", "document-indexing/infrastructure/production-document-content-projection-work-handler.ts", "settings.semantic.maximumEvidenceTargets"),
  semantic("graphRagAdapterTimeoutMs", "document-indexing/infrastructure/production-document-graphrag-work-handler.ts", "outputSettings.semantic.graphRagAdapterTimeoutMs"),
  semantic("searchLaneCutoffMs", "main.ts", "snapshot.semantic.searchLaneCutoffMs"),
  semantic("queryEmbeddingConcurrency", "semantic/search/production-runtime.ts", "settings.queryEmbeddingConcurrency"),
  semantic("queryEmbeddingCacheEntries", "semantic/search/production-runtime.ts", "settings.queryEmbeddingCacheEntries"),
  model("displayName", "runtime-settings/repository.ts", "displayName: input.displayName"),
  model("apiMode", "document-indexing/infrastructure/production-document-processor-support.ts", "model.apiMode"),
  model("baseUrl", "document-indexing/infrastructure/production-document-processor-support.ts", "model.baseUrl"),
  model("apiKey", "document-indexing/infrastructure/production-document-processor-support.ts", "model.apiKey"),
  model("modelName", "document-indexing/infrastructure/production-document-processor-support.ts", "model.modelName"),
  model("contextWindowTokens", "document-indexing/infrastructure/production-document-processor-support.ts", "model.contextWindowTokens"),
  model("requestMaxTimeoutMs", "document-indexing/infrastructure/production-document-processor-support.ts", "model.requestMaxTimeoutMs"),
  model("requestIdleTimeoutMs", "document-indexing/infrastructure/production-document-processor-support.ts", "model.requestIdleTimeoutMs"),
  model("suggestionConcurrency", "document-indexing/infrastructure/production-document-processor-support.ts", "model.suggestionConcurrency"),
  model("transientRetryDelayMs", "document-indexing/infrastructure/production-document-processor-support.ts", "model.transientRetryDelayMs"),
  model("requestMinIntervalMs", "document-indexing/infrastructure/production-document-processor-support.ts", "model.requestMinIntervalMs")
];

describe("runtime settings field consumers", () => {
  it("covers every exposed settings field exactly once", () => {
    expect(consumers).toHaveLength(64);
    expect(new Set(consumers.map((entry) => entry.id)).size).toBe(consumers.length);
  });

  it.each(consumers)("keeps $id visible and connected to a live reader", (entry) => {
    for (const token of entry.adminTokens) {
      expect(adminPanel, `${entry.id} is missing from Admin settings`).toContain(token);
    }
    const source = readFileSync(resolve(apiSource, entry.source), "utf8");
    for (const token of entry.tokens) {
      expect(source, `${entry.id} has no live reader in ${entry.source}`).toContain(token);
    }
  });

  it("passes both rate-limit values to the shared limiter", () => {
    const source = [
      "security/rate-limit.ts",
      "redis/coordination.ts"
    ].map((relativePath) => readFileSync(resolve(apiSource, relativePath), "utf8"))
      .join("\n");
    expect(source).toContain("limit.max");
    expect(source).toContain("limit.windowSeconds");
  });
});

function rateLimitConsumers(
  group: "adminLogin" | "adminApi" | "publicOpenApi",
  source: string
): FieldConsumer[] {
  return ["max", "windowSeconds"].map((field) => ({
    id: `rateLimits.${group}.${field}`,
    adminTokens: [group, field],
    source,
    tokens: [group]
  }));
}

function worker(field: string, source: string, token: string): FieldConsumer {
  return fieldConsumer("worker", field, source, token);
}

function generated(field: string, source: string, token: string): FieldConsumer {
  return fieldConsumer("generated", field, source, token);
}

function graph(field: string, source: string, token: string): FieldConsumer {
  return fieldConsumer("graph", field, source, token);
}

function maintenance(field: string, source: string, token: string): FieldConsumer {
  return fieldConsumer("maintenance", field, source, token);
}

function search(field: string, source: string, token: string): FieldConsumer {
  return fieldConsumer("search", field, source, token);
}

function semantic(field: string, source: string, token: string): FieldConsumer {
  return fieldConsumer("semantic", field, source, token);
}

function model(field: string, source: string, token: string): FieldConsumer {
  return {
    id: `model.${field}`,
    adminTokens: [field],
    source,
    tokens: [token]
  };
}

function fieldConsumer(
  section: "worker" | "generated" | "graph" | "maintenance" | "search" | "semantic",
  field: string,
  source: string,
  token: string
): FieldConsumer {
  return {
    id: `${section}.${field}`,
    adminTokens: [field],
    source,
    tokens: [token]
  };
}
