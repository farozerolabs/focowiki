import { describe, expect, it } from "vitest";
import {
  assertDocumentProjectionDirectoryOwnership,
  assertDocumentProjectionPathOwnership,
  documentProjectionScopeIdentity,
  isDocumentProjectionDirectoryOwnedBy,
  isDocumentProjectionPathOwnedBy,
  normalizeDocumentProjectionOwnedPath
} from
  "../src/document-indexing/application/document-projection-path-ownership.js";

const cases = [{
  scope: { kind: "source" as const, key: "source-a" },
  logicalPath: "pages/Guides/Document.md",
  sourceFilePublicId: "source-a"
}, {
  scope: { kind: "directory" as const, key: "pages/Guides" },
  logicalPath: "pages/Guides/index.md"
}, {
  scope: { kind: "_index" as const, key: "pages:pages/Guides" },
  logicalPath: "_index/pages/Guides/Guides-documents.json"
}, {
  scope: { kind: "_index" as const, key: "term:han" },
  logicalPath: "_index/terms/han/han-terms-part-0001.json"
}, {
  scope: { kind: "_index" as const, key: "term-catalog" },
  logicalPath: "_index/terms/index.json"
}, {
  scope: { kind: "_graph" as const, key: "source-a" },
  logicalPath: "_graph/by-file/Guides/Document.json",
  sourceFilePublicId: "source-a"
}, {
  scope: { kind: "_graph" as const, key: "directory:pages/Guides" },
  logicalPath: "_graph/by-directory/Guides/Guides-relationships.json"
}, {
  scope: { kind: "_graph" as const, key: "file-directory:pages/Guides" },
  logicalPath: "_graph/by-file/Guides/index.md"
}, {
  scope: { kind: "_graph" as const, key: "catalog" },
  logicalPath: "_graph/catalog.json"
}, {
  scope: { kind: "root" as const, key: "index" },
  logicalPath: "_graph/index-extension-leaf-stable.md"
}];

describe("document projection path ownership", () => {
  it("normalizes canonical paths without locale-dependent ordering", () => {
    expect(normalizeDocumentProjectionOwnedPath("pages/Guides/É.md"))
      .toBe("pages/guides/é.md");
    expect(() => normalizeDocumentProjectionOwnedPath("pages/../secret.md"))
      .toThrow();
  });

  it("assigns every exact and dynamic path family to one scope", () => {
    for (const item of cases) {
      expect(isDocumentProjectionPathOwnedBy(item)).toBe(true);
      const otherOwners = cases.filter((candidate) =>
        documentProjectionScopeIdentity(candidate.scope)
          !== documentProjectionScopeIdentity(item.scope)
        && isDocumentProjectionPathOwnedBy({
          scope: candidate.scope,
          logicalPath: item.logicalPath,
          sourceFilePublicId: item.sourceFilePublicId ?? null
        }));
      expect(otherOwners).toEqual([]);
    }
  });

  it("assigns ordered navigation directories to one scope", () => {
    const root = { kind: "root" as const, key: "index" };
    expect(isDocumentProjectionDirectoryOwnedBy({
      scope: root,
      directoryPath: "_graph"
    })).toBe(true);
    expect(isDocumentProjectionDirectoryOwnedBy({
      scope: { kind: "_graph", key: "catalog" },
      directoryPath: "_graph"
    })).toBe(false);
  });

  it("rejects pages and directory mutations outside the declared owner", () => {
    expect(() => assertDocumentProjectionPathOwnership({
      scope: { kind: "root", key: "index" },
      logicalPath: "_graph/catalog.json"
    })).toThrow(expect.objectContaining({
      code: "projection_path_owner_mismatch"
    }));
    expect(() => assertDocumentProjectionDirectoryOwnership({
      scope: { kind: "_index", key: "term:han" },
      directoryPath: "_index/terms/latin"
    })).toThrow(expect.objectContaining({
      code: "projection_directory_owner_mismatch"
    }));
  });
});
