import { describe, expect, it, vi } from "vitest";
import type {
  StorageVnextDirectoryFact,
  StorageVnextSourceFileFact,
  StorageVnextSourceRevisionFact
} from "../src/storage-vnext/catalog/ports.js";
import type { StorageVnextGraphNodeFact } from
  "../src/storage-vnext/graph/ports.js";
import {
  createStorageVnextPublicationProjectionLoader
} from "../src/storage-vnext/publication/projection-loader.js";
import { insertOrderedDirectoryEntries } from
  "../src/storage-vnext/publication/ordered-directory-batch.js";
import {
  directoryLeafByteSize,
  insertDirectoryEntry,
  type OrderedDirectoryEntry,
  type OrderedDirectoryLeaf
} from "../src/publication/ordered-directory-leaves.js";

const checksum = "a".repeat(64);

describe("storage vNext publication projection loader", () => {
  it("loads only affected pages, directory ancestors, and obsolete navigation paths", async () => {
    const directory = directoryFact();
    const pendingSiblingDirectory = {
      ...directoryFact(),
      publicId: "directory-research",
      logicalPath: "research",
      normalizedPath: "research",
      title: "research"
    };
    const source = { ...sourceFile(), status: "processing" as const };
    const revision = sourceRevision();
    const node = graphNode();
    const listDirectories = vi.fn(async (request: { parentPublicId: string | null | undefined }) => ({
      items: request.parentPublicId === undefined || request.parentPublicId === null
        ? [directory, pendingSiblingDirectory]
        : [],
      nextCursor: null
    }));
    const listSourceFiles = vi.fn(async (request: { directoryPublicId: string | null | undefined }) => ({
      items: request.directoryPublicId === directory.publicId ? [source] : [],
      nextCursor: null
    }));
    const listAffectedObsoletePaths = vi.fn(async () => [
      "pages/guides/index-directory-leaf-old.md",
      "pages/old.md"
    ]);
    const summarizeCandidate = vi.fn(async () => ({
      sourceFileCount: 1,
      directoryCount: 2,
      generatedEntryCount: 11,
      graphNodeCount: 1,
      graphEdgeCount: 0,
      generatedByteCount: 1_024
    }));
    const readExtensionNavigationLeaves = vi.fn(async (_request: {
      directoryPath: string;
    }) => []);
    const listExtensionNavigationShards = vi.fn(async (request: {
      directoryPaths: readonly string[];
    }) => request.directoryPaths.map((directoryPath, ordinal) => ({
      publicId: `release-shard-${ordinal}`,
      logicalKind: "extension_navigation" as const,
      firstLogicalPath: directoryPath,
      lastLogicalPath: directoryPath,
      recordCount: 0,
      byteCount: 64,
      checksum: `${ordinal}`.padStart(64, "0"),
      objectId: `generated-${ordinal}`,
      ordinal: 0
    })));
    const listExtensionCatalogPaths = vi.fn(async (request: {
      includeByFileResources?: boolean;
      cursor: string | null;
    }) => request.includeByFileResources === false ? {
      byFileLogicalPaths: [],
      markdownLogicalPaths: [],
      scannedCount: 0,
      nextCursor: null
    } : request.cursor === null ? {
      byFileLogicalPaths: ["_graph/by-file/source-setup.json"],
      markdownLogicalPaths: [],
      scannedCount: 1,
      nextCursor: "extension-page-two"
    } : {
      byFileLogicalPaths: [],
      markdownLogicalPaths: ["_index/search/index.md"],
      scannedCount: 1,
      nextCursor: null
    });
    const getSourceContext = vi.fn(async () => ({
      entities: [{
        label: "Runtime service",
        kind: "component",
        description: "Processes source revisions.",
        confidence: 0.94,
        evidencePaths: ["pages/guides/setup.md"]
      }]
    }));
    const loader = createStorageVnextPublicationProjectionLoader({
      catalog: {
        getKnowledgeBase: vi.fn(async () => ({
          publicId: "kb-one",
          name: "Engineering",
          description: null,
          revision: 1,
          visibility: "current" as const,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z"
        })),
        getCurrentSourceRevision: vi.fn(async () => revision),
        listDirectories,
        listSourceFiles,
        listSourceFilesByPublicIds: vi.fn(async () => [source])
      },
      graph: {
        getEdge: vi.fn(async () => null),
        getNode: vi.fn(async () => node),
        listBySourceFile: vi.fn(async () => ({ items: [node], nextCursor: null })),
        listNeighborhood: vi.fn(async () => ({ items: [], nextCursor: null }))
      },
      sourceBodies: {
        readVerifiedStream: vi.fn(async () => bytes("# Setup\n\nSource body."))
      },
      semanticPresentation: { getSourceContext },
      snapshot: {
        readBaseNavigationProfile: vi.fn(async () => 1),
        readKnowledgeBaseCounts: vi.fn(async () => ({
          sourceFileCount: 0,
          directoryCount: 2,
          graphNodeCount: 1,
          graphEdgeCount: 0
        })),
        readDirectoryDescendantFileCounts: vi.fn(async () => new Map([
          ["pages", 0],
          ["pages/guides", 0]
        ])),
        readDirectoryLeaves: vi.fn(async ({ directoryPath }: { directoryPath: string }) =>
          directoryPath === "pages/guides" ? [{
            id: "directory-leaf-existing",
            previousLeafId: null,
            nextLeafId: null,
            revision: 4,
            changedAt: "2026-07-31T00:00:00.000Z",
            entries: [{
              id: "source-setup",
              sortKey: "setup.md/source-setup",
              name: "setup.md",
              targetPath: "pages/guides/setup.md",
              kind: "file" as const
            }]
          }] : []),
        readExtensionNavigationLeaves,
        readProjectionRecords: vi.fn(async ({ logicalPath }: { logicalPath: string }) =>
          logicalPath.includes("/search/")
            ? [{ id: "source-existing", path: "pages/existing.md" }]
            : []),
        listAffectedObsoletePaths,
        listProjectionShards: vi.fn(async () => [{
          projectionKind: "manifest",
          shardKey: "manifest/v1/0000",
          logicalPath: "_index/manifest/v1/0000.json",
          recordCount: 1
        }]),
        listExtensionNavigationShards,
        listExtensionCatalogPaths,
        summarizeCandidate
      },
      limits: {
        catalogPageSize: 100,
        maximumSourceBytes: 1_024,
        maximumAffectedPaths: 100,
        directoryIndexMaxEntries: 200,
        directoryIndexMaxBytes: 65_536,
        relatedFileLimit: 100,
        maximumProjectionShards: 1_024,
        maximumMachineArtifactBytes: 1_048_576,
        machineShardCounts: {
          search: 64,
          links: 64,
          manifest: 64,
          tree: 64,
          graphNode: 64,
          graphEdge: 128
        }
      }
    });
    const request = {
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      operationPublicId: "operation-one",
      searchProjectionPublicId: "candidate-one",
      signal: new AbortController().signal
    };
    const plan = {
      sourcePaths: ["pages/guides/setup.md", "pages/old.md"],
      directoryPaths: ["pages", "pages/guides"],
      graphPublicIds: ["source-setup"],
      linkPublicIds: [],
      searchSourceFilePublicIds: [],
      rootPaths: [
        "index.md", "pages/index.md", "schema.md", "log.md",
        "_index/index.md", "_graph/index.md", "_index/catalog.json"
      ]
    };

    const projection = await loader.load({ ...request, plan });
    const batches = [];
    for await (const batch of projection.batches) batches.push(batch);
    const pages = batches.flatMap((batch) => batch.pages);
    const deletedLogicalPaths = batches.flatMap((batch) => batch.deletedLogicalPaths);
    const machineArtifacts = batches.flatMap((batch) => batch.machineArtifacts);

    expect(projection.knowledgeBase.sourceFileCount).toBe(1);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.sourceBody).toContain("Source body.");
    expect(pages[0]?.semanticContext).toMatchObject({
      entities: [{ label: "Runtime service", kind: "component" }]
    });
    expect(getSourceContext).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-one",
      operationPublicId: "operation-one",
      sourceFilePublicId: "source-setup",
      sourceRevisionPublicId: "revision-setup",
      entityLimit: 100
    });
    expect(projection.removedSourceLogicalPaths).toEqual(["pages/old.md"]);
    expect(projection.directories.map((item) => item.directoryPath)).toEqual([
      "pages",
      "pages/guides"
    ]);
    expect(projection.directories[0]).toMatchObject({
      directoryPublicId: null,
      entryCount: 1,
      descendantFileCount: 1
    });
    expect(projection.directories[0]?.leaves[0]?.entries[0]).toEqual({
      id: "directory:guides",
      sortKey: "guides/directory:guides",
      name: "guides",
      targetPath: "pages/guides/index.md",
      kind: "directory"
    });
    expect(projection.directories[1]?.leaves[0]?.entries[0]).toEqual({
      id: "source-setup",
      sortKey: "setup.md/source-setup",
      name: "setup.md",
      targetPath: "pages/guides/setup.md",
      kind: "file"
    });
    expect(projection.directories[1]?.leaves[0]?.id).toBe("directory-leaf-existing");
    expect(projection.directories[1]?.leaves[0]?.changedAt)
      .toBe("2026-07-31T00:00:00.000Z");
    expect(deletedLogicalPaths).toEqual([
      "pages/guides/index-directory-leaf-old.md",
      "pages/old.md"
    ]);
    expect(projection.internalShards).toHaveLength(2);
    expect(projection.extensionNavigation).toMatchObject({
      byFileLogicalPaths: [],
      existingMarkdownPaths: [],
      previousPresentDirectoryPaths: []
    });
    expect(listExtensionCatalogPaths).toHaveBeenCalledWith(expect.objectContaining({
      includeByFileResources: false,
      cursor: null
    }));
    expect(readExtensionNavigationLeaves.mock.calls.map(([request]) =>
      request.directoryPath)).toEqual([
      "_index/manifest/v1",
      "_index/search/v1",
      "_index/tree/v1",
      "_graph/graph_node/v1",
      "_graph/by-file"
    ]);
    expect(listExtensionNavigationShards).toHaveBeenCalledWith(expect.objectContaining({
      directoryPaths: ["_index/links/v1", "_graph/graph_edge/v1"]
    }));
    expect(projection.reusedInternalShards.map((shard) => shard.firstLogicalPath))
      .toEqual(["_index/links/v1", "_graph/graph_edge/v1"]);
    expect(projection.internalShards.map((shard) => [
      shard.logicalKind,
      shard.firstLogicalPath,
      shard.recordCount
    ])).toEqual([
      ["directory_navigation", "pages", 1],
      ["directory_navigation", "pages/guides", 1]
    ]);
    expect(JSON.parse(Buffer.from(projection.internalShards[1]!.bytes).toString("utf8")))
      .toMatchObject({
        formatVersion: 1,
        kind: "directory-navigation",
        directoryPath: "pages/guides",
        leaves: [{ id: "directory-leaf-existing", revision: 4 }]
      });
    expect(machineArtifacts.map((artifact) => artifact.logicalPath))
      .toEqual(expect.arrayContaining([
        expect.stringMatching(/^_index\/search\/v1\/\d{4}\.json$/u),
        expect.stringMatching(/^_index\/manifest\/v1\/\d{4}\.json$/u),
        expect.stringMatching(/^_index\/tree\/v1\/\d{4}\.json$/u),
        expect.stringMatching(/^_graph\/graph_node\/v1\/\d{4}\.json$/u),
        "_graph/by-file/source-setup.json"
      ]));
    const searchArtifact = machineArtifacts.find((artifact) =>
      artifact.logicalPath.includes("/search/"))!;
    expect(JSON.parse(Buffer.from(searchArtifact.bytes).toString("utf8")).records
      .map((record: { id: string }) => record.id)).toEqual([
      "source-existing",
      "source-setup"
    ]);
    const graphNodeArtifact = machineArtifacts.find((artifact) =>
      artifact.logicalPath.includes("/graph_node/"))!;
    const graphNodeRecords = JSON.parse(Buffer.from(
      graphNodeArtifact.bytes
    ).toString("utf8")).records;
    expect(graphNodeRecords).toEqual([
      expect.objectContaining({
        id: "source-setup",
        semanticContext: {
          entities: [{
            label: "Runtime service",
            kind: "component",
            description: "Processes source revisions.",
            confidence: 0.94,
            evidencePaths: ["pages/guides/setup.md"]
          }]
        }
      })
    ]);
    expect(JSON.stringify(graphNodeRecords)).not.toMatch(
      /semanticGenerationPublicId|entityPublicId|vector|prompt/iu
    );
    expect(listAffectedObsoletePaths).toHaveBeenCalledWith(expect.objectContaining({
      sourcePaths: ["pages/guides/setup.md", "pages/old.md"],
      currentDirectoryPaths: ["pages", "pages/guides"],
      deletedDirectoryPaths: [],
      currentLogicalPaths: expect.arrayContaining([
        "pages/guides/setup.md",
        "pages/index.md",
        "pages/guides/index.md"
      ])
    }));
    await expect(loader.summarizeCandidate(request)).resolves.toMatchObject({
      generatedEntryCount: 11
    });
    expect(summarizeCandidate).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      operationPublicId: "operation-one"
    });
  });

  it("reads and emits each final machine shard only once across page batches", async () => {
    const sources = ["a", "b", "c"].map(sourceFileWithId);
    const revisions = new Map(sources.map((source) => [
      source.publicId,
      sourceRevisionWithId(source.publicId)
    ]));
    const nodes = new Map(sources.map((source) => [
      source.publicId,
      graphNodeWithId(source.publicId)
    ]));
    const readProjectionRecords = vi.fn(async (_input: { logicalPath: string }) => []);
    const listExtensionCatalogPaths = vi.fn(async (request: {
      cursor: string | null;
    }) => request.cursor === null ? {
      byFileLogicalPaths: ["_graph/by-file/a.json"],
      markdownLogicalPaths: [],
      scannedCount: 1,
      nextCursor: "extension-page-two"
    } : {
      byFileLogicalPaths: [],
      markdownLogicalPaths: ["_index/search/index.md"],
      scannedCount: 1,
      nextCursor: null
    });
    const loader = createStorageVnextPublicationProjectionLoader({
      catalog: {
        getKnowledgeBase: vi.fn(async () => ({
          publicId: "kb-one",
          name: "Engineering",
          description: null,
          revision: 1,
          visibility: "current" as const,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z"
        })),
        getCurrentSourceRevision: vi.fn(async ({ sourceFilePublicId }) =>
          revisions.get(sourceFilePublicId) ?? null),
        listDirectories: vi.fn(async () => ({ items: [], nextCursor: null })),
        listSourceFiles: vi.fn(async () => ({ items: sources, nextCursor: null })),
        listSourceFilesByPublicIds: vi.fn(async ({ publicIds }) =>
          sources.filter((source) => publicIds.includes(source.publicId)))
      },
      graph: {
        getEdge: vi.fn(async () => null),
        getNode: vi.fn(async ({ publicId }) =>
          [...nodes.values()].find((node) => node.publicId === publicId) ?? null),
        listBySourceFile: vi.fn(async ({ sourceFilePublicId }) => ({
          items: [nodes.get(sourceFilePublicId)!],
          nextCursor: null
        })),
        listNeighborhood: vi.fn(async () => ({ items: [], nextCursor: null }))
      },
      sourceBodies: {
        readVerifiedStream: vi.fn(async () => bytes("# Source\n\nBody."))
      },
      snapshot: {
        readBaseNavigationProfile: vi.fn(async () => 0),
        readKnowledgeBaseCounts: vi.fn(async () => ({
          sourceFileCount: 3,
          directoryCount: 1,
          graphNodeCount: 3,
          graphEdgeCount: 0
        })),
        readDirectoryDescendantFileCounts: vi.fn(async () => new Map([["pages", 3]])),
        readDirectoryLeaves: vi.fn(async () => []),
        readExtensionNavigationLeaves: vi.fn(async () => []),
        readProjectionRecords,
        listAffectedObsoletePaths: vi.fn(async () => []),
        listProjectionShards: vi.fn(async () => []),
        listExtensionNavigationShards: vi.fn(async () => []),
        listExtensionCatalogPaths,
        summarizeCandidate: vi.fn(async () => ({
          sourceFileCount: 3,
          directoryCount: 1,
          generatedEntryCount: 10,
          graphNodeCount: 3,
          graphEdgeCount: 0,
          generatedByteCount: 1_024
        }))
      },
      limits: {
        catalogPageSize: 1,
        maximumSourceBytes: 1_024,
        maximumAffectedPaths: 100,
        directoryIndexMaxEntries: 200,
        directoryIndexMaxBytes: 65_536,
        relatedFileLimit: 100,
        maximumProjectionShards: 1_024,
        maximumMachineArtifactBytes: 1_048_576,
        machineShardCounts: {
          search: 1,
          links: 1,
          manifest: 1,
          tree: 1,
          graphNode: 1,
          graphEdge: 1
        }
      }
    });
    const sourceIds = sources.map((source) => source.publicId);
    const projection = await loader.load({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      operationPublicId: "operation-one",
      searchProjectionPublicId: "candidate-one",
      signal: new AbortController().signal,
      plan: {
        sourcePaths: sources.map((source) => `pages/${source.logicalPath}`),
        directoryPaths: ["pages"],
        graphPublicIds: sourceIds,
        linkPublicIds: [],
        searchSourceFilePublicIds: [],
        rootPaths: [
          "index.md", "pages/index.md", "schema.md", "log.md",
          "_index/index.md", "_graph/index.md", "_index/catalog.json"
        ]
      }
    });
    const batches = [];
    for await (const batch of projection.batches) batches.push(batch);
    const machineArtifacts = batches.flatMap((batch) => batch.machineArtifacts);
    const finalShards = machineArtifacts.filter((artifact) =>
      !artifact.logicalPath.startsWith("_graph/by-file/"));

    expect(projection.profileUpgrade).toBe(true);
    expect(projection.extensionNavigation).toMatchObject({
      byFileLogicalPaths: ["_graph/by-file/a.json"],
      existingMarkdownPaths: ["_index/search/index.md"]
    });
    expect(listExtensionCatalogPaths).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ cursor: null, limit: 1 }));
    expect(listExtensionCatalogPaths).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ cursor: "extension-page-two", limit: 1 }));

    expect(readProjectionRecords).toHaveBeenCalledTimes(4);
    expect(new Set(readProjectionRecords.mock.calls.map((call) =>
      call[0].logicalPath)).size).toBe(4);
    expect(finalShards).toHaveLength(4);
    for (const shard of finalShards) {
      const document = JSON.parse(Buffer.from(shard.bytes).toString("utf8"));
      expect(document.records).toHaveLength(document.projection === "tree" ? 4 : 3);
    }
  });
});

