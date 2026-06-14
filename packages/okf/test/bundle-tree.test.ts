import { describe, expect, it } from "vitest";
import { buildBundleTreeEntries } from "../src/bundle-tree.js";

describe("buildBundleTreeEntries", () => {
  it("creates directory and file nodes with normalized parent paths", () => {
    const entries = buildBundleTreeEntries({
      knowledgeBaseId: "kb-001",
      releaseId: "release-001",
      files: [
        { id: "file-index", logicalPath: "index.md" },
        { id: "file-page", logicalPath: "pages/intro.md" },
        { id: "file-search", logicalPath: "_index/search.json" },
        { id: "file-nested", logicalPath: "pages/guides/install.md" }
      ],
      createId: (entry) => `entry-${entry.entryType}-${entry.logicalPath}`
    });

    expect(entries).toEqual([
      {
        id: "entry-file-index.md",
        knowledgeBaseId: "kb-001",
        releaseId: "release-001",
        parentPath: "",
        name: "index.md",
        logicalPath: "index.md",
        entryType: "file",
        bundleFileId: "file-index"
      },
      {
        id: "entry-directory-pages",
        knowledgeBaseId: "kb-001",
        releaseId: "release-001",
        parentPath: "",
        name: "pages",
        logicalPath: "pages",
        entryType: "directory",
        bundleFileId: null
      },
      {
        id: "entry-file-pages/intro.md",
        knowledgeBaseId: "kb-001",
        releaseId: "release-001",
        parentPath: "pages",
        name: "intro.md",
        logicalPath: "pages/intro.md",
        entryType: "file",
        bundleFileId: "file-page"
      },
      {
        id: "entry-directory-_index",
        knowledgeBaseId: "kb-001",
        releaseId: "release-001",
        parentPath: "",
        name: "_index",
        logicalPath: "_index",
        entryType: "directory",
        bundleFileId: null
      },
      {
        id: "entry-file-_index/search.json",
        knowledgeBaseId: "kb-001",
        releaseId: "release-001",
        parentPath: "_index",
        name: "search.json",
        logicalPath: "_index/search.json",
        entryType: "file",
        bundleFileId: "file-search"
      },
      {
        id: "entry-directory-pages/guides",
        knowledgeBaseId: "kb-001",
        releaseId: "release-001",
        parentPath: "pages",
        name: "guides",
        logicalPath: "pages/guides",
        entryType: "directory",
        bundleFileId: null
      },
      {
        id: "entry-file-pages/guides/install.md",
        knowledgeBaseId: "kb-001",
        releaseId: "release-001",
        parentPath: "pages/guides",
        name: "install.md",
        logicalPath: "pages/guides/install.md",
        entryType: "file",
        bundleFileId: "file-nested"
      }
    ]);
  });

  it("rejects unsafe logical paths before tree persistence", () => {
    expect(() =>
      buildBundleTreeEntries({
        knowledgeBaseId: "kb-001",
        releaseId: "release-001",
        files: [{ id: "file-bad", logicalPath: "pages/../secret.md" }]
      })
    ).toThrow(/logical path/i);
  });
});
