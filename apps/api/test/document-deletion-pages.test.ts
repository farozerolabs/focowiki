import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProductionDocumentDeletionPages } from
  "../src/document-indexing/infrastructure/production-document-deletion-pages.js";

describe("document deletion generated pages", () => {
  it("removes a deleted directory from parent navigation and rewrites its neighbor", async () => {
    const body = Buffer.from("# Retained\n\nThis page no longer links to the deleted file.\n");
    const checksum = createHash("sha256").update(body).digest("hex");
    const factory = createProductionDocumentDeletionPages({
      context: {
        async read() {
          return {
            deletedSources: [{
              sourceFilePublicId: "source-deleted",
              logicalPath: "Guides/deleted.md"
            }],
            deletedDirectoryPaths: ["Guides"],
            affectedSurvivorSourceFilePublicIds: ["source-retained"],
            obsoleteRelationPublicIds: ["relation-old"]
          };
        },
        async readActiveRelations() { return []; },
        async countActiveSources() { return 1; },
        async countActiveRelations() { return 0; }
      } as never,
      generatedContext: {
        async readActiveSources() {
          return [{
            sourceFilePublicId: "source-retained",
            sourceRevisionPublicId: "revision-retained",
            resourceRevision: 1,
            logicalPath: "retained.md",
            title: "Retained",
            objectId: "object-retained",
            checksumSha256: checksum,
            byteCount: body.byteLength,
            contentType: "text/markdown; charset=utf-8",
            modelSuggestions: {
              title: "",
              type: "",
              description: "A retained source description.",
              tags: [],
              keywords: ["retained-keyword"]
            },
            semanticEntities: []
          }];
        },
        async readKnowledgeBase() {
          return { id: "knowledge-base-1", name: "Knowledge", description: null };
        },
        async readRecentAvailableDocumentEvents() { return []; }
      } as never,
      directoryNavigation: {
        async read({ directoryPath }: { directoryPath: string }) {
          if (directoryPath !== "pages") return [];
          return [{
            id: "leaf-root",
            previousLeafId: null,
            nextLeafId: null,
            revision: 1,
            entries: [{
              id: "directory:Guides",
              sortKey: "guides/directory:Guides",
              name: "Guides",
              targetPath: "pages/Guides/index.md",
              kind: "directory" as const
            }, {
              id: "source-retained",
              sortKey: "retained.md/source-retained",
              name: "retained.md",
              targetPath: "pages/retained.md",
              kind: "file" as const
            }]
          }];
        }
      } as never,
      bodyStore: {
        async readVerifiedStream() {
          return (async function* () { yield body; })();
        }
      } as never,
      permits: {
        async run(_kind: string, operation: () => Promise<unknown>) {
          return operation();
        }
      } as never,
      documentConcurrency: 2,
      maximumSourceBytes: 1_048_576
    });

    const result = await factory({
      action: {
        publicId: "cleanup-delete",
        operationPublicId: "operation-delete",
        knowledgeBaseId: "knowledge-base-1",
        targetKind: "source_directory",
        targetPublicId: "directory-guides",
        attempt: 1,
        maximumAttempts: 3,
        checkpoint: {
          phase: "reconcile_projection",
          cursor: null,
          affectedSourceCount: 1
        }
      },
      outputSettings: {
        generated: {
          rootSummaryLimit: 500,
          okfLogMaxEntries: 100,
          okfLogMaxBytes: 65_536
        },
        graph: {}, semantic: {}, search: {},
        directoryLeafLimits: {
          maxEntries: 50,
          maxBytes: 65_536,
          mergeBelowEntries: 12
        }
      } as never,
      baseRevision: 3,
      completedAt: "2026-08-14T16:00:00.000Z",
      signal: new AbortController().signal
    });

    expect(result.removedDirectoryPrefixes).toEqual(["pages/Guides"]);
    const rootNavigation = result.navigationPages.find((page) =>
      page.logicalPath === "pages/index.md");
    const markdown = new TextDecoder().decode(rootNavigation!.bytes);
    expect(markdown).not.toContain("Guides");
    const leafNavigation = result.navigationPages.find((page) =>
      page.logicalPath === "pages/index-leaf-root.md");
    const leafMarkdown = new TextDecoder().decode(leafNavigation!.bytes);
    expect(leafMarkdown).toContain("retained.md");
    expect(leafMarkdown).not.toContain("Guides");
    const retained = result.renderedPages.find((page) =>
      page.logicalPath === "pages/retained.md");
    expect(new TextDecoder().decode(retained!.bytes)).not.toContain("deleted.md");
    expect(result.generatedSources[0]?.modelSuggestions?.keywords)
      .toEqual(["retained-keyword"]);
  });
});
