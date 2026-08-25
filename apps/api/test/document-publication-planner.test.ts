import { describe, expect, it } from "vitest";
import { eligibleDocumentPublicationScopes } from
  "../src/document-indexing/application/document-publication-dag.js";
import { planDocumentPublicationGeneration } from
  "../src/document-indexing/application/document-publication-planner.js";
import { documentPublicationScopeMembers } from
  "../src/document-indexing/application/document-publication-snapshot-members.js";
import {
  monotonicDocumentPublicationTargetFactEpoch,
  selectReadyDocumentPublicationWindow
} from
  "../src/document-indexing/application/document-publication-window.js";

describe("document publication planner", () => {
  it("freezes only ready documents inside the adaptive bounded window", () => {
    const documents = [ready("job-b", 2, "2026-08-21T12:00:00.010Z"),
      ready("job-a", 1, "2026-08-21T12:00:00.000Z")];
    expect(selectReadyDocumentPublicationWindow({
      documents,
      now: "2026-08-21T12:00:00.020Z",
      contributorCap: 4
    })).toBeNull();
    const frozen = selectReadyDocumentPublicationWindow({
      documents,
      now: "2026-08-21T12:00:00.100Z",
      contributorCap: 4
    });
    expect(frozen).toMatchObject({
      targetFactEpoch: 2,
      deterministicChangedAt: "2026-08-21T12:00:00.010Z"
    });
    expect(frozen!.documents.map((document) => document.documentJobPublicId))
      .toEqual(["job-a", "job-b"]);
    expect(frozen!.windowMilliseconds).toBeGreaterThanOrEqual(25);
    expect(frozen!.windowMilliseconds).toBeLessThanOrEqual(100);
  });

  it("leaves a document arriving after freeze for the next generation", () => {
    const first = selectReadyDocumentPublicationWindow({
      documents: [ready("job-a", 1, "2026-08-21T12:00:00.000Z")],
      now: "2026-08-21T12:00:00.100Z",
      contributorCap: 1
    })!;
    const next = selectReadyDocumentPublicationWindow({
      documents: [ready("job-b", 2, "2026-08-21T12:00:00.101Z")],
      now: "2026-08-21T12:00:00.201Z",
      contributorCap: 1
    })!;
    expect(first.documents.map((document) => document.documentJobPublicId))
      .toEqual(["job-a"]);
    expect(next.documents.map((document) => document.documentJobPublicId))
      .toEqual(["job-b"]);
  });

  it("coalesces in-flight bulk work without delaying an idle tail", () => {
    const documents = [ready("job-a", 1, "2026-08-21T12:00:00.000Z")];
    expect(selectReadyDocumentPublicationWindow({
      documents,
      now: "2026-08-21T12:00:00.100Z",
      contributorCap: 256,
      inFlightDocumentCount: 99
    })).toBeNull();
    const bulk = selectReadyDocumentPublicationWindow({
      documents,
      now: "2026-08-21T12:00:30.000Z",
      contributorCap: 256,
      inFlightDocumentCount: 99
    });
    expect(bulk).toMatchObject({ inFlightDocumentCount: 99 });
    expect(bulk!.windowMilliseconds).toBeGreaterThanOrEqual(29_000);
    expect(bulk!.windowMilliseconds).toBeLessThanOrEqual(30_000);
    expect(selectReadyDocumentPublicationWindow({
      documents,
      now: "2026-08-21T12:00:00.100Z",
      contributorCap: 256,
      inFlightDocumentCount: 0
    })).toMatchObject({ inFlightDocumentCount: 0 });
  });

  it("flushes a full contributor window immediately under load", () => {
    const documents = Array.from({ length: 4 }, (_, index) => ready(
      `job-${index}`,
      index + 1,
      `2026-08-21T12:00:00.00${index}Z`
    ));
    expect(selectReadyDocumentPublicationWindow({
      documents,
      now: "2026-08-21T12:00:00.004Z",
      contributorCap: 4,
      inFlightDocumentCount: 100
    })?.documents).toHaveLength(4);
  });

  it("keeps publication target epochs monotonic across recovery", () => {
    expect(monotonicDocumentPublicationTargetFactEpoch(11743, 11931))
      .toBe(11931);
    expect(monotonicDocumentPublicationTargetFactEpoch(11932, 11931))
      .toBe(11932);
    expect(() => monotonicDocumentPublicationTargetFactEpoch(0, 11931))
      .toThrow("DOCUMENT_PUBLICATION_FACT_EPOCH_INVALID");
  });

  it.each([
    ["one document", delta()],
    ["hot directory", delta({ sourceFilePublicId: "source-hot" })],
    ["empty graph", delta({ relatedSourceFilePublicIds: [] })],
    ["graph change", delta({ relatedSourceFilePublicIds: ["source-b"] })],
    ["term change", delta({ nextTermBuckets: ["han"] })],
    ["replace", delta({
      operation: "replace", priorLogicalPath: "docs/a.md",
      nextLogicalPath: "docs/a.md", sourceRevisionPublicId: "revision-b"
    })],
    ["rename", delta({
      operation: "move", priorLogicalPath: "docs/old-name.md",
      nextLogicalPath: "docs/new-name.md"
    })],
    ["move", delta({
      operation: "move", priorLogicalPath: "old/a.md",
      nextLogicalPath: "new/a.md"
    })],
    ["relation change", delta({
      relatedSourceFilePublicIds: ["source-b"],
      priorGraphDirectoryPaths: ["pages/old"],
      nextGraphDirectoryPaths: ["pages/new"]
    })],
    ["delete", delta({
      operation: "delete", priorLogicalPath: "old/a.md",
      nextLogicalPath: null, documentJobPublicId: null,
      mutationPublicId: "delete-source-a"
    })],
    ["same path recreate", delta({
      operation: "create", priorLogicalPath: "same/a.md",
      nextLogicalPath: "same/a.md"
    })]
  ])("plans a closed deterministic DAG for %s", (_name, document) => {
    const plan = planDocumentPublicationGeneration({
      generationPublicId: "generation-a",
      baseGenerationPublicId: null,
      targetFactEpoch: document.factEpoch,
      rendererContractVersion: "portable-okf-v2",
      deterministicChangedAt: "2026-08-21T12:00:00.000Z",
      documents: [document]
    });
    expect(plan.scopes.at(-1)?.identity).toBe("validation:generation-a");
    expect(plan.scopes.some((scope) => scope.identity === "root:index"))
      .toBe(true);
    expect(new Set(plan.scopes.map((scope) => scope.identity)).size)
      .toBe(plan.scopes.length);
    if (_name === "empty graph") {
      expect(plan.scopes.some((scope) => scope.identity === "_graph:catalog"))
        .toBe(false);
    }
    if (_name === "graph change") {
      expect(plan.scopes.some((scope) => scope.identity === "_graph:catalog"))
        .toBe(true);
    }
    if (_name === "move") {
      expect(plan.putPaths).toEqual(["pages/new/a.md"]);
      expect(plan.deletePaths).toEqual(["pages/old/a.md"]);
    }
    if (_name === "replace") {
      expect(plan.putPaths).toEqual(["pages/docs/a.md"]);
      expect(plan.deletePaths).toEqual([]);
    }
    if (_name === "rename") {
      expect(plan.putPaths).toEqual(["pages/docs/new-name.md"]);
      expect(plan.deletePaths).toEqual(["pages/docs/old-name.md"]);
    }
    if (_name === "relation change") {
      expect(plan.scopes.some((scope) => scope.identity === "_graph:catalog"))
        .toBe(true);
      expect(plan.scopes.some((scope) => scope.identity === "_graph:source-a"))
        .toBe(true);
      const relatedSourceScope = plan.scopes.find((scope) =>
        scope.identity === "source:source-b");
      expect(relatedSourceScope).toBeDefined();
      const members = documentPublicationScopeMembers({
        scope: relatedSourceScope!,
        documents: [document],
        activeSourceRevisions: [{
          sourceFilePublicId: "source-b",
          sourceRevisionPublicId: "revision-source-b",
          activationSequence: 7
        }]
      });
      expect(members).toHaveLength(2);
      expect(members.at(-1)).toEqual({
        kind: "source_revision",
        publicId: "revision-source-b",
        version: "7",
        order: 1
      });
      const graphScopes = plan.scopes.filter((scope) =>
        scope.identity === "_graph:source-b"
          || scope.identity === "_graph:directory:pages/new"
          || scope.identity === "_graph:file-directory:pages/new");
      expect(graphScopes).toHaveLength(3);
      for (const scope of graphScopes) {
        expect(documentPublicationScopeMembers({
          scope,
          documents: [document],
          activeSourceRevisions: [{
            sourceFilePublicId: "source-b",
            sourceRevisionPublicId: "revision-source-b",
            activationSequence: 7
          }]
        })).toEqual([{ kind: "source_revision", publicId: "revision-a",
          version: "1", order: 0 }, {
          kind: "source_revision",
          publicId: "revision-source-b",
          version: "7",
          order: 1
        }]);
      }
    }
    if (_name === "delete") {
      expect(plan.tombstoneSourceFilePublicIds).toEqual(["source-a"]);
    }
    if (_name === "same path recreate") {
      expect(plan.deletePaths).toEqual([]);
    }
  });

  it("deduplicates shared hot-directory work across ready documents", () => {
    const plan = planDocumentPublicationGeneration({
      generationPublicId: "generation-hot",
      baseGenerationPublicId: "generation-base",
      targetFactEpoch: 2,
      rendererContractVersion: "portable-okf-v2",
      deterministicChangedAt: "2026-08-21T12:00:00.000Z",
      documents: [
        delta({ sourceFilePublicId: "source-a", nextLogicalPath: "same/a.md" }),
        delta({
          documentJobPublicId: "job-b", sourceFilePublicId: "source-b",
          sourceRevisionPublicId: "revision-b", factEpoch: 2,
          nextLogicalPath: "same/b.md"
        })
      ]
    });
    expect(plan.scopes.filter((scope) =>
      scope.identity === "directory:pages/same")).toHaveLength(1);
  });

  it("makes independent leaf scopes eligible before their parents", () => {
    const plan = planDocumentPublicationGeneration({
      generationPublicId: "generation-dag",
      baseGenerationPublicId: null,
      targetFactEpoch: 1,
      rendererContractVersion: "portable-okf-v2",
      deterministicChangedAt: "2026-08-21T12:00:00.000Z",
      documents: [delta({ relatedSourceFilePublicIds: ["source-b"] })]
    });
    const first = eligibleDocumentPublicationScopes({
      scopes: plan.scopes,
      completedScopeIdentities: new Set(),
      runningScopeIdentities: new Set(),
      limit: 100
    });
    expect(first.some((scope) => scope.identity === "source:source-a"))
      .toBe(true);
    expect(first.some((scope) => scope.identity === "root:index"))
      .toBe(false);
    const allExceptRoot = new Set(plan.scopes
      .filter((scope) => !["root:index", "validation:generation-dag"]
        .includes(scope.identity))
      .map((scope) => scope.identity));
    expect(eligibleDocumentPublicationScopes({
      scopes: plan.scopes,
      completedScopeIdentities: allExceptRoot,
      runningScopeIdentities: new Set(),
      limit: 100
    }).map((scope) => scope.identity)).toEqual(["root:index"]);
  });
});

function ready(documentJobPublicId: string, factEpoch: number, readyAt: string) {
  return {
    mutationPublicId: documentJobPublicId,
    documentJobPublicId,
    sourceFilePublicId: `source-${documentJobPublicId}`,
    sourceRevisionPublicId: `revision-${documentJobPublicId}`,
    factEpoch,
    readyAt
  };
}

function delta(overrides: Record<string, unknown> = {}) {
  return {
    mutationPublicId: "job-a",
    documentJobPublicId: "job-a",
    sourceFilePublicId: "source-a",
    sourceRevisionPublicId: "revision-a",
    factEpoch: 1,
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
