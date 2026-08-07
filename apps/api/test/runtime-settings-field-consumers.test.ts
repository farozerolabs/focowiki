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
  worker("sourceFileConcurrency", "storage-vnext/source-processing/role-runtime.ts", "settings.sourceFileConcurrency"),
  worker("sourceObjectReadConcurrency", "storage-vnext/publication/production-pipeline.ts", "snapshot.worker.sourceObjectReadConcurrency"),
  worker("claimBatchSize", "storage-vnext/source-processing/role-runtime.ts", "settings.claimBatchSize"),
  worker("pollIntervalMs", "storage-vnext/source-processing/role-runtime.ts", "settings.pollIntervalMs"),
  worker("lockTtlSeconds", "storage-vnext/source-processing/role-runtime.ts", "settings.lockTtlSeconds"),
  worker("heartbeatIntervalMs", "storage-vnext/publication/production-runtime.ts", "settings.heartbeatIntervalMs"),
  worker("jobMaxAttempts", "storage-vnext/source-processing/production-runtime.ts", "settings.jobMaxAttempts"),
  worker("jobRetryDelayMs", "storage-vnext/source-processing/production-runtime.ts", "settings.jobRetryDelayMs"),
  worker("completedJobRetentionDays", "storage-vnext/source-processing/production-runtime.ts", "settings.completedJobRetentionDays"),
  worker("hardDeleteConcurrency", "storage-vnext/maintenance/production-runtime.ts", "snapshot.worker.hardDeleteConcurrency"),
  worker("hardDeleteDatabaseBatchSize", "storage-vnext/maintenance/production-runtime.ts", "snapshot.worker.hardDeleteDatabaseBatchSize"),
  worker("hardDeleteObjectBatchSize", "storage-vnext/maintenance/production-runtime.ts", "snapshot.worker.hardDeleteObjectBatchSize"),
  worker("hardDeleteMaxAttempts", "storage-vnext/maintenance/production-runtime.ts", "snapshot.worker.hardDeleteMaxAttempts"),
  worker("hardDeleteRetryDelayMs", "storage-vnext/maintenance/production-runtime.ts", "snapshot.worker.hardDeleteRetryDelayMs"),
  publication("mode", "storage-vnext/source-processing/production-runtime.ts", "snapshot.publication.mode"),
  publication("intervalSeconds", "storage-vnext/source-processing/production-runtime.ts", "snapshot.publication.intervalSeconds"),
  publication("roleConcurrency", "storage-vnext/publication/role-runtime.ts", "settings.roleConcurrency"),
  publication("claimBatchSize", "storage-vnext/publication/role-runtime.ts", "settings.claimBatchSize"),
  publication("generatedObjectWriteConcurrency", "runtime-settings/resource-budget-settings.ts", "snapshot.publication.generatedObjectWriteConcurrency"),
  publication("directoryIndexMaxEntries", "storage-vnext/publication/production-pipeline.ts", "snapshot.publication.directoryIndexMaxEntries"),
  publication("directoryIndexMaxBytes", "storage-vnext/publication/production-pipeline.ts", "snapshot.publication.directoryIndexMaxBytes"),
  graph("candidateLimit", "storage-vnext/source-processing/production-runtime.ts", "snapshot.graph.candidateLimit"),
  graph("acceptedEdgeLimit", "storage-vnext/source-processing/production-runtime.ts", "snapshot.graph.acceptedEdgeLimit"),
  graph("searchDefaultDepth", "developer-openapi/file-search-filters.ts", "graphSettings?.searchDefaultDepth"),
  graph("searchMaxDepth", "developer-openapi/file-search-filters.ts", "graphSettings?.searchMaxDepth"),
  graph("searchDefaultFanout", "developer-openapi/file-search-filters.ts", "graphSettings?.searchDefaultFanout"),
  graph("searchMaxFanout", "developer-openapi/file-search-filters.ts", "graphSettings?.searchMaxFanout"),
  graph("modelReviewEnabled", "storage-vnext/source-processing/production-runtime.ts", "snapshot.graph.modelReviewEnabled"),
  graph("genericPhraseThreshold", "storage-vnext/source-processing/production-runtime.ts", "snapshot.graph.genericPhraseThreshold"),
  maintenance("knowledgeBaseMaintenanceMode", "storage-vnext/maintenance/production-runtime.ts", "snapshot.maintenance.knowledgeBaseMaintenanceMode"),
  maintenance("knowledgeBaseMaintenanceScanIntervalSeconds", "storage-vnext/maintenance/production-runtime.ts", "snapshot.maintenance.knowledgeBaseMaintenanceScanIntervalSeconds"),
  maintenance("knowledgeBaseMaintenanceConcurrency", "storage-vnext/maintenance/production-runtime.ts", "snapshot.maintenance.knowledgeBaseMaintenanceConcurrency"),
  maintenance("reconciliationEnabled", "storage-vnext/maintenance/production-runtime.ts", "snapshot.maintenance.reconciliationEnabled"),
  maintenance("scanBatchSize", "storage-vnext/maintenance/production-runtime.ts", "snapshot.maintenance.scanBatchSize"),
  maintenance("deletionBatchSize", "storage-vnext/maintenance/production-runtime.ts", "snapshot.maintenance.deletionBatchSize"),
  maintenance("quarantineGracePeriodSeconds", "storage-vnext/maintenance/production-runtime.ts", "snapshot.maintenance.quarantineGracePeriodSeconds"),
  maintenance("maxAttempts", "storage-vnext/maintenance/production-runtime.ts", "snapshot.maintenance.maxAttempts"),
  maintenance("retryDelayMs", "storage-vnext/maintenance/production-runtime.ts", "snapshot.maintenance.retryDelayMs"),
  maintenance("projectionRepairConcurrency", "storage-vnext/maintenance/production-runtime.ts", "snapshot.maintenance.projectionRepairConcurrency"),
  maintenance("projectionRepairDatabaseBatchSize", "storage-vnext/publication/production-pipeline.ts", "snapshot.maintenance.projectionRepairDatabaseBatchSize"),
  maintenance("projectionRepairObjectWriteConcurrency", "storage-vnext/publication/production-pipeline.ts", "snapshot.maintenance.projectionRepairObjectWriteConcurrency"),
  maintenance("lexicalRebuildConcurrency", "storage-vnext/maintenance/production-runtime.ts", "snapshot.maintenance.lexicalRebuildConcurrency"),
  maintenance("lexicalRebuildSourceReadConcurrency", "storage-vnext/publication/production-pipeline.ts", "snapshot.maintenance.lexicalRebuildSourceReadConcurrency"),
  maintenance("lexicalRebuildMaxInFlightSourceBytes", "storage-vnext/publication/production-pipeline.ts", "snapshot.maintenance.lexicalRebuildMaxInFlightSourceBytes"),
  search("requestTimeoutMs", "main.ts", "snapshot.search.requestTimeoutMs"),
  search("engineSearchCutoffMs", "storage-vnext/publication/production-pipeline.ts", "snapshot.search.engineSearchCutoffMs"),
  search("overfetchFactor", "main.ts", "snapshot.search.overfetchFactor"),
  search("indexBatchDocumentCount", "storage-vnext/publication/production-pipeline.ts", "snapshot.search.indexBatchDocumentCount"),
  search("indexBatchCompressedBytes", "storage-vnext/publication/production-pipeline.ts", "snapshot.search.indexBatchCompressedBytes"),
  search("maxInFlightTasks", "storage-vnext/maintenance/production-runtime.ts", "snapshot.search.maxInFlightTasks"),
  search("taskPollIntervalMs", "storage-vnext/publication/production-pipeline.ts", "snapshot.search.taskPollIntervalMs"),
  search("taskTimeoutMs", "storage-vnext/publication/production-pipeline.ts", "snapshot.search.taskTimeoutMs"),
  search("maxAttempts", "runtime/search-provider.ts", "input.settings.maxAttempts"),
  search("retryDelayMs", "runtime/search-provider.ts", "input.settings.retryDelayMs"),
  search("cleanupBatchSize", "storage-vnext/maintenance/production-runtime.ts", "snapshot.search.cleanupBatchSize"),
  search("stagingRetentionHours", "storage-vnext/maintenance/production-runtime.ts", "snapshot.search.stagingRetentionHours"),
  search("cropLength", "main.ts", "snapshot.search.cropLength"),
  model("displayName", "runtime-settings/repository.ts", "displayName: input.displayName"),
  model("apiMode", "runtime-settings/model-assistance-gateway.ts", "model.apiMode"),
  model("baseUrl", "runtime-settings/model-assistance-gateway.ts", "model.baseUrl"),
  model("apiKey", "runtime-settings/model-assistance-gateway.ts", "model.apiKey"),
  model("modelName", "runtime-settings/model-assistance-gateway.ts", "model.modelName"),
  model("contextWindowTokens", "runtime-settings/model-assistance-gateway.ts", "model.contextWindowTokens"),
  model("requestMaxTimeoutMs", "runtime-settings/model-assistance-gateway.ts", "model.requestMaxTimeoutMs"),
  model("requestIdleTimeoutMs", "runtime-settings/model-assistance-gateway.ts", "model.requestIdleTimeoutMs"),
  model("suggestionConcurrency", "runtime-settings/model-assistance-gateway.ts", "model.suggestionConcurrency"),
  model("transientRetryDelayMs", "runtime-settings/model-assistance-gateway.ts", "model.transientRetryDelayMs"),
  model("requestMinIntervalMs", "runtime-settings/model-assistance-gateway.ts", "model.requestMinIntervalMs")
];

describe("runtime settings field consumers", () => {
  it("covers every exposed settings field exactly once", () => {
    expect(consumers).toHaveLength(74);
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

function publication(field: string, source: string, token: string): FieldConsumer {
  return fieldConsumer("publication", field, source, token);
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

function model(field: string, source: string, token: string): FieldConsumer {
  return {
    id: `model.${field}`,
    adminTokens: [field],
    source,
    tokens: [token]
  };
}

function fieldConsumer(
  section: "worker" | "publication" | "graph" | "maintenance" | "search",
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
