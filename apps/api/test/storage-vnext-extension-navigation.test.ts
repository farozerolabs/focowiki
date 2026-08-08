import { describe, expect, it } from "vitest";
import type { PersistentDirectoryLeaf } from
  "../src/application/ports/directory-navigation-repository.js";
import { assembleStorageVnextExtensionNavigation } from
  "../src/storage-vnext/publication/extension-navigation.js";
import { validateStorageVnextExtensionNavigationClosure } from
  "../src/storage-vnext/publication/candidate-validator.js";
import { parseStorageVnextExtensionNavigationState } from
  "../src/storage-vnext/publication/extension-navigation-state.js";
import { STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES } from
  "../src/storage-vnext/publication/profile.js";
import { resolveStorageVnextMarkdownTargets } from
  "../src/storage-vnext/publication/validation.js";

describe("storage vNext extension navigation", () => {
  it("renders present typed and by-file families without absent families", async () => {
    const result = await assembleStorageVnextExtensionNavigation({
      knowledgeBaseId: "kb-one",
      projectionShards: [{
        projectionKind: "search",
        shardKey: "search/v1/0001",
        logicalPath: "_index/search/v1/0001.json",
        recordCount: 2
      }],
      navigation: navigation({
        byFileLogicalPaths: ["_graph/by-file/source-1.json"],
        sources: [{
          publicId: "source-1",
          title: "Setup",
          pagePath: "pages/guides/setup.md"
        }]
      })
    });

    const paths = result.artifacts.map((artifact) => artifact.logicalPath);
    expect(paths).toEqual(expect.arrayContaining([
      "_index/index.md",
      "_graph/index.md",
      "_index/search/index.md",
      "_index/search/v1/index.md",
      "_graph/by-file/index.md"
    ]));
    expect(paths.some((path) => path === "_index/manifest/index.md")).toBe(false);
    expect(paths.some((path) => path.includes("index-map-"))).toBe(false);
    const byFileLeaf = result.artifacts.find((artifact) =>
      artifact.logicalPath.startsWith("_graph/by-file/index-extension-leaf-"));
    const body = Buffer.from(byFileLeaf!.bytes).toString("utf8");
    expect(body).toContain("[Setup](/_graph/by-file/source-1.json)");
    expect(body).toContain("[Source](/pages/guides/setup.md)");
    expect(body).toContain(
      'generated: {"by":"process:focowiki-publication","at":"2026-08-01T00:00:00.000Z"}'
    );
    expect(result.internalShards.every((shard) =>
      shard.logicalKind === "extension_navigation")).toBe(true);

    const documents = new Map(result.artifacts
      .filter((artifact) => artifact.logicalPath.endsWith(".md"))
      .map((artifact) => [artifact.logicalPath, resolveStorageVnextMarkdownTargets(
        artifact.logicalPath,
        Buffer.from(artifact.bytes).toString("utf8")
      )]));
    const state = new Map(STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES.map(
      (directoryPath) => [directoryPath, parseLeaves(result.internalShards, directoryPath)]
    ));
    expect(() => validateStorageVnextExtensionNavigationClosure({
      documents,
      resources: new Set([
        "_index/search/v1/0001.json",
        "_graph/by-file/source-1.json"
      ]),
      state
    })).not.toThrow();
    const brokenByFileState = new Map(state);
    brokenByFileState.set("_graph/by-file", state.get("_graph/by-file")!.map(
      (leaf) => ({ ...leaf, nextLeafId: "missing-leaf" })
    ));
    expect(() => validateStorageVnextExtensionNavigationClosure({
      documents,
      resources: new Set([
        "_index/search/v1/0001.json",
        "_graph/by-file/source-1.json"
      ]),
      state: brokenByFileState
    })).toThrow(/leaf links/iu);
  });

  it("preserves stable leaf identities and tombstones removed family paths", async () => {
    const first = await assembleStorageVnextExtensionNavigation({
      knowledgeBaseId: "kb-one",
      projectionShards: [0, 1, 2].map((ordinal) => ({
        projectionKind: "search",
        shardKey: `search/v1/000${ordinal}`,
        logicalPath: `_index/search/v1/000${ordinal}.json`,
        recordCount: 1
      })),
      navigation: navigation({ maxEntries: 2 })
    });
    const previousLeaves = parseLeaves(first.internalShards, "_index/search/v1");
    expect(previousLeaves).toHaveLength(2);
    expect(previousLeaves[0]?.nextLeafId).toBe(previousLeaves[1]?.id);
    expect(previousLeaves[1]?.previousLeafId).toBe(previousLeaves[0]?.id);

    const second = await assembleStorageVnextExtensionNavigation({
      knowledgeBaseId: "kb-one",
      projectionShards: [0, 1, 2].map((ordinal) => ({
        projectionKind: "search",
        shardKey: `search/v1/000${ordinal}`,
        logicalPath: `_index/search/v1/000${ordinal}.json`,
        recordCount: 1
      })),
      navigation: navigation({
        maxEntries: 2,
        changedAt: "2026-08-02T00:00:00.000Z",
        previousLeaves: new Map([["_index/search/v1", previousLeaves]])
      })
    });
    expect(parseLeaves(second.internalShards, "_index/search/v1"))
      .toEqual(previousLeaves);

    const removed = await assembleStorageVnextExtensionNavigation({
      knowledgeBaseId: "kb-one",
      projectionShards: [],
      navigation: navigation({
        existingMarkdownPaths: first.artifacts.map((artifact) => artifact.logicalPath),
        previousLeaves: new Map([["_index/search/v1", previousLeaves]])
      })
    });
    expect(removed.artifacts.map((artifact) => artifact.logicalPath))
      .toEqual(["_index/index.md", "_graph/index.md"]);
    expect(removed.deletedLogicalPaths).toEqual(expect.arrayContaining([
      "_index/search/index.md",
      "_index/search/v1/index.md"
    ]));
  });

  it("emits only changed roots and leaves for a current-profile family", async () => {
    const projectionShards = [{
      projectionKind: "search" as const,
      shardKey: "search/v1/0000",
      logicalPath: "_index/search/v1/0000.json",
      recordCount: 1
    }];
    const initial = await assembleStorageVnextExtensionNavigation({
      knowledgeBaseId: "kb-one",
      projectionShards,
      navigation: navigation()
    });
    const previousLeaves = parseLeaves(initial.internalShards, "_index/search/v1");
    const currentNavigation = navigation({
      previousLeaves: new Map([["_index/search/v1", previousLeaves]]),
      existingMarkdownPaths: initial.artifacts.map((artifact) => artifact.logicalPath),
      affectedDirectoryPaths: ["_index/search/v1"],
      previousPresentDirectoryPaths: ["_index/search/v1"],
      completeProfile: false
    });

    const unchanged = await assembleStorageVnextExtensionNavigation({
      knowledgeBaseId: "kb-one",
      projectionShards,
      navigation: currentNavigation
    });
    expect(unchanged.artifacts).toEqual([]);
    expect(unchanged.deletedLogicalPaths).toEqual([]);
    expect(unchanged.internalShards.map((shard) => shard.firstLogicalPath))
      .toEqual(["_index/search/v1"]);

    const changed = await assembleStorageVnextExtensionNavigation({
      knowledgeBaseId: "kb-one",
      projectionShards: [
        ...projectionShards,
        {
          projectionKind: "search" as const,
          shardKey: "search/v1/0001",
          logicalPath: "_index/search/v1/0001.json",
          recordCount: 1
        }
      ],
      navigation: currentNavigation
    });
    expect(changed.artifacts.map((artifact) => artifact.logicalPath)).toEqual([
      "_index/search/v1/index.md",
      expect.stringMatching(
        /^_index\/search\/v1\/index-extension-leaf-[a-f0-9-]+\.md$/u
      )
    ]);
  });

  it("rejects a by-file catalog entry without current source evidence", async () => {
    await expect(assembleStorageVnextExtensionNavigation({
      knowledgeBaseId: "kb-one",
      projectionShards: [],
      navigation: navigation({
        byFileLogicalPaths: ["_graph/by-file/missing.json"]
      })
    })).rejects.toMatchObject({ code: "by_file_source_conflict" });
  });

  it("rejects a single long title that exceeds the UTF-8 leaf byte budget", async () => {
    await expect(assembleStorageVnextExtensionNavigation({
      knowledgeBaseId: "kb-one",
      projectionShards: [],
      navigation: {
        ...navigation({
          byFileLogicalPaths: ["_graph/by-file/source-long.json"],
          sources: [{
            publicId: "source-long",
            title: "界".repeat(1_000),
            pagePath: "pages/long.md"
          }]
        }),
        maxLeafBytes: 512
      }
    })).rejects.toThrow(/byte|large/iu);
  });

  it("converges across replace, move, delete, retry, and recreate", async () => {
    const initial = await byFileRelease({
      pagePath: "pages/guides/setup.md",
      previousLeaves: new Map(),
      existingMarkdownPaths: []
    });
    const initialLeaves = parseLeaves(initial.internalShards, "_graph/by-file");
    const initialLeafId = initialLeaves[0]!.id;

    const retry = await byFileRelease({
      pagePath: "pages/guides/setup.md",
      previousLeaves: new Map([["_graph/by-file", initialLeaves]]),
      existingMarkdownPaths: initial.artifacts.map((artifact) => artifact.logicalPath)
    });
    expect(parseLeaves(retry.internalShards, "_graph/by-file")).toEqual(initialLeaves);

    const moved = await byFileRelease({
      pagePath: "pages/reference/setup-renamed.md",
      previousLeaves: new Map([["_graph/by-file", initialLeaves]]),
      existingMarkdownPaths: initial.artifacts.map((artifact) => artifact.logicalPath)
    });
    const movedLeaves = parseLeaves(moved.internalShards, "_graph/by-file");
    expect(movedLeaves[0]).toMatchObject({ id: initialLeafId, revision: 2 });
    expect(movedLeaves[0]?.entries[0]).toMatchObject({
      id: "source-1",
      targetPath: "_graph/by-file/source-1.json",
      evidencePath: "pages/reference/setup-renamed.md"
    });

    const removed = await assembleStorageVnextExtensionNavigation({
      knowledgeBaseId: "kb-one",
      projectionShards: [],
      navigation: navigation({
        previousLeaves: new Map([["_graph/by-file", movedLeaves]]),
        existingMarkdownPaths: moved.artifacts.map((artifact) => artifact.logicalPath)
      })
    });
    expect(parseLeaves(removed.internalShards, "_graph/by-file")).toEqual([]);
    expect(removed.deletedLogicalPaths.some((path) =>
      path.startsWith("_graph/by-file/index-extension-leaf-"))).toBe(true);

    const recreated = await byFileRelease({
      pagePath: "pages/recreated/setup.md",
      previousLeaves: new Map([["_graph/by-file", []]]),
      existingMarkdownPaths: removed.artifacts.map((artifact) => artifact.logicalPath)
    });
    expect(parseLeaves(recreated.internalShards, "_graph/by-file")[0]?.id)
      .toBe(initialLeafId);
  });
});

