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
    state: "waiting",
    blockingWorkKind: "prepare",
    requiredWorkCount: 8,
    completedWorkCount: 0,
    activeWorkKinds: [],
    retryingWorkKind: null,
    processingStartedAt: null,
    processingEndedAt: null,
    failure: null,
    actions: [],
    createdAt: "2026-06-14T00:00:00.000Z",
    ...input
  };
}

describe("source file task deletion selection", () => {
  it("allows waiting, error, and available rows", () => {
    expect(isSourceFileTaskDeletionSelectable(sourceFile({ state: "waiting" }))).toBe(
      true
    );
    expect(isSourceFileTaskDeletionSelectable(sourceFile({ state: "error" }))).toBe(
      true
    );
    expect(
      isSourceFileTaskDeletionSelectable(
        sourceFile({
          state: "available",
          generatedFileAvailable: true,
          generatedOutputStatus: "current_available"
        })
      )
    ).toBe(true);
  });

  it("disables processing and deleting rows", () => {
    expect(isSourceFileTaskDeletionSelectable(sourceFile({ state: "processing" }))).toBe(
      false
    );
    expect(
      isSourceFileTaskDeletionSelectable(
        sourceFile({
          state: "deleting",
          generatedFileAvailable: false,
          generatedOutputStatus: "unavailable"
        })
      )
    ).toBe(false);
  });

  it("returns only selectable IDs from the current page", () => {
    expect(
      getSelectableSourceFileIds([
        sourceFile({ id: "source-file-waiting", state: "waiting" }),
        sourceFile({ id: "source-file-processing", state: "processing" }),
        sourceFile({
          id: "source-file-available",
          state: "available",
          generatedOutputStatus: "current_available"
        })
      ])
    ).toEqual(["source-file-waiting", "source-file-available"]);
  });
});
