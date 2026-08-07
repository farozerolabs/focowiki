import { describe, expect, it, vi } from "vitest";
import type { PersistentDirectoryLeaf } from
  "../src/application/ports/directory-navigation-repository.js";
import { renderBoundedRootFile } from
  "../src/publication/bounded-root-writer.js";
import { renderDirectoryRootMarkdown } from
  "../src/publication/directory-navigation-writer.js";
import { renderProjectionCatalog } from
  "../src/publication/projection-catalog-writer.js";
import type { StorageVnextCurrentSourceFact } from
  "../src/storage-vnext/catalog/ports.js";
import type { StorageVnextGraphNodeFact } from
  "../src/storage-vnext/graph/ports.js";
import {
  createStorageVnextPublicationArtifactAssembler
} from "../src/storage-vnext/publication/artifact-assembler.js";
import type { StorageVnextPublicationArtifact } from
  "../src/storage-vnext/publication/types.js";

const checksumA = "a".repeat(64);
const checksumB = "b".repeat(64);

describe("storage vNext publication artifact assembler", () => {
  it("publishes only the candidate dependency closure through released renderers", async () => {
    const current = currentSource();
    const node = graphNode(current);
    const leaves: PersistentDirectoryLeaf[] = [{
      id: "000001",
      previousLeafId: null,
      nextLeafId: null,
      revision: 1,
      entries: [{
        id: current.sourceFile.publicId,
        sortKey: "setup.md/source-setup",
        name: "Setup",
        targetPath: "pages/guides/setup.md",
        kind: "file"
      }]
    }];
    const rootLeaves: PersistentDirectoryLeaf[] = [{
      id: "000001",
      previousLeafId: null,
      nextLeafId: null,
      revision: 1,
      entries: [{
        id: "directory-guides",
        sortKey: "guides/directory-guides",
        name: "guides",
        targetPath: "pages/guides/index.md",
        kind: "directory"
      }]
    }];
    const dependencies = [
      { kind: "ancestor" as const, publicId: "pages", reasonCode: "directory_ancestor" },
      { kind: "ancestor" as const, publicId: "pages/guides", reasonCode: "directory_ancestor" },
      { kind: "ancestor" as const, publicId: "pages/removed", reasonCode: "directory_ancestor" },
      { kind: "index" as const, publicId: "_graph/index.md", reasonCode: "required_navigation" },
      { kind: "index" as const, publicId: "_index/catalog.json", reasonCode: "required_navigation" },
      { kind: "index" as const, publicId: "_index/index.md", reasonCode: "required_navigation" },
      { kind: "index" as const, publicId: "index.md", reasonCode: "required_navigation" },
      { kind: "index" as const, publicId: "pages/index.md", reasonCode: "required_navigation" },
      { kind: "log" as const, publicId: "log.md", reasonCode: "bounded_update_log" },
      { kind: "path" as const, publicId: "pages/guides/setup.md", reasonCode: "source_path" },
      { kind: "path" as const, publicId: "pages/old.md", reasonCode: "source_path" },
      { kind: "schema" as const, publicId: "schema.md", reasonCode: "required_schema" },
      { kind: "search" as const, publicId: "source-setup", reasonCode: "search_document" }
    ];
    const listCandidateDependencies = vi.fn(async (input: { cursor: string | null }) =>
      input.cursor === null
        ? { items: dependencies.slice(0, 7), nextCursor: "next" }
        : { items: dependencies.slice(7), nextCursor: null });
    const publish = vi.fn(async (request: { artifacts: readonly unknown[] }) => ({
      artifactCount: request.artifacts.length
    }));
    const replaceCandidateSummaries = vi.fn(async () => undefined);
    const load = vi.fn(async () => ({
      knowledgeBase: {
        id: "kb-one",
        name: "Engineering",
        description: "Technical knowledge.",
        sourceFileCount: 1,
        graphEdgeCount: 0
      },
      rootEntryCount: 1,
      directories: [
        {
          directoryPublicId: null,
          directoryPath: "pages",
          entryCount: 1,
          descendantFileCount: 1,
          leaves: rootLeaves
        },
        {
          directoryPublicId: "directory-guides",
          directoryPath: "pages/guides",
          entryCount: 1,
          descendantFileCount: 1,
          leaves
        }
      ],
      projectionShards: [{
        projectionKind: "search",
        shardKey: "search/v1/0001",
        logicalPath: "_index/search/v1/0001.json",
        recordCount: 1
      }],
      extensionNavigation: {
        byFileLogicalPaths: [],
        existingMarkdownPaths: [],
        previousLeaves: new Map(),
        sources: projectionBatches([]),
        affectedDirectoryPaths: ["_index/search/v1", "_graph/by-file"],
        previousPresentDirectoryPaths: [],
        completeProfile: false,
        maxEntries: 200,
        maxLeafBytes: 65_536,
        maxShardBytes: 1_048_576
      },
      internalShards: [],
      reusedInternalShards: [],
      batches: projectionBatches([{
        pages: [{
          current,
          node,
          neighborhood: [],
          endpointNodes: [node],
          sourceBody: "# Setup\n\nKeep the released source body."
        }],
        machineArtifacts: [{
          logicalPath: "_graph/by-file/source-setup.json",
          kind: "graph" as const,
          sourceFilePublicId: null,
          ordinal: 0,
          bytes: Buffer.from("{}\n", "utf8")
        }],
        projectionShards: [],
        deletedLogicalPaths: ["pages/old.md"]
      }])
    }));
    const summarizeCandidate = vi.fn(async () => ({
      sourceFileCount: 1,
      directoryCount: 2,
      generatedEntryCount: 11,
      graphNodeCount: 1,
      graphEdgeCount: 0,
      generatedByteCount: 1_024
    }));
    const assembler = createStorageVnextPublicationArtifactAssembler({
      releases: {
        getLiveCandidate: vi.fn(async () => ({
          publicId: "candidate-one",
          candidateRootPublicId: "root-candidate-one"
        } as never)),
        listCandidateDependencies,
        listDirectorySummaries: vi.fn(async () => ({ items: [], nextCursor: null })),
        replaceCandidateSummaries
      },
      projection: { load, summarizeCandidate },
      publisher: { publish },
      schemaChecksum: checksumA,
      settingsChecksum: checksumB,
      limits: {
        dependencyPageSize: 7,
        maximumDependencies: 64,
        relatedFileLimit: 100
      }
    });
    const signal = new AbortController().signal;

    await expect(assembler.publish({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      operationPublicId: "operation-one",
      searchProjectionPublicId: "candidate-one",
      signal
    })).resolves.toEqual({ artifactCount: 17 });

    expect(listCandidateDependencies).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      plan: expect.objectContaining({
        sourcePaths: ["pages/guides/setup.md", "pages/old.md"],
        directoryPaths: ["pages", "pages/guides", "pages/removed"],
        searchSourceFilePublicIds: ["source-setup"]
      })
    }));
    const requests = publish.mock.calls.map((call) => call[0]) as Array<{
      deletedLogicalPaths: readonly string[];
      searchDocuments: readonly unknown[];
      artifacts: readonly StorageVnextPublicationArtifact[];
    }>;
    expect(requests.flatMap((request) => request.deletedLogicalPaths))
      .toEqual(["pages/old.md"]);
    expect(requests.every((request) => request.searchDocuments.length === 0)).toBe(true);
    const artifacts = requests.flatMap((request) => request.artifacts);
    expect(artifacts.map((artifact: { logicalPath: string }) => artifact.logicalPath))
      .toEqual([
        "index.md",
        "pages/index.md",
        "schema.md",
        "log.md",
        "pages/index-000001.md",
        "pages/guides/index.md",
        "pages/guides/index-000001.md",
        "_graph/by-file/source-setup.json",
        "pages/guides/setup.md",
        "_index/index.md",
        "_graph/index.md",
        "_graph/by-file/index.md",
        expect.stringMatching(
          /^_graph\/by-file\/index-extension-leaf-[a-f0-9-]+\.md$/u
        ),
        "_index/search/index.md",
        "_index/search/v1/index.md",
        expect.stringMatching(
          /^_index\/search\/v1\/index-extension-leaf-[a-f0-9-]+\.md$/u
        ),
        "_index/catalog.json"
      ]);
    expect(text(artifacts[0]!)).toBe(renderBoundedRootFile({
      path: "index.md",
      knowledgeBase: {
        id: "kb-one",
        name: "Engineering",
        description: "Technical knowledge.",
        sourceFileCount: 1,
        graphEdgeCount: 0
      },
      rootEntryCount: 1,
      generationId: "candidate-one"
    }).body);
    expect(text(artifacts[1]!)).toBe(renderDirectoryRootMarkdown({
      directoryPath: "pages",
      entryCount: 1,
      firstLeafId: "000001"
    }));
    expect(text(artifacts.find((artifact) =>
      artifact.logicalPath === "_index/catalog.json")!)).toBe(renderProjectionCatalog({
      knowledgeBaseId: "kb-one",
      generationId: "candidate-one",
      shards: [{
        projectionKind: "search",
        shardKey: "search/v1/0001",
        logicalPath: "_index/search/v1/0001.json",
        recordCount: 1
      }]
    }));
    expect(text(artifacts.find((artifact) =>
      artifact.logicalPath === "pages/guides/setup.md")!))
      .toContain("Keep the released source body.");
    expect(text(artifacts.find((artifact) =>
      artifact.logicalPath.startsWith("_graph/by-file/index-extension-leaf-"))!))
      .toContain("[Source](/pages/guides/setup.md)");
    expect(summarizeCandidate).toHaveBeenCalledAfter(publish);
    expect(replaceCandidateSummaries).toHaveBeenCalledWith({
      candidatePublicId: "candidate-one",
      directories: [
        {
          directoryPublicId: null,
          logicalPath: "_graph",
          firstLeafPath: null,
          directFileCount: 1,
          descendantFileCount: 4,
          ordinal: 0
        },
        {
          directoryPublicId: null,
          logicalPath: "_graph/by-file",
          firstLeafPath: expect.stringMatching(
            /^_graph\/by-file\/index-extension-leaf-[a-f0-9-]+\.md$/u
          ),
          directFileCount: 3,
          descendantFileCount: 3,
          ordinal: 1
        },
        {
          directoryPublicId: null,
          logicalPath: "_index",
          firstLeafPath: null,
          directFileCount: 2,
          descendantFileCount: 6,
          ordinal: 2
        },
        {
          directoryPublicId: null,
          logicalPath: "_index/search",
          firstLeafPath: null,
          directFileCount: 1,
          descendantFileCount: 4,
          ordinal: 3
        },
        {
          directoryPublicId: null,
          logicalPath: "_index/search/v1",
          firstLeafPath: expect.stringMatching(
            /^_index\/search\/v1\/index-extension-leaf-[a-f0-9-]+\.md$/u
          ),
          directFileCount: 3,
          descendantFileCount: 3,
          ordinal: 4
        },
        {
          directoryPublicId: null,
          logicalPath: "pages",
          firstLeafPath: "pages/index-000001.md",
          directFileCount: 0,
          descendantFileCount: 1,
          ordinal: 5
        },
        {
          directoryPublicId: "directory-guides",
          logicalPath: "pages/guides",
          firstLeafPath: "pages/guides/index-000001.md",
          directFileCount: 1,
          descendantFileCount: 1,
          ordinal: 6
        }
      ],
      knowledgeBase: {
        sourceFileCount: 1,
        directoryCount: 2,
        generatedEntryCount: 11,
        graphNodeCount: 1,
        graphEdgeCount: 0,
        generatedByteCount: 1_024
      }
    });
  });

  it("rejects a projection that changes the required root set", async () => {
    const assembler = createStorageVnextPublicationArtifactAssembler({
      releases: {
        getLiveCandidate: vi.fn(),
        listCandidateDependencies: vi.fn(async () => ({
          items: [{ kind: "index" as const, publicId: "index.md", reasonCode: "required_navigation" }],
          nextCursor: null
        })),
        listDirectorySummaries: vi.fn(),
        replaceCandidateSummaries: vi.fn()
      },
      projection: {
        load: vi.fn(async () => ({
          knowledgeBase: {
            id: "kb-one",
            name: "Engineering",
            description: null,
            sourceFileCount: 0,
            graphEdgeCount: 0
          },
          rootEntryCount: 0,
          directories: [],
          projectionShards: [],
          internalShards: [],
          reusedInternalShards: [],
          batches: projectionBatches([])
        })),
        summarizeCandidate: vi.fn()
      },
      publisher: { publish: vi.fn() },
      schemaChecksum: checksumA,
      settingsChecksum: checksumB,
      limits: { dependencyPageSize: 10, maximumDependencies: 10, relatedFileLimit: 100 }
    });

    await expect(assembler.publish({
      knowledgeBaseId: "kb-one",
      candidatePublicId: "candidate-one",
      operationPublicId: "operation-one",
      searchProjectionPublicId: "candidate-one",
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "required_navigation_conflict" });
  });
});

