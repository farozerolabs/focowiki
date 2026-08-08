import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  renderDirectoryLeafMarkdown,
  renderDirectoryRootMarkdown
} from "../src/publication/directory-navigation-writer.js";
import { renderBoundedRootFile } from "../src/publication/bounded-root-writer.js";
import { renderPageFile } from "../src/okf/publication-files.js";
import {
  createStorageVnextContentDocument,
  createStorageVnextGraphSeedDocument
} from "../src/storage-vnext/search/documents.js";
import {
  createStorageVnextPublicationCandidateValidator,
  validateStorageVnextProjectionCatalogParity
} from "../src/storage-vnext/publication/candidate-validator.js";
import { createStorageVnextExtensionNavigationShards } from
  "../src/storage-vnext/publication/extension-navigation-state.js";
import { STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES } from
  "../src/storage-vnext/publication/profile.js";
import {
  packStorageVnextInternalShards
} from "../src/storage-vnext/publication/internal-shards.js";
import {
  createStorageVnextPublicationObjectValidator
} from "../src/storage-vnext/publication/object-validator.js";
import {
  planStorageVnextPublicationBatch
} from "../src/storage-vnext/publication/planning.js";
import {
  createStorageVnextPublicationPublisher
} from "../src/storage-vnext/publication/publisher.js";
import {
  renderStorageVnextDirectoryArtifacts,
  renderStorageVnextPageArtifact,
  renderStorageVnextRootArtifact
} from "../src/storage-vnext/publication/rendering.js";
import type {
  StorageVnextPublicationArtifact
} from "../src/storage-vnext/publication/types.js";
import {
  STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS,
  validateStorageVnextReleasedStructure,
  resolveStorageVnextMarkdownTargets
} from "../src/storage-vnext/publication/validation.js";

const checksumA = "a".repeat(64);
const checksumB = "b".repeat(64);

