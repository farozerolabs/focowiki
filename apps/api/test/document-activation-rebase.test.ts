import { describe, expect, it } from "vitest";
import {
  rebaseDocumentActivationOwnerVersions
} from "../src/document-indexing/application/document-activation-rebase.js";

describe("document activation rebase", () => {
  it("rebases stale shared owners without changing their desired values", () => {
    const owners = rebaseDocumentActivationOwnerVersions({
      desired: [{
        kind: "source",
        key: "source-1",
        expectedVersion: 0,
        activeSourceRevisionPublicId: "revision-1",
        activePageCandidatePublicId: null
      }, {
        kind: "page_head",
        key: "_index/index.md",
        expectedVersion: 2,
        activeSourceRevisionPublicId: null,
        activePageCandidatePublicId: "candidate-latest"
      }],
      current: [{
        kind: "source",
        key: "source-1",
        version: 0
      }, {
        kind: "page_head",
        key: "_index/index.md",
        version: 7
      }]
    });

    expect(owners).toEqual([{
      kind: "source",
      key: "source-1",
      expectedVersion: 0,
      activeSourceRevisionPublicId: "revision-1",
      activePageCandidatePublicId: null
    }, {
      kind: "page_head",
      key: "_index/index.md",
      expectedVersion: 7,
      activeSourceRevisionPublicId: null,
      activePageCandidatePublicId: "candidate-latest"
    }]);
  });

  it("rejects an incomplete current owner snapshot", () => {
    expect(() => rebaseDocumentActivationOwnerVersions({
      desired: [{
        kind: "source",
        key: "source-1",
        expectedVersion: 0,
        activeSourceRevisionPublicId: "revision-1",
        activePageCandidatePublicId: null
      }],
      current: []
    })).toThrowError(/activation_owner_snapshot_incomplete/u);
  });
});
