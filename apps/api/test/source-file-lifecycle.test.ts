import { describe, expect, it } from "vitest";
import {
  deriveSourceFileLifecycle,
  type SourceFileTerminalFailure
} from "../src/domain/source-file-lifecycle.js";

const OCCURRED_AT = "2026-08-14T14:00:00.000Z";

describe("source-file lifecycle", () => {
  it("exposes a current available document immediately", () => {
    expect(deriveSourceFileLifecycle({
      processingStatus: "available",
      blockingWorkKind: null,
      generatedOutputStatus: "current_available",
      generatedPath: "pages/source.md",
      failure: null
    })).toEqual({
      state: "available",
      blockingWorkKind: null,
      failure: null,
      actions: ["open_generated_file"]
    });
  });

  it("keeps a previous active document readable after replacement failure", () => {
    const failure = terminalFailure("first_layer", "document_processing");
    expect(deriveSourceFileLifecycle({
      processingStatus: "error",
      blockingWorkKind: null,
      generatedOutputStatus: "previous_available",
      generatedPath: "pages/source.md",
      failure
    })).toEqual({
      state: "error",
      blockingWorkKind: null,
      failure,
      actions: [
        "open_generated_file",
        "view_failure_details",
        "retry_document_processing"
      ]
    });
  });

  it("never opens a newly failed document with no active revision", () => {
    expect(deriveSourceFileLifecycle({
      processingStatus: "error",
      blockingWorkKind: null,
      generatedOutputStatus: "unavailable",
      generatedPath: null,
      failure: terminalFailure("content_projection", "document_processing")
    }).actions).toEqual([
      "view_failure_details",
      "retry_document_processing"
    ]);
  });

  it("offers correction instead of retry for deterministic source input", () => {
    const failure = {
      ...terminalFailure("prepare", "none"),
      code: "source_frontmatter_invalid"
    };
    expect(deriveSourceFileLifecycle({
      processingStatus: "error",
      blockingWorkKind: null,
      generatedOutputStatus: "unavailable",
      generatedPath: null,
      failure
    }).actions).toEqual([
      "view_failure_details",
      "replace_source_content"
    ]);
  });

  it("shows no terminal action while a retry is waiting or processing", () => {
    for (const processingStatus of ["waiting", "processing"] as const) {
      expect(deriveSourceFileLifecycle({
        processingStatus,
        blockingWorkKind: "prepare",
        generatedOutputStatus: "unavailable",
        generatedPath: null,
        failure: null
      }).actions).toEqual([]);
    }
  });

  it("keeps deleting non-openable", () => {
    expect(deriveSourceFileLifecycle({
      processingStatus: "deleting",
      blockingWorkKind: null,
      generatedOutputStatus: "unavailable",
      generatedPath: null,
      failure: null
    })).toMatchObject({ state: "deleting", actions: [] });
  });
});

function terminalFailure(
  workKind: SourceFileTerminalFailure["workKind"],
  retryKind: SourceFileTerminalFailure["retryKind"]
): SourceFileTerminalFailure {
  return {
    workKind,
    code: "DOCUMENT_PROCESSING_FAILED",
    message: "Document processing failed.",
    occurredAt: OCCURRED_AT,
    retryKind,
    correlationId: "document-job-1"
  };
}
