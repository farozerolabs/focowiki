import { describe, expect, it } from "vitest";
import {
  createSemanticStageBudgetManager,
  planSemanticSourceStages,
  semanticStagePredecessors
} from "../src/semantic/application/stage-orchestration.js";

describe("durable semantic stage orchestration", () => {
  it("plans revision-bound stages with immutable settings snapshots", () => {
    const plan = planSemanticSourceStages({
      knowledgeBaseId: "kb-main",
      operationPublicId: "operation-main",
      semanticGenerationPublicId: "generation-main",
      sourceFilePublicId: "file-main",
      sourceRevisionPublicId: "revision-main",
      extractionContractVersion: "extract-v1",
      embeddingConfigurationRevisionPublicId: "embedding-revision-1",
      settingsSnapshot: {
        generationModelRevisionPublicId: "model-revision-1",
        graphSchemaVersion: "graph-v1",
        promptContractVersion: "prompt-v1"
      },
      dirtyCommunityPartitionKeys: ["entity-ab"],
      includeValidation: true,
      maximumAttempts: 3
    });
    expect(plan.map((item) => item.stageKind)).toEqual([
      "extraction", "reconciliation", "community", "embedding",
      "vector", "publication", "validation"
    ]);
    expect(plan.every((item) => item.sourceRevisionPublicId === "revision-main")).toBe(true);
    expect(plan.every((item) =>
      item.settingsSnapshot.generationModelRevisionPublicId === "model-revision-1"
    )).toBe(true);
    expect(new Set(plan.map((item) => item.publicId)).size).toBe(plan.length);
    expect(semanticStagePredecessors("vector")).toEqual([
      "extraction", "reconciliation", "community", "embedding"
    ]);
  });

  it("plans deletion cleanup without extraction or model embedding", () => {
    const plan = planSemanticSourceStages({
      knowledgeBaseId: "kb-main",
      operationPublicId: "operation-delete",
      semanticGenerationPublicId: "generation-main",
      sourceFilePublicId: "file-main",
      sourceRevisionPublicId: "revision-main",
      extractionContractVersion: "extract-v1",
      embeddingConfigurationRevisionPublicId: "embedding-revision-1",
      settingsSnapshot: { graphSchemaVersion: "graph-v1" },
      dirtyCommunityPartitionKeys: ["entity-ab"],
      includeValidation: false,
      deletion: true,
      maximumAttempts: 3
    });
    expect(plan.map((item) => item.stageKind)).toEqual([
      "cleanup", "community", "vector", "publication"
    ]);
  });

  it("enforces independent bounded queues while allowing different knowledge bases progress", async () => {
    const budgets = createSemanticStageBudgetManager({
      generation: { concurrency: 1, maximumBacklog: 2 },
      python: { concurrency: 1, maximumBacklog: 2 },
      embedding: { concurrency: 1, maximumBacklog: 2 },
      s3_read: { concurrency: 1, maximumBacklog: 2 },
      s3_write: { concurrency: 1, maximumBacklog: 2 },
      database_mutation: { concurrency: 2, maximumBacklog: 4 },
      search_write: { concurrency: 1, maximumBacklog: 2 },
      publication: { concurrency: 1, maximumBacklog: 2 },
      maintenance: { concurrency: 1, maximumBacklog: 2 }
    });
    const first = await budgets.acquire("database_mutation", "kb-a");
    const second = await budgets.acquire("database_mutation", "kb-b");
    expect(budgets.stats().database_mutation.active).toBe(2);
    first();
    second();
    expect(budgets.stats().database_mutation.active).toBe(0);
  });

  it("rejects a saturated stage instead of stealing another resource budget", async () => {
    const budgets = createSemanticStageBudgetManager(singleBudgets());
    const release = await budgets.acquire("python", "kb-a");
    const queued = budgets.acquire("python", "kb-b");
    await expect(budgets.acquire("python", "kb-c")).rejects.toMatchObject({
      code: "semantic_stage_backlog_full"
    });
    expect(budgets.stats().embedding.active).toBe(0);
    release();
    const releaseQueued = await queued;
    releaseQueued();
  });

  it("keeps S3 reads, S3 writes, database mutations, and search writes independent", async () => {
    const budgets = createSemanticStageBudgetManager(singleBudgets());
    const releaseWrite = await budgets.acquire("s3_write", "kb-a");
    const queuedWrite = budgets.acquire("s3_write", "kb-b");
    const releaseRead = await budgets.acquire("s3_read", "kb-c");
    const releaseDatabase = await budgets.acquire("database_mutation", "kb-c");
    const releaseSearch = await budgets.acquire("search_write", "kb-c");

    expect(budgets.stats()).toMatchObject({
      s3_write: { active: 1, queued: 1 },
      s3_read: { active: 1, queued: 0 },
      database_mutation: { active: 1, queued: 0 },
      search_write: { active: 1, queued: 0 }
    });
    releaseRead();
    releaseDatabase();
    releaseSearch();
    releaseWrite();
    (await queuedWrite)();
  });
});

function singleBudgets() {
  return {
    generation: { concurrency: 1, maximumBacklog: 1 },
    python: { concurrency: 1, maximumBacklog: 1 },
    embedding: { concurrency: 1, maximumBacklog: 1 },
    s3_read: { concurrency: 1, maximumBacklog: 1 },
    s3_write: { concurrency: 1, maximumBacklog: 1 },
    database_mutation: { concurrency: 1, maximumBacklog: 1 },
    search_write: { concurrency: 1, maximumBacklog: 1 },
    publication: { concurrency: 1, maximumBacklog: 1 },
    maintenance: { concurrency: 1, maximumBacklog: 1 }
  };
}