describe("storage vNext incremental publication", () => {
  it("resolves generated Markdown targets containing balanced parentheses", () => {
    const target =
      "最高人民法院关于《中华人民共和国刑法修正案(八)》时间效力问题的解释__2011-04-25__有效__bb564a577367.md";

    expect(resolveStorageVnextMarkdownTargets(
      "pages/06_司法解释/index.md",
      `[最高人民法院解释](${target})`
    )).toEqual([`pages/06_司法解释/${target}`]);
  });

  it("plans only the bounded changed dependency set", () => {
    const result = planStorageVnextPublicationBatch({
      dependencies: [
        dependency("path", "pages/guides/setup.md", "source_path"),
        dependency("ancestor", "pages", "directory_ancestor"),
        dependency("ancestor", "pages/guides", "directory_ancestor"),
        dependency("graph", "source-setup", "graph_source"),
        dependency("link", "edge-setup-reference", "graph_edge"),
        dependency("search", "source-setup", "search_document"),
        dependency("index", "index.md", "required_navigation"),
        dependency("schema", "schema.md", "required_schema"),
        dependency("log", "log.md", "bounded_update_log")
      ],
      maximumDependencies: 16
    });

    expect(result).toEqual({
      sourcePaths: ["pages/guides/setup.md"],
      directoryPaths: ["pages", "pages/guides"],
      graphPublicIds: ["source-setup"],
      linkPublicIds: ["edge-setup-reference"],
      searchSourceFilePublicIds: ["source-setup"],
      rootPaths: ["index.md", "log.md", "schema.md"]
    });
    expect(() => planStorageVnextPublicationBatch({
      dependencies: [
        dependency("path", "pages/a.md", "source_path"),
        dependency("path", "pages/b.md", "source_path")
      ],
      maximumDependencies: 1
    })).toThrow(/dependency budget/iu);
  });

  it("packs reusable byte-and-record bounded internal shards without public paths", () => {
    const shards = packStorageVnextInternalShards({
      logicalKind: "tree",
      records: [
        { publicId: "record-b", logicalPath: "pages/b.md", value: { title: "B" } },
        { publicId: "record-a", logicalPath: "pages/a.md", value: { title: "A" } },
        { publicId: "record-c", logicalPath: "pages/c.md", value: { title: "C" } }
      ],
      maximumRecords: 2,
      maximumBytes: 180
    });

    expect(shards).toHaveLength(2);
    expect(shards.map((shard) => shard.recordCount)).toEqual([2, 1]);
    expect(shards.every((shard) => shard.bytes.byteLength <= 180)).toBe(true);
    expect(shards.map((shard) => [shard.firstLogicalPath, shard.lastLogicalPath])).toEqual([
      ["pages/a.md", "pages/b.md"],
      ["pages/c.md", "pages/c.md"]
    ]);
    expect(shards.every((shard) => !("logicalPath" in shard))).toBe(true);
    expect(packStorageVnextInternalShards({
      logicalKind: "tree",
      records: [
        { publicId: "record-a", logicalPath: "pages/a.md", value: { title: "A" } },
        { publicId: "record-b", logicalPath: "pages/b.md", value: { title: "B" } }
      ],
      maximumRecords: 2,
      maximumBytes: 180
    })[0]?.publicId).toBe(shards[0]?.publicId);
  });

  it("reuses unchanged public and internal objects while attaching one candidate delta", async () => {
    const putVerified = vi.fn()
      .mockResolvedValueOnce(objectResult("generated-page", checksumA, 20, "reused"));
    const addCandidateCatalogEntries = vi.fn().mockResolvedValue(undefined);
    const addCandidateCatalogTombstones = vi.fn().mockResolvedValue(undefined);
    const addCandidateShards = vi.fn().mockResolvedValue({
      createdDescriptorCount: 0,
      reusedDescriptorCount: 1,
      attachedCount: 1
    });
    const publisher = createStorageVnextPublicationPublisher({
      objects: { putVerified },
      releases: {
        addCandidateCatalogEntries,
        addCandidateCatalogTombstones,
        addCandidateShards
      },
      search: {
        prepareCandidate: vi.fn(),
        writeDocumentBatch: vi.fn()
      },
      clock: () => "2026-08-01T00:00:00.000Z",
      limits: {
        maximumArtifacts: 8,
        maximumArtifactBytes: 1_024,
        maximumSearchDocuments: 8,
        maximumSearchCompressedBytes: 8_192,
        objectWriteConcurrency: 2
      }
    });

    const result = await publisher.publish({
      knowledgeBaseId: "kb-a",
      candidatePublicId: "candidate-a",
      operationPublicId: "operation-a",
      schemaChecksum: checksumA,
      settingsChecksum: checksumB,
      searchBatchOrdinal: 0,
      deletedLogicalPaths: ["pages/old-setup.md"],
      artifacts: [artifact("pages/guides/setup.md", "source", 7, "# Setup\n", "source-a")],
      internalShards: [],
      reusedInternalShards: [{
        publicId: "release-shard-unchanged",
        logicalKind: "tree",
        firstLogicalPath: "pages/a.md",
        lastLogicalPath: "pages/z.md",
        recordCount: 24,
        byteCount: 80,
        checksum: checksumB,
        objectId: "generated-shard",
        ordinal: 0
      }],
      searchDocuments: []
    });

    expect(result).toMatchObject({
      artifactCount: 1,
      internalShardCount: 0,
      reusedInternalShardCount: 1,
      storedObjectCount: 0,
      reusedObjectCount: 1,
      reusedShardDescriptorCount: 1
    });
    expect(putVerified).toHaveBeenCalledOnce();
    expect(addCandidateCatalogTombstones).toHaveBeenCalledWith({
      candidatePublicId: "candidate-a",
      logicalPaths: ["pages/old-setup.md"]
    });
    expect(addCandidateCatalogEntries).toHaveBeenCalledWith({
      candidatePublicId: "candidate-a",
      entries: [expect.objectContaining({
        logicalPath: "pages/guides/setup.md",
        sourceFilePublicId: "source-a",
        objectId: "generated-page"
      })]
    });
    expect(addCandidateShards).toHaveBeenCalledWith({
      candidatePublicId: "candidate-a",
      shards: [expect.objectContaining({
        logicalKind: "tree",
        objectId: "generated-shard",
        firstLogicalPath: "pages/a.md",
        lastLogicalPath: "pages/z.md"
      })]
    });
    await expect(publisher.publish({
      knowledgeBaseId: "kb-a",
      candidatePublicId: "candidate-a",
      operationPublicId: "operation-a",
      schemaChecksum: checksumA,
      settingsChecksum: checksumB,
      searchBatchOrdinal: 0,
      deletedLogicalPaths: [],
      artifacts: [artifact("private.md", "index", 0, "# Private")],
      internalShards: [],
      reusedInternalShards: [],
      searchDocuments: []
    })).rejects.toThrow(/artifact/iu);
  });

  it("binds publication write attempts to immutable artifact content", async () => {
    const putVerified = vi.fn(async (request: {
      bytes: Uint8Array;
      writeAttemptPublicId: string;
    }) => {
      const checksum = createHash("sha256").update(request.bytes).digest("hex");
      return objectResult(`generated-page-${checksum}`, checksum, request.bytes.byteLength, "stored");
    });
    const publisher = createStorageVnextPublicationPublisher({
      objects: { putVerified },
      releases: {
        addCandidateCatalogEntries: vi.fn().mockResolvedValue(undefined),
        addCandidateCatalogTombstones: vi.fn().mockResolvedValue(undefined),
        addCandidateShards: vi.fn().mockResolvedValue({
          createdDescriptorCount: 0,
          reusedDescriptorCount: 0,
          attachedCount: 0
        })
      },
      search: { prepareCandidate: vi.fn(), writeDocumentBatch: vi.fn() },
      clock: () => "2026-08-01T00:00:00.000Z",
      limits: {
        maximumArtifacts: 1,
        maximumArtifactBytes: 1_024,
        maximumSearchDocuments: 1,
        maximumSearchCompressedBytes: 1_024,
        objectWriteConcurrency: 2
      }
    });
    const publish = (body: string) => publisher.publish({
      knowledgeBaseId: "kb-a",
      candidatePublicId: "candidate-a",
      operationPublicId: "operation-a",
      schemaChecksum: checksumA,
      settingsChecksum: checksumB,
      searchBatchOrdinal: 0,
      deletedLogicalPaths: [],
      artifacts: [artifact("index.md", "index", 0, body)],
      internalShards: [],
      reusedInternalShards: [],
      searchDocuments: []
    });

    await publish("# First\n");
    await publish("# First\n");
    await publish("# Second\n");

    const writeAttempts = putVerified.mock.calls.map((call) =>
      call[0].writeAttemptPublicId);
    expect(writeAttempts[0]).toBe(writeAttempts[1]);
    expect(writeAttempts[2]).not.toBe(writeAttempts[0]);
  });

  it("writes large candidate deltas through bounded repository batches", async () => {
    const addCandidateCatalogEntries = vi.fn(async (request: { entries: readonly unknown[] }) => {
      if (request.entries.length > 1_000) throw new Error("repository batch overflow");
    });
    const addCandidateCatalogTombstones = vi.fn(async (request: { logicalPaths: readonly string[] }) => {
      if (request.logicalPaths.length > 1_000) throw new Error("repository batch overflow");
    });
    const publisher = createStorageVnextPublicationPublisher({
      objects: {
        putVerified: vi.fn(async (request: { bytes: Uint8Array }) =>
          objectResult("generated-batched", checksumA, request.bytes.byteLength, "reused"))
      },
      releases: {
        addCandidateCatalogEntries,
        addCandidateCatalogTombstones,
        addCandidateShards: vi.fn()
      },
      search: { prepareCandidate: vi.fn(), writeDocumentBatch: vi.fn() },
      clock: () => "2026-08-01T00:00:00.000Z",
      limits: {
        maximumArtifacts: 2_100,
        maximumArtifactBytes: 1_024,
        maximumSearchDocuments: 1,
        maximumSearchCompressedBytes: 1_024,
        objectWriteConcurrency: 2
      }
    });
    const artifacts = Array.from({ length: 2_001 }, (_, ordinal) =>
      artifact(`pages/file-${String(ordinal).padStart(4, "0")}.md`, "source", ordinal,
        "# File", `source-${ordinal}`));
    const deletedLogicalPaths = Array.from({ length: 2_001 }, (_, ordinal) =>
      `pages/deleted-${String(ordinal).padStart(4, "0")}.md`);

    await expect(publisher.publish({
      knowledgeBaseId: "kb-a",
      candidatePublicId: "candidate-a",
      operationPublicId: "operation-a",
      schemaChecksum: checksumA,
      settingsChecksum: checksumB,
      searchBatchOrdinal: 0,
      deletedLogicalPaths,
      artifacts,
      internalShards: [],
      reusedInternalShards: [],
      searchDocuments: []
    })).resolves.toMatchObject({ artifactCount: 2_001 });
    expect(addCandidateCatalogEntries.mock.calls.map((call) => call[0].entries.length))
      .toEqual([1_000, 1_000, 1]);
    expect(addCandidateCatalogTombstones.mock.calls.map((call) =>
      call[0].logicalPaths.length)).toEqual([1_000, 1_000, 1]);
  });

  it("preserves nested directory root and continuation navigation bytes", () => {
    const directoryInput = {
      directoryPath: "pages/guides/install",
      entryCount: 2,
      leaves: [{
        id: "000001",
        previousLeafId: null,
        nextLeafId: null,
        revision: 1,
        entries: [
          {
            id: "source-linux",
            sortKey: "linux/source-linux",
            name: "Linux",
            targetPath: "pages/guides/install/linux.md",
            kind: "file" as const
          },
          {
            id: "source-macos",
            sortKey: "macos/source-macos",
            name: "macOS",
            targetPath: "pages/guides/install/macos.md",
            kind: "file" as const
          }
        ]
      }]
    };
    const artifacts = renderStorageVnextDirectoryArtifacts({
      ...directoryInput,
      ordinalStart: 10
    });

    expect(artifacts.map((item) => item.logicalPath)).toEqual([
      "pages/guides/install/index.md",
      "pages/guides/install/index-000001.md"
    ]);
    expect(text(artifacts[0]!)).toContain("[Parent directory](/pages/guides/index.md)");
    expect(text(artifacts[0]!)).toContain("[Browse entries](/pages/guides/install/index-000001.md)");
    expect(text(artifacts[1]!)).toContain("[Directory index](/pages/guides/install/index.md)");
    expect(text(artifacts[1]!)).toContain("[Linux](/pages/guides/install/linux.md)");
    expect(text(artifacts[0]!)).toBe(renderDirectoryRootMarkdown({
      directoryPath: directoryInput.directoryPath,
      entryCount: directoryInput.entryCount,
      firstLeafId: directoryInput.leaves[0]!.id
    }));
    expect(text(artifacts[1]!)).toBe(renderDirectoryLeafMarkdown({
      directoryPath: directoryInput.directoryPath,
      leaf: directoryInput.leaves[0]!
    }));
  });

  it("preserves readable source Markdown and cross-directory graph links", () => {
    const input = {
      page: {
        pagePath: "pages/guides/setup.md",
        fileId: "source-setup",
        metadata: {
          type: "Guide",
          title: "Setup",
          description: "Install the service."
        },
        suggestions: null,
        graphLinks: [{
          fileId: "source-configuration",
          path: "pages/reference/configuration.md",
          title: "Configuration",
          relationType: "references",
          direction: "outgoing",
          weight: 1,
          reason: "Configure the installed service.",
          source: "deterministic"
        }]
      },
      sourceBody: "# Old heading\n\nKeep this source body readable.",
      ordinal: 20
    } satisfies Parameters<typeof renderStorageVnextPageArtifact>[0];
    const artifact = renderStorageVnextPageArtifact(input);

    expect(artifact.logicalPath).toBe("pages/guides/setup.md");
    expect(artifact.sourceFilePublicId).toBe("source-setup");
    expect(text(artifact)).toContain("# Setup");
    expect(text(artifact)).toContain("Keep this source body readable.");
    expect(text(artifact)).toContain(
      "[Configuration](/pages/reference/configuration.md) - Configure the installed service."
    );
    expect(text(artifact)).toBe(renderPageFile(input.page, input.sourceBody));
  });

  it("writes content and graph-seed documents through one candidate index identity", async () => {
    const prepareCandidate = vi.fn().mockResolvedValue(undefined);
    const writeDocumentBatch = vi.fn().mockResolvedValue(undefined);
    const publisher = createStorageVnextPublicationPublisher({
      objects: { putVerified: vi.fn() },
      releases: {
        addCandidateCatalogEntries: vi.fn(),
        addCandidateCatalogTombstones: vi.fn(),
        addCandidateShards: vi.fn()
      },
      search: { prepareCandidate, writeDocumentBatch },
      clock: () => "2026-08-01T00:00:00.000Z",
      limits: {
        maximumArtifacts: 8,
        maximumArtifactBytes: 1_024,
        maximumSearchDocuments: 8,
        maximumSearchCompressedBytes: 8_192,
        objectWriteConcurrency: 2
      }
    });
    const content = createStorageVnextContentDocument({
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/a.md",
      fileKind: "page",
      title: "A",
      contentKind: "file",
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: "content"
    });
    const graph = createStorageVnextGraphSeedDocument({
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "pages/a.md",
      title: "A",
      searchText: "relationship",
      rankingTerms: ["guide"]
    });

    await publisher.publish({
      knowledgeBaseId: "kb-a",
      candidatePublicId: "candidate-a",
      operationPublicId: "operation-a",
      schemaChecksum: checksumA,
      settingsChecksum: checksumB,
      searchBatchOrdinal: 0,
      deletedLogicalPaths: [],
      artifacts: [],
      internalShards: [],
      reusedInternalShards: [],
      searchDocuments: [content, graph]
    });

    expect(prepareCandidate).toHaveBeenCalledOnce();
    expect(prepareCandidate).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-a",
      candidatePublicId: "candidate-a",
      schemaChecksum: checksumA,
      settingsChecksum: checksumB
    });
    expect(writeDocumentBatch).toHaveBeenCalledOnce();
    expect(writeDocumentBatch).toHaveBeenCalledWith(expect.objectContaining({
      candidatePublicId: "candidate-a",
      operationPublicId: "operation-a",
      batchOrdinal: 0,
      documents: [content, graph]
    }));
    expect(Object.keys(writeDocumentBatch.mock.calls[0]![0])).not.toEqual(
      expect.arrayContaining(["contentIndexUid", "graphIndexUid"])
    );
  });

  it("matches the released logical manifest and unchanged root renderer exactly", () => {
    expect(STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS).toEqual([
      "index.md",
      "pages/index.md",
      "schema.md",
      "log.md",
      "_index/index.md",
      "_graph/index.md",
      "_index/catalog.json"
    ]);
    const rootInput = {
      knowledgeBase: {
        id: "kb-a",
        name: "Engineering",
        description: "Technical knowledge.",
        sourceFileCount: 2,
        graphEdgeCount: 1
      },
      rootEntryCount: 1,
      generationId: "candidate-a",
      ordinal: 0
    };
    for (const path of [
      "index.md",
      "schema.md",
      "log.md",
      "_index/index.md",
      "_graph/index.md"
    ]) {
      const input = { ...rootInput, path };
      expect(text(renderStorageVnextRootArtifact(input))).toBe(
        renderBoundedRootFile(input).body
      );
    }

    const validation = validateStorageVnextReleasedStructure({
      artifacts: [
        artifact("index.md", "index", 0, "[Browse documents](/pages/index.md)"),
        artifact("pages/index.md", "directory", 1, "[Guide](/pages/guides/index.md)"),
        artifact("schema.md", "schema", 2, "# Schema"),
        artifact("log.md", "log", 3, "# Log"),
        artifact("_index/index.md", "index", 4, "[Catalog](/_index/catalog.json)"),
        artifact("_graph/index.md", "graph", 5, "[Graph](/_index/catalog.json)"),
        artifact("_index/catalog.json", "index", 6, "{}"),
        artifact("pages/guides/index.md", "directory", 7, "[Setup](/pages/guides/setup.md)"),
        artifact("pages/guides/setup.md", "source", 8, "[Configuration](/pages/reference/configuration.md)", "source-setup"),
        artifact("pages/reference/index.md", "directory", 9, "[Configuration](/pages/reference/configuration.md)"),
        artifact("pages/reference/configuration.md", "source", 10, "# Configuration", "source-configuration"),
        artifact("_index/search/v1/0001.json", "index", 11, "{}"),
        artifact("_graph/by-file/source-setup.json", "graph", 12, "{}")
      ],
      expectedSourceMappings: [
        { sourceFilePublicId: "source-setup", logicalPath: "pages/guides/setup.md" },
        { sourceFilePublicId: "source-configuration", logicalPath: "pages/reference/configuration.md" }
      ],
      expectedDirectoryPaths: ["pages", "pages/guides", "pages/reference"]
    });

    expect(validation.logicalPaths).toEqual([
      "index.md",
      "pages/index.md",
      "schema.md",
      "log.md",
      "_index/index.md",
      "_graph/index.md",
      "_index/catalog.json",
      "pages/guides/index.md",
      "pages/guides/setup.md",
      "pages/reference/index.md",
      "pages/reference/configuration.md",
      "_index/search/v1/0001.json",
      "_graph/by-file/source-setup.json"
    ]);
    expect(validation.linkCount).toBe(7);
    expect(validation.sourceMappingCount).toBe(2);
  });

  it("validates an effective candidate through bounded pages without loading a full catalog", async () => {
    const extensionStateShards = STORAGE_VNEXT_EXTENSION_NAVIGATION_DIRECTORIES
      .flatMap((directoryPath) => createStorageVnextExtensionNavigationShards({
        directoryPath,
        leaves: [],
        maximumBytes: 65_536
      }))
      .map((shard, index) => ({
        publicId: shard.publicId,
        logicalKind: shard.logicalKind,
        firstLogicalPath: shard.firstLogicalPath,
        lastLogicalPath: shard.lastLogicalPath,
        recordCount: shard.recordCount,
        byteCount: shard.bytes.byteLength,
        checksum: shard.publicId.slice(-64),
        objectId: `object-extension-state-${index}`,
        ordinal: shard.ordinal,
        bytes: shard.bytes
      }));
    const entries = [
      releaseEntry("index.md", "index", 0),
      releaseEntry("pages/index.md", "directory", 1),
      releaseEntry("schema.md", "schema", 2),
      releaseEntry("log.md", "log", 3),
      releaseEntry("_index/index.md", "index", 4),
      releaseEntry("_graph/index.md", "graph", 5),
      releaseEntry("_index/catalog.json", "index", 6),
      // Candidate-local ordinals restart at zero. The effective release order is
      // canonical across the inherited root chain and must not reject this entry.
      releaseEntry("pages/guides/setup.md", "source", 0, "source-setup", true)
    ];
    const listEffectiveCatalogEntries = vi.fn(async ({ limit, cursor }) => {
      const start = cursor ? Number(cursor) : 0;
      const items = entries.slice(start, start + limit);
      const next = start + items.length < entries.length ? String(start + items.length) : null;
      return { items, nextCursor: next };
    });
    const recordCandidateValidation = vi.fn().mockResolvedValue(true);
    const markCandidateReady = vi.fn().mockResolvedValue(true);
    const countCandidateOwnedObjects = vi.fn().mockResolvedValue(2);
    const verifyObject = vi.fn().mockResolvedValue(true);
    let activeObjectReads = 0;
    let peakObjectReads = 0;
    const navigationBodies = new Map([
      ["object-0", "---\nokf_version: \"0.2\"\n---\n# Knowledge base\n\n[Documents](/pages/index.md) [Indexes](/_index/index.md) [Graph](/_graph/index.md)"],
      ["object-1", "# Documents\n\n[Root](/index.md) [Documents](/pages/index.md) [Indexes](/_index/index.md) [Graph](/_graph/index.md)"],
      ["object-2", [
        "---",
        'type: "Schema Reference"',
        'title: "Metadata and navigation schema"',
        'generated: {"by":"process:focowiki-publication","at":"2026-08-01T00:00:00.000Z"}',
        "---",
        "# Schema"
      ].join("\n")],
      ["object-3", "# Directory Update Log\n\n## 2026-08-01\n\n* **Publication**: Published one file."],
      ["object-4", "# Machine-readable indexes\n\n[Root](/index.md) [Documents](/pages/index.md) [Indexes](/_index/index.md) [Graph](/_graph/index.md)"],
      ["object-5", "# Relationship graph\n\n[Root](/index.md) [Documents](/pages/index.md) [Indexes](/_index/index.md) [Graph](/_graph/index.md)"],
      ["object-6", `${JSON.stringify({
        formatVersion: 1,
        knowledgeBaseId: "kb-a",
        generationId: "candidate-a",
        projections: {
          search: { shards: [] },
          links: { shards: [] },
          manifest: { shards: [] },
          tree: { shards: [] },
          graphNodes: { shards: [] },
          graphEdges: { shards: [] },
          relatedFiles: { pathTemplate: "_graph/by-file/{fileId}.json" }
        }
      })}\n`],
      ...extensionStateShards.map((shard) => [
        shard.objectId,
        Buffer.from(shard.bytes).toString("utf8")
      ] as const)
    ]);
    const readObjectText = vi.fn(async (request: { objectId: string }) => {
      activeObjectReads += 1;
      peakObjectReads = Math.max(peakObjectReads, activeObjectReads);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeObjectReads -= 1;
      return navigationBodies.get(request.objectId) ?? "# Generated file";
    });
    const validator = createStorageVnextPublicationCandidateValidator({
      releases: {
        getLiveCandidate: vi.fn().mockResolvedValue({
          publicId: "candidate-a",
          knowledgeBaseId: "kb-a",
          operationPublicId: "operation-a",
          candidateRootPublicId: "candidate-root-a",
          expectedActiveRootPublicId: "active-root-a",
          expectedActiveRevision: 3,
          state: "building",
          changedFactCount: 1,
          affectedDependencyCount: 1,
          manifestChecksum: null,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z"
        }),
        listCandidateDependencies: vi.fn().mockResolvedValue({
          items: [dependency("link", "edge-a", "graph_edge")],
          nextCursor: null
        }),
        listCandidateShards: vi.fn(async ({ limit, cursor }) => {
          const shards = [{
            publicId: "shard-a",
            logicalKind: "tree",
            firstLogicalPath: "pages/guides/setup.md",
            lastLogicalPath: "pages/guides/setup.md",
            recordCount: 1,
            byteCount: 80,
            checksum: checksumB,
            objectId: "object-shard-a",
            ordinal: 0
          }, ...extensionStateShards.map(({ bytes: _bytes, ...shard }) => shard)];
          const start = cursor ? Number(cursor) : 0;
          const items = shards.slice(start, start + limit);
          return {
            items,
            nextCursor: start + items.length < shards.length
              ? String(start + items.length)
              : null
          };
        }),
        getKnowledgeBaseSummary: vi.fn().mockResolvedValue({
          sourceFileCount: 1,
          directoryCount: 2,
          generatedEntryCount: 8,
          graphNodeCount: 1,
          graphEdgeCount: 1,
          generatedByteCount: 800
        }),
        countCandidateOwnedObjects,
        markCandidateValidating: vi.fn().mockResolvedValue(true),
        recordCandidateValidation,
        markCandidateReady
      },
      effectiveCatalog: {
        listEffectiveCatalogEntries,
        findMissingLogicalPaths: vi.fn().mockResolvedValue([])
      },
      objects: {
        verify: verifyObject,
        readText: readObjectText
      },
      search: {
        getProjection: vi.fn().mockResolvedValue({
          publicId: "search-candidate-a",
          knowledgeBaseId: "kb-a",
          providerKind: "meilisearch",
          providerIndexUid: "run-owned-kb-a-candidate",
          schemaChecksum: checksumA,
          settingsChecksum: checksumB,
          documentChecksum: checksumA,
          state: "ready",
          documentCount: 2,
          nextBatchOrdinal: 1,
          lastBatchOrdinal: 0,
          lastBatchChecksum: checksumA,
          correlationPublicId: null,
          providerOperationRef: null,
          revision: 2
        })
      },
      clock: () => "2026-08-01T00:05:00.000Z",
      limits: {
        maximumPageSize: 3,
        maximumMarkdownBytes: 65_536,
        objectReadConcurrency: 3
      }
    });

    const result = await validator.validate({
      knowledgeBaseId: "kb-a",
      candidatePublicId: "candidate-a",
      searchProjectionPublicId: "search-candidate-a"
    });

    expect(listEffectiveCatalogEntries).toHaveBeenCalledTimes(3);
    expect(listEffectiveCatalogEntries.mock.calls.every((call) => call[0].limit === 3)).toBe(true);
    expect(recordCandidateValidation).toHaveBeenCalledWith(expect.objectContaining({
      candidatePublicId: "candidate-a",
      searchProjectionPublicId: "search-candidate-a",
      objectOwnerCount: 2,
      searchDocumentCount: 2,
      generatedEntryCount: 8,
      linkCount: 1,
      objectValidationPassed: true,
      pathValidationPassed: true
    }));
    expect(markCandidateReady).toHaveBeenCalledWith({
      candidatePublicId: "candidate-a",
      manifestChecksum: result.manifestChecksum
    });
    expect(countCandidateOwnedObjects).toHaveBeenCalledWith("candidate-a");
    expect(readObjectText).toHaveBeenCalledTimes(14);
    expect(readObjectText.mock.calls.filter(([request]) =>
      request.objectId === "object-0"
    )).toHaveLength(1);
    expect(verifyObject).toHaveBeenCalledWith(expect.objectContaining({
      logicalPath: "pages/guides/setup.md",
      kind: "source"
    }));
    expect(verifyObject).toHaveBeenCalledTimes(9);
    expect(peakObjectReads).toBe(3);
  });

  it("requires exact typed projection catalog parity and the bounded by-file template", () => {
    const catalog = {
      formatVersion: 1,
      knowledgeBaseId: "kb-a",
      generationId: "candidate-a",
      projections: {
        search: { shards: [{ path: "_index/search/v1/0001.json", recordCount: 2 }] },
        links: { shards: [] },
        manifest: { shards: [] },
        tree: { shards: [] },
        graphNodes: { shards: [] },
        graphEdges: { shards: [] },
        relatedFiles: { pathTemplate: "_graph/by-file/{fileId}.json" }
      }
    };
    const input = {
      body: `${JSON.stringify(catalog)}\n`,
      knowledgeBaseId: "kb-a",
      generationId: "candidate-a",
      extensionResources: new Set([
        "_index/search/v1/0001.json",
        "_graph/by-file/source-a.json"
      ])
    };
    expect(() => validateStorageVnextProjectionCatalogParity(input)).not.toThrow();
    expect(() => validateStorageVnextProjectionCatalogParity({
      ...input,
      body: JSON.stringify({
        ...catalog,
        projections: {
          ...catalog.projections,
          search: { shards: [] }
        }
      })
    })).toThrow(/parity/iu);
    expect(() => validateStorageVnextProjectionCatalogParity({
      ...input,
      body: JSON.stringify({
        ...catalog,
        projections: {
          ...catalog.projections,
          relatedFiles: { pathTemplate: "_graph/by-file/{objectKey}.json" }
        }
      })
    })).toThrow(/template/iu);
  });

  it("resolves generated-object validation through verified registrations and bytes", async () => {
    const bytes = Buffer.from("# Verified\n", "utf8");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const descriptor = {
      objectId: `generated-sha256:okf-generated-markdown-v1:${checksum}`,
      storageKey: `run-owned/generated/${checksum}.md`,
      checksum,
      byteCount: bytes.byteLength,
      contentType: "text/markdown; charset=utf-8",
      objectFormat: "okf-generated-markdown-v1" as const
    };
    const verify = vi.fn().mockResolvedValue(undefined);
    const readVerified = vi.fn().mockResolvedValue(bytes);
    const validator = createStorageVnextPublicationObjectValidator({
      registrations: {
        getRegistration: vi.fn().mockResolvedValue({
          ...descriptor,
          format: descriptor.objectFormat,
          state: "verified",
          writeAttemptPublicId: "attempt-a",
          verifiedAt: "2026-08-01T00:00:00.000Z",
          zeroOwnerSince: null,
          createdAt: "2026-08-01T00:00:00.000Z"
        })
      },
      bodyStore: { verify, readVerified }
    });

    await expect(validator.verify(descriptor)).resolves.toBe(true);
    await expect(validator.readText({
      ...descriptor,
      maximumBytes: 1_024
    })).resolves.toBe("# Verified\n");
    expect(verify).toHaveBeenCalledWith({ descriptor });
    expect(readVerified).toHaveBeenCalledWith({ descriptor, maximumBytes: 1_024 });
  });

  it("reads verified generated JSON for catalog and navigation validation", async () => {
    const bytes = Buffer.from('{"version":1}\n', "utf8");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const descriptor = {
      objectId: `generated-sha256:okf-generated-json-v1:${checksum}`,
      storageKey: `run-owned/generated/${checksum}.json`,
      checksum,
      byteCount: bytes.byteLength,
      contentType: "application/json; charset=utf-8",
      objectFormat: "okf-generated-json-v1" as const
    };
    const validator = createStorageVnextPublicationObjectValidator({
      registrations: {
        getRegistration: vi.fn().mockResolvedValue({
          ...descriptor,
          format: descriptor.objectFormat,
          state: "verified",
          writeAttemptPublicId: "attempt-json",
          verifiedAt: "2026-08-01T00:00:00.000Z",
          zeroOwnerSince: null,
          createdAt: "2026-08-01T00:00:00.000Z"
        })
      },
      bodyStore: {
        verify: vi.fn().mockResolvedValue(undefined),
        readVerified: vi.fn().mockResolvedValue(bytes)
      }
    });

    await expect(validator.readText({
      ...descriptor,
      maximumBytes: 1_024
    })).resolves.toBe('{"version":1}\n');
  });
});

