import { describe, expect, it } from "vitest";
import type { ResourceOperationRecord } from "../src/domain/source-resource.js";
import { presentDeveloperResourceOperation } from
  "../src/developer-openapi/resource-operation-presenter.js";

describe("Developer OpenAPI resource operation presentation", () => {
  it.each(["accepted", "validating"] as const)(
    "collapses the internal %s state to the public processing state",
    (state) => {
      const presented = presentDeveloperResourceOperation(operation({ state }));

      expect(presented.state).toBe("processing");
      expect(presented.retryGuidance).toBe(
        "Check this change again after a short delay."
      );
      expect(presented.completedAt).toBeNull();
    }
  );

  it("publishes only documented progressive counts for upload operations", () => {
    const presented = presentDeveloperResourceOperation(operation({
      kind: "upload",
      targetKind: "knowledge_base",
      targetId: "knowledge-base-review",
      result: {
        sessionPublicId: "upload-private-shape",
        relatedOperationPublicId: "deletion-private-shape",
        expectedEntryCount: 2,
        expectedByteCount: 100,
        receivedEntryCount: 2,
        receivedByteCount: 100,
        skippedExistingCount: 0,
        totalCount: 2,
        waitingCount: 0,
        processingCount: 0,
        availableCount: 2,
        failedCount: 0,
        deletingCount: 0,
        cancelledCount: 0,
        supersededCount: 0
      }
    }));

    expect(presented.result).toEqual({
      totalCount: 2,
      waitingCount: 0,
      processingCount: 0,
      availableCount: 2,
      failedCount: 0,
      deletingCount: 0,
      cancelledCount: 0,
      supersededCount: 0
    });
  });

  it.each([
    "source_file_move",
    "source_file_replace",
    "source_file_delete",
    "source_directory_delete",
    "knowledge_base_delete"
  ] as const)("removes duplicate internal result fields from %s", (kind) => {
    const presented = presentDeveloperResourceOperation(operation({
      kind,
      targetKind: kind === "knowledge_base_delete" ? "knowledge_base" : "source_file",
      targetId: "source-file-review",
      result: {
        targetKind: "source_file",
        targetPublicId: "source-file-review",
        affectedSourceCount: 1,
        sourceFilePublicId: "source-file-review",
        sourceRevisionPublicId: "source-revision-review"
      }
    }));

    expect(presented.result).toBeNull();
    expect(presented.targetId).toBe("source-file-review");
  });

  it("keeps bounded progress for directory moves", () => {
    const presented = presentDeveloperResourceOperation(operation({
      kind: "source_directory_move",
      result: {
        totalCount: 3,
        waitingCount: 0,
        processingCount: 0,
        availableCount: 2,
        failedCount: 1,
        deletingCount: 0,
        cancelledCount: 0,
        supersededCount: 0,
        sourceRevisionPublicId: "source-revision-private-shape"
      }
    }));

    expect(presented.result).toEqual({
      totalCount: 3,
      waitingCount: 0,
      processingCount: 0,
      availableCount: 2,
      failedCount: 1,
      deletingCount: 0,
      cancelledCount: 0,
      supersededCount: 0
    });
  });
});

function operation(
  overrides: Partial<ResourceOperationRecord>
): ResourceOperationRecord {
  return {
    id: "source-move-review",
    knowledgeBaseId: "knowledge-base-review",
    kind: "source_file_move",
    state: "completed",
    expectedResourceRevision: 1,
    result: null,
    errorCode: null,
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:01.000Z",
    completedAt: "2026-08-17T00:00:01.000Z",
    targetKind: "source_file",
    targetId: "source-file-review",
    candidateRelativePath: null,
    ...overrides
  };
}
