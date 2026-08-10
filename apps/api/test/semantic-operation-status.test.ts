import { describe, expect, it } from "vitest";
import {
  presentSemanticOperationResult,
  presentSemanticOperationState
} from
  "../src/storage-vnext/api/postgres-operation-read.js";

describe("semantic operation status", () => {
  it("normalizes an accepted semantic handoff to pending", () => {
    expect(presentSemanticOperationResult(
      { semanticState: "queued", semanticSafeCode: null },
      counts()
    )).toMatchObject({ semanticState: "pending", semanticSafeCode: null });
    expect(presentSemanticOperationResult(
      {
        semanticState: "disabled",
        semanticSafeCode: "semantic_contract_not_adopted"
      },
      counts()
    )).toMatchObject({
      semanticState: "degraded",
      semanticCurrentStage: "semantic_maintenance_required"
    });
  });

  it("reports durable stage progress and completion", () => {
    expect(presentSemanticOperationResult({}, counts({
      semantic_total_count: 6,
      semantic_completed_count: 4,
      semantic_pending_count: 2,
      semantic_current_stage_kind: "embedding"
    }))).toMatchObject({
      semanticState: "pending",
      semanticStageTotalCount: 6,
      semanticStageCompletedCount: 4,
      semanticStagePendingCount: 2,
      semanticCurrentStage: "embedding_generation"
    });
    expect(presentSemanticOperationResult({}, counts({
      semantic_total_count: 6,
      semantic_completed_count: 6
    }))).toMatchObject({
      semanticState: "completed",
      semanticCurrentStage: "generation_activation"
    });
  });

  it("reports failed and superseded terminal work without diagnostics", () => {
    expect(presentSemanticOperationResult({}, counts({
      semantic_total_count: 6,
      semantic_completed_count: 2,
      semantic_pending_count: 3,
      semantic_failed_count: 1,
      semantic_safe_error_code: "semantic_embedding_timeout"
    }))).toMatchObject({
      semanticState: "failed",
      semanticSafeCode: "semantic_embedding_timeout"
    });
    expect(presentSemanticOperationResult({}, counts({
      semantic_total_count: 6,
      semantic_completed_count: 2,
      semantic_cancelled_count: 4
    }))).toMatchObject({
      semanticState: "superseded",
      semanticStageSupersededCount: 4
    });
  });

  it("keeps the public operation nonterminal until final semantic publication completes", () => {
    expect(presentSemanticOperationState("completed", counts({
      semantic_total_count: 7,
      semantic_completed_count: 6,
      semantic_pending_count: 1
    }))).toBe("processing");
    expect(presentSemanticOperationState("completed", counts({
      semantic_total_count: 7,
      semantic_completed_count: 6,
      semantic_failed_count: 1
    }))).toBe("failed");
    expect(presentSemanticOperationState("completed", counts({
      semantic_total_count: 7,
      semantic_completed_count: 7
    }))).toBe("completed");
  });
});

type Counts = {
  semantic_total_count: number;
  semantic_completed_count: number;
  semantic_pending_count: number;
  semantic_failed_count: number;
  semantic_cancelled_count: number;
  semantic_superseded_count: number;
  semantic_safe_error_code: string | null;
  semantic_current_stage_kind: string | null;
};

function counts(overrides: Partial<Counts> = {}): Counts {
  return {
    semantic_total_count: 0,
    semantic_completed_count: 0,
    semantic_pending_count: 0,
    semantic_failed_count: 0,
    semantic_cancelled_count: 0,
    semantic_superseded_count: 0,
    semantic_safe_error_code: null,
    semantic_current_stage_kind: null,
    ...overrides
  };
}
