import { describe, expect, it } from "vitest";
import {
  deriveSourceFileLifecycle,
  type SourceFileTerminalFailure
} from "../src/domain/source-file-lifecycle.js";

const OCCURRED_AT = "2026-07-16T14:00:00.000Z";

describe("source-file lifecycle", () => {
  it("projects publication failure as failed with publication recovery actions", () => {
    const failure = terminalFailure("projection_generation", "publication");

    expect(deriveSourceFileLifecycle({
      processingStatus: "completed",
      processingStage: "projection_generation",
      generatedOutputStatus: "unavailable",
      generatedPath: null,
      failure
    })).toEqual({
      state: "failed",
      currentStage: "projection_generation",
      failure,
      actions: ["view_failure_details", "retry_publication"]
    });
  });

  it("projects processing failure with a source-processing retry", () => {
    const failure = terminalFailure("graph_generation", "source_processing");

    expect(deriveSourceFileLifecycle({
      processingStatus: "failed",
      processingStage: "graph_generation",
      generatedOutputStatus: "unavailable",
      generatedPath: null,
      failure
    }).actions).toEqual(["view_failure_details", "retry_source_processing"]);
  });

  it("keeps a deterministic failure detail-only", () => {
    expect(deriveSourceFileLifecycle({
      processingStatus: "failed",
      processingStage: "metadata_resolution",
      generatedOutputStatus: "unavailable",
      generatedPath: null,
      failure: terminalFailure("metadata_resolution", "none")
    }).actions).toEqual(["view_failure_details"]);
  });

});

function terminalFailure(
  stage: SourceFileTerminalFailure["stage"],
  retryKind: SourceFileTerminalFailure["retryKind"]
): SourceFileTerminalFailure {
  return {
    stage,
    code: "RELEASE_VALIDATION_FAILED",
    message: "Generated navigation could not be validated.",
    occurredAt: OCCURRED_AT,
    retryKind,
    correlationId: "publication-job-1"
  };
}
