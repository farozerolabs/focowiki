import { describe, expect, it, vi } from "vitest";
import type { SourceFileTaskDeletionRepository } from "../src/application/ports/source-file-task-deletion-repository.js";
import type { AdminRepositories } from "../src/db/admin-repositories.js";
import type { RedisCoordinator } from "../src/redis/coordination.js";
import { createSourceFileTaskDeletionService } from "../src/admin/source-file-task-deletion-service.js";

const knowledgeBase = {
  id: "kb-001",
  name: "Developer docs",
  description: null,
  activeGenerationId: "generation-001",
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z"
};

describe("source file task deletion service", () => {
  it("returns safe per-row results and cleans only unpublished deleted source files", async () => {
    const deleteTasks = vi.fn(async () => [
      {
        sourceFileId: "source-file-11111111-1111-4111-8111-111111111111",
        outcome: "deleted" as const
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
    const markPaginationInvalid = vi.fn(async () => undefined);
    const service = createSourceFileTaskDeletionService(
      {
        knowledgeBases: {
          async getKnowledgeBase(id: string) {
            return id === knowledgeBase.id ? knowledgeBase : null;
          }
        },
        files: {}
      } as unknown as AdminRepositories,
      {
        deleteTasks
      } as SourceFileTaskDeletionRepository,
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
      cursorTtlSeconds: 900,
      hardDeleteMaxAttempts: 5,
      publicationSettingsSnapshot: { publication: { mode: "per_file" } }
    });

    expect(deleteTasks).toHaveBeenCalledWith({
      knowledgeBaseId: knowledgeBase.id,
      sourceFileIds: [
        "source-file-11111111-1111-4111-8111-111111111111",
        "source-file-22222222-2222-4222-8222-222222222222",
        "source-file-33333333-3333-4333-8333-333333333333"
      ],
      deletedAt: "2026-06-14T00:00:00.000Z",
      hardDeleteMaxAttempts: 5,
      publicationSettingsSnapshot: { publication: { mode: "per_file" } }
    });
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
      `developer-openapi:related:${knowledgeBase.id}:source-file-11111111-1111-4111-8111-111111111111`,
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
    const deleteTasks = vi.fn();
    const markPaginationInvalid = vi.fn();
    const service = createSourceFileTaskDeletionService(
      {
        knowledgeBases: {
          async getKnowledgeBase() {
            return null;
          }
        },
        files: {}
      } as unknown as AdminRepositories,
      {
        deleteTasks
      } as unknown as SourceFileTaskDeletionRepository,
      {
        markPaginationInvalid
      } as unknown as RedisCoordinator
    );

    await expect(
      service?.deleteTasks({
        knowledgeBaseId: "kb-missing",
        sourceFileIds: ["source-file-11111111-1111-4111-8111-111111111111"],
        deletedAt: "2026-06-14T00:00:00.000Z",
        cursorTtlSeconds: 900,
        publicationSettingsSnapshot: { publication: { mode: "per_file" } }
      })
    ).resolves.toBeNull();
    expect(deleteTasks).not.toHaveBeenCalled();
    expect(markPaginationInvalid).not.toHaveBeenCalled();
  });
});
