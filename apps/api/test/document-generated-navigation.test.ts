import { describe, expect, it } from "vitest";
import {
  renderDocumentDirectoryPages,
  renderDocumentDirectoryMutationPages,
  renderDocumentRootPage,
  selectDocumentDirectoryRefreshLeaves
} from "../src/document-indexing/application/document-generated-navigation.js";

describe("document generated navigation", () => {
  it("preserves root links across index, graph, and machine-readable navigation", () => {
    const root = text(renderDocumentRootPage({
      path: "index.md",
      knowledgeBase: {
        id: "knowledge-base-a", name: "General Knowledge",
        description: null, sourceFileCount: 2, graphEdgeCount: 1
      },
      rootEntryCount: 1
    }));
    expect(root).toContain("[Browse documents](pages/index.md)");
    expect(root).toContain("[Relationship graph](_graph/index.md)");
    expect(root).toContain("[Machine-readable indexes](_index/index.md)");
    expect(root).not.toContain("schema.md");
    expect(root).not.toContain("Metadata schema");
  });

  it("applies root summary and update-log limits without publication wording", () => {
    const root = text(renderDocumentRootPage({
      path: "index.md",
      knowledgeBase: {
        id: "knowledge-base-a",
        name: "General Knowledge",
        description: "A long general-purpose description",
        sourceFileCount: 2,
        graphEdgeCount: 1
      },
      rootEntryCount: 1,
      limits: {
        rootSummaryLimit: 8,
        okfLogMaxEntries: 1,
        okfLogMaxBytes: 1_024
      }
    }));
    const log = text(renderDocumentRootPage({
      path: "log.md",
      knowledgeBase: {
        id: "knowledge-base-a",
        name: "General Knowledge",
        description: null,
        sourceFileCount: 2,
        graphEdgeCount: 1,
        changedAt: "2026-08-14T10:00:00.000Z"
      },
      rootEntryCount: 1,
      limits: {
        rootSummaryLimit: 8,
        okfLogMaxEntries: 1,
        okfLogMaxBytes: 1_024
      },
      logEntries: [{
        occurredAt: "2026-08-13T10:00:00.000Z",
        action: "Indexed document",
        message: "Indexed an older document."
      }]
    }));

    expect(root).toContain("A long g…");
    expect(log).toContain("The bundle contains 2 Markdown pages");
    expect(log).not.toContain("Indexed");
    expect(log).not.toContain("older document");
    expect(log).not.toContain("Publication");
    expect(Buffer.byteLength(log, "utf8")).toBeLessThanOrEqual(1_024);
  });

  it("preserves stable leaf paths and mutual directory navigation", () => {
    const pages = renderDocumentDirectoryPages({
      directoryPath: "pages/guides",
      entryCount: 2,
      leaves: [{
        id: "stable-a", previousLeafId: null, nextLeafId: "stable-b",
        revision: 1,
        changedAt: "2026-08-16T09:02:54.694Z",
        entries: [{
          id: "source-a", sortKey: "a.md", name: "A",
          targetPath: "pages/guides/a.md", kind: "file"
        }]
      }, {
        id: "stable-b", previousLeafId: "stable-a", nextLeafId: null,
        revision: 1,
        entries: [{
          id: "source-b", sortKey: "b.md", name: "B",
          targetPath: "pages/guides/b.md", kind: "file"
        }]
      }]
    });
    expect(pages.map((item) => item.logicalPath)).toEqual([
      "pages/guides/index.md",
      "pages/guides/index-stable-a.md",
      "pages/guides/index-stable-b.md"
    ]);
    expect(text(pages[0]!)).toContain("[Browse entries](index-stable-a.md)");
    expect(text(pages[1]!)).toContain("[Next](index-stable-b.md)");
    expect(text(pages[1]!)).not.toContain("generated:");
    expect(text(pages[1]!)).not.toContain("leaf_id:");
    expect(text(pages[1]!)).not.toContain("entry_count:");
    expect(text(pages[2]!)).toContain("[Previous](index-stable-a.md)");
  });

  it("keeps the machine-readable index catalog reachable from its directory root", () => {
    const [root] = renderDocumentDirectoryPages({
      directoryPath: "_index",
      entryCount: 0,
      leaves: []
    });

    expect(text(root!)).toContain("[Index catalog](catalog.json)");
  });

  it("renders only touched leaf pages while keeping the directory root linked", () => {
    const pages = renderDocumentDirectoryMutationPages({
      directoryPath: "pages/guides",
      entryCount: 20,
      firstLeafId: "stable-a",
      touchedLeaves: [{
        id: "stable-b", previousLeafId: "stable-a", nextLeafId: "stable-c",
        revision: 2,
        entries: [{
          id: "source-b", sortKey: "b.md", name: "B",
          targetPath: "pages/guides/b.md", kind: "file"
        }]
      }]
    });
    expect(pages.map((item) => item.logicalPath)).toEqual([
      "pages/guides/index.md",
      "pages/guides/index-stable-b.md"
    ]);
    expect(text(pages[0]!)).toContain("index-stable-a.md");
  });

  it("refreshes the containing stable leaf during maintenance without widening normal updates", () => {
    const leaves = [{
      id: "stable-a", previousLeafId: null, nextLeafId: "stable-b",
      revision: 1,
      entries: [{
        id: "directory:guides", sortKey: "guides", name: "guides",
        targetPath: "pages/guides/index.md", kind: "directory" as const
      }]
    }, {
      id: "stable-b", previousLeafId: "stable-a", nextLeafId: null,
      revision: 1,
      entries: [{
        id: "source-b", sortKey: "b.md", name: "B",
        targetPath: "pages/b.md", kind: "file" as const
      }]
    }];

    expect(selectDocumentDirectoryRefreshLeaves({
      leaves,
      touchedLeafIds: [],
      refreshedEntryIds: ["directory:guides"],
      maintenanceRebuild: true
    }).map((leaf) => leaf.id)).toEqual(["stable-a"]);
    expect(selectDocumentDirectoryRefreshLeaves({
      leaves,
      touchedLeafIds: [],
      refreshedEntryIds: ["directory:guides"],
      maintenanceRebuild: false
    })).toEqual([]);
  });

});

function text(page: { bytes: Uint8Array }): string {
  return new TextDecoder().decode(page.bytes);
}