function navigation(overrides: Partial<{
  byFileLogicalPaths: string[];
  existingMarkdownPaths: string[];
  previousLeaves: Map<string, readonly PersistentDirectoryLeaf[]>;
  sources: Array<{ publicId: string; title: string; pagePath: string }>;
  maxEntries: number;
  affectedDirectoryPaths: string[];
  previousPresentDirectoryPaths: string[];
  completeProfile: boolean;
  changedAt: string;
}> = {}) {
  return {
    byFileLogicalPaths: overrides.byFileLogicalPaths ?? [],
    existingMarkdownPaths: overrides.existingMarkdownPaths ?? [],
    previousLeaves: overrides.previousLeaves ?? new Map(),
    changedAt: overrides.changedAt ?? "2026-08-01T00:00:00.000Z",
    sources: sourcePages(overrides.sources ?? []),
    affectedDirectoryPaths: overrides.affectedDirectoryPaths
      ?? [...STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES],
    previousPresentDirectoryPaths: overrides.previousPresentDirectoryPaths ?? [],
    completeProfile: overrides.completeProfile ?? true,
    maxEntries: overrides.maxEntries ?? 200,
    maxLeafBytes: 65_536,
    maxShardBytes: 1_048_576
  };
}

async function* sourcePages<T>(items: readonly T[]): AsyncIterable<readonly T[]> {
  yield [...items];
}

function parseLeaves(
  shards: readonly { firstLogicalPath: string; bytes: Uint8Array }[],
  directoryPath: string
): PersistentDirectoryLeaf[] {
  return shards
    .filter((shard) => shard.firstLogicalPath === directoryPath)
    .map((shard) => parseStorageVnextExtensionNavigationState({
      bytes: shard.bytes,
      directoryPath
    }))
    .sort((left, right) => left.partIndex - right.partIndex)
    .flatMap((part) => part.leaves);
}

function byFileRelease(input: {
  pagePath: string;
  previousLeaves: Map<string, readonly PersistentDirectoryLeaf[]>;
  existingMarkdownPaths: string[];
}) {
  return assembleStorageVnextExtensionNavigation({
    knowledgeBaseId: "kb-one",
    projectionShards: [],
    navigation: navigation({
      byFileLogicalPaths: ["_graph/by-file/source-1.json"],
      sources: [{ publicId: "source-1", title: "Setup", pagePath: input.pagePath }],
      previousLeaves: input.previousLeaves,
      existingMarkdownPaths: input.existingMarkdownPaths
    })
  });
}