async function* projectionBatches<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

function currentSource(): StorageVnextCurrentSourceFact {
  return {
    sourceFile: {
      publicId: "source-setup",
      knowledgeBaseId: "kb-one",
      directoryPublicId: "directory-guides",
      logicalPath: "guides/setup.md",
      normalizedPath: "guides/setup.md",
      title: "Setup",
      metadata: { type: "Guide", title: "Setup" },
      currentRevisionPublicId: "revision-setup",
      status: "ready",
      safeErrorCode: null,
      safeErrorMessage: null,
      revision: 1,
      visibility: "current"
    },
    sourceRevision: {
      publicId: "revision-setup",
      sourceFilePublicId: "source-setup",
      knowledgeBaseId: "kb-one",
      objectId: "source-object",
      checksum: checksumA,
      byteCount: 42,
      contentType: "text/markdown; charset=utf-8",
      createdAt: "2026-08-01T00:00:00.000Z"
    }
  };
}

function graphNode(current: StorageVnextCurrentSourceFact): StorageVnextGraphNodeFact {
  return {
    publicId: "node-setup",
    knowledgeBaseId: current.sourceFile.knowledgeBaseId,
    sourceFilePublicId: current.sourceFile.publicId,
    sourceRevisionPublicId: current.sourceRevision.publicId,
    logicalPath: "pages/guides/setup.md",
    label: "Setup",
    kind: "Guide",
    metadata: {},
    evidence: [],
    revision: 1
  };
}

function text(artifact: { bytes: Uint8Array }): string {
  return Buffer.from(artifact.bytes).toString("utf8");
}
