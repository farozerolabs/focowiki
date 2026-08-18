import { describe, expect, it } from "vitest";
import { mergeDocumentProjectionScopeOutputs } from
  "../src/document-indexing/application/document-projection-scope-output-merge.js";

describe("document projection scope output merge", () => {
  it("assembles exact candidates, removals, and navigation without cross-scope conflicts", () => {
    const page = {
      logicalPath: "_index/pages/guides/index.json",
      normalizedPath: "_index/pages/guides/index.json",
      entryKind: "page_directory",
      sourceFilePublicId: null,
      sourceRevisionPublicId: null,
      objectId: "object-guides",
      checksumSha256: "a".repeat(64),
      byteCount: 128
    };
    const candidate = {
      ...page,
      pageCandidatePublicId: "candidate-guides"
    };
    expect(mergeDocumentProjectionScopeOutputs({
      outputs: [{
        pages: [page],
        removedNormalizedPaths: ["_index/pages/old/index.json"],
        navigationMutations: [{
          directoryPath: "_index/pages/guides",
          touchedLeaves: [],
          removedLeafIds: ["old-leaf"]
        }]
      }],
      candidates: [candidate]
    })).toEqual({
      pageCandidates: [candidate],
      removedPageNormalizedPaths: ["_index/pages/old/index.json"],
      navigationMutations: [{
        directoryPath: "_index/pages/guides",
        touchedLeaves: [],
        removedLeafIds: ["old-leaf"]
      }]
    });
  });

  it("rejects two scopes that claim different output for one logical path", () => {
    const base = {
      logicalPath: "_index/catalog.json",
      normalizedPath: "_index/catalog.json",
      entryKind: "catalog",
      sourceFilePublicId: null,
      sourceRevisionPublicId: null,
      objectId: "object-a",
      checksumSha256: "a".repeat(64),
      byteCount: 10
    };
    expect(() => mergeDocumentProjectionScopeOutputs({
      outputs: [{ pages: [base], removedNormalizedPaths: [],
        navigationMutations: [] }, {
        pages: [{ ...base, objectId: "object-b", checksumSha256: "b".repeat(64) }],
        removedNormalizedPaths: [], navigationMutations: []
      }],
      candidates: [{ ...base, pageCandidatePublicId: "candidate-a" }]
    })).toThrow(expect.objectContaining({
      code: "projection_scope_page_conflict"
    }));
  });

  it("rejects an output page without the contributor-owned staged candidate", () => {
    expect(() => mergeDocumentProjectionScopeOutputs({
      outputs: [{
        pages: [{
          logicalPath: "index.md", normalizedPath: "index.md",
          entryKind: "index", sourceFilePublicId: null,
          sourceRevisionPublicId: null, objectId: "object-root",
          checksumSha256: "c".repeat(64), byteCount: 20
        }],
        removedNormalizedPaths: [], navigationMutations: []
      }],
      candidates: []
    })).toThrow(expect.objectContaining({
      code: "projection_scope_candidate_missing"
    }));
  });
});
