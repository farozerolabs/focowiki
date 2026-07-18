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
    state: "queued",
    currentStage: "upload_storage",
    processingStartedAt: null,
    processingEndedAt: null,
    failure: null,
    actions: [],
    createdAt: "2026-06-14T00:00:00.000Z",
    ...input
  };
}

describe("source file task deletion selection", () => {
  it("allows queued, failed, and completed visible rows", () => {
    expect(isSourceFileTaskDeletionSelectable(sourceFile({ state: "queued" }))).toBe(
      true
    );
    expect(isSourceFileTaskDeletionSelectable(sourceFile({ state: "failed" }))).toBe(
      true
    );
    expect(
      isSourceFileTaskDeletionSelectable(
        sourceFile({
          state: "visible",
          generatedFileAvailable: true,
          generatedOutputStatus: "visible"
        })
      )
    ).toBe(true);
  });

  it("disables running and completed pending rows", () => {
    expect(isSourceFileTaskDeletionSelectable(sourceFile({ state: "running" }))).toBe(
      false
    );
    expect(
      isSourceFileTaskDeletionSelectable(
        sourceFile({
          state: "pending_publication",
          generatedFileAvailable: false,
          generatedOutputStatus: "pending"
        })
      )
    ).toBe(false);
  });

  it("returns only selectable IDs from the current page", () => {
    expect(
      getSelectableSourceFileIds([
        sourceFile({ id: "source-file-queued", state: "queued" }),
        sourceFile({ id: "source-file-running", state: "running" }),
        sourceFile({
          id: "source-file-visible",
          state: "visible",
          generatedOutputStatus: "visible"
        })
      ])
    ).toEqual(["source-file-queued", "source-file-visible"]);
  });
});
