import { describe, expect, it, vi } from "vitest";
import {
  createProjectionRepairDirectoryStream
} from "../src/maintenance/projection-repair-directory-builder.js";

describe("projection repair directory builder", () => {
  it("writes deterministic final leaves once with complete navigation links", async () => {
    const writeLeaf = vi.fn().mockResolvedValue(undefined);
    const builder = createProjectionRepairDirectoryStream({
      directoryPath: "pages/guides",
      limits: { maxEntries: 2, maxBytes: 1_024 },
      writeLeaf
    });

    for (const ordinal of [1, 2, 3, 4, 5]) {
      await builder.add({
        id: `file-${ordinal}`,
        sortKey: `file-${ordinal}`,
        name: `File ${ordinal}`,
        targetPath: `pages/guides/file-${ordinal}.md`,
        kind: "file"
      });
    }
    const result = await builder.finish();

    expect(writeLeaf).toHaveBeenCalledTimes(3);
    expect(writeLeaf.mock.calls.map(([leaf]) => ({
      id: leaf.id,
      previousLeafId: leaf.previousLeafId,
      nextLeafId: leaf.nextLeafId,
      entries: leaf.entries.map((entry: { id: string }) => entry.id)
    }))).toEqual([
      {
        id: "directory-leaf-9a037ae269611310-000000",
        previousLeafId: null,
        nextLeafId: "directory-leaf-9a037ae269611310-000001",
        entries: ["file-1", "file-2"]
      },
      {
        id: "directory-leaf-9a037ae269611310-000001",
        previousLeafId: "directory-leaf-9a037ae269611310-000000",
        nextLeafId: "directory-leaf-9a037ae269611310-000002",
        entries: ["file-3", "file-4"]
      },
      {
        id: "directory-leaf-9a037ae269611310-000002",
        previousLeafId: "directory-leaf-9a037ae269611310-000001",
        nextLeafId: null,
        entries: ["file-5"]
      }
    ]);
    expect(result).toEqual({
      entryCount: 5,
      leafCount: 3,
      firstLeafId: "directory-leaf-9a037ae269611310-000000"
    });
  });

  it("uses stable directory-scoped leaf IDs", async () => {
    const createFirstLeafId = async (directoryPath: string) => {
      let id = "";
      const builder = createProjectionRepairDirectoryStream({
        directoryPath,
        limits: { maxEntries: 10, maxBytes: 1_024 },
        writeLeaf: async (leaf) => {
          id = leaf.id;
        }
      });
      await builder.add({
        id: "file",
        sortKey: "file",
        name: "File",
        targetPath: `${directoryPath}/file.md`,
        kind: "file"
      });
      await builder.finish();
      return id;
    };

    expect(await createFirstLeafId("pages/guides"))
      .toBe(await createFirstLeafId("pages/guides"));
    expect(await createFirstLeafId("pages/guides"))
      .not.toBe(await createFirstLeafId("pages/reference"));
  });

  it("rejects unordered input and a single entry over the byte budget", async () => {
    const unordered = createProjectionRepairDirectoryStream({
      directoryPath: "pages",
      limits: { maxEntries: 10, maxBytes: 1_024 },
      writeLeaf: async () => undefined
    });
    await unordered.add({
      id: "b",
      sortKey: "b",
      name: "B",
      targetPath: "pages/b.md",
      kind: "file"
    });
    await expect(unordered.add({
      id: "a",
      sortKey: "a",
      name: "A",
      targetPath: "pages/a.md",
      kind: "file"
    })).rejects.toThrow("ordered");

    const oversized = createProjectionRepairDirectoryStream({
      directoryPath: "pages",
      limits: { maxEntries: 10, maxBytes: 20 },
      writeLeaf: async () => undefined
    });
    await expect(oversized.add({
      id: "large",
      sortKey: "large",
      name: "A very large directory entry",
      targetPath: "pages/a-very-large-directory-entry.md",
      kind: "file"
    })).rejects.toThrow("byte limit");
  });
});
