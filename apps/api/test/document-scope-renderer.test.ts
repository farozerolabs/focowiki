import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  documentRelatedProjectionRecord,
  documentRelationProjectionRecord
} from
  "../src/document-indexing/application/document-machine-record.js";
import { buildDocumentNavigationTermBucketResources } from
  "../src/document-indexing/application/document-page-term-projection.js";
import { createProductionDocumentScopeRenderer } from
  "../src/document-indexing/infrastructure/production-document-scope-renderer.js";

describe("production document scope renderer", () => {
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
      snapshots: ({
        async render() { throw new Error("source scope must be materialized"); }
      }) as never,
      machineProjection: {} as never,
      sourceProjection: { project },
      scopeContributions: {
        async listCovered() {
          return [{
            sourceFilePublicId: "source-b",
            sourceRevisionPublicId: "revision-b",
            requiredSequence: 7
          }, {
            sourceFilePublicId: "source-a",
            sourceRevisionPublicId: "revision-a",
            requiredSequence: 8
          }];
        }
      } as never,
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
    }, new AbortController().signal);

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
      snapshots: {
        async render() {
          throw new Error("term scope must not use fingerprint-only fallback");
        }
      } as never,
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
      scopeContributions: {
        async listCovered() {
          return [{
            sourceFilePublicId: "source-new",
            sourceRevisionPublicId: "revision-old",
            requiredSequence: 2
          }, {
            sourceFilePublicId: "source-new",
            sourceRevisionPublicId: "revision-new",
            requiredSequence: 3
          }];
        }
      } as never,
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
    }, new AbortController().signal);

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
      snapshots: ({
        async render() { throw new Error("unexpected fallback"); }
      }) as never,
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
      scopeContributions: { async listCovered() { return []; } } as never,
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
      snapshots: ({
        async render() { throw new Error("unexpected fallback"); }
      }) as never,
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
      scopeContributions: {
        async listCovered() {
          return [{
            sourceFilePublicId: "source-new",
            sourceRevisionPublicId: "revision-new"
          }];
        }
      } as never,
      objectWriter: { putVerified },
      maximumRecordsPerShard: 100,
      maximumShardBytes: 1_048_576,
      now: () => "2026-08-17T12:00:00.000Z"
    });

    const result = await renderer.render({
      publicId: "scope-pages-guides",
      knowledgeBaseId: "kb-1",
      kind: "_index",
      key: "pages:pages/guides",
      requiredSequence: 8,
      renderedSequence: 8
    }, new AbortController().signal);

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
      const renderer = createProductionDocumentScopeRenderer({
        snapshots: ({
          async render() { throw new Error("unexpected fallback"); }
        }) as never,
        machineProjection: {
          async readDocumentDirectoryState() {
            return {
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
                path: "_index/pages/guides/advanced/index.json"
              }],
              resourcePaths: []
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
        scopeContributions: {
          async listCovered() {
            return [{
              sourceFilePublicId: "source-new",
              sourceRevisionPublicId: "revision-new"
            }];
          }
        } as never,
        objectWriter: { putVerified },
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576,
        now: () => "2026-08-17T12:00:00.000Z"
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
      expect(result.storageRequests.put).toBe(2);
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
        snapshots: ({
          async render() { throw new Error("unexpected fallback"); }
        }) as never,
        machineProjection: {
          async readGraphDirectoryState(request: {
            includedSourceRevisionPublicIds: readonly string[];
            excludedActiveSourceFilePublicIds: readonly string[];
          }) {
            expect(request.includedSourceRevisionPublicIds).toEqual([
              "revision-new"
            ]);
            expect(request.excludedActiveSourceFilePublicIds).toEqual([
              "source-new"
            ]);
            return {
              records: [documentRelationProjectionRecord({
                fromPath: "guides/overview.md",
                toPath: "guides/operations.md",
                fromTitle: "Overview",
                toTitle: "Operations",
                relationType: "references",
                evidenceKind: "markdown_link",
                evidenceValue: { sourceExcerpt: "See Operations." }
              })],
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
        scopeContributions: {
          async listCovered() {
            return [{
              sourceFilePublicId: "source-new",
              sourceRevisionPublicId: "revision-new"
            }];
          }
        } as never,
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
      }, new AbortController().signal);

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
        snapshots: ({
          async render() { throw new Error("unexpected fallback"); }
        }) as never,
        machineProjection: {
          async readGraphDirectoryState() {
            return {
              records: [],
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
        scopeContributions: {
          async listCovered() {
            return [{
              sourceFilePublicId: "source-old",
              sourceRevisionPublicId: "revision-new"
            }];
          }
        } as never,
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
        snapshots: ({
          async render() { throw new Error("unexpected fallback"); }
        }) as never,
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
        scopeContributions: {
          async listCovered() {
            return [{
              sourceFilePublicId: "source-new",
              sourceRevisionPublicId: "revision-new"
            }];
          }
        } as never,
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
      }, new AbortController().signal);

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
        snapshots: ({
          async render() { throw new Error("unexpected fallback"); }
        }) as never,
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
        scopeContributions: {
          async listCovered() {
            return [{
              sourceFilePublicId: "source-new",
              sourceRevisionPublicId: "revision-new"
            }];
          }
        } as never,
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
        snapshots: ({
          async render() { throw new Error("unexpected fallback"); }
        }) as never,
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
        scopeContributions: {
          async listCovered() { return []; }
        } as never,
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
      }, new AbortController().signal);

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
        snapshots: ({
          async render() { throw new Error("unexpected fallback"); }
        }) as never,
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
        scopeContributions: {
          async listCovered() {
            return [{
              sourceFilePublicId: "source-new",
              sourceRevisionPublicId: "revision-new"
            }];
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
        snapshots: ({
          async render() { throw new Error("unexpected fallback"); }
        }) as never,
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
        scopeContributions: {
          async listCovered() {
            return [{
              sourceFilePublicId: "source-new",
              sourceRevisionPublicId: "revision-new",
              requiredSequence: 15
            }];
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
      }, new AbortController().signal);

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
        snapshots: ({
          async render() { throw new Error("unexpected fallback"); }
        }) as never,
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
        scopeContributions: {
          async listCovered() {
            return [{
              sourceFilePublicId: "source-new",
              sourceRevisionPublicId: "revision-new",
              requiredSequence: 16
            }];
          }
        } as never,
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
      }, new AbortController().signal);

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
      const renderer = createProductionDocumentScopeRenderer({
        snapshots: ({
          async render() { throw new Error("unexpected fallback"); }
        }) as never,
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
        scopeContributions: {
          async listCovered() {
            return [{
              sourceFilePublicId: "source-new",
              sourceRevisionPublicId: "revision-new",
              requiredSequence: 17
            }];
          }
        } as never,
        objectWriter: { putVerified },
        maximumRecordsPerShard: 100,
        maximumShardBytes: 1_048_576,
        now: () => "2026-08-17T12:00:00.000Z"
      });

      const scope = {
        publicId: "scope-root-index",
        knowledgeBaseId: "kb-1",
        kind: "root" as const,
        key: "index",
        requiredSequence: 17,
        renderedSequence: 17
      };
      const projectedRoot = await renderer.project(scope);
      const result = await renderer.render(scope, new AbortController().signal);

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
      expect(putVerified).toHaveBeenCalledTimes(7);
    });

  it("removes an emptied term bucket without writing an empty graph", async () => {
    const putVerified = vi.fn();
    const renderer = createProductionDocumentScopeRenderer({
      snapshots: ({
        async render() { throw new Error("unexpected fallback"); }
      }) as never,
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
      scopeContributions: {
        async listCovered() {
          return [{ sourceFilePublicId: "source-old",
            sourceRevisionPublicId: "revision-new" }];
        }
      } as never,
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
