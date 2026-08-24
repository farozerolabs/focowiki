import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  documentRelatedProjectionRecord,
  documentRelationProjectionRecord
} from
  "../src/document-indexing/application/document-machine-record.js";
import { buildDocumentNavigationTermBucketResources } from
  "../src/document-indexing/application/document-page-term-projection.js";
import { parseDocumentPortableRecords } from
  "../src/document-indexing/application/document-portable-record-parser.js";
import { documentDirectoryEntryId } from
  "../src/document-indexing/domain/document-directory-entry-identity.js";
import { createProductionDocumentScopeRenderer } from
  "../src/document-indexing/infrastructure/production-document-scope-renderer.js";
import { projectTermCatalog } from
  "../src/document-indexing/infrastructure/production-document-scope-renderer-helpers.js";
import { projectGraphCatalog, projectGraphDirectory,
  projectPerFileGraphDirectory } from
  "../src/document-indexing/infrastructure/production-document-scope-graph.js";
import { projectRoot, projectSemanticDirectory } from
  "../src/document-indexing/infrastructure/production-document-scope-navigation.js";

describe("production document scope renderer", () => {
  it("treats included pure-create revisions as a semantic directory delta",
    async () => {
      const readSemanticDirectoryState = vi.fn(async () => {
        throw new Error("Pure create must not read complete directory state");
      });
      const readSemanticDirectoryDeltaState = vi.fn(async () => ({
        records: [], childDirectories: [], navigationCandidateEntryIds: []
      }));
      const resolveSourceFilePublicIdsForRevisions = vi.fn(async () =>
        ["source-new"]);

      await projectSemanticDirectory({
        dependencies: {
          machineProjection: {
            readSemanticDirectoryState,
            readSemanticDirectoryDeltaState,
            resolveSourceFilePublicIdsForRevisions
          } as never
        },
        knowledgeBaseId: "kb-baseline",
        scopePath: "pages",
        includedSourceRevisionPublicIds: ["revision-new"],
        excludedActiveSourceFilePublicIds: []
      });

      expect(readSemanticDirectoryDeltaState).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-baseline",
        scopePath: "pages",
        affectedSourceFilePublicIds: ["source-new"],
        includedSourceRevisionPublicIds: ["revision-new"],
        navigationSourceFilePublicIds: ["source-new"]
      });
      expect(readSemanticDirectoryState).not.toHaveBeenCalled();
    });

  it("does not treat relation-only closure members as navigation removals",
    async () => {
      const readSemanticDirectoryDeltaState = vi.fn(async () => ({
        records: [], childDirectories: [], navigationCandidateEntryIds: []
      }));

      await projectSemanticDirectory({
        dependencies: {
          machineProjection: {
            readSemanticDirectoryDeltaState
          } as never
        },
        knowledgeBaseId: "kb-delta-navigation",
        scopePath: "pages",
        includedSourceRevisionPublicIds: ["revision-new"],
        excludedActiveSourceFilePublicIds: ["source-new"],
        affectedSourceFilePublicIds: ["source-existing", "source-new"],
        planningMode: "delta"
      });

      expect(readSemanticDirectoryDeltaState).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-delta-navigation",
        scopePath: "pages",
        affectedSourceFilePublicIds: ["source-existing", "source-new"],
        includedSourceRevisionPublicIds: ["revision-new"],
        navigationSourceFilePublicIds: ["source-new"]
      });
    });

  it("projects an ordinary graph directory from bounded relationship deltas",
    async () => {
      const scanGraphDirectoryState = vi.fn(async () => {
        throw new Error("Ordinary graph projection must not scan full state");
      });
      const scanGraphDirectoryDeltaState = vi.fn(async () => ({
        recordCount: 0,
        childDirectories: [],
        resourcePaths: []
      }));

      await projectGraphDirectory({
        dependencies: {
          machineProjection: {
            scanGraphDirectoryState,
            scanGraphDirectoryDeltaState,
            resolveSourceFilePublicIdsForRevisions: vi.fn(async () =>
              ["source-new"])
          } as never,
          maximumRecordsPerShard: 100,
          maximumShardBytes: 1_048_576
        },
        knowledgeBaseId: "kb-baseline",
        scopePath: "pages",
        includedSourceRevisionPublicIds: ["revision-new"],
        excludedActiveSourceFilePublicIds: ["source-new"]
      });

      expect(scanGraphDirectoryDeltaState).toHaveBeenCalledWith(
        expect.objectContaining({
          knowledgeBaseId: "kb-baseline",
          scopePath: "pages",
          affectedSourceFilePublicIds: ["source-new"],
          includedSourceRevisionPublicIds: ["revision-new"]
        })
      );
      expect(scanGraphDirectoryState).not.toHaveBeenCalled();
    });

  it("assigns the relationship catalog only to its graph scope", async () => {
    const root = await projectRoot({
      dependencies: {
        machineProjection: {
          async readRootProjectionState() {
            return {
              knowledgeBase: { id: "kb-1", name: "Portable", description: null },
              sourceFileCount: 1,
              graphEdgeCount: 0,
              rootEntryCount: 1,
              currentLogEntries: [],
              previousLogEntries: []
            };
          }
        } as never,
        rootLimits: {
          rootSummaryLimit: 500,
          okfLogMaxEntries: 100,
          okfLogMaxBytes: 65_536
        }
      },
      knowledgeBaseId: "kb-1",
      includedSourceRevisionPublicIds: [],
      excludedActiveSourceFilePublicIds: [],
      changedAt: "2026-08-21T09:00:00.000Z"
    });
    const graph = await projectGraphCatalog({
      dependencies: {
        machineProjection: {
          async readGraphCatalogState() {
            return { relationshipCount: 3 };
          }
        } as never,
        maximumRecordsPerShard: 1_000,
        maximumShardBytes: 1_000_000
      },
      knowledgeBaseId: "kb-1",
      includedSourceRevisionPublicIds: ["revision-a", "revision-b"],
      excludedActiveSourceFilePublicIds: []
    });

    expect(root.pages.map((page) => page.logicalPath))
      .not.toContain("_graph/catalog.json");
    const graphCatalog = graph.pages.find((page) =>
      page.logicalPath === "_graph/catalog.json");
    expect(JSON.parse(new TextDecoder().decode(graphCatalog?.bytes)))
      .toMatchObject({ relationshipCount: 3 });
  });

  it("materializes a source page through its exact dirty scope", async () => {
    const body = new TextEncoder().encode("# Updated source\n\nRelated content.");
    const checksum = createHash("sha256").update(body).digest("hex");
    const project = vi.fn(async () => ({
      pages: [{
        logicalPath: "pages/guides/updated-source.md",
        normalizedPath: "pages/guides/updated-source.md",
        entryKind: "source",
        sourceFilePublicId: "source-a",
        sourceRevisionPublicId: "revision-a",
        bytes: body,
        checksumSha256: checksum,
        byteCount: body.byteLength
      }],
      removedLogicalPaths: [],
      factCount: 2
    }));
    const putVerified = vi.fn(async (input: { bytes: Uint8Array }) => ({
      objectId: "object-source-a",
      storageKey: "generated/object-source-a",
      checksum: createHash("sha256").update(input.bytes).digest("hex"),
      byteCount: input.bytes.byteLength,
      contentType: "text/markdown; charset=utf-8",
      objectFormat: "okf-generated-markdown-v1" as const,
      outcome: "stored" as const,
      requests: { put: 1, head: 0, verification: 0,
        attemptedBytes: input.bytes.byteLength, retries: 0,
        latencyMilliseconds: 2 }
    }));
    const renderer = createProductionDocumentScopeRenderer({
      machineProjection: {} as never,
      sourceProjection: { project },
      objectWriter: { putVerified },
      maximumRecordsPerShard: 100,
      maximumShardBytes: 1_048_576
    });

    const result = await renderer.render({
      publicId: "scope-source-a",
      knowledgeBaseId: "kb-1",
      kind: "source",
      key: "source-a",
      requiredSequence: 8,
      renderedSequence: 8
    }, new AbortController().signal, {
      contributors: [{
        sourceFilePublicId: "source-b",
        sourceRevisionPublicId: "revision-b",
        requiredSequence: 7
      }, {
        sourceFilePublicId: "source-a",
        sourceRevisionPublicId: "revision-a",
        requiredSequence: 8
      }]
    });

    expect(project).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-1",
      sourceFilePublicId: "source-a",
      includedSourceRevisionPublicIds: ["revision-a", "revision-b"],
      excludedActiveSourceFilePublicIds: ["source-a", "source-b"],
      signal: expect.any(AbortSignal)
    });
    expect(result.pages).toEqual([expect.objectContaining({
      logicalPath: "pages/guides/updated-source.md",
      sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a"
    })]);
    expect(result.factCount).toBe(2);
    expect(putVerified).toHaveBeenCalledTimes(1);
  });

  it("renders a source tombstone from its frozen base without reading source bytes",
    async () => {
      const project = vi.fn(async () => {
        throw new Error("tombstone_source_should_not_render");
      });
      const putVerified = vi.fn();
      const renderer = createProductionDocumentScopeRenderer({
        machineProjection: {
          readGeneratedPageChecksums: vi.fn(async () => [])
        } as never,
        sourceProjection: { project },
        objectWriter: { putVerified } as never,
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576
      });

      const result = await renderer.renderPublication({
        publicId: "scope-source-deleted",
        publicationGenerationPublicId: "generation-delete",
        knowledgeBaseId: "kb-1",
        scopeIdentity: "source:source-deleted",
        scopeKind: "source",
        scopeKey: "source-deleted",
        scopeGeneration: 2,
        targetFactEpoch: 9,
        inputSnapshotFingerprintSha256: "a".repeat(64),
        rendererContractVersion: "portable-okf-v2",
        planningMode: "delta",
        affectedSourceFilePublicIds: ["source-deleted"],
        deterministicChangedAt: "2026-08-21T12:00:00.000Z",
        baseGenerationPublicId: "generation-active",
        members: [{
          kind: "tombstone",
          publicId: "source-deleted",
          version: "9",
          order: 0,
          sourceFilePublicId: "source-deleted"
        }],
        basePages: [{
          normalizedPath: "pages/deleted.md",
          action: "put",
          entryKind: "source",
          objectId: "object-deleted",
          checksumSha256: "b".repeat(64),
          byteCount: 128
        }]
      }, new AbortController().signal);

      expect(project).not.toHaveBeenCalled();
      expect(putVerified).not.toHaveBeenCalled();
      expect(result.pages).toEqual([{
        logicalPath: "pages/deleted.md",
        normalizedPath: "pages/deleted.md",
        action: "delete",
        entryKind: null,
        objectId: null,
        checksumSha256: null,
        byteCount: null
      }]);
    });

  it("renders one finite term bucket directly from PostgreSQL facts", async () => {
    const putVerified = vi.fn(async (input: { bytes: Uint8Array }) => ({
      objectId: "object-han-part",
      storageKey: "generated/object-han-part",
      checksum: createHash("sha256").update(input.bytes).digest("hex"),
      byteCount: input.bytes.byteLength,
      contentType: "application/json; charset=utf-8",
      objectFormat: "okf-generated-json-v1" as const,
      outcome: "stored" as const,
      requests: {
        put: 1, head: 0, verification: 0,
        attemptedBytes: input.bytes.byteLength,
        retries: 0, latencyMilliseconds: 4
      }
    }));
    const renderer = createProductionDocumentScopeRenderer({
      machineProjection: {
        async listNavigationTermRecords(request: {
          includedSourceRevisionPublicIds: readonly string[];
          excludedActiveSourceFilePublicIds: readonly string[];
        }) {
          expect(request.includedSourceRevisionPublicIds).toEqual([
            "revision-new"
          ]);
          expect(request.excludedActiveSourceFilePublicIds).toEqual([
            "source-new"
          ]);
          return [{ term: "知识库", postings: [{
            path: "pages/guides/overview.md", fields: ["title"]
          }] }];
        },
        async listTermPartPaths() {
          return [
            "_index/terms/han/han-terms-part-0001.json",
            "_index/terms/han/han-terms-part-0002.json"
          ];
        }
      } as never,
      directoryNavigation: {
        async read() { return []; }
      } as never,
      directoryLeafLimits: {
        maxEntries: 200,
        maxBytes: 65_536,
        mergeBelowEntries: 50
      },
      objectWriter: { putVerified },
      ownership: {
        releaseVerifiedReservation: vi.fn()
      } as never,
      maximumRecordsPerShard: 100,
      maximumShardBytes: 1_048_576,
      now: () => "2026-08-17T12:00:00.000Z"
    });
    const result = await renderer.render({
      publicId: "scope-han",
      knowledgeBaseId: "kb-1",
      kind: "_index",
      key: "term:han",
      requiredSequence: 3,
      renderedSequence: 3
    }, new AbortController().signal, {
      contributors: [{
        sourceFilePublicId: "source-new",
        sourceRevisionPublicId: "revision-new",
        requiredSequence: 3
      }]
    });

    expect(result.pages.map((page) => page.logicalPath)).toEqual([
      "_index/terms/han/han-terms-part-0001.json",
      "_index/terms/han/index.json",
      "_index/terms/han/index.md",
      expect.stringMatching(
        /^_index\/terms\/han\/index-extension-leaf-[0-9a-f-]+\.md$/u
      )
    ]);
    expect(result.removedNormalizedPaths).toEqual([
      "_index/terms/han/han-terms-part-0002.json"
    ]);
    expect(result.navigationMutations).toHaveLength(1);
    expect(result.navigationMutations[0]?.directoryPath).toBe(
      "_index/terms/han"
    );
    expect(result.storageRequests).toEqual(expect.objectContaining({
      put: 4,
      head: 0,
      verification: 0,
      retries: 0,
      latencyMilliseconds: 16
    }));
    expect(result.outputFingerprintSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.verifiedReservations).toHaveLength(4);
    expect(putVerified).toHaveBeenCalledWith(expect.objectContaining({
      retainVerifiedReservation: true
    }));
    expect(putVerified).toHaveBeenCalledTimes(4);
  });

  it("writes only changed immutable objects for a large shared scope", async () => {
    const records = Array.from({ length: 40 }, (_, index) => ({
      term: `term-${String(index).padStart(3, "0")}`,
      postings: [{ path: `pages/document-${index}.md`, fields: ["title"] }]
    }));
    const expected = buildDocumentNavigationTermBucketResources({
      bucket: "latin",
      records,
      previousPaths: [],
      maximumRecordsPerShard: 1,
      maximumShardBytes: 1_024
    }).pages;
    expect(expected.length).toBeGreaterThan(32);
    const putVerified = vi.fn(async (input: { bytes: Uint8Array }) => ({
      objectId: "object-changed-term-part",
      storageKey: "generated/object-changed-term-part",
      checksum: createHash("sha256").update(input.bytes).digest("hex"),
      byteCount: input.bytes.byteLength,
      contentType: "application/json; charset=utf-8",
      objectFormat: "okf-generated-json-v1" as const,
      outcome: "stored" as const,
      requests: { put: 1, head: 0, verification: 0,
        attemptedBytes: input.bytes.byteLength, retries: 0,
        latencyMilliseconds: 1 }
    }));
    const renderer = createProductionDocumentScopeRenderer({
      machineProjection: {
        async listNavigationTermRecords() { return records; },
        async listTermPartPaths() { return []; },
        async readGeneratedPageChecksums() {
          return expected.slice(1).map((page) => ({
            logicalPath: page.logicalPath,
            checksumSha256: page.checksumSha256
          }));
        }
      } as never,
      directoryNavigation: {
        async read() { return []; }
      } as never,
      directoryLeafLimits: {
        maxEntries: 200,
        maxBytes: 65_536,
        mergeBelowEntries: 50
      },
      objectWriter: { putVerified },
      maximumRecordsPerShard: 1,
      maximumShardBytes: 1_024
    });

    const result = await renderer.render({
      publicId: "scope-large-latin",
      knowledgeBaseId: "kb-1",
      kind: "_index",
      key: "term:latin",
      requiredSequence: 16,
      renderedSequence: 16
    }, new AbortController().signal);

    expect(result.pages.map((page) => page.logicalPath)).toEqual([
      expected[0]!.logicalPath,
      "_index/terms/latin/index.md",
      expect.stringMatching(
        /^_index\/terms\/latin\/index-extension-leaf-[0-9a-f-]+\.md$/u
      )
    ]);
    expect(putVerified).toHaveBeenCalledTimes(3);
  });

  it("renders one exact page directory with the fixed-sequence revisions", async () => {
    const putVerified = vi.fn(async (input: { bytes: Uint8Array }) => ({
      objectId: `object-${putVerified.mock.calls.length}`,
      storageKey: `generated/object-${putVerified.mock.calls.length}`,
      checksum: createHash("sha256").update(input.bytes).digest("hex"),
      byteCount: input.bytes.byteLength,
      contentType: "application/json; charset=utf-8",
      objectFormat: "okf-generated-json-v1" as const,
      outcome: "stored" as const,
      requests: {
        put: 1, head: 0, verification: 0,
        attemptedBytes: input.bytes.byteLength,
        retries: 0, latencyMilliseconds: 2
      }
    }));
    const renderer = createProductionDocumentScopeRenderer({
      machineProjection: {
        async readDocumentDirectoryState(request: {
          includedSourceRevisionPublicIds: readonly string[];
          excludedActiveSourceFilePublicIds: readonly string[];
        }) {
          expect(request.includedSourceRevisionPublicIds).toEqual(["revision-new"]);
          expect(request.excludedActiveSourceFilePublicIds).toEqual(["source-new"]);
          return {
            records: [{
              path: "pages/guides/overview.md",
              title: "Overview",
              summary: "A concise overview",
              metadata: {}, subjects: [], tags: [], headings: [],
              keywords: [], entities: [], type: "document",
              contentType: "text/markdown; charset=utf-8",
              checksumSha256: "a".repeat(64), byteCount: 10,
              relationshipCount: 0
            }],
            childDirectories: [{
              title: "advanced",
              scopePath: "pages/guides/advanced",
              path: "_index/pages/guides/advanced/index.json"
            }],
            resourcePaths: [
              "_index/pages/guides/guides-documents.json",
              "_index/pages/guides/guides-documents-part-0002.json"
            ]
          };
        }
      } as never,
      directoryNavigation: {
        async read() { return []; }
      } as never,
      directoryLeafLimits: {
        maxEntries: 200,
        maxBytes: 65_536,
        mergeBelowEntries: 50
      },
      objectWriter: { putVerified },
      maximumRecordsPerShard: 100,
      maximumShardBytes: 1_048_576,
      now: () => "2026-08-17T12:00:00.000Z"
    });

    const projected = await renderer.project({
      publicId: "scope-pages-guides",
      knowledgeBaseId: "kb-1",
      kind: "_index",
      key: "pages:pages/guides",
      requiredSequence: 8,
      renderedSequence: 8
    }, {
      contributors: [{
        sourceFilePublicId: "source-new",
        sourceRevisionPublicId: "revision-new",
        requiredSequence: 8
      }],
      pageIntegrityOverrides: [{
        path: "pages/guides/overview.md",
        checksumSha256: "9".repeat(64),
        byteCount: 99
      }]
    });
    const documentResource = projected.pages.find((page) =>
      page.logicalPath.endsWith("-documents.json"));
    expect(documentResource).toBeDefined();
    expect(parseDocumentPortableRecords(
      documentResource!.bytes,
      documentResource!.logicalPath
    )).toEqual([expect.objectContaining({
      path: "pages/guides/overview.md",
      checksumSha256: "9".repeat(64),
      byteCount: 99
    })]);

    const result = await renderer.render({
      publicId: "scope-pages-guides",
      knowledgeBaseId: "kb-1",
      kind: "_index",
      key: "pages:pages/guides",
      requiredSequence: 8,
      renderedSequence: 8
    }, new AbortController().signal, {
      contributors: [{
        sourceFilePublicId: "source-new",
        sourceRevisionPublicId: "revision-new",
        requiredSequence: 8
      }]
    });

    expect(result.pages.map((page) => page.logicalPath)).toEqual([
      "_index/pages/guides/guides-documents.json",
      "_index/pages/guides/index.json",
      "_index/pages/guides/index.md",
      expect.stringMatching(
        /^_index\/pages\/guides\/index-extension-leaf-[0-9a-f-]+\.md$/u
      )
    ]);
    expect(result.removedNormalizedPaths).toEqual([
      "_index/pages/guides/guides-documents-part-0002.json"
    ]);
    expect(result.factCount).toBe(1);
    expect(result.navigationMutations).toHaveLength(1);
    expect(result.navigationMutations[0]?.directoryPath).toBe(
      "_index/pages/guides"
    );
    expect(result.navigationMutations[0]?.touchedLeaves[0]?.entries)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        name: "advanced",
        targetPath: "_index/pages/guides/advanced/index.md"
      })]));
    expect(result.storageRequests.put).toBe(4);
  });

  it("removes an emptied page-index directory after its final document moves",
    async () => {
      const putVerified = vi.fn();
      const renderer = createProductionDocumentScopeRenderer({
        machineProjection: {
          async readDocumentDirectoryState() {
            return {
              records: [],
              childDirectories: [],
              resourcePaths: [
                "_index/pages/guides/guides-documents.json"
              ]
            };
          }
        } as never,
        directoryNavigation: {
          async read() {
            return [{
              id: "extension-leaf-old",
              previousLeafId: null,
              nextLeafId: null,
              revision: 1,
              entries: [{
                id: "old-document-packet",
                sortKey: "1/guides-documents.json/resource",
                name: "guides-documents.json",
                targetPath: "_index/pages/guides/guides-documents.json",
                kind: "file" as const
              }]
            }];
          }
        } as never,
        directoryLeafLimits: {
          maxEntries: 200,
          maxBytes: 65_536,
          mergeBelowEntries: 50
        },
        objectWriter: { putVerified } as never,
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576
      });

      const result = await renderer.render({
        publicId: "scope-empty-page-index-guides",
        knowledgeBaseId: "kb-1",
        kind: "_index",
        key: "pages:pages/guides",
        requiredSequence: 9,
        renderedSequence: 9
      }, new AbortController().signal);

      expect(result.pages).toEqual([]);
      expect(result.removedNormalizedPaths).toEqual([
        "_index/pages/guides/guides-documents.json",
        "_index/pages/guides/index-extension-leaf-old.md",
        "_index/pages/guides/index.json",
        "_index/pages/guides/index.md"
      ]);
      expect(result.navigationMutations).toEqual([expect.objectContaining({
        directoryPath: "_index/pages/guides",
        removedLeafIds: ["extension-leaf-old"]
      })]);
      expect(putVerified).not.toHaveBeenCalled();
    });

  it("bounds immutable object writes while yielding between projection chunks",
    async () => {
      const pages = Array.from({ length: 65 }, (_, index) => {
        const bytes = new TextEncoder().encode(`Page ${index}`);
        return {
          logicalPath: `pages/chunks/page-${index}.md`,
          normalizedPath: `pages/chunks/page-${index}.md`,
          entryKind: "source",
          sourceFilePublicId: "source-chunks",
          sourceRevisionPublicId: "revision-chunks",
          bytes,
          checksumSha256: createHash("sha256").update(bytes).digest("hex"),
          byteCount: bytes.byteLength
        };
      });
      let activeWrites = 0;
      let maximumActiveWrites = 0;
      const checkpoint = vi.fn(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
      const renderer = createProductionDocumentScopeRenderer({
        machineProjection: {
          readGeneratedPageChecksums: vi.fn(async () => [])
        } as never,
        sourceProjection: {
          project: vi.fn(async () => ({
            pages, removedLogicalPaths: [], factCount: pages.length
          }))
        },
        objectWriter: {
          async putVerified(input: { bytes: Uint8Array }) {
            activeWrites += 1;
            maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
            await new Promise<void>((resolve) => setImmediate(resolve));
            activeWrites -= 1;
            return {
              objectId: createHash("sha256").update(input.bytes).digest("hex"),
              storageKey: "generated/safe-object",
              checksum: createHash("sha256").update(input.bytes).digest("hex"),
              byteCount: input.bytes.byteLength,
              contentType: "text/markdown; charset=utf-8",
              objectFormat: "okf-generated-markdown-v1" as const,
              outcome: "stored" as const,
              requests: { put: 1, head: 0, verification: 0,
                attemptedBytes: input.bytes.byteLength, retries: 0,
                latencyMilliseconds: 1 }
            };
          }
        } as never,
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576
      });

      const result = await renderer.render({
        publicId: "scope-source-chunks",
        knowledgeBaseId: "kb-1",
        kind: "source",
        key: "source-chunks",
        requiredSequence: 1,
        renderedSequence: 1
      }, new AbortController().signal, {
        contributors: [{
          sourceFilePublicId: "source-chunks",
          sourceRevisionPublicId: "revision-chunks",
          requiredSequence: 1
        }],
        checkpoint
      });

      expect(result.pages).toHaveLength(65);
      expect(maximumActiveWrites).toBe(32);
      expect(checkpoint.mock.calls.length).toBeGreaterThanOrEqual(68);
    });

  it("renders one semantic Markdown directory from the same PostgreSQL snapshot",
    async () => {
      const putVerified = vi.fn(async (input: { bytes: Uint8Array }) => ({
        objectId: `object-directory-${putVerified.mock.calls.length}`,
        storageKey: `generated/object-directory-${putVerified.mock.calls.length}`,
        checksum: createHash("sha256").update(input.bytes).digest("hex"),
        byteCount: input.bytes.byteLength,
        contentType: "text/markdown; charset=utf-8",
        objectFormat: "okf-generated-markdown-v1" as const,
        outcome: "stored" as const,
        requests: {
          put: 1, head: 0, verification: 0,
          attemptedBytes: input.bytes.byteLength,
          retries: 0, latencyMilliseconds: 2
        }
      }));
      let wallClockOffset = 0;
      const readDocumentDirectoryState = vi.fn(async () => {
        throw new Error("Semantic directory must not read machine graph facts");
      });
      const readSemanticDirectoryState = vi.fn(async () => ({
        records: [{
          path: "pages/guides/overview.md",
          title: "Overview",
          summary: "A concise overview",
          metadata: {}, subjects: [], tags: [], headings: [],
          keywords: [], entities: [], type: "document",
          contentType: "text/markdown; charset=utf-8",
          checksumSha256: "a".repeat(64), byteCount: 10
        }],
        childDirectories: [{
          title: "advanced",
          scopePath: "pages/guides/advanced",
          path: "pages/guides/advanced/index.md"
        }]
      }));
      const renderer = createProductionDocumentScopeRenderer({
        machineProjection: {
          readDocumentDirectoryState,
          readSemanticDirectoryState
        } as never,
        directoryNavigation: {
          async read() { return []; }
        } as never,
        directoryLeafLimits: {
          maxEntries: 200,
          maxBytes: 65_536,
          mergeBelowEntries: 50
        },
        objectWriter: { putVerified },
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576,
        now: () => new Date(Date.parse("2026-08-17T12:00:00.000Z")
          + wallClockOffset++ * 1_000).toISOString()
      });

      const result = await renderer.render({
        publicId: "scope-directory-guides",
        knowledgeBaseId: "kb-1",
        kind: "directory",
        key: "pages/guides",
        requiredSequence: 9,
        renderedSequence: 9
      }, new AbortController().signal);

      expect(result.pages.map((page) => page.logicalPath)).toEqual([
        "pages/guides/index.md",
        expect.stringMatching(
          /^pages\/guides\/index-directory-leaf-[0-9a-f-]+\.md$/u
        )
      ]);
      expect(result.navigationMutations[0]?.touchedLeaves[0]?.entries)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            name: "Overview",
            targetPath: "pages/guides/overview.md"
          }),
          expect.objectContaining({
            name: "advanced",
            targetPath: "pages/guides/advanced/index.md"
          })
        ]));
      expect(readSemanticDirectoryState).toHaveBeenCalledOnce();
      expect(readDocumentDirectoryState).not.toHaveBeenCalled();
      expect(result.storageRequests.put).toBe(2);
    });

  it("materializes a publication semantic directory from bounded entry deltas",
    async () => {
      const readSemanticDirectoryState = vi.fn(async () => {
        throw new Error("Publication rendering must use immutable deltas");
      });
      const readSemanticDirectoryDeltaState = vi.fn(async () => ({
        records: [{
          path: "pages/guides/overview.md", title: "Overview",
          summary: "Overview", metadata: {}, subjects: [], tags: [],
          headings: [], keywords: [], entities: [], type: "document",
          contentType: "text/markdown", checksumSha256: "a".repeat(64),
          byteCount: 10
        }],
        childDirectories: [{
          title: "advanced", scopePath: "pages/guides/advanced",
          path: "pages/guides/advanced/index.md"
        }],
        navigationCandidateEntryIds: [
          documentDirectoryEntryId("file", "pages/guides/overview.md"),
          documentDirectoryEntryId(
            "directory", "pages/guides/advanced/index.md"
          )
        ]
      }));
      const readDelta = vi.fn(async (request: {
        desiredEntries: Array<{
          id: string; sortKey: string; name: string; targetPath: string;
          kind: "file" | "directory";
        }>;
        candidateEntryIds: string[];
      }) => ({
        mode: "window" as const,
        leaves: [],
        changes: request.desiredEntries.map((entry) => ({
          entryId: entry.id, desiredEntry: entry
        })),
        totalEntryCount: 0,
        firstLeafId: null,
        rootExists: false
      }));
      const renderer = createProductionDocumentScopeRenderer({
        machineProjection: {
          readSemanticDirectoryState,
          readSemanticDirectoryDeltaState
        } as never,
        directoryNavigation: {
          readDelta,
          async read() {
            throw new Error("Publication delta rendering must not list all leaves");
          }
        } as never,
        directoryLeafLimits: {
          maxEntries: 200, maxBytes: 65_536, mergeBelowEntries: 50
        },
        objectWriter: {} as never,
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576
      });

      const projected = await renderer.project({
        publicId: "scope-directory-delta",
        publicationGenerationPublicId: "generation-delta",
        knowledgeBaseId: "kb-1",
        kind: "directory",
        key: "pages/guides",
        requiredSequence: 10,
        renderedSequence: 10
      }, {
        contributors: [{
          sourceFilePublicId: "source-overview",
          sourceRevisionPublicId: "revision-overview",
          requiredSequence: 10
        }],
        planningMode: "delta",
        affectedSourceFilePublicIds: ["source-neighbor", "source-overview"]
      });

      expect(projected.navigationMutations).toHaveLength(1);
      expect(readSemanticDirectoryDeltaState).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-1",
        scopePath: "pages/guides",
        affectedSourceFilePublicIds: ["source-neighbor", "source-overview"],
        includedSourceRevisionPublicIds: ["revision-overview"],
        navigationSourceFilePublicIds: ["source-overview"]
      });
      expect(readSemanticDirectoryState).not.toHaveBeenCalled();
      expect(readDelta).toHaveBeenCalledWith(expect.objectContaining({
        maximumChanges: 2_048,
        candidateEntryIds: expect.arrayContaining([
          documentDirectoryEntryId("file", "pages/guides/overview.md")
        ])
      }));
    });

  it("rejects an oversized ordinary navigation delta without a full fallback",
    async () => {
      const renderer = createProductionDocumentScopeRenderer({
        machineProjection: {
          async readSemanticDirectoryDeltaState() {
            return {
              records: [], childDirectories: [],
              navigationCandidateEntryIds: ["candidate-entry"]
            };
          }
        } as never,
        directoryNavigation: {
          async readDelta() {
            return {
              mode: "full" as const, leaves: [], changes: [],
              totalEntryCount: 0, firstLeafId: null, rootExists: false
            };
          },
          async read() {
            throw new Error("Ordinary delta must not read all navigation leaves");
          }
        } as never,
        directoryLeafLimits: {
          maxEntries: 200, maxBytes: 65_536, mergeBelowEntries: 50
        },
        objectWriter: {} as never,
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576
      });

      await expect(renderer.project({
        publicId: "scope-directory-window-limit",
        publicationGenerationPublicId: "generation-window-limit",
        knowledgeBaseId: "kb-1",
        kind: "directory",
        key: "pages/guides",
        requiredSequence: 11,
        renderedSequence: 11
      }, {
        contributors: [{
          sourceFilePublicId: "source-overview",
          sourceRevisionPublicId: "revision-overview",
          requiredSequence: 11
        }],
        planningMode: "delta",
        affectedSourceFilePublicIds: ["source-overview"]
      })).rejects.toMatchObject({ code: "navigation_delta_window_exceeded" });
    });

  it("materializes disconnected bounded navigation windows", async () => {
    const entryId = documentDirectoryEntryId(
      "file", "pages/guides/overview.md");
    const renderer = createProductionDocumentScopeRenderer({
      machineProjection: {
        async readSemanticDirectoryDeltaState() {
          return {
            records: [{
              path: "pages/guides/overview.md", title: "Overview",
              summary: "Overview", metadata: {}, subjects: [], tags: [],
              headings: [], keywords: [], entities: [], type: "document",
              contentType: "text/markdown", checksumSha256: "a".repeat(64),
              byteCount: 10
            }],
            childDirectories: [], navigationCandidateEntryIds: [entryId]
          };
        }
      } as never,
      directoryNavigation: {
        async readDelta(request: { desiredEntries: Array<{
          id: string; sortKey: string; name: string; targetPath: string;
          kind: "file" | "directory";
        }> }) {
          return {
            mode: "windows" as const,
            windows: [[{
              id: "directory-leaf-a", previousLeafId: null,
              nextLeafId: "directory-leaf-middle",
              revision: 1, entries: [{
                ...request.desiredEntries[0]!, name: "Old overview"
              }]
            }], [{
              id: "directory-leaf-z",
              previousLeafId: "directory-leaf-middle", nextLeafId: null,
              revision: 1, entries: [{
                id: "entry-z", sortKey: "1/z.md/pages/guides/z.md",
                name: "Z", targetPath: "pages/guides/z.md",
                kind: "file" as const
              }]
            }]],
            changes: request.desiredEntries.map((entry) => ({
              entryId: entry.id, desiredEntry: entry
            })),
            totalEntryCount: 3,
            firstLeafId: "directory-leaf-a",
            rootExists: true
          };
        },
        async read() {
          throw new Error("Disconnected delta must not list the directory");
        }
      } as never,
      directoryLeafLimits: {
        maxEntries: 200, maxBytes: 65_536, mergeBelowEntries: 50
      },
      objectWriter: {} as never,
      maximumRecordsPerShard: 100,
      maximumShardBytes: 1_048_576
    });

    const projected = await renderer.project({
      publicId: "scope-directory-disconnected",
      publicationGenerationPublicId: "generation-disconnected",
      knowledgeBaseId: "kb-1", kind: "directory", key: "pages/guides",
      requiredSequence: 12, renderedSequence: 12
    }, {
      contributors: [{
        sourceFilePublicId: "source-overview",
        sourceRevisionPublicId: "revision-overview",
        requiredSequence: 12
      }],
      planningMode: "delta",
      affectedSourceFilePublicIds: ["source-overview"]
    });

    expect(projected.navigationMutations).toHaveLength(1);
    expect(projected.navigationMutations[0]).toMatchObject({
      directoryPath: "pages/guides", entryCount: 3,
      firstLeafId: "directory-leaf-a"
    });
  });

  it("bounds term catalog navigation to the changed buckets", async () => {
    const projected = await projectTermCatalog({
      input: {
        machineProjection: {
          async readNavigationTermCatalogDeltaState() {
            return [
              { bucket: "han" as const, present: true },
              { bucket: "latin" as const, present: false }
            ];
          }
        } as never,
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576
      },
      knowledgeBaseId: "kb-1",
      includedSourceRevisionPublicIds: [],
      excludedActiveSourceFilePublicIds: [],
      publicationGenerationPublicId: "generation-term-catalog",
      planningMode: "delta",
      basePages: []
    });

    expect(projected.navigationCandidateEntryIds).toEqual([
      documentDirectoryEntryId("file", "_index/terms/index.json"),
      documentDirectoryEntryId("directory", "_index/terms/han/index.md"),
      documentDirectoryEntryId("directory", "_index/terms/latin/index.md")
    ]);
  });

  it("uses the canonical pure-create closure for by-file navigation", async () => {
    const readPerFileGraphDirectoryState = vi.fn(async () => {
      throw new Error("Publication delta must not enumerate all graph files");
    });
    const readPerFileGraphDirectoryDeltaState = vi.fn(async () => ({
      records: [{
        path: "_graph/by-file/guides/overview.json",
        title: "Overview"
      }],
      childDirectories: []
    }));

    const projected = await projectPerFileGraphDirectory({
      dependencies: {
        machineProjection: {
          readPerFileGraphDirectoryState,
          readPerFileGraphDirectoryDeltaState
        } as never,
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576
      },
      knowledgeBaseId: "kb-1",
      scopePath: "pages/guides",
      publicationGenerationPublicId: "generation-graph-files",
      includedSourceRevisionPublicIds: ["revision-overview"],
      excludedActiveSourceFilePublicIds: [],
      affectedSourceFilePublicIds: ["source-overview"],
      affectedLogicalPaths: ["pages/guides/overview.md"],
      planningMode: "delta"
    });

    expect(readPerFileGraphDirectoryDeltaState).toHaveBeenCalledWith(
      expect.objectContaining({
        affectedSourceFilePublicIds: ["source-overview"],
        publicationGenerationPublicId: "generation-graph-files"
      })
    );
    expect(readPerFileGraphDirectoryState).not.toHaveBeenCalled();
    expect(projected.navigationCandidateEntryIds).toContain(
      documentDirectoryEntryId(
        "file", "_graph/by-file/guides/overview.json"
      )
    );
  });

  it("renders one exact graph directory from fixed-sequence relationship facts",
    async () => {
      const putVerified = vi.fn(async (input: { bytes: Uint8Array }) => ({
        objectId: `object-graph-${putVerified.mock.calls.length}`,
        storageKey: `generated/object-graph-${putVerified.mock.calls.length}`,
        checksum: createHash("sha256").update(input.bytes).digest("hex"),
        byteCount: input.bytes.byteLength,
        contentType: "application/json; charset=utf-8",
        objectFormat: "okf-generated-json-v1" as const,
        outcome: "stored" as const,
        requests: {
          put: 1, head: 0, verification: 0,
          attemptedBytes: input.bytes.byteLength,
          retries: 0, latencyMilliseconds: 3
        }
      }));
      const renderer = createProductionDocumentScopeRenderer({
        machineProjection: {
          async scanGraphDirectoryDeltaState(request: {
            includedSourceRevisionPublicIds: readonly string[];
            excludedActiveSourceFilePublicIds: readonly string[];
            onRecords(records: readonly Record<string, unknown>[]): void;
          }) {
            expect(request.includedSourceRevisionPublicIds).toEqual([
              "revision-new"
            ]);
            expect(request.excludedActiveSourceFilePublicIds).toEqual([
              "source-new"
            ]);
            const records = [documentRelationProjectionRecord({
                fromPath: "guides/overview.md",
                toPath: "guides/operations.md",
                fromTitle: "Overview",
                toTitle: "Operations",
                relationType: "references",
                evidenceKind: "markdown_link",
                evidenceValue: { sourceExcerpt: "See Operations." }
              })];
            request.onRecords(records);
            return {
              recordCount: records.length,
              childDirectories: [{
                title: "advanced",
                scopePath: "pages/guides/advanced",
                path: "_graph/by-directory/guides/advanced/index.json"
              }],
              resourcePaths: [
                "_graph/by-directory/guides/guides-relationships.json",
                "_graph/by-directory/guides/guides-relationships-part-0002.json"
              ]
            };
          }
        } as never,
        directoryNavigation: {
          async read() { return []; }
        } as never,
        directoryLeafLimits: {
          maxEntries: 200,
          maxBytes: 65_536,
          mergeBelowEntries: 50
        },
        objectWriter: { putVerified },
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576,
        now: () => "2026-08-17T12:00:00.000Z"
      });

      const result = await renderer.render({
        publicId: "scope-graph-guides",
        knowledgeBaseId: "kb-1",
        kind: "_graph",
        key: "directory:pages/guides",
        requiredSequence: 11,
        renderedSequence: 11
      }, new AbortController().signal, {
        contributors: [{
          sourceFilePublicId: "source-new",
          sourceRevisionPublicId: "revision-new",
          requiredSequence: 11
        }]
      });

      expect(result.pages.map((page) => page.logicalPath)).toEqual([
        "_graph/by-directory/guides/guides-relationships.json",
        "_graph/by-directory/guides/index.json",
        "_graph/by-directory/guides/index.md",
        expect.stringMatching(
          /^_graph\/by-directory\/guides\/index-extension-leaf-[0-9a-f-]+\.md$/u
        )
      ]);
      expect(result.removedNormalizedPaths).toEqual([
        "_graph/by-directory/guides/guides-relationships-part-0002.json"
      ]);
      expect(result.factCount).toBe(1);
      expect(result.navigationMutations).toHaveLength(1);
      expect(result.navigationMutations[0]?.touchedLeaves[0]?.entries)
        .toEqual(expect.arrayContaining([expect.objectContaining({
          name: "advanced",
          targetPath: "_graph/by-directory/guides/advanced/index.md"
        })]));
      expect(result.storageRequests.put).toBe(4);
    });

  it("removes an exact graph directory after its final relationship disappears",
    async () => {
      const putVerified = vi.fn();
      const renderer = createProductionDocumentScopeRenderer({
        machineProjection: {
          async scanGraphDirectoryDeltaState() {
            return {
              recordCount: 0,
              childDirectories: [],
              resourcePaths: [
                "_graph/by-directory/guides/guides-relationships.json"
              ]
            };
          }
        } as never,
        directoryNavigation: {
          async read() {
            return [{
              id: "extension-leaf-old",
              previousLeafId: null,
              nextLeafId: null,
              revision: 1,
              entries: [{
                id: "_graph/by-directory/guides/guides-relationships.json",
                sortKey: "1/guides-relationships.json/resource",
                name: "guides-relationships.json",
                targetPath:
                  "_graph/by-directory/guides/guides-relationships.json",
                kind: "file" as const
              }]
            }];
          }
        } as never,
        directoryLeafLimits: {
          maxEntries: 200,
          maxBytes: 65_536,
          mergeBelowEntries: 50
        },
        objectWriter: { putVerified } as never,
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576
      });

      const result = await renderer.render({
        publicId: "scope-empty-graph-guides",
        knowledgeBaseId: "kb-1",
        kind: "_graph",
        key: "directory:pages/guides",
        requiredSequence: 12,
        renderedSequence: 12
      }, new AbortController().signal);

      expect(result.pages).toEqual([]);
      expect(result.removedNormalizedPaths).toEqual([
        "_graph/by-directory/guides/guides-relationships.json",
        "_graph/by-directory/guides/index-extension-leaf-old.md",
        "_graph/by-directory/guides/index.json",
        "_graph/by-directory/guides/index.md"
      ]);
      expect(putVerified).not.toHaveBeenCalled();
    });

  it("renders one exact per-file graph from fixed-sequence relationship facts",
    async () => {
      const putVerified = vi.fn(async (input: { bytes: Uint8Array }) => ({
        objectId: "object-file-graph",
        storageKey: "generated/object-file-graph",
        checksum: createHash("sha256").update(input.bytes).digest("hex"),
        byteCount: input.bytes.byteLength,
        contentType: "application/json; charset=utf-8",
        objectFormat: "okf-generated-json-v1" as const,
        outcome: "stored" as const,
        requests: {
          put: 1, head: 0, verification: 0,
          attemptedBytes: input.bytes.byteLength,
          retries: 0, latencyMilliseconds: 3
        }
      }));
      const renderer = createProductionDocumentScopeRenderer({
        machineProjection: {
          async readPerFileGraphState(request: {
            sourceFilePublicId: string;
            includedSourceRevisionPublicIds: readonly string[];
            excludedActiveSourceFilePublicIds: readonly string[];
          }) {
            expect(request.sourceFilePublicId).toBe("source-new");
            expect(request.includedSourceRevisionPublicIds).toEqual([
              "revision-new"
            ]);
            expect(request.excludedActiveSourceFilePublicIds).toEqual([
              "source-new"
            ]);
            return {
              source: {
                path: "pages/guides/overview.md",
                title: "Overview"
              },
              relationships: [documentRelatedProjectionRecord({
                fromPath: "guides/overview.md",
                toPath: "guides/operations.md",
                fromTitle: "Overview",
                toTitle: "Operations",
                relationType: "references",
                evidenceKind: "markdown_link",
                evidenceValue: { sourceExcerpt: "See Operations." }
              }, "guides/overview.md")],
              resourcePaths: [
                "_graph/by-file/legacy/overview.json"
              ]
            };
          }
        } as never,
        directoryNavigation: {
          async read() { return []; }
        } as never,
        directoryLeafLimits: {
          maxEntries: 200,
          maxBytes: 65_536,
          mergeBelowEntries: 50
        },
        objectWriter: { putVerified },
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576,
        now: () => "2026-08-17T12:00:00.000Z"
      });

      const result = await renderer.render({
        publicId: "scope-file-graph",
        knowledgeBaseId: "kb-1",
        kind: "_graph",
        key: "source-new",
        requiredSequence: 13,
        renderedSequence: 13
      }, new AbortController().signal, {
        contributors: [{
          sourceFilePublicId: "source-new",
          sourceRevisionPublicId: "revision-new",
          requiredSequence: 13
        }]
      });

      expect(result.pages.map((page) => page.logicalPath)).toEqual([
        "_graph/by-file/guides/overview.json"
      ]);
      expect(result.removedNormalizedPaths).toEqual([
        "_graph/by-file/legacy/overview.json"
      ]);
      expect(result.factCount).toBe(1);
      expect(putVerified).toHaveBeenCalledTimes(1);
    });

  it("renders progressive by-file navigation from relationship-bearing files",
    async () => {
      const putVerified = vi.fn(async (input: { bytes: Uint8Array }) => ({
        objectId: `object-file-directory-${putVerified.mock.calls.length}`,
        storageKey: `generated/file-directory-${putVerified.mock.calls.length}`,
        checksum: createHash("sha256").update(input.bytes).digest("hex"),
        byteCount: input.bytes.byteLength,
        contentType: "text/markdown; charset=utf-8",
        objectFormat: "okf-generated-markdown-v1" as const,
        outcome: "stored" as const,
        requests: {
          put: 1, head: 0, verification: 0,
          attemptedBytes: input.bytes.byteLength,
          retries: 0, latencyMilliseconds: 2
        }
      }));
      const renderer = createProductionDocumentScopeRenderer({
        machineProjection: {
          async readPerFileGraphDirectoryState() {
            return {
              records: [{
                path: "_graph/by-file/guides/overview.json",
                title: "Overview"
              }],
              childDirectories: [{
                title: "advanced",
                scopePath: "pages/guides/advanced",
                path: "_graph/by-file/guides/advanced/index.md"
              }]
            };
          }
        } as never,
        directoryNavigation: {
          async read() { return []; }
        } as never,
        directoryLeafLimits: {
          maxEntries: 200,
          maxBytes: 65_536,
          mergeBelowEntries: 50
        },
        objectWriter: { putVerified },
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576,
        now: () => "2026-08-17T12:00:00.000Z"
      });

      const result = await renderer.render({
        publicId: "scope-file-directory-guides",
        knowledgeBaseId: "kb-1",
        kind: "_graph",
        key: "file-directory:pages/guides",
        requiredSequence: 14,
        renderedSequence: 14
      }, new AbortController().signal);

      expect(result.pages.map((page) => page.logicalPath)).toEqual([
        "_graph/by-file/guides/index.md",
        expect.stringMatching(
          /^_graph\/by-file\/guides\/index-extension-leaf-[0-9a-f-]+\.md$/u
        )
      ]);
      expect(result.navigationMutations[0]?.touchedLeaves[0]?.entries)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            name: "Overview",
            targetPath: "_graph/by-file/guides/overview.json"
          }),
          expect.objectContaining({
            name: "advanced",
            targetPath: "_graph/by-file/guides/advanced/index.md"
          })
        ]));
      expect(result.storageRequests.put).toBe(2);
    });

  it("removes by-file navigation after the final relationship disappears",
    async () => {
      const renderer = createProductionDocumentScopeRenderer({
        machineProjection: {
          async readPerFileGraphDirectoryState() {
            return { records: [], childDirectories: [] };
          }
        } as never,
        directoryNavigation: {
          async read() {
            return [{
              id: "extension-leaf-old",
              previousLeafId: null,
              nextLeafId: null,
              revision: 1,
              entries: [{
                id: "_graph/by-file/guides/overview.json",
                sortKey: "1/overview/overview.json",
                name: "Overview",
                targetPath: "_graph/by-file/guides/overview.json",
                kind: "file" as const
              }]
            }];
          }
        } as never,
        directoryLeafLimits: {
          maxEntries: 200,
          maxBytes: 65_536,
          mergeBelowEntries: 50
        },
        objectWriter: { putVerified: vi.fn() } as never,
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576
      });

      const result = await renderer.render({
        publicId: "scope-empty-file-directory-guides",
        knowledgeBaseId: "kb-1",
        kind: "_graph",
        key: "file-directory:pages/guides",
        requiredSequence: 15,
        renderedSequence: 15
      }, new AbortController().signal, {
        contributors: [{
          sourceFilePublicId: "source-new",
          sourceRevisionPublicId: "revision-new",
          requiredSequence: 15
        }]
      });

      expect(result.pages).toEqual([]);
      expect(result.removedNormalizedPaths).toEqual([
        "_graph/by-file/guides/index-extension-leaf-old.md",
        "_graph/by-file/guides/index.md"
      ]);
    });

  it("removes a per-file graph after its final relationship disappears",
    async () => {
      const putVerified = vi.fn();
      const renderer = createProductionDocumentScopeRenderer({
        machineProjection: {
          async readPerFileGraphState() {
            return {
              source: {
                path: "pages/guides/overview.md",
                title: "Overview"
              },
              relationships: [],
              resourcePaths: ["_graph/by-file/guides/overview.json"]
            };
          }
        } as never,
        objectWriter: { putVerified } as never,
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576
      });

      const result = await renderer.render({
        publicId: "scope-empty-file-graph",
        knowledgeBaseId: "kb-1",
        kind: "_graph",
        key: "source-new",
        requiredSequence: 14,
        renderedSequence: 14
      }, new AbortController().signal);

      expect(result.pages).toEqual([]);
      expect(result.removedNormalizedPaths).toEqual([
        "_graph/by-file/guides/overview.json"
      ]);
      expect(putVerified).not.toHaveBeenCalled();
    });

  it("renders the graph catalog from the fixed-sequence relation count",
    async () => {
      const putVerified = vi.fn(async (input: { bytes: Uint8Array }) => ({
        objectId: "object-graph-catalog",
        storageKey: "generated/object-graph-catalog",
        checksum: createHash("sha256").update(input.bytes).digest("hex"),
        byteCount: input.bytes.byteLength,
        contentType: "application/json; charset=utf-8",
        objectFormat: "okf-generated-json-v1" as const,
        outcome: "stored" as const,
        requests: {
          put: 1, head: 0, verification: 0,
          attemptedBytes: input.bytes.byteLength,
          retries: 0, latencyMilliseconds: 3
        }
      }));
      const renderer = createProductionDocumentScopeRenderer({
        machineProjection: {
          async readGraphCatalogState(request: {
            includedSourceRevisionPublicIds: readonly string[];
            excludedActiveSourceFilePublicIds: readonly string[];
          }) {
            expect(request.includedSourceRevisionPublicIds).toEqual([
              "revision-new"
            ]);
            expect(request.excludedActiveSourceFilePublicIds).toEqual([
              "source-new"
            ]);
            return { relationshipCount: 2 };
          }
        } as never,
        objectWriter: { putVerified },
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576,
        now: () => "2026-08-17T12:00:00.000Z"
      });

      const result = await renderer.render({
        publicId: "scope-graph-catalog",
        knowledgeBaseId: "kb-1",
        kind: "_graph",
        key: "catalog",
        requiredSequence: 15,
        renderedSequence: 15
      }, new AbortController().signal, {
        contributors: [{
          sourceFilePublicId: "source-new",
          sourceRevisionPublicId: "revision-new",
          requiredSequence: 15
        }]
      });

      expect(result.pages.map((page) => page.logicalPath)).toEqual([
        "_graph/catalog.json"
      ]);
      expect(result.factCount).toBe(2);
      expect(putVerified).toHaveBeenCalledTimes(1);
    });

  it("renders the finite term catalog from fixed-sequence PostgreSQL facts",
    async () => {
      const putVerified = vi.fn(async (input: { bytes: Uint8Array }) => ({
        objectId: "object-term-catalog",
        storageKey: "generated/object-term-catalog",
        checksum: createHash("sha256").update(input.bytes).digest("hex"),
        byteCount: input.bytes.byteLength,
        contentType: "application/json; charset=utf-8",
        objectFormat: "okf-generated-json-v1" as const,
        outcome: "stored" as const,
        requests: {
          put: 1, head: 0, verification: 0,
          attemptedBytes: input.bytes.byteLength,
          retries: 0, latencyMilliseconds: 3
        }
      }));
      const renderer = createProductionDocumentScopeRenderer({
        machineProjection: {
          async readNavigationTermCatalogState(request: {
            includedSourceRevisionPublicIds: readonly string[];
            excludedActiveSourceFilePublicIds: readonly string[];
          }) {
            expect(request.includedSourceRevisionPublicIds).toEqual([
              "revision-new"
            ]);
            expect(request.excludedActiveSourceFilePublicIds).toEqual([
              "source-new"
            ]);
            return { buckets: ["han", "latin"] };
          }
        } as never,
        directoryNavigation: {
          async read() { return []; }
        } as never,
        directoryLeafLimits: {
          maxEntries: 200,
          maxBytes: 65_536,
          mergeBelowEntries: 50
        },
        objectWriter: { putVerified },
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576,
        now: () => "2026-08-17T12:00:00.000Z"
      });

      const result = await renderer.render({
        publicId: "scope-term-catalog",
        knowledgeBaseId: "kb-1",
        kind: "_index",
        key: "term-catalog",
        requiredSequence: 16,
        renderedSequence: 16
      }, new AbortController().signal, {
        contributors: [{
          sourceFilePublicId: "source-new",
          sourceRevisionPublicId: "revision-new",
          requiredSequence: 16
        }]
      });

      expect(result.pages.map((page) => page.logicalPath)).toEqual([
        "_index/terms/index.json",
        "_index/terms/index.md",
        expect.stringMatching(
          /^_index\/terms\/index-extension-leaf-[0-9a-f-]+\.md$/u
        )
      ]);
      expect(result.navigationMutations[0]?.touchedLeaves[0]?.entries)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            name: "han",
            targetPath: "_index/terms/han/index.md"
          }),
          expect.objectContaining({
            name: "latin",
            targetPath: "_index/terms/latin/index.md"
          })
        ]));
      expect(result.factCount).toBe(2);
      expect(putVerified).toHaveBeenCalledTimes(3);
    });

  it("renders the stable index catalog through the coalesced root scope",
    async () => {
      const putVerified = vi.fn(async (input: { bytes: Uint8Array }) => ({
        objectId: "object-index-catalog",
        storageKey: "generated/object-index-catalog",
        checksum: createHash("sha256").update(input.bytes).digest("hex"),
        byteCount: input.bytes.byteLength,
        contentType: "application/json; charset=utf-8",
        objectFormat: "okf-generated-json-v1" as const,
        outcome: "stored" as const,
        requests: {
          put: 1, head: 0, verification: 0,
          attemptedBytes: input.bytes.byteLength,
          retries: 0, latencyMilliseconds: 3
        }
      }));
      let rootWallClockOffset = 0;
      const renderer = createProductionDocumentScopeRenderer({
        machineProjection: {
          async readRootProjectionState() {
            return {
              knowledgeBase: {
                id: "kb-1",
                name: "Portable knowledge base",
                description: "A reusable knowledge bundle."
              },
              sourceFileCount: 3,
              graphEdgeCount: 2,
              rootEntryCount: 2,
              currentLogEntries: [{
                occurredAt: "2026-08-17T12:00:00.000Z",
                action: "Updated page",
                message: "Updated pages/guides/overview.md.",
                links: [{
                  path: "pages/guides/overview.md",
                  title: "Overview"
                }]
              }],
              previousLogEntries: []
            };
          }
        } as never,
        rootLimits: {
          rootSummaryLimit: 500,
          okfLogMaxEntries: 100,
          okfLogMaxBytes: 65_536
        },
        directoryNavigation: {
          async read() { return []; }
        } as never,
        directoryLeafLimits: {
          maxEntries: 200,
          maxBytes: 65_536,
          mergeBelowEntries: 50
        },
        objectWriter: { putVerified },
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576,
        now: () => new Date(Date.parse("2026-08-17T12:00:00.000Z")
          + rootWallClockOffset++ * 1_000).toISOString()
      });

      const scope = {
        publicId: "scope-root-index",
        knowledgeBaseId: "kb-1",
        kind: "root" as const,
        key: "index",
        requiredSequence: 17,
        renderedSequence: 17,
        deterministicEventTime: "2026-08-17T11:59:00.000Z"
      };
      const projectedRoot = await renderer.project(scope);
      const repeatedRoot = await renderer.project(scope);
      const result = await renderer.render(scope, new AbortController().signal);
      const repeatedResult = await renderer.render(
        scope,
        new AbortController().signal
      );

      expect(repeatedRoot.pages.map((page) => ({
        logicalPath: page.logicalPath,
        checksumSha256: page.checksumSha256,
        bytes: [...page.bytes]
      }))).toEqual(projectedRoot.pages.map((page) => ({
        logicalPath: page.logicalPath,
        checksumSha256: page.checksumSha256,
        bytes: [...page.bytes]
      })));
      expect({
        pages: repeatedResult.pages,
        removedNormalizedPaths: repeatedResult.removedNormalizedPaths,
        navigationMutations: repeatedResult.navigationMutations,
        factCount: repeatedResult.factCount,
        outputFingerprintSha256: repeatedResult.outputFingerprintSha256
      }).toEqual({
        pages: result.pages,
        removedNormalizedPaths: result.removedNormalizedPaths,
        navigationMutations: result.navigationMutations,
        factCount: result.factCount,
        outputFingerprintSha256: result.outputFingerprintSha256
      });

      expect(result.pages.map((page) => page.logicalPath)).toEqual([
        "_index/catalog.json",
        "_graph/index.md",
        expect.stringMatching(
          /^_graph\/index-extension-leaf-[0-9a-f-]+\.md$/u
        ),
        "_index/index.md",
        expect.stringMatching(
          /^_index\/index-extension-leaf-[0-9a-f-]+\.md$/u
        ),
        "index.md",
        "log.md"
      ]);
      const indexRoot = projectedRoot.pages.find((page) =>
        page.logicalPath === "_index/index.md");
      const indexLeaf = projectedRoot.pages.find((page) =>
        /^_index\/index-extension-leaf-[0-9a-f-]+\.md$/u.test(
          page.logicalPath
        ));
      const graphRoot = projectedRoot.pages.find((page) =>
        page.logicalPath === "_graph/index.md");
      const graphLeaf = projectedRoot.pages.find((page) =>
        /^_graph\/index-extension-leaf-[0-9a-f-]+\.md$/u.test(
          page.logicalPath
        ));
      expect(new TextDecoder().decode(indexRoot?.bytes)).toContain(
        "[Browse entries](index-extension-leaf-"
      );
      expect(new TextDecoder().decode(indexLeaf?.bytes)).toContain(
        "[Directory index](index.md)"
      );
      expect(new TextDecoder().decode(indexLeaf?.bytes)).toContain(
        "[Documents](pages/index.md)"
      );
      expect(new TextDecoder().decode(indexLeaf?.bytes)).toContain(
        "[Navigation terms](terms/index.md)"
      );
      expect(new TextDecoder().decode(graphRoot?.bytes)).toContain(
        "[Browse entries](index-extension-leaf-"
      );
      expect(new TextDecoder().decode(graphLeaf?.bytes)).toContain(
        "[Directory index](index.md)"
      );
      expect(new TextDecoder().decode(graphLeaf?.bytes)).toContain(
        "[Relationships by file](by-file/index.md)"
      );
      expect(result.navigationMutations.map((mutation) =>
        mutation.directoryPath)).toEqual(["_graph", "_index"]);
      expect(result.factCount).toBe(3);
      expect(putVerified).toHaveBeenCalledTimes(14);
    });

  it("removes an emptied term bucket without writing an empty graph", async () => {
    const putVerified = vi.fn();
    const renderer = createProductionDocumentScopeRenderer({
      machineProjection: {
        async listNavigationTermRecords() { return []; },
        async listTermPartPaths() {
          return ["_index/terms/han/han-terms-part-0001.json"];
        }
      } as never,
      directoryNavigation: {
        async read() {
          return [{
            id: "extension-leaf-old",
            previousLeafId: null,
            nextLeafId: null,
            revision: 1,
            entries: [{
              id: "old-part",
              sortKey: "old-part",
              name: "han-terms-part-0001.json",
              targetPath: "_index/terms/han/han-terms-part-0001.json",
              kind: "file"
            }]
          }];
        }
      } as never,
      directoryLeafLimits: {
        maxEntries: 200,
        maxBytes: 65_536,
        mergeBelowEntries: 50
      },
      objectWriter: { putVerified } as never,
      maximumRecordsPerShard: 100,
      maximumShardBytes: 1_048_576
    });

    const result = await renderer.render({
      publicId: "scope-empty-han",
      knowledgeBaseId: "kb-1",
      kind: "_index",
      key: "term:han",
      requiredSequence: 9,
      renderedSequence: 9
    }, new AbortController().signal);

    expect(result.pages).toEqual([]);
    expect(result.removedNormalizedPaths).toEqual([
      "_index/terms/han/han-terms-part-0001.json",
      "_index/terms/han/index-extension-leaf-old.md",
      "_index/terms/han/index.json",
      "_index/terms/han/index.md"
    ]);
    expect(putVerified).not.toHaveBeenCalled();
  });
});
