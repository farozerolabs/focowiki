import { describe, expect, it, vi } from "vitest";
import type { ActiveGenerationProjection } from "../src/application/ports/active-generation-read-repository.js";
import {
  ActiveTreeStatisticsUnavailableError,
  hydrateActiveTreeStatistics
} from "../src/infrastructure/postgres/active-tree-statistics.js";

describe("active tree statistics", () => {
  it("prefers persisted typed statistics over payload values", async () => {
    const sql = queryStub([[
      statisticsRow("pages", 3, 1, 2, 20)
    ]]);
    const [result] = await hydrateActiveTreeStatistics({
      sql,
      knowledgeBaseId: "kb-1",
      generationId: "generation-1",
      entries: [directory("pages", {
        directEntryCount: 1,
        directDirectoryCount: 0,
        directFileCount: 1,
        descendantFileCount: 1
      })]
    });

    expect(result?.payload).toMatchObject({
      directEntryCount: 3,
      directDirectoryCount: 1,
      directFileCount: 2,
      descendantFileCount: 20
    });
    expect(sql).toHaveBeenCalledOnce();
  });

  it.each([
    ["absent", {}],
    ["null", { directEntryCount: null }],
    ["string", {
      directEntryCount: "1",
      directDirectoryCount: "0",
      directFileCount: "1",
      descendantFileCount: "1"
    }],
    ["negative", {
      directEntryCount: -1,
      directDirectoryCount: 0,
      directFileCount: -1,
      descendantFileCount: 0
    }],
    ["inconsistent total", {
      directEntryCount: 2,
      directDirectoryCount: 0,
      directFileCount: 1,
      descendantFileCount: 1
    }]
  ])("uses one grouped fallback for %s payload counts", async (_label, payload) => {
    const sql = queryStub([
      [],
      [statisticsRow("pages", 1, 0, 1, 1)]
    ]);

    const [result] = await hydrateActiveTreeStatistics({
      sql,
      knowledgeBaseId: "kb-1",
      generationId: "generation-1",
      entries: [directory("pages", payload)]
    });

    expect(result?.payload).toMatchObject({
      directEntryCount: 1,
      directDirectoryCount: 0,
      directFileCount: 1,
      descendantFileCount: 1
    });
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it("hydrates duplicate page paths once while preserving root and nested entries", async () => {
    const sql = queryStub([[
      statisticsRow("pages", 1, 1, 0, 2),
      statisticsRow("pages/guides", 2, 0, 2, 2)
    ]]);
    const entries = [
      directory("pages", {}),
      directory("pages/guides", {}),
      directory("pages/guides", {})
    ];

    const result = await hydrateActiveTreeStatistics({
      sql,
      knowledgeBaseId: "kb-1",
      generationId: "generation-1",
      entries
    });

    expect(result.map((entry) => entry.payload)).toEqual([
      expect.objectContaining({ directEntryCount: 1 }),
      expect.objectContaining({ directEntryCount: 2 }),
      expect.objectContaining({ directEntryCount: 2 })
    ]);
    expect(sql).toHaveBeenCalledOnce();
  });

  it("rejects duplicate persisted rows and invalid grouped fallback rows", async () => {
    const duplicate = queryStub([[
      statisticsRow("pages", 0, 0, 0, 0),
      statisticsRow("pages", 0, 0, 0, 0)
    ]]);
    await expect(hydrateActiveTreeStatistics({
      sql: duplicate,
      knowledgeBaseId: "kb-1",
      generationId: "generation-1",
      entries: [directory("pages", {})]
    })).rejects.toBeInstanceOf(ActiveTreeStatisticsUnavailableError);

    const invalidFallback = queryStub([
      [],
      [statisticsRow("pages", 2, 0, 1, 1)]
    ]);
    await expect(hydrateActiveTreeStatistics({
      sql: invalidFallback,
      knowledgeBaseId: "kb-1",
      generationId: "generation-1",
      entries: [directory("pages", {})]
    })).rejects.toBeInstanceOf(ActiveTreeStatisticsUnavailableError);
  });

  it("does not query statistics for empty and file-only pages", async () => {
    const sql = queryStub([]);
    const file = {
      ...directory("pages/a.md", {}),
      recordId: "source-a",
      payload: { kind: "file" }
    };

    await expect(hydrateActiveTreeStatistics({
      sql,
      knowledgeBaseId: "kb-1",
      generationId: "generation-1",
      entries: [file]
    })).resolves.toEqual([file]);
    expect(sql).not.toHaveBeenCalled();
  });
});

function directory(
  path: string,
  counts: Record<string, unknown>
): ActiveGenerationProjection {
  return {
    generationId: "generation-1",
    projectionKind: "tree",
    recordId: `directory:${path}`,
    sourceFileId: null,
    relatedSourceFileId: null,
    path,
    parentPath: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    sortKey: path,
    title: path,
    summary: null,
    score: null,
    payload: { kind: "directory", ...counts } as never
  };
}

function statisticsRow(
  path: string,
  directEntryCount: number,
  directDirectoryCount: number,
  directFileCount: number,
  descendantFileCount: number
) {
  return {
    path,
    direct_entry_count: directEntryCount,
    direct_directory_count: directDirectoryCount,
    direct_file_count: directFileCount,
    descendant_file_count: descendantFileCount
  };
}

function queryStub(responses: unknown[]) {
  return vi.fn(async () => responses.shift() ?? []) as never;
}
