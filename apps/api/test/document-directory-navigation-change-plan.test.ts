import { describe, expect, it } from "vitest";
import { planDocumentDirectoryNavigationChanges } from
  "../src/document-indexing/application/document-directory-navigation-change-plan.js";
import { documentDirectoryEntryId } from
  "../src/document-indexing/domain/document-directory-entry-identity.js";

describe("document directory navigation change plan", () => {
  it("adds every new ancestor and the source entry with existing path semantics", () => {
    const guidesId = documentDirectoryEntryId("directory", "pages/guides/index.md");
    const deepId = documentDirectoryEntryId(
      "directory",
      "pages/guides/deep/index.md"
    );
    const fileId = documentDirectoryEntryId("file", "pages/guides/deep/a.md");
    expect(planDocumentDirectoryNavigationChanges({
      sourceFilePublicId: "source-a",
      oldLogicalPath: null,
      newLogicalPath: "guides/deep/a.md"
    })).toEqual([{
      directoryPath: "pages",
      changes: [{
        entryId: guidesId,
        desiredEntry: {
          id: guidesId,
          sortKey: `guides/${guidesId}`,
          name: "guides",
          targetPath: "pages/guides/index.md",
          kind: "directory"
        }
      }]
    }, {
      directoryPath: "pages/guides",
      changes: [{
        entryId: deepId,
        desiredEntry: expect.objectContaining({
          targetPath: "pages/guides/deep/index.md",
          kind: "directory"
        })
      }]
    }, {
      directoryPath: "pages/guides/deep",
      changes: [{
        entryId: fileId,
        desiredEntry: {
          id: fileId,
          sortKey: `a.md/${fileId}`,
          name: "a.md",
          targetPath: "pages/guides/deep/a.md",
          kind: "file"
        }
      }]
    }]);
  });

  it("removes the old file entry and adds the moved entry without removing ancestors", () => {
    const plan = planDocumentDirectoryNavigationChanges({
      sourceFilePublicId: "source-a",
      oldLogicalPath: "old/a.md",
      newLogicalPath: "new/a.md"
    });
    const oldId = documentDirectoryEntryId("file", "pages/old/a.md");
    const newId = documentDirectoryEntryId("file", "pages/new/a.md");
    expect(plan.find((item) => item.directoryPath === "pages/old")?.changes)
      .toContainEqual({ entryId: oldId, desiredEntry: null });
    expect(plan.find((item) => item.directoryPath === "pages/new")?.changes)
      .toContainEqual(expect.objectContaining({
        entryId: newId,
        desiredEntry: expect.objectContaining({ targetPath: "pages/new/a.md" })
      }));
  });

  it("keeps directory entry identities bounded for long portable paths", () => {
    const fileName = `${"法".repeat(997)}.md`;
    const plan = planDocumentDirectoryNavigationChanges({
      sourceFilePublicId: "source-long",
      oldLogicalPath: null,
      newLogicalPath: `archive/${fileName}`
    });

    const changes = plan.flatMap((item) => item.changes);
    expect(changes.every((change) => Buffer.byteLength(change.entryId) <= 255))
      .toBe(true);
    expect(changes.some((change) => change.desiredEntry?.targetPath
      .includes(fileName))).toBe(true);
  });
});
