import { describe, expect, it, vi } from "vitest";
import {
  createDirectoryNavigationWriter,
  renderDirectoryLeafMarkdown,
  renderDirectoryRootMarkdown
} from "../src/publication/directory-navigation-writer.js";

describe("directory navigation writer", () => {
  it("renders stable progressive links without a corpus-wide index", () => {
    const leaf = renderDirectoryLeafMarkdown({
      directoryPath: "pages/guides",
      leaf: {
        id: "leaf-b",
        previousLeafId: "leaf-a",
        nextLeafId: "leaf-c",
        revision: 2,
        entries: [{
          id: "source-1",
          sortKey: "setup.md",
          name: "Setup.md",
          targetPath: "pages/guides/Setup.md",
          kind: "file"
        }]
      }
    });
    expect(leaf).toContain("[Previous](/pages/guides/index-leaf-a.md)");
    expect(leaf).toContain("[Next](/pages/guides/index-leaf-c.md)");
    expect(leaf).toContain("[Setup.md](/pages/guides/Setup.md)");
    expect(renderDirectoryRootMarkdown({
      directoryPath: "pages/guides",
      entryCount: 500,
      firstLeafId: "leaf-a"
    })).toContain("[Browse entries](/pages/guides/index-leaf-a.md)");
  });

  it("writes only touched leaves, their root, and removed leaf tombstones", async () => {
    const stageUpsert = vi.fn().mockResolvedValue(undefined);
    const stageDelete = vi.fn().mockResolvedValue(undefined);
    const applyEntries = vi.fn().mockResolvedValue({
      changed: true,
      touchedLeaves: [{
        id: "leaf-a",
        previousLeafId: null,
        nextLeafId: null,
        revision: 1,
        entries: [{
          id: "source-1",
          sortKey: "guide.md",
          name: "guide.md",
          targetPath: "pages/guide.md",
          kind: "file"
        }]
      }],
      removedLeafIds: ["leaf-old"],
      summary: { directoryPath: "pages", entryCount: 1, firstLeafId: "leaf-a", revision: 2 }
    });
    const writer = createDirectoryNavigationWriter({
      navigation: {
        applyEntry: vi.fn(),
        applyEntries,
        getSummary: vi.fn()
      },
      references: {
        stageUpsert,
        stageDelete,
        findActiveByPath: vi.fn(),
        findActiveByRef: vi.fn(),
        findStagedByRef: vi.fn()
      },
      immutableObjects: {
        write: vi.fn().mockResolvedValue({
          checksumSha256: "a".repeat(64),
          formatVersion: 1,
          objectKey: "generated/object",
          contentType: "text/markdown; charset=utf-8",
          sizeBytes: 100,
          createdAt: "2026-07-17T00:00:00.000Z",
          verifiedAt: "2026-07-17T00:00:00.000Z",
          reused: false
        })
      },
      limits: { maxEntries: 200, maxBytes: 65_536, mergeBelowEntries: 50 }
    });

    const result = await writer.write({
      id: "impact-1",
      knowledgeBaseId: "kb-1",
      generationId: "generation-1",
      changeFactId: "change-1",
      changeKind: "source_created",
      sourceFileId: "source-1",
      sourceRevisionId: "revision-1",
      previousPath: null,
      path: "guide.md",
      resourceRevision: 1,
      projectionKind: "directory",
      projectionKey: "",
      recordIdentity: "source-1:guide.md:pages",
      action: "validate",
      retryCursor: {},
      attemptCount: 1,
      maxAttempts: 3,
      projectionInput: navigationInput("source-1", "guide.md", "")
    });
    expect(result).toEqual({ handled: true, touchedShardCount: 2 });
    expect(stageDelete).toHaveBeenCalledWith(expect.objectContaining({
      logicalPath: "pages/index-leaf-old.md"
    }));
    expect(stageUpsert).toHaveBeenCalledTimes(2);
    expect(applyEntries).toHaveBeenCalledWith(expect.objectContaining({
      entries: [expect.objectContaining({
        desiredEntry: expect.objectContaining({ sortKey: "guide.md/source-1" })
      })]
    }));
    expect(applyEntries.mock.calls[0]?.[0].entries[0].desiredEntry.sortKey)
      .not.toMatch(/[\u0000-\u001f\u007f]/u);
  });

  it("coalesces repeated mutations of one directory into one final leaf and root write", async () => {
    const stageUpsert = vi.fn().mockResolvedValue(undefined);
    const applyEntries = vi.fn().mockResolvedValue(directoryMutation("source-2", 2));
    const writer = createDirectoryNavigationWriter({
      navigation: { applyEntry: vi.fn(), applyEntries, getSummary: vi.fn() },
      references: {
        stageUpsert,
        stageDelete: vi.fn(),
        findActiveByPath: vi.fn(),
        findActiveByRef: vi.fn(),
        findStagedByRef: vi.fn()
      },
      immutableObjects: {
        write: vi.fn(async () => ({
          checksumSha256: "a".repeat(64),
          formatVersion: 1,
          objectKey: "generated/object",
          contentType: "text/markdown; charset=utf-8",
          sizeBytes: 100,
          createdAt: "2026-07-17T00:00:00.000Z",
          verifiedAt: "2026-07-17T00:00:00.000Z",
          reused: false
        }))
      },
      limits: { maxEntries: 200, maxBytes: 65_536, mergeBelowEntries: 50 }
    });

    const first = directoryImpact("source-1");
    const second = directoryImpact("source-2");
    expect(await writer.writeBatch([first, second])).toEqual({
      handled: true,
      touchedShardCount: 2
    });
    expect(applyEntries).toHaveBeenCalledOnce();
    expect(applyEntries).toHaveBeenCalledWith(expect.objectContaining({
      entries: [
        expect.objectContaining({ entryId: "source-1" }),
        expect.objectContaining({ entryId: "source-2" })
      ]
    }));
    expect(stageUpsert).toHaveBeenCalledTimes(2);
  });
});