function dependency(
  kind: "ancestor" | "graph" | "index" | "link" | "log" | "path" | "schema" | "search",
  publicId: string,
  reasonCode: string
) {
  return { kind, publicId, reasonCode } as const;
}

function artifact(
  logicalPath: string,
  kind: StorageVnextPublicationArtifact["kind"],
  ordinal: number,
  body: string,
  sourceFilePublicId: string | null = null
): StorageVnextPublicationArtifact {
  return {
    logicalPath,
    kind,
    sourceFilePublicId,
    ordinal,
    bytes: Buffer.from(body, "utf8")
  };
}

function text(artifact: StorageVnextPublicationArtifact): string {
  return Buffer.from(artifact.bytes).toString("utf8");
}

function objectResult(
  objectId: string,
  checksum: string,
  byteCount: number,
  outcome: "stored" | "reused"
) {
  return {
    objectId,
    storageKey: `run-owned/generated/${objectId}`,
    checksum,
    byteCount,
    contentType: objectId.includes("page")
      ? "text/markdown; charset=utf-8"
      : "application/json; charset=utf-8",
    objectFormat: objectId.includes("page")
      ? "okf-generated-markdown-v1" as const
      : "okf-generated-json-v1" as const,
    outcome
  };
}

function releaseEntry(
  logicalPath: string,
  kind: StorageVnextPublicationArtifact["kind"],
  ordinal: number,
  sourceFilePublicId: string | null = null,
  candidateOwned = false
) {
  return {
    logicalPath,
    kind,
    sourceFilePublicId,
    checksum: checksumA,
    objectId: `object-${ordinal}`,
    byteCount: 100,
    ordinal,
    candidateOwned
  };
}
