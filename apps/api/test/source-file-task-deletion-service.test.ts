import { describe, expect, it, vi } from "vitest";
import type { AdminRepositories } from "../src/db/admin-repositories.js";
import type { RedisCoordinator } from "../src/redis/coordination.js";
import type { StorageAdapter } from "../src/storage/s3.js";
import { createSourceFileTaskDeletionService } from "../src/admin/source-file-task-deletion-service.js";

const knowledgeBase = {
  id: "kb-001",
  name: "Developer docs",
  description: null,
  activeReleaseId: "release-001",
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z"
};

describe("source file task deletion service", () => {
  it("returns safe per-row results and cleans only unpublished deleted source files", async () => {
    const deleteSourceFileTasks = vi.fn(async () => [
      {
        sourceFileId: "source-file-11111111-1111-4111-8111-111111111111",
        outcome: "deleted" as const,
        objectKey: "tenant/raw/private-source.md"
      },
      {
        sourceFileId: "source-file-22222222-2222-4222-8222-222222222222",
        outcome: "hidden" as const
      },
      {
        sourceFileId: "source-file-33333333-3333-4333-8333-333333333333",
        outcome: "skipped" as const,
        reason: "running" as const
      }
    ]);
    const deleteGraphForSourceFile = vi.fn(async () => undefined);
    const deleteObject = vi.fn(async () => undefined);
    const markPaginationInvalid = vi.fn(async () => undefined);
    const service = createSourceFileTaskDeletionService(
      {
        knowledgeBases: {
          async getKnowledgeBase(id: string) {
            return id === knowledgeBase.id ? knowledgeBase : null;
          }
        },
        files: {
          deleteSourceFileTasks
        },
        graph: {
          deleteGraphForSourceFile
        }
      } as unknown as AdminRepositories,
      {
        deleteObject
      } as unknown as StorageAdapter,
      {
        markPaginationInvalid
      } as unknown as RedisCoordinator
    );

    const result = await service?.deleteTasks({
      knowledgeBaseId: knowledgeBase.id,
      sourceFileIds: [
        "source-file-11111111-1111-4111-8111-111111111111",
        "source-file-22222222-2222-4222-8222-222222222222",
        "source-file-33333333-3333-4333-8333-333333333333"
      ],
      deletedAt: "2026-06-14T00:00:00.000Z",
      cursorTtlSeconds: 900
    });

    expect(deleteSourceFileTasks).toHaveBeenCalledWith({
      knowledgeBaseId: knowledgeBase.id,
      sourceFileIds: [
        "source-file-11111111-1111-4111-8111-111111111111",
        "source-file-22222222-2222-4222-8222-222222222222",
        "source-file-33333333-3333-4333-8333-333333333333"
      ],
      deletedAt: "2026-06-14T00:00:00.000Z"
    });
    expect(deleteGraphForSourceFile).toHaveBeenCalledWith({
      knowledgeBaseId: knowledgeBase.id,
      sourceFileId: "source-file-11111111-1111-4111-8111-111111111111"
    });
    expect(deleteGraphForSourceFile).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith("tenant/raw/private-source.md");
    expect(JSON.stringify(result)).not.toContain("tenant/raw/private-source.md");
    expect(result).toEqual({
      results: [
        {
          sourceFileId: "source-file-11111111-1111-4111-8111-111111111111",
          status: "deleted"
        },
        {
          sourceFileId: "source-file-22222222-2222-4222-8222-222222222222",
          status: "hidden"
        },
        {
          sourceFileId: "source-file-33333333-3333-4333-8333-333333333333",
          status: "skipped",
          reason: "running"
        }
      ],
      summary: {
        deleted: 1,
        hidden: 1,
        skipped: 1
      }
    });
    expect(markPaginationInvalid).toHaveBeenCalledWith(
      `source-file-events:${knowledgeBase.id}:source-file-11111111-1111-4111-8111-111111111111`,
      "changed",
      900
    );
    expect(markPaginationInvalid).toHaveBeenCalledWith(
      `source-file-events:${knowledgeBase.id}:source-file-22222222-2222-4222-8222-222222222222`,
      "changed",
      900
    );
    expect(markPaginationInvalid).not.toHaveBeenCalledWith(
      expect.stringContaining("source-file-33333333-3333-4333-8333-333333333333"),
      "changed",
      900
    );
  });

  it("does not mutate storage or caches when the knowledge base is missing", async () => {
    const deleteSourceFileTasks = vi.fn();
    const deleteObject = vi.fn();
    const markPaginationInvalid = vi.fn();
    const service = createSourceFileTaskDeletionService(
      {
        knowledgeBases: {
          async getKnowledgeBase() {
            return null;
          }
        },
        files: {
          deleteSourceFileTasks
        }
      } as unknown as AdminRepositories,
      {
        deleteObject
      } as unknown as StorageAdapter,
      {
        markPaginationInvalid
      } as unknown as RedisCoordinator
    );

    await expect(
      service?.deleteTasks({
        knowledgeBaseId: "kb-missing",
        sourceFileIds: ["source-file-11111111-1111-4111-8111-111111111111"],
        deletedAt: "2026-06-14T00:00:00.000Z",
        cursorTtlSeconds: 900
      })
    ).resolves.toBeNull();
    expect(deleteSourceFileTasks).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(markPaginationInvalid).not.toHaveBeenCalled();
  });
});
