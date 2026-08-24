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

  it("reconciles thirty thousand direct entries without a navigation cap", () => {
    let sequence = 0;
    const changes = Array.from({ length: 30_001 }, (_, index) => {
      const id = `source-${String(index).padStart(5, "0")}`;
      return { entryId: id, desiredEntry: entry(id, `${id}.md`) };
    });
    const result = reconcileDocumentDirectoryNavigation({
      previous: [],
      changes,
      limits: { maxEntries: 200, maxBytes: 65_536, mergeBelowEntries: 50 },
      createLeafId: () => `leaf-${++sequence}`
    });

    expect(result.entryCount).toBe(30_001);
    expect(result.leaves.every((leaf) => leaf.entries.length <= 200)).toBe(true);
    expect(new Set(result.leaves.flatMap((leaf) =>
      leaf.entries.map((item) => item.id))).size).toBe(30_001);
  }, 30_000);

  it("applies one real change from a snapshot larger than ten thousand", () => {
    const entries = Array.from({ length: 10_001 }, (_, index) => {
      const id = `source-${String(index).padStart(5, "0")}`;
      return entry(id, `${id}.md`);
    });
    const groups = Array.from({ length: Math.ceil(entries.length / 200) },
      (_, index) => entries.slice(index * 200, (index + 1) * 200));
    const previous = groups.map((leafEntries, index) => ({
      id: `leaf-${index + 1}`,
      previousLeafId: index > 0 ? `leaf-${index}` : null,
      nextLeafId: index + 1 < groups.length ? `leaf-${index + 2}` : null,
      revision: 1,
      entries: leafEntries
    }));
    const added = entry("source-new", "source-new.md");
    const result = reconcileDocumentDirectoryNavigation({
      previous,
      changes: [
        ...entries.map((item) => ({ entryId: item.id, desiredEntry: item })),
        { entryId: added.id, desiredEntry: added }
      ],
      limits: { maxEntries: 200, maxBytes: 65_536, mergeBelowEntries: 50 },
      createLeafId: () => "unused"
    });

    expect(result.entryCount).toBe(10_002);
    expect(result.touchedLeafIds).toEqual(["leaf-51"]);
    expect(result.leaves.at(-1)).toMatchObject({
      id: "leaf-51",
      revision: 2,
      entries: [entries.at(-1), added]
    });
  });

  it("updates one bounded leaf window while preserving external neighbors", () => {
    const result = reconcileDocumentDirectoryNavigation({
      previous: [{
        id: "leaf-b", previousLeafId: "leaf-a", nextLeafId: "leaf-c",
        revision: 4, entries: [entry("source-b", "b.md")]
      }, {
        id: "leaf-c", previousLeafId: "leaf-b", nextLeafId: "leaf-d",
        revision: 5, entries: [entry("source-c", "c.md")]
      }, {
        id: "leaf-d", previousLeafId: "leaf-c", nextLeafId: "leaf-e",
        revision: 6, entries: [entry("source-d", "d.md")]
      }],
      changes: [{
        entryId: "source-c2",
        desiredEntry: entry("source-c2", "c2.md")
      }],
      window: { totalEntryCount: 5, firstLeafId: "leaf-a" },
      limits: { maxEntries: 2, maxBytes: 8_192, mergeBelowEntries: 1 },
      createLeafId: () => "unused"
    });

    expect(result.entryCount).toBe(6);
    expect(result.firstLeafId).toBe("leaf-a");
    expect(result.leaves[0]).toMatchObject({
      id: "leaf-b", previousLeafId: "leaf-a", nextLeafId: "leaf-c"
    });
    expect(result.leaves.at(-1)).toMatchObject({
      id: "leaf-d", previousLeafId: "leaf-c", nextLeafId: "leaf-e"
    });
    expect(result.touchedLeafIds).toEqual(["leaf-d"]);
  });

  it("returns an unchanged global summary without loading any leaf entries", () => {
    expect(reconcileDocumentDirectoryNavigation({
      previous: [], changes: [],
      window: { totalEntryCount: 12_345, firstLeafId: "leaf-first" },
      limits: { maxEntries: 200, maxBytes: 65_536, mergeBelowEntries: 50 },
      createLeafId: () => "unused"
    })).toEqual({
      leaves: [], touchedLeafIds: [], removedLeafIds: [],
      entryCount: 12_345, firstLeafId: "leaf-first"
    });
  });

  it("still rejects duplicate and mismatched navigation identities", () => {
    const reconcile = (changes: Parameters<
      typeof reconcileDocumentDirectoryNavigation>[0]["changes"]
    ) => reconcileDocumentDirectoryNavigation({
      previous: [],
      changes,
      limits: { maxEntries: 200, maxBytes: 65_536, mergeBelowEntries: 50 },
      createLeafId: () => "unused"
    });

    expect(() => reconcile([
      { entryId: "source-a", desiredEntry: entry("source-a", "a.md") },
      { entryId: "source-a", desiredEntry: entry("source-a", "a.md") }
    ])).toThrow(expect.objectContaining({ code: "navigation_changes_invalid" }));
    expect(() => reconcile([{
      entryId: "source-a",
      desiredEntry: entry("source-b", "b.md")
    }])).toThrow(expect.objectContaining({ code: "navigation_changes_invalid" }));
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
