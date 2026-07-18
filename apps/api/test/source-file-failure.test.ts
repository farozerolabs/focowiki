import { MetadataValidationError } from "@focowiki/okf";
import { describe, expect, it } from "vitest";
import {
  createSourceProcessingFailure,
  createTerminalFailure
} from "../src/application/source-file-failure.js";

const NOW = "2026-07-16T14:00:00.000Z";

describe("source-file terminal failure", () => {
  it.each([
    ["upload_storage", "UPLOAD_STORAGE_FAILED"],
    ["metadata_resolution", "METADATA_RESOLUTION_FAILED"],
    ["llm_suggestion", "MODEL_SUGGESTION_FAILED"],
    ["graph_generation", "GRAPH_GENERATION_FAILED"],
    ["projection_generation", "PROJECTION_GENERATION_FAILED"],
    ["generation_validation", "GENERATION_VALIDATION_FAILED"],
    ["generation_activation", "GENERATION_ACTIVATION_FAILED"]
  ] as const)("classifies %s as one bounded source-processing failure", (stage, code) => {
    const failure = createSourceProcessingFailure({
      stage,
      error: new Error("credential=secret"),
      occurredAt: NOW,
      correlationId: `job-${stage}`
    });

    expect(failure).toMatchObject({
      stage,
      code,
      retryKind: "source_processing",
      correlationId: `job-${stage}`
    });
    expect(failure.message).not.toContain("secret");
  });

  it("bounds and sanitizes user-facing fields", () => {
    const failure = createTerminalFailure({
      stage: "graph_generation",
      code: " graph failure! ",
      message: `Graph\nfailed\u0000${"x".repeat(600)}`,
      occurredAt: NOW,
      retryKind: "source_processing",
      correlationId: "job\u0000id"
    });

    expect(failure.code).toBe("GRAPH_FAILURE");
    expect(failure.message).toHaveLength(500);
    expect(failure.message).not.toMatch(/[\u0000-\u001f]/);
    expect(failure.correlationId).toBe("job id");
  });

  it("classifies invalid source identity as deterministic", () => {
    expect(createSourceProcessingFailure({
      stage: "metadata_resolution",
      error: new MetadataValidationError(["unsafe title"]),
      occurredAt: NOW,
      correlationId: "source-job-1"
    })).toMatchObject({
      code: "METADATA_VALIDATION_FAILED",
      retryKind: "none"
    });
  });
});