function directoryFact(): StorageVnextDirectoryFact {
  return {
    publicId: "directory-guides",
    knowledgeBaseId: "kb-one",
    parentPublicId: null,
    logicalPath: "guides",
    normalizedPath: "guides",
    title: "guides",
    revision: 1,
    visibility: "current"
  };
}

function sourceFile(): StorageVnextSourceFileFact {
  return {
    publicId: "source-setup",
    knowledgeBaseId: "kb-one",
    directoryPublicId: "directory-guides",
    logicalPath: "guides/setup.md",
    normalizedPath: "guides/setup.md",
    title: "Setup",
    metadata: {},
    currentRevisionPublicId: "revision-setup",
    status: "ready",
    safeErrorCode: null,
    safeErrorMessage: null,
    revision: 1,
    visibility: "current"
  };
}

function sourceRevision(): StorageVnextSourceRevisionFact {
  return {
    publicId: "revision-setup",
    sourceFilePublicId: "source-setup",
    knowledgeBaseId: "kb-one",
    objectId: "source-object",
    checksum,
    byteCount: 22,
    contentType: "text/markdown; charset=utf-8",
    createdAt: "2026-08-01T00:00:00.000Z"
  };
}

function graphNode(): StorageVnextGraphNodeFact {
  return {
    publicId: "node-setup",
    knowledgeBaseId: "kb-one",
    sourceFilePublicId: "source-setup",
    sourceRevisionPublicId: "revision-setup",
    logicalPath: "pages/guides/setup.md",
    label: "Setup",
    kind: "Guide",
    metadata: {},
    evidence: [],
    revision: 1
  };
}

