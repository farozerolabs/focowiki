import { describe, expect, it } from "vitest";
import { documentDeletionProjectionScopes } from
  "../src/document-indexing/application/document-deletion-projection-scopes.js";

describe("document deletion projection scopes", () => {
  it("targets only affected portable machine and root scopes", () => {
    expect(documentDeletionProjectionScopes({
      deletedSources: [{
        sourceFilePublicId: "source-deleted",
        logicalPath: "guides/old/deleted.md"
      }],
      affectedSurvivors: [{
        sourceFilePublicId: "source-survivor",
        logicalPath: "guides/current.md"
      }],
      obsoleteRelationPublicIds: ["relation-deleted"],
      termBuckets: ["han", "latin"]
    })).toEqual([
      { kind: "_graph", key: "catalog" },
      { kind: "_graph", key: "directory:pages" },
      { kind: "_graph", key: "directory:pages/guides" },
      { kind: "_graph", key: "directory:pages/guides/old" },
      { kind: "_graph", key: "file-directory:pages" },
      { kind: "_graph", key: "file-directory:pages/guides" },
      { kind: "_graph", key: "file-directory:pages/guides/old" },
      { kind: "_graph", key: "source-deleted" },
      { kind: "_graph", key: "source-survivor" },
      { kind: "_index", key: "pages:pages" },
      { kind: "_index", key: "pages:pages/guides" },
      { kind: "_index", key: "pages:pages/guides/old" },
      { kind: "_index", key: "term-catalog" },
      { kind: "_index", key: "term:han" },
      { kind: "_index", key: "term:latin" },
      { kind: "root", key: "index" }
    ]);
  });

  it("omits graph scopes when no relation endpoint is affected", () => {
    expect(documentDeletionProjectionScopes({
      deletedSources: [{
        sourceFilePublicId: "source-only",
        logicalPath: "plain.md"
      }],
      affectedSurvivors: [],
      obsoleteRelationPublicIds: [],
      termBuckets: []
    })).toEqual([
      { kind: "_index", key: "pages:pages" },
      { kind: "root", key: "index" }
    ]);
  });
});
