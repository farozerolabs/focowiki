import { describe, expect, it } from "vitest";
import type { SourceFileRecord } from "../src/lib/admin-api";
import {
  getSelectableSourceFileIds,
  isSourceFileTaskDeletionSelectable
} from "../src/lib/source-file-task-deletion";

function sourceFile(input: Partial<SourceFileRecord>): SourceFileRecord {
  return {
    id: "source-file-001",
    name: "example.md",
    relativePath: "example.md",
    processingStatus: "queued",
    processingStage: "upload_storage",
    processingStartedAt: null,
    processingEndedAt: null,
    processingErrorCode: null,
    createdAt: "2026-06-14T00:00:00.000Z",
    ...input
  };
}

describe("source file task deletion selection", () => {
  it("allows queued, failed, and completed visible rows", () => {
    expect(isSourceFileTaskDeletionSelectable(sourceFile({ processingStatus: "queued" }))).toBe(
      true
    );
    expect(isSourceFileTaskDeletionSelectable(sourceFile({ processingStatus: "failed" }))).toBe(
      true
    );
    expect(
      isSourceFileTaskDeletionSelectable(
        sourceFile({
          processingStatus: "completed",
          generatedFileAvailable: true,
          generatedOutputStatus: "visible"
        })
      )
    ).toBe(true);
  });

  it("disables running and completed pending rows", () => {
    expect(isSourceFileTaskDeletionSelectable(sourceFile({ processingStatus: "running" }))).toBe(
      false
    );
    expect(
      isSourceFileTaskDeletionSelectable(
        sourceFile({
          processingStatus: "completed",
          generatedFileAvailable: false,
          generatedOutputStatus: "pending"
        })
      )
    ).toBe(false);
  });

  it("returns only selectable IDs from the current page", () => {
    expect(
      getSelectableSourceFileIds([
        sourceFile({ id: "source-file-queued", processingStatus: "queued" }),
        sourceFile({ id: "source-file-running", processingStatus: "running" }),
        sourceFile({
          id: "source-file-visible",
          processingStatus: "completed",
          generatedOutputStatus: "visible"
        })
      ])
    ).toEqual(["source-file-queued", "source-file-visible"]);
  });
});