function sourceFileWithId(id: string): StorageVnextSourceFileFact {
  return {
    ...sourceFile(),
    publicId: `source-${id}`,
    directoryPublicId: null,
    logicalPath: `${id}.md`,
    normalizedPath: `${id}.md`,
    title: id.toUpperCase(),
    currentRevisionPublicId: `revision-${id}`
  };
}

function sourceRevisionWithId(sourceFilePublicId: string): StorageVnextSourceRevisionFact {
  return {
    ...sourceRevision(),
    publicId: `revision-${sourceFilePublicId}`,
    sourceFilePublicId,
    objectId: `object-${sourceFilePublicId}`
  };
}

function graphNodeWithId(sourceFilePublicId: string): StorageVnextGraphNodeFact {
  const id = sourceFilePublicId.replace(/^source-/u, "");
  return {
    ...graphNode(),
    publicId: `node-${id}`,
    sourceFilePublicId,
    sourceRevisionPublicId: `revision-${id}`,
    logicalPath: `pages/${id}.md`,
    label: id.toUpperCase()
  };
}

async function* bytes(value: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(value, "utf8");
}

describe("storage vNext ordered directory batch", () => {
  it("preserves the exact released sequential leaf structure", () => {
    const initialLeaves: OrderedDirectoryLeaf[] = [
      { id: "leaf-existing", entries: [directoryEntry("a"), directoryEntry("e")] }
    ];
    const entries = [
      directoryEntry("d"),
      directoryEntry("b"),
      directoryEntry("g"),
      directoryEntry("f")
    ];
    const limits = { maxEntries: 3, maxBytes: 10_000, mergeBelowEntries: 1 };
    let sequentialSequence = 1;
    let sequentialLeaves = initialLeaves;
    for (const entry of entries) {
      sequentialLeaves = insertDirectoryEntry({
        leaves: sequentialLeaves,
        entry,
        limits,
        createLeafId: () => `leaf-${sequentialSequence++}`
      }).leaves;
    }

    let batchSequence = 1;
    const batch = insertOrderedDirectoryEntries({
      leaves: initialLeaves,
      entries,
      limits,
      createLeafId: () => `leaf-${batchSequence++}`
    });

    expect(batch.leaves).toEqual(sequentialLeaves);
    expect(batchSequence).toBe(sequentialSequence);
  });

  it("preserves exact sequential splits at the UTF-8 byte limit", () => {
    const entries = ["alpha", "beta", "gamma", "delta"].map(directoryEntry);
    const limits = {
      maxEntries: 10,
      maxBytes: directoryLeafByteSize(entries.slice(0, 2)),
      mergeBelowEntries: 1
    };
    let sequentialSequence = 0;
    let sequentialLeaves: OrderedDirectoryLeaf[] = [];
    for (const entry of entries) {
      sequentialLeaves = insertDirectoryEntry({
        leaves: sequentialLeaves,
        entry,
        limits,
        createLeafId: () => `leaf-${sequentialSequence++}`
      }).leaves;
    }

    let batchSequence = 0;
    const batch = insertOrderedDirectoryEntries({
      leaves: [],
      entries,
      limits,
      createLeafId: () => `leaf-${batchSequence++}`
    });

    expect(batch.leaves).toEqual(sequentialLeaves);
    expect(batch.leaves.every((leaf) =>
      directoryLeafByteSize(leaf.entries) <= limits.maxBytes)).toBe(true);
  });

  it("inserts a large directory within a bounded time", () => {
    const entries = Array.from({ length: 10_000 }, (_, index) =>
      directoryEntry(`entry-${String(index).padStart(8, "0")}`));
    let sequence = 0;
    const startedAt = performance.now();

    const batch = insertOrderedDirectoryEntries({
      leaves: [],
      entries,
      limits: { maxEntries: 200, maxBytes: 65_536, mergeBelowEntries: 50 },
      createLeafId: () => `leaf-${sequence++}`
    });

    expect(performance.now() - startedAt).toBeLessThan(1_500);
    expect(batch.leaves.flatMap((leaf) => leaf.entries)).toEqual(entries);
  });
});

function directoryEntry(id: string): OrderedDirectoryEntry {
  return {
    id,
    sortKey: id,
    name: id,
    targetPath: `pages/${id}.md`,
    kind: "file"
  };
}