function directoryImpact(sourceFileId: string) {
  return {
    id: `impact-${sourceFileId}`,
    knowledgeBaseId: "kb-1",
    generationId: "generation-1",
    changeFactId: `change-${sourceFileId}`,
    changeKind: "source_created" as const,
    sourceFileId,
    sourceRevisionId: `revision-${sourceFileId}`,
    previousPath: null,
    path: `guides/${sourceFileId}.md`,
    resourceRevision: 1,
    projectionKind: "directory" as const,
    projectionKey: "guides",
    recordIdentity: `${sourceFileId}:guides/${sourceFileId}.md:guides`,
    action: "validate" as const,
    retryCursor: {},
    attemptCount: 1,
    maxAttempts: 3,
    projectionInput: navigationInput(sourceFileId, `${sourceFileId}.md`, "guides")
  };
}

function navigationInput(sourceFileId: string, name: string, directoryPath: string) {
  return {
    kind: "navigation" as const,
    targets: [{
      entryId: sourceFileId,
      desiredEntry: {
        id: sourceFileId,
        sortKey: `${name.toLocaleLowerCase("en")}/${sourceFileId}`,
        name,
        targetPath: directoryPath
          ? `pages/${directoryPath}/${name}`
          : `pages/${name}`,
        kind: "file" as const
      }
    }]
  };
}

function directoryMutation(sourceFileId: string, entryCount: number) {
  return {
    changed: true,
    touchedLeaves: [{
      id: "leaf-a",
      previousLeafId: null,
      nextLeafId: null,
      revision: entryCount,
      entries: [{
        id: sourceFileId,
        sortKey: `${sourceFileId}.md`,
        name: `${sourceFileId}.md`,
        targetPath: `pages/guides/${sourceFileId}.md`,
        kind: "file" as const
      }]
    }],
    removedLeafIds: [],
    summary: {
      directoryPath: "pages/guides",
      entryCount,
      firstLeafId: "leaf-a",
      revision: entryCount
    }
  };
}
