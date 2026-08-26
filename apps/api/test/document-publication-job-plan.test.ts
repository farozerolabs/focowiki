import { describe, expect, it } from "vitest";
import { eligibleDocumentPublicationWork } from
  "../src/document-indexing/application/document-publication-work-order.js";
import { planDocumentPublicationJob } from
  "../src/document-indexing/application/document-publication-job-plan.js";

describe("document publication job plan", () => {
  it.each([
    ["create", delta()],
    ["graph change", delta({ relatedSourceFilePublicIds: ["source-b"] })],
    ["term change", delta({ nextTermBuckets: ["han"] })],
    ["replace", delta({
      operation: "replace", priorLogicalPath: "docs/a.md",
      nextLogicalPath: "docs/a.md", sourceRevisionPublicId: "revision-b"
    })],
    ["move", delta({
      operation: "move", priorLogicalPath: "old/a.md",
      nextLogicalPath: "new/a.md"
    })],
    ["delete", delta({
      operation: "delete", priorLogicalPath: "old/a.md",
      nextLogicalPath: null, documentJobPublicId: null,
      mutationPublicId: "delete-source-a"
    })]
  ])("plans one closed deterministic local work order for %s",
    (name, document) => {
    const plan = planDocumentPublicationJob({
      jobPublicId: "publication-job-a",
      targetReadinessSequence: document.readinessSequence,
      rendererContractVersion: "portable-okf-v5",
      deterministicChangedAt: "2026-08-25T12:00:00.000Z",
      documents: [document]
    });
    expect(plan.work.at(-1)?.identity)
      .toBe("validation:publication-job-a");
    expect(plan.work.some((node) => node.identity === "root:index"))
      .toBe(true);
    expect(new Set(plan.work.map((node) => node.identity)).size)
      .toBe(plan.work.length);
    if (name === "graph change") {
      expect(plan.work.some((node) => node.identity === "_graph:catalog"))
        .toBe(true);
    }
    if (name === "move") {
      expect(plan.putPaths).toEqual(["pages/new/a.md"]);
      expect(plan.deletePaths).toEqual([
        "_graph/by-file/old/a.json",
        "pages/old/a.md"
      ]);
    }
    if (name === "replace") {
      expect(plan.putPaths).toEqual(["pages/docs/a.md"]);
      expect(plan.deletePaths).toEqual([]);
    }
    if (name === "delete") {
      expect(plan.tombstoneSourceFilePublicIds).toEqual(["source-a"]);
      expect(plan.deletePaths).toEqual([
        "_graph/by-file/old/a.json",
        "pages/old/a.md"
      ]);
    }
  });

  it("deduplicates shared directory work across frozen items", () => {
    const plan = planDocumentPublicationJob({
      jobPublicId: "publication-job-hot",
      targetReadinessSequence: 2,
      rendererContractVersion: "portable-okf-v5",
      deterministicChangedAt: "2026-08-25T12:00:00.000Z",
      documents: [
        delta({ nextLogicalPath: "same/a.md" }),
        delta({
          documentJobPublicId: "job-b", sourceFilePublicId: "source-b",
          sourceRevisionPublicId: "revision-b", readinessSequence: 2,
          nextLogicalPath: "same/b.md"
        })
      ]
    });
    expect(plan.work.filter((node) =>
      node.identity === "directory:pages/same")).toHaveLength(1);
  });

  it("makes independent leaves eligible before their parents", () => {
    const plan = planDocumentPublicationJob({
      jobPublicId: "publication-job-order",
      targetReadinessSequence: 1,
      rendererContractVersion: "portable-okf-v5",
      deterministicChangedAt: "2026-08-25T12:00:00.000Z",
      documents: [delta({ relatedSourceFilePublicIds: ["source-b"] })]
    });
    const first = eligibleDocumentPublicationWork({
      work: plan.work,
      completedIdentities: new Set(),
      runningIdentities: new Set(),
      limit: 100
    });
    expect(first.some((scope) => scope.identity === "source:source-a"))
      .toBe(true);
    expect(first.some((scope) => scope.identity === "root:index"))
      .toBe(false);
  });
});

function delta(overrides: Record<string, unknown> = {}) {
  return {
    mutationPublicId: "job-a",
    documentJobPublicId: "job-a",
    sourceFilePublicId: "source-a",
    sourceRevisionPublicId: "revision-a",
    readinessSequence: 1,
    operation: "create" as const,
    priorLogicalPath: null,
    nextLogicalPath: "docs/a.md",
    priorTermBuckets: [],
    nextTermBuckets: [],
    relatedSourceFilePublicIds: [],
    priorGraphDirectoryPaths: [],
    nextGraphDirectoryPaths: [],
    ...overrides
  };
}
