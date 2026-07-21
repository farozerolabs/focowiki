import { describe, expect, it } from "vitest";
import { resolveResourceBudgetLimits } from "../src/runtime-settings/resource-budget-settings.js";

describe("resource budget settings", () => {
  it("maps Admin-managed concurrency fields to isolated process budgets", () => {
    const limits = resolveResourceBudgetLimits({
      worker: {
        sourceFileConcurrency: 8,
        sourceObjectReadConcurrency: 5,
        graphQueryConcurrency: 3,
        databaseMutationConcurrency: 4
      },
      publication: {
        roleConcurrency: 2,
        generationAssemblyConcurrency: 2,
        projectionPartitionConcurrency: 7,
        generatedObjectWriteConcurrency: 6,
        directoryMaterializationConcurrency: 4
      },
      maintenance: {
        migrationBackfillConcurrency: 3,
        compactionConcurrency: 2
      },
      activeModel: { suggestionConcurrency: 4 }
    } as never);

    expect(limits).toMatchObject({
      model: 4,
      sourceObjectRead: 5,
      graphQuery: 3,
      databaseMutation: 4,
      generationAssembly: 2,
      projectionPartition: 7,
      generatedObjectWrite: 6,
      directory: 4,
      migrationBackfill: 3,
      compaction: 2
    });
  });
});
