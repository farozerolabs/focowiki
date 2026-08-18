import { describe, expect, it } from "vitest";
import { reconcileDocumentDirectoryNavigation } from
  "../src/document-indexing/application/document-directory-navigation-state.js";

describe("document directory navigation state", () => {
  it("preserves existing leaf identities and touches only changed navigation", () => {
    let nextId = 0;
    const result = reconcileDocumentDirectoryNavigation({
      previous: [{
        id: "leaf-a",
        previousLeafId: null,
        nextLeafId: null,
        revision: 3,
        entries: [entry("source-a", "a.md"), entry("source-c", "c.md")]
      }],
      changes: [{ entryId: "source-b", desiredEntry: entry("source-b", "b.md") }],
      limits: { maxEntries: 2, maxBytes: 8_192, mergeBelowEntries: 1 },
      createLeafId: () => `leaf-new-${++nextId}`
    });

    expect(result.leaves).toEqual([expect.objectContaining({
      id: "leaf-a",
      previousLeafId: null,
      nextLeafId: "leaf-new-1",
      revision: 4,
      entries: [entry("source-a", "a.md")]
    }), expect.objectContaining({
      id: "leaf-new-1",
      previousLeafId: "leaf-a",
      nextLeafId: null,
      revision: 1,
      entries: [entry("source-b", "b.md"), entry("source-c", "c.md")]
    })]);
    expect(result.touchedLeafIds).toEqual(["leaf-a", "leaf-new-1"]);
    expect(result.removedLeafIds).toEqual([]);
    expect(result.entryCount).toBe(3);
  });

  it("removes an obsolete leaf and revises the surviving neighbor link", () => {
    const result = reconcileDocumentDirectoryNavigation({
      previous: [{
        id: "leaf-a", previousLeafId: null, nextLeafId: "leaf-b", revision: 2,
        entries: [entry("source-a", "a.md")]
      }, {
        id: "leaf-b", previousLeafId: "leaf-a", nextLeafId: null, revision: 7,
        entries: [entry("source-b", "b.md")]
      }],
      changes: [{ entryId: "source-a", desiredEntry: null }],
      limits: { maxEntries: 2, maxBytes: 8_192, mergeBelowEntries: 1 },
      createLeafId: () => "unused"
    });

    expect(result.leaves).toEqual([expect.objectContaining({
      id: "leaf-b", previousLeafId: null, nextLeafId: null, revision: 8
    })]);
    expect(result.touchedLeafIds).toEqual(["leaf-b"]);
    expect(result.removedLeafIds).toEqual(["leaf-a"]);
  });

  it("replaces changed entry presentation without changing its identity", () => {
    const result = reconcileDocumentDirectoryNavigation({
      previous: [{
        id: "leaf-a", previousLeafId: null, nextLeafId: null, revision: 1,
        entries: [entry("source-a", "a.md")]
      }],
      changes: [{
        entryId: "source-a",
        desiredEntry: { ...entry("source-a", "renamed.md"), name: "Renamed" }
      }],
      limits: { maxEntries: 2, maxBytes: 8_192, mergeBelowEntries: 1 },
      createLeafId: () => "unused"
    });

    expect(result.leaves[0]).toMatchObject({
      id: "leaf-a", revision: 2,
      entries: [{ id: "source-a", sortKey: "renamed.md", name: "Renamed" }]
    });
    expect(result.touchedLeafIds).toEqual(["leaf-a"]);
  });

  it("reconciles a bounded multi-neighbor update without a corpus-wide listing", () => {
    let sequence = 0;
    const changes = Array.from({ length: 100 }, (_, index) => {
      const id = `source-${String(index).padStart(3, "0")}`;
      return { entryId: id, desiredEntry: entry(id, `${id}.md`) };
    });
    const result = reconcileDocumentDirectoryNavigation({
      previous: [],
      changes,
      limits: { maxEntries: 25, maxBytes: 65_536, mergeBelowEntries: 6 },
      createLeafId: () => `leaf-${++sequence}`
    });

    expect(result.entryCount).toBe(100);
    expect(result.leaves.every((leaf) => leaf.entries.length <= 25)).toBe(true);
  });
});

function entry(id: string, path: string) {
  return {
    id,
    sortKey: path,
    name: path,
    targetPath: `pages/${path}`,
    kind: "file" as const
  };
}
