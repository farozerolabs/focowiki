import { describe, expect, it } from "vitest";
import {
  decideDocumentPublicationCutoverEligibility,
  inferDocumentPublicationOwnerCandidate
} from "../src/document-indexing/application/document-publication-cutover-preflight.js";

describe("document publication cutover preflight", () => {
  it.each([
    ["pages/guides/a.md", "source-a", "source:source-a"],
    ["pages/guides/index.md", null, "directory:pages/guides"],
    ["_index/pages/guides/records.json", null, "_index:pages:pages/guides"],
    ["_index/terms/han/records.json", null, "_index:term:han"],
    ["_graph/catalog.json", null, "_graph:catalog"],
    ["_graph/by-file/guides/a.json", "source-a", "_graph:source-a"],
    ["index.md", null, "root:index"]
  ])("infers one owner for %s", (normalizedPath, sourceFilePublicId, expected) => {
    expect(inferDocumentPublicationOwnerCandidate({
      normalizedPath,
      sourceFilePublicId
    })?.scopeIdentity).toBe(expected);
  });

  it("reports every cutover blocker without changing data", () => {
    expect(decideDocumentPublicationCutoverEligibility({
      activePathCount: 4,
      unresolvedOwnerCount: 1,
      duplicateProducerPathCount: 2,
      unfinishedWorkCount: 3,
      unverifiedObjectCount: 4,
      searchOwnerMismatchCount: 5
    })).toEqual({
      eligible: false,
      blockers: [
        "unresolved_path_owner", "duplicate_path_producer",
        "unfinished_document_work", "unverified_referenced_object",
        "search_owner_mismatch"
      ]
    });
  });
});
