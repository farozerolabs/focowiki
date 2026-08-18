import { describe, expect, it } from "vitest";
import {
  documentActivationOwnerRequests,
  documentProjectionAvailableSourceFileIds,
  documentProjectionGraphDirectoryPaths,
  documentProjectionActivationOwnerVersions,
  documentProjectionHeadLookupPaths,
  documentProjectionScopes,
  documentProjectionSourceFileIds,
  shouldProjectDocumentGraphDirectories
} from
  "../src/document-indexing/infrastructure/document-knowledge-projection-support.js";

describe("document knowledge projection support", () => {
  it("reconciles prior graph directories when the last relationship disappears", () => {
    expect(shouldProjectDocumentGraphDirectories({
      relationCount: 0,
      affectedSourceFileCount: 1,
      hasPriorPresentation: true
    })).toBe(true);
    expect(shouldProjectDocumentGraphDirectories({
      relationCount: 0,
      affectedSourceFileCount: 1,
      hasPriorPresentation: false
    })).toBe(false);
  });

  it("dirties both old and new by-file ancestors when a related file moves", () => {
    expect(documentProjectionGraphDirectoryPaths({
      enabled: true,
      currentSourceFilePublicId: "source-current",
      affectedSourceFilePublicIds: ["source-current", "source-neighbor"],
      sourcePaths: [{
        sourceFilePublicId: "source-current",
        logicalPath: "new/current.md"
      }, {
        sourceFilePublicId: "source-neighbor",
        logicalPath: "reference/neighbor.md"
      }],
      priorCurrentLogicalPath: "old/nested/current.md"
    })).toEqual([
      "pages",
      "pages/new",
      "pages/old",
      "pages/old/nested",
      "pages/reference"
    ]);
  });

  it("does not dirty graph scopes for a relation-free document", () => {
    expect(documentProjectionScopes({
      relationPublicIds: [],
      graphSourceFilePublicIds: [],
      navigationMutations: [{ directoryPath: "pages/guides" }],
      pages: [{ sourceFilePublicId: "source-a" }],
      termBuckets: ["han", "han"]
    })).toEqual([
      { kind: "source", key: "source-a" },
      { kind: "directory", key: "pages/guides" },
      { kind: "_index", key: "pages:pages/guides" },
      { kind: "_index", key: "term:han" },
      { kind: "_index", key: "term-catalog" },
      { kind: "root", key: "index" }
    ]);
  });

  it("derives shared scopes from factual paths without rendered extensions", () => {
    expect(documentProjectionScopes({
      relationPublicIds: [],
      sourceFilePublicIds: ["source-a"],
      directoryPaths: ["pages", "pages/guides"],
      graphDirectoryPaths: [],
      graphSourceFilePublicIds: [],
      navigationMutations: [],
      pages: [],
      termBuckets: ["han", "latin"]
    })).toEqual([
      { kind: "source", key: "source-a" },
      { kind: "directory", key: "pages" },
      { kind: "directory", key: "pages/guides" },
      { kind: "_index", key: "pages:pages" },
      { kind: "_index", key: "pages:pages/guides" },
      { kind: "_index", key: "term:han" },
      { kind: "_index", key: "term:latin" },
      { kind: "_index", key: "term-catalog" },
      { kind: "root", key: "index" }
    ]);
  });

  it("dirties only exact graph owners when relationships change", () => {
    expect(documentProjectionScopes({
      relationPublicIds: ["relation-b", "relation-a"],
      graphSourceFilePublicIds: ["source-b", "source-a", "source-b"],
      navigationMutations: [
        { directoryPath: "_graph/by-directory" },
        { directoryPath: "_graph/by-directory/guides" }
      ],
      pages: [{ sourceFilePublicId: "source-a" }],
      termBuckets: []
    })).toEqual([
      { kind: "source", key: "source-a" },
      { kind: "relation", key: "relation-a" },
      { kind: "relation", key: "relation-b" },
      { kind: "directory", key: "_graph/by-directory" },
      { kind: "directory", key: "_graph/by-directory/guides" },
      { kind: "graph", key: "source-a" },
      { kind: "graph", key: "source-b" },
      { kind: "_graph", key: "source-a" },
      { kind: "_graph", key: "source-b" },
      { kind: "_graph", key: "directory:pages" },
      { kind: "_graph", key: "directory:pages/guides" },
      { kind: "_graph", key: "file-directory:pages" },
      { kind: "_graph", key: "file-directory:pages/guides" },
      { kind: "_graph", key: "catalog" },
      { kind: "root", key: "index" }
    ]);
  });

  it("uses the same NFKC owner identity that the activation repository reads", () => {
    const owners = documentActivationOwnerRequests({
      sourceFilePublicId: "source-file-normalized-owner",
      sourceRevisionPublicId: "source-revision-normalized-owner",
      pairPublicIds: [],
      familyPublicIds: [],
      pageCandidates: [{
        normalizedPath: "pages/Constitution（1988）.md",
        pageCandidatePublicId: "page-candidate-normalized-owner"
      }],
      removedPaths: [],
      navigationMutations: [{
        directoryPath: "pages/Constitution（1988）",
        touchedLeaves: [{ id: "leaf（current）", entries: [] }],
        removedLeafIds: []
      }]
    });

    expect(owners.find((owner) => owner.kind === "page_head")?.key)
      .toBe("pages/Constitution(1988).md");
    expect(owners.find((owner) => owner.kind === "directory_leaf")?.key)
      .toBe('["pages/Constitution(1988)","leaf(current)"]');
  });

  it("builds PostgreSQL-safe and unambiguous directory leaf owner keys", () => {
    const owners = documentActivationOwnerRequests({
      sourceFilePublicId: "source-file-safe-owner",
      sourceRevisionPublicId: "source-revision-safe-owner",
      pairPublicIds: [],
      familyPublicIds: [],
      pageCandidates: [],
      removedPaths: [],
      navigationMutations: [{
        directoryPath: "pages/a",
        touchedLeaves: [
          { id: "b/c", entries: [] },
          { id: "c", entries: [] }
        ],
        removedLeafIds: []
      }, {
        directoryPath: "pages/a/b",
        touchedLeaves: [{ id: "c", entries: [] }],
        removedLeafIds: []
      }]
    }).filter((owner) => owner.kind === "directory_leaf");

    expect(owners).toHaveLength(3);
    expect(new Set(owners.map((owner) => owner.key)).size).toBe(3);
    expect(owners.every((owner) => !/[\u0000-\u001f\u007f]/u.test(owner.key)))
      .toBe(true);
  });

  it("locks the same directory entry when concurrent renders place it in different leaves", () => {
    const ownerForLeaf = (leafId: string) => documentActivationOwnerRequests({
      sourceFilePublicId: `source-${leafId}`,
      sourceRevisionPublicId: `revision-${leafId}`,
      pairPublicIds: [],
      familyPublicIds: [],
      pageCandidates: [],
      removedPaths: [],
      navigationMutations: [{
        directoryPath: "pages/guides",
        touchedLeaves: [{
          id: leafId,
          entries: [{ id: "entry-shared" }]
        }],
        removedLeafIds: []
      }]
    }).filter((owner) => owner.kind === "directory_entry");

    expect(ownerForLeaf("leaf-a")).toEqual(ownerForLeaf("leaf-b"));
    expect(ownerForLeaf("leaf-a")).toEqual([{
      kind: "directory_entry",
      key: '["pages/guides","entry-shared"]',
      activeSourceRevisionPublicId: null,
      activePageCandidatePublicId: null
    }]);
  });

  it("leaves graph artifact ownership to independent projection scopes", () => {
    const owners = documentActivationOwnerRequests({
      sourceFilePublicId: "source-file-snapshot",
      sourceRevisionPublicId: "source-revision-snapshot",
      pairPublicIds: [],
      familyPublicIds: [],
      pageCandidates: [{
        normalizedPath: "_index/pages/guides/guides-documents-part-0008.json",
        pageCandidatePublicId: "page-candidate-shard"
      }],
      removedPaths: [],
      navigationMutations: []
    });

    expect(documentProjectionActivationOwnerVersions({
      owners,
      versions: owners.map((owner) => ({ ...owner, version: 9 }))
    }).map((owner) => [owner.kind, owner.key, owner.expectedVersion]))
      .toEqual([
        ["page_head", "_index/pages/guides/guides-documents-part-0008.json", 9],
        ["source", "source-file-snapshot", 9]
      ]);
  });

  it("loads affected files even when their prior relationship was removed", () => {
    expect(documentProjectionSourceFileIds({
      currentSourceFilePublicId: "source-current",
      affectedSourceFilePublicIds: ["source-prior-neighbor", "source-current"],
      relations: []
    })).toEqual(["source-current", "source-prior-neighbor"]);
  });

  it("renders only the current source and affected sources with active bases", () => {
    expect(documentProjectionAvailableSourceFileIds({
      currentSourceFilePublicId: "source-current",
      requestedSourceFilePublicIds: [
        "source-current",
        "source-active-neighbor",
        "source-pending-neighbor"
      ],
      availableBaseSourceFilePublicIds: ["source-active-neighbor"]
    })).toEqual(["source-current", "source-active-neighbor"]);
  });

  it("normalizes Unicode and case before reading active generated heads", () => {
    expect(documentProjectionHeadLookupPaths([
      "_graph/by-directory/regions/区域 A/index.json",
      "_graph/by-directory/regions/区域 a/index.json"
    ])).toEqual(["_graph/by-directory/regions/区域 a/index.json"]);
  });
});
