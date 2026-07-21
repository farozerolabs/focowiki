import { describe, expect, it } from "vitest";

import { toAdminSourceFile } from "../src/admin/serializers.js";
import type { SourceFileRecord } from "../src/db/admin-repositories.js";
import {
  deriveSourceFileLifecycle,
  type SourceFileTerminalFailure
} from "../src/domain/source-file-lifecycle.js";

const OCCURRED_AT = "2026-07-16T14:00:00.000Z";

describe("source-file lifecycle", () => {
  it("serializes publication failure instead of an error-free completed row", () => {
    const file = sourceFile({
      processingStatus: "completed",
      processingStage: "projection_generation",
      generatedOutputStatus: "unavailable",
      terminalFailure: terminalFailure("projection_generation", "publication")
    });

    expect(toAdminSourceFile(file)).toMatchObject({
      state: "failed",
      currentStage: "projection_generation",
      failure: {
        code: "RELEASE_VALIDATION_FAILED",
        retryKind: "publication"
      },
      actions: expect.arrayContaining([
        expect.objectContaining({ kind: "view_failure_details" }),
        expect.objectContaining({ kind: "retry_publication" })
      ])
    });
  });

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

  it("preserves missing processing timestamps for queued retries", () => {
    const serialized = toAdminSourceFile(sourceFile({
      processingStartedAt: null,
      processingEndedAt: null
    }));

    expect(serialized.processingStartedAt).toBeNull();
    expect(serialized.processingEndedAt).toBeNull();
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

function sourceFile(overrides: Partial<SourceFileRecord>): SourceFileRecord {
  return {
    id: "source-file-1",
    knowledgeBaseId: "kb-1",
    sourceRevisionId: "source-revision-1",
    name: "guide.md",
    relativePath: "guides/guide.md",
    resourceRevision: 1,
    objectKey: "sources/guide.md",
    contentType: "text/markdown",
    sizeBytes: 10,
    checksumSha256: "checksum",
    metadata: { type: "page", title: "Guide" },
    processingStatus: "queued",
    processingStage: "upload_storage",
    generatedOutputStatus: "pending",
    createdAt: OCCURRED_AT,
    deletedAt: null,
    ...overrides
  };
}
