import { describe, expect, it } from "vitest";
import { buildDocumentPublicationAffectedClosure } from
  "../src/document-indexing/application/document-publication-affected-closure.js";

describe("document publication affected closure", () => {
  it("builds one canonical closure for source, paths, ancestors and relations", () => {
    const closure = buildDocumentPublicationAffectedClosure({
      planningMode: "delta",
      documents: [{
        mutationPublicId: "mutation-1",
        documentJobPublicId: "job-1",
        sourceFilePublicId: "source-a",
        sourceRevisionPublicId: "revision-a",
        readinessSequence: 7,
        operation: "move",
        priorLogicalPath: "old/a.md",
        nextLogicalPath: "new/deep/a.md",
        priorTermBuckets: ["old-term"], nextTermBuckets: ["new-term"],
        relatedSourceFilePublicIds: ["source-b"],
        priorGraphDirectoryPaths: ["pages/old"],
        nextGraphDirectoryPaths: ["pages/new/deep"]
      }]
    });
    expect(closure.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "source", publicId: "source-a" }),
      expect.objectContaining({ kind: "relation_endpoint", publicId: "source-b" }),
      expect.objectContaining({ kind: "directory", publicId: "pages" }),
      expect.objectContaining({ kind: "directory", publicId: "pages/new/deep" }),
      expect.objectContaining({ kind: "term_bucket", publicId: "new-term" }),
      expect.objectContaining({ kind: "graph_directory", publicId: "pages/new/deep" }),
      expect.objectContaining({ kind: "search_owner", publicId: "source-b" }),
      expect.objectContaining({ kind: "tombstone", publicId: "source-a" }),
      expect.objectContaining({ kind: "root", publicId: "index.md" })
    ]));
    expect(closure.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects an ordinary delta without an affected closure", () => {
    expect(() => buildDocumentPublicationAffectedClosure({
      planningMode: "delta", documents: []
    })).toThrowError(expect.objectContaining({
      code: "publication_delta_closure_incomplete"
    }));
  });

  it.each([
    ["create", null, "new/a.md"],
    ["replace", "old/a.md", "old/a.md"],
    ["rename", "old/a.md", "old/b.md"],
    ["move", "old/a.md", "new/deep/a.md"],
    ["delete", "old/a.md", null],
    ["repair", "old/a.md", "old/a.md"]
  ] as const)("uses the canonical closure for %s mutations",
    (operation, priorLogicalPath, nextLogicalPath) => {
      const closure = buildDocumentPublicationAffectedClosure({
        planningMode: operation === "repair" ? "repair" : "delta",
        documents: [document({
          operation: operation === "rename" ? "move" : operation,
          priorLogicalPath, nextLogicalPath,
          relatedSourceFilePublicIds: ["source-neighbor"]
        })]
      });

      expect(closure.members).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "source", publicId: "source-a" }),
        expect.objectContaining({
          kind: "relation_endpoint", publicId: "source-neighbor"
        }),
        expect.objectContaining({ kind: "directory", publicId: "pages" })
      ]));
      if (priorLogicalPath) {
        expect(closure.members).toContainEqual(expect.objectContaining({
          kind: "prior_path", publicId: priorLogicalPath
        }));
      }
      if (nextLogicalPath) {
        expect(closure.members).toContainEqual(expect.objectContaining({
          kind: "successor_path", publicId: nextLogicalPath
        }));
      }
    });

  it.each([
    ["relation add", [], ["source-neighbor"]],
    ["relation remove", ["source-neighbor"], []]
  ] as const)("keeps reciprocal endpoints for %s",
    (_name, priorRelations, nextRelations) => {
      const closure = buildDocumentPublicationAffectedClosure({
        planningMode: "delta",
        documents: [document({
          relatedSourceFilePublicIds: [...new Set([
            ...priorRelations, ...nextRelations
          ])]
        })]
      });
      expect(closure.members).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "relation_endpoint", publicId: "source-neighbor",
          sourceFilePublicId: "source-neighbor"
        }),
        expect.objectContaining({
          kind: "search_owner", publicId: "source-neighbor",
          sourceFilePublicId: "source-neighbor"
        })
      ]));
    });

  it("covers both sides of directory split and merge mutations", () => {
    const closure = buildDocumentPublicationAffectedClosure({
      planningMode: "delta",
      documents: [
        document({
          operation: "move",
          priorLogicalPath: "combined/a.md",
          nextLogicalPath: "split/left/a.md",
          priorGraphDirectoryPaths: ["pages/combined"],
          nextGraphDirectoryPaths: ["pages/split/left"]
        }),
        document({
          sourceFilePublicId: "source-b",
          sourceRevisionPublicId: "revision-b",
          operation: "move",
          priorLogicalPath: "split/right/b.md",
          nextLogicalPath: "combined/b.md",
          priorGraphDirectoryPaths: ["pages/split/right"],
          nextGraphDirectoryPaths: ["pages/combined"]
        })
      ]
    });
    for (const path of [
      "pages/combined", "pages/split", "pages/split/left",
      "pages/split/right"
    ]) {
      expect(closure.members).toContainEqual(expect.objectContaining({
        kind: "directory", publicId: path
      }));
    }
  });

  it("is bytewise deterministic across contributor order", () => {
    const first = document({ sourceFilePublicId: "source-a",
      sourceRevisionPublicId: "revision-a", nextLogicalPath: "a.md" });
    const second = document({ sourceFilePublicId: "source-b",
      sourceRevisionPublicId: "revision-b", nextLogicalPath: "b.md" });
    const forward = buildDocumentPublicationAffectedClosure({
      planningMode: "delta", documents: [first, second]
    });
    const reverse = buildDocumentPublicationAffectedClosure({
      planningMode: "delta", documents: [second, first]
    });

    expect(reverse).toEqual(forward);
  });

  it("allows an empty initial knowledge base without inventing members", () => {
    expect(buildDocumentPublicationAffectedClosure({
      planningMode: "initial", documents: []
    }).members).toEqual([]);
  });
});

function document(overrides: Partial<Parameters<
  typeof buildDocumentPublicationAffectedClosure
>[0]["documents"][number]> = {}) {
  return {
    mutationPublicId: "mutation-a",
    documentJobPublicId: "job-a",
    sourceFilePublicId: "source-a",
    sourceRevisionPublicId: "revision-a",
    readinessSequence: 1,
    operation: "create" as const,
    priorLogicalPath: null,
    nextLogicalPath: "new/a.md",
    priorTermBuckets: [],
    nextTermBuckets: [],
    relatedSourceFilePublicIds: [],
    priorGraphDirectoryPaths: [],
    nextGraphDirectoryPaths: [],
    ...overrides
  };
}
