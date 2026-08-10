import { describe, expect, it } from "vitest";
import { createSemanticStageMetrics } from
  "../src/semantic/application/stage-metrics.js";

describe("semantic stage metrics", () => {
  it("aggregates bounded stage labels without source identifiers", () => {
    const metrics = createSemanticStageMetrics();
    metrics.record({ stageKind: "embedding", outcome: "completed", durationMs: 40 });
    metrics.record({ stageKind: "embedding", outcome: "retry", durationMs: 20 });
    metrics.record({ stageKind: "extraction", outcome: "completed", durationMs: 15 });

    expect(metrics.diagnosticFields()).toEqual(expect.objectContaining({
      stageExecutionCount: 3,
      stageRetryCount: 1,
      embeddingExecutionCount: 2,
      embeddingCompletedCount: 1,
      embeddingRetryCount: 1,
      embeddingAverageDurationMs: 30,
      embeddingMaximumDurationMs: 40,
      extractionExecutionCount: 1,
      extractionAverageDurationMs: 15
    }));
    expect(Object.keys(metrics.diagnosticFields()).join(" "))
      .not.toMatch(/source|knowledgeBase|operation/u);
  });
});
