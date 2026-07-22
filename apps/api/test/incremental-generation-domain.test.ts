import { describe, expect, it } from "vitest";
import {
  createChangeFactIdentity,
  createImmutableObjectKey,
  createProjectionImpactIdentity,
  resolveProjectionShard
} from "../src/domain/generation.js";
import {
  insertDirectoryEntry,
  removeDirectoryEntry,
  type OrderedDirectoryEntry,
  type OrderedDirectoryLeaf
} from "../src/publication/ordered-directory-leaves.js";
import { planPublicationImpacts } from "../src/publication/impact-planner.js";

describe("incremental generation domain", () => {
  it("creates deterministic change and impact identities", () => {
    const input = {
      knowledgeBaseId: "kb-1",
      sourceRevisionId: "revision-2",
      kind: "source_moved" as const,
      previousPath: "old/file.md",
      path: "new/file.md"
    };
    const first = createChangeFactIdentity(input);
    const second = createChangeFactIdentity({ ...input });

    expect(first).toBe(second);
    expect(
      createProjectionImpactIdentity({
        changeFactId: first,
        projectionKind: "search",
        projectionKey: "search/v1/0001",
        recordIdentity: "source-file-1",
        action: "upsert"
      })
    ).toBe(
      createProjectionImpactIdentity({
        changeFactId: first,
        projectionKind: "search",
        projectionKey: "search/v1/0001",
        recordIdentity: "source-file-1",
        action: "upsert"
      })
    );
  });

  it("keeps machine projection shard ownership stable", () => {
    const before = resolveProjectionShard({
      projectionKind: "search",
      stableIdentity: "source-file-a",
      shardCount: 64
    });
    const unrelated = resolveProjectionShard({
      projectionKind: "search",
      stableIdentity: "source-file-z",
      shardCount: 64
    });
    const after = resolveProjectionShard({
      projectionKind: "search",
      stableIdentity: "source-file-a",
      shardCount: 64
    });

    expect(after).toBe(before);
    expect(unrelated).toMatch(/^search\/v1\/\d{4}$/);
  });

  it("uses one immutable key for the same checksum", () => {
    const checksum = "ab".repeat(32);
    expect(createImmutableObjectKey({ prefix: "production", checksumSha256: checksum })).toBe(
      "production/generated/v1/objects/ab/" + checksum
    );
  });

  it("plans only the changed file, ancestors, shards, and graph neighborhood", () => {
    const changeFactId = createChangeFactIdentity({
      knowledgeBaseId: "kb-1",
      sourceRevisionId: "revision-2",
      kind: "source_moved",
      previousPath: "old/area/file.md",
      path: "new/area/file.md"
    });
    const impacts = planPublicationImpacts({
      changeFactId,
      kind: "source_moved",
      sourceFileId: "source-file-1",
      previousPath: "old/area/file.md",
      path: "new/area/file.md",
      graphNeighborSourceFileIds: ["source-file-2"],
      graphEdgeIds: ["edge-1"],
      config: {
        searchShardCount: 64,
        linkShardCount: 64,
        manifestShardCount: 64,
        treeShardCount: 64,
        graphNodeShardCount: 64,
        graphEdgeShardCount: 64
      }
    });

    expect(impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectionKind: "page", projectionKey: "source-file-1" }),
        expect.objectContaining({ projectionKind: "directory", projectionKey: "old/area" }),
        expect.objectContaining({ projectionKind: "directory", projectionKey: "new/area" }),
        expect.objectContaining({ projectionKind: "graph_reverse_neighbor", projectionKey: "source-file-2" })
      ])
    );
    expect(impacts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ projectionKey: "source-file-3" })])
    );
  });

  it("keeps distinct records when multiple graph edges share one shard", () => {
    const impacts = planPublicationImpacts({
      changeFactId: "change-shared-graph-shard",
      kind: "source_replaced",
      sourceFileId: "source-file-1",
      previousPath: null,
      path: "docs/file.md",
      graphEdgeIds: ["edge-1", "edge-2"],
      config: {
        searchShardCount: 1,
        linkShardCount: 1,
        manifestShardCount: 1,
        treeShardCount: 1,
        graphNodeShardCount: 1,
        graphEdgeShardCount: 1
      }
    });
    const edgeImpacts = impacts.filter((impact) => impact.projectionKind === "graph_edge");
    const linkImpacts = impacts.filter((impact) => impact.projectionKind === "links");
    expect(edgeImpacts).toHaveLength(2);
    expect(edgeImpacts.map((impact) => impact.recordIdentity).sort()).toEqual([
      "edge-1",
      "edge-2"
    ]);
    expect(new Set(edgeImpacts.map((impact) => impact.projectionKey)).size).toBe(1);
    expect(linkImpacts).toHaveLength(2);
    expect(linkImpacts.map((impact) => impact.recordIdentity).sort()).toEqual([
      "edge-1",
      "edge-2"
    ]);
    expect(new Set(linkImpacts.map((impact) => impact.projectionKey)).size).toBe(1);
  });

  it("removes graph-backed link records with deleted graph edges", () => {
    const impacts = planPublicationImpacts({
      changeFactId: "change-removed-edge",
      kind: "source_replaced",
      sourceFileId: "source-file-1",
      previousPath: "docs/file.md",
      path: "docs/file.md",
      removedGraphEdgeIds: ["edge-removed"],
      config: oneShardConfig()
    });

    expect(impacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectionKind: "graph_edge",
        recordIdentity: "edge-removed",
        action: "delete"
      }),
      expect.objectContaining({
        projectionKind: "links",
        recordIdentity: "edge-removed",
        action: "delete"
      })
    ]));
  });

  it("deletes source records while rebuilding roots and directory membership", () => {
    const deleted = planPublicationImpacts({
      changeFactId: "change-delete",
      kind: "source_deleted",
      sourceFileId: "source-file-1",
      previousPath: "old/area/file.md",
      path: null,
      config: oneShardConfig()
    });
    expect(deleted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectionKind: "page",
        recordIdentity: "source-file-1",
        action: "delete"
      }),
      expect.objectContaining({
        projectionKind: "directory",
        projectionKey: "old/area",
        action: "validate"
      }),
      expect.objectContaining({
        projectionKind: "root",
        projectionKey: "index.md",
        action: "upsert"
      })
    ]));

    const moved = planPublicationImpacts({
      changeFactId: "change-move",
      kind: "source_moved",
      sourceFileId: "source-file-1",
      previousPath: "old/file.md",
      path: "new/file.md",
      config: oneShardConfig()
    });
    expect(moved).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectionKind: "directory",
        projectionKey: "old",
        action: "validate"
      }),
      expect.objectContaining({
        projectionKind: "directory",
        projectionKey: "new",
        action: "validate"
      }),
      expect.objectContaining({
        projectionKind: "tree",
        recordIdentity: "directory:old",
        action: "upsert"
      }),
      expect.objectContaining({
        projectionKind: "tree",
        recordIdentity: "directory:new",
        action: "upsert"
      }),
      expect.objectContaining({
        projectionKind: "tree",
        recordIdentity: "directory:",
        action: "upsert"
      })
    ]));
  });

  it("splits and merges ordered directory leaves locally", () => {
    let sequence = 2;
    const leaves: OrderedDirectoryLeaf[] = [
      { id: "leaf-1", entries: [entry("a"), entry("c"), entry("e")] },
      { id: "leaf-existing", entries: [entry("x"), entry("z")] }
    ];
    const inserted = insertDirectoryEntry({
      leaves,
      entry: entry("d"),
      limits: { maxEntries: 3, maxBytes: 10_000, mergeBelowEntries: 2 },
      createLeafId: () => `leaf-${sequence++}`
    });

    expect(inserted.leaves.map((leaf) => leaf.id)).toEqual([
      "leaf-1",
      "leaf-2",
      "leaf-existing"
    ]);
    expect(inserted.touchedLeafIds).toEqual(expect.arrayContaining(["leaf-1", "leaf-2"]));
    expect(inserted.touchedLeafIds).not.toContain("leaf-existing");

    const removed = removeDirectoryEntry({
      leaves: inserted.leaves,
      entryId: "d",
      limits: { maxEntries: 3, maxBytes: 10_000, mergeBelowEntries: 2 }
    });
    expect(removed.leaves.flatMap((leaf) => leaf.entries.map((item) => item.id))).toEqual([
      "a",
      "c",
      "e",
      "x",
      "z"
    ]);
    expect(removed.touchedLeafIds).not.toContain("leaf-existing");
  });

  it("marks the first persistent directory leaf as touched", () => {
    const inserted = insertDirectoryEntry({
      leaves: [],
      entry: entry("first"),
      limits: { maxEntries: 10, maxBytes: 10_000, mergeBelowEntries: 2 },
      createLeafId: () => "leaf-first"
    });
    expect(inserted.touchedLeafIds).toEqual(["leaf-first"]);
  });

  it("removes the only leaf when its final directory entry is deleted", () => {
    const removed = removeDirectoryEntry({
      leaves: [{ id: "leaf-only", entries: [entry("only")] }],
      entryId: "only",
      limits: { maxEntries: 10, maxBytes: 10_000, mergeBelowEntries: 2 }
    });

    expect(removed.leaves).toEqual([]);
    expect(removed.touchedLeafIds).toEqual([]);
    expect(removed.removedLeafIds).toEqual(["leaf-only"]);
  });
});

function entry(id: string): OrderedDirectoryEntry {
  return {
    id,
    sortKey: id,
    name: `${id}.md`,
    targetPath: `${id}.md`,
    kind: "file"
  };
}

function oneShardConfig() {
  return {
    searchShardCount: 1,
    linkShardCount: 1,
    manifestShardCount: 1,
    treeShardCount: 1,
    graphNodeShardCount: 1,
    graphEdgeShardCount: 1
  };
}
