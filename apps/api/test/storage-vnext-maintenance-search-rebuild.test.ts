import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextMaintenanceSearchRebuild
} from "../src/storage-vnext/maintenance/search-rebuild.js";

describe("storage vNext maintenance search rebuild", () => {
  it("excludes a failed current source from the rebuilt search projection", async () => {
    const readVerifiedStream = vi.fn();
    const writeDocumentBatch = vi.fn();
    const rebuild = createStorageVnextMaintenanceSearchRebuild({
      catalog: {
        listCurrentSources: vi.fn(async () => ({
          items: [failedCurrentSource()],
          nextCursor: null
        }))
      },
      sourceBodies: { readVerifiedStream },
      graph: { listNodes: vi.fn() },
      projection: { writeDocumentBatch },
      limits: {
        sourcePageSize: 10,
        graphPageSize: 10,
        maxSourceBytes: 1_024,
        maxSegmentBytes: 256,
        maxBatchDocuments: 10,
        maxBatchCompressedBytes: 4_096
      }
    });

    await expect(rebuild.runPage({
      knowledgeBaseId: "kb-maintenance",
      candidatePublicId: "candidate-maintenance",
      operationPublicId: "operation-maintenance",
      cursor: null,
      batchOrdinal: 0
    })).resolves.toMatchObject({
      outcome: "progress",
      completedDelta: 0,
      expectedCount: 0,
      processedBytesDelta: 0,
      batchOrdinalDelta: 0
    });
    expect(readVerifiedStream).not.toHaveBeenCalled();
    expect(writeDocumentBatch).not.toHaveBeenCalled();
  });
});

function failedCurrentSource() {
  return {
    sourceFile: {
      publicId: "source-failed",
      knowledgeBaseId: "kb-maintenance",
      directoryPublicId: null,
      logicalPath: "failed.md",
      normalizedPath: "failed.md",
      title: "Failed source",
      metadata: {},
      currentRevisionPublicId: "revision-failed",
      status: "failed" as const,
      safeErrorCode: "semantic_generation_model_revision_mismatch",
      safeErrorMessage: "Source processing failed.",
      revision: 1,
      visibility: "current" as const
    },
    sourceRevision: {
      publicId: "revision-failed",
      sourceFilePublicId: "source-failed",
      knowledgeBaseId: "kb-maintenance",
      objectId: "source-sha256:failed",
      checksum: "a".repeat(64),
      byteCount: 12,
      contentType: "text/markdown; charset=utf-8",
      createdAt: "2026-08-01T00:00:00.000Z"
    }
  };
}
