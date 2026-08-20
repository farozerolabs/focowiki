import { describe, expect, it } from "vitest";
import { planDocumentFailureRetry, safeWorkerErrorDiagnostic } from
  "../src/document-indexing/infrastructure/production-document-error-diagnostic.js";

describe("document worker error diagnostic", () => {
  it("keeps a bounded error identity and source frame without logging the message", () => {
    const error = Object.assign(new TypeError("Bearer secret-value"), {
      resourcePath: "pages/guide.md",
      targetPath: "pages/孤立/无关系.md",
      stack: [
        "TypeError: Bearer secret-value",
        "    at finalizeDocument (/app/src/document-finalization.ts:42:11)",
        "    at async processDocument (/app/src/document-worker.ts:21:3)"
      ].join("\n")
    });

    expect(safeWorkerErrorDiagnostic(error)).toEqual({
      errorCode: "DOCUMENT_PROCESSING_FAILED",
      errorName: "TypeError",
      errorFrame: "/app/src/document-finalization.ts:42:11",
      errorResource: "pages/guide.md",
      errorTarget: "pages/%E5%AD%A4%E7%AB%8B/%E6%97%A0%E5%85%B3%E7%B3%BB.md"
    });
    expect(JSON.stringify(safeWorkerErrorDiagnostic(error))).not.toContain(
      "secret-value"
    );
  });

  it("preserves a safe explicit error code and tolerates non-errors", () => {
    expect(safeWorkerErrorDiagnostic(Object.assign(new Error("failed"), {
      code: "source_body_empty"
    }))).toMatchObject({ errorCode: "source_body_empty", errorName: "Error" });
    expect(safeWorkerErrorDiagnostic("failed")).toEqual({
      errorCode: "DOCUMENT_PROCESSING_FAILED",
      errorName: "UnknownError",
      errorFrame: null,
      errorResource: null,
      errorTarget: null
    });
  });

  it("keeps transient terminal failures manually retryable after auto attempts", () => {
    expect(planDocumentFailureRetry({
      error: Object.assign(new Error("failed"), { code: "provider_unavailable" }),
      attemptCount: 3,
      nowMilliseconds: Date.parse("2026-08-14T16:50:53.000Z")
    })).toEqual({
      retryable: true,
      nextAttemptAt: "2026-08-14T16:50:59.000Z"
    });
  });

  it("does not automatically repeat deterministic internal failures", () => {
    expect(planDocumentFailureRetry({
      error: Object.assign(new Error("invalid generated path"), {
        code: "generated_root"
      }),
      attemptCount: 1,
      nowMilliseconds: Date.parse("2026-08-14T16:50:53.000Z")
    })).toEqual({ retryable: true, nextAttemptAt: null });
    expect(planDocumentFailureRetry({
      error: Object.assign(new Error("bundle changed"), {
        code: "immutable_bundle_conflict"
      }),
      attemptCount: 1,
      nowMilliseconds: Date.parse("2026-08-14T16:50:53.000Z")
    })).toEqual({ retryable: true, nextAttemptAt: null });
    expect(planDocumentFailureRetry({
      error: Object.assign(new Error("projection scope contract invalid"), {
        code: "projection_scope_contribution_count_invalid"
      }),
      attemptCount: 1,
      nowMilliseconds: Date.parse("2026-08-14T16:50:53.000Z")
    })).toEqual({ retryable: false, nextAttemptAt: null });
  });

  it.each([
    "semantic_generation_request_rejected",
    "semantic_generation_request_forbidden",
    "semantic_generation_configuration_invalid",
    "semantic_generation_output_invalid",
    "INVALID_CHUNK_TEXT"
  ])("keeps manual retry but does not repeat permanent semantic failure %s", (code) => {
    expect(planDocumentFailureRetry({
      error: Object.assign(new Error("permanent semantic failure"), { code }),
      attemptCount: 1,
      nowMilliseconds: Date.parse("2026-08-14T16:50:53.000Z")
    })).toEqual({ retryable: true, nextAttemptAt: null });
  });
});
