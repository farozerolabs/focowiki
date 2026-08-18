import { describe, expect, it } from "vitest";
import { omitAppliedProjectionScopeEffects } from
  "../src/document-indexing/infrastructure/document-projection-output-idempotency.js";
import type { DocumentProjectionScopeOutput } from
  "../src/document-indexing/infrastructure/postgres-projection-scope-output-repository.js";

describe("document projection output idempotency", () => {
  it("omits page and navigation effects already active with identical content", async () => {
    const output = projectionOutput();
    const filtered = await omitAppliedProjectionScopeEffects({
      outputs: [output],
      heads: [{
        ...output.pages[0]!,
        pageCandidatePublicId: "candidate-active",
        activationRevision: 2
      }],
      readDirectory: async () => output.navigationMutations[0]!.touchedLeaves
    });
    expect(filtered[0]).toMatchObject({
      pages: [],
      removedNormalizedPaths: [],
      navigationMutations: []
    });
  });

  it("keeps changed effects so scoped activation can detect a conflict", async () => {
    const output = projectionOutput();
    const filtered = await omitAppliedProjectionScopeEffects({
      outputs: [output],
      heads: [{
        logicalPath: "removed.md",
        normalizedPath: "removed.md",
        entryKind: "source",
        sourceFilePublicId: null,
        sourceRevisionPublicId: null,
        pageCandidatePublicId: "candidate-removed",
        objectId: "object-removed",
        checksumSha256: "c".repeat(64),
        byteCount: 64,
        activationRevision: 1
      }],
      readDirectory: async () => []
    });
    expect(filtered[0]!.pages).toHaveLength(1);
    expect(filtered[0]!.removedNormalizedPaths).toEqual(["removed.md"]);
    expect(filtered[0]!.navigationMutations).toHaveLength(1);
  });
});

function projectionOutput(): DocumentProjectionScopeOutput {
  return {
    scopePublicId: "scope-1",
    renderedSequence: 2,
    knowledgeBaseId: "knowledge-base-1",
    outputFingerprintSha256: "a".repeat(64),
    pages: [{
      logicalPath: "_index/index.md",
      normalizedPath: "_index/index.md",
      entryKind: "index",
      sourceFilePublicId: null,
      sourceRevisionPublicId: null,
      objectId: "object-1",
      checksumSha256: "b".repeat(64),
      byteCount: 128
    }],
    removedNormalizedPaths: ["removed.md"],
    navigationMutations: [{
      directoryPath: "_index",
      touchedLeaves: [{
        id: "leaf-1",
        previousLeafId: null,
        nextLeafId: null,
        entries: [{
          id: "_index/index.md",
          sortKey: "index",
          name: "Index",
          targetPath: "_index/index.md",
          kind: "file"
        }],
        revision: 1
      }],
      removedLeafIds: []
    }],
    activationOwnerVersions: [],
    createdAt: "2026-08-17T00:00:00.000Z"
  };
}
