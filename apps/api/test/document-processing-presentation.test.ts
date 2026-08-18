import { describe, expect, it } from "vitest";
import {
  presentDocumentProcessing,
  type DocumentProcessingPresentationInput
} from "../src/document-indexing/domain/document-processing-presentation.js";

describe("document processing presentation", () => {
  it("presents concurrent work with real model and GraphRAG facts", () => {
    expect(presentDocumentProcessing(baseInput({
      state: "processing",
      work: [
        { kind: "first_layer", state: "running", startedAt: "2026-08-15T01:00:00.000Z", endedAt: null },
        { kind: "content_projection", state: "running", startedAt: "2026-08-15T01:00:00.100Z", endedAt: null }
      ],
      model: {
        status: "running",
        modelName: "general-model",
        startedAt: "2026-08-15T01:00:00.000Z",
        endedAt: null,
        warningCount: 0,
        errorCode: null
      },
      graph: { required: true, completedChunks: 1, totalChunks: 3 }
    }))).toMatchObject({
      state: "processing",
      activeWork: ["first_layer", "content_projection"],
      model: { modelName: "general-model", status: "running" },
      graph: { status: "running", completedChunks: 1, totalChunks: 3 },
      generatedOutput: "unavailable",
      actions: []
    });
  });

  it.each([
    ["waiting", []],
    ["available", ["open_generated_file"]],
    ["deleting", []],
    ["cancelled", []],
    ["superseded", []]
  ] as const)("presents truthful %s actions", (state, actions) => {
    expect(presentDocumentProcessing(baseInput({
      state,
      generatedOutput: state === "available" ? "current_available" : "unavailable"
    })).actions).toEqual(actions);
  });

  it("presents safe terminal error and retry only when it is executable", () => {
    expect(presentDocumentProcessing(baseInput({
      state: "error",
      failure: { code: "MODEL_RATE_LIMITED", message: null, retryable: true }
    }))).toMatchObject({
      state: "error",
      failure: { code: "MODEL_RATE_LIMITED", message: null, retryable: true },
      actions: ["view_failure_details", "retry_document_processing"]
    });
  });
});

function baseInput(
  overrides: Partial<DocumentProcessingPresentationInput>
): DocumentProcessingPresentationInput {
  return {
    state: "waiting",
    work: [],
    model: null,
    graph: { required: false, completedChunks: 0, totalChunks: 0 },
    generatedOutput: "unavailable",
    failure: null,
    ...overrides
  };
}
