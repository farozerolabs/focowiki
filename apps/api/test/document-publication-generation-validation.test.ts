import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateDocumentPublicationGeneration } from
  "../src/document-indexing/application/document-publication-generation-validation.js";

describe("document publication generation validation", () => {
  it("produces the same generation checksum for every scope completion order",
    () => {
      const scopes = [scope("source:a", "a"), scope("root:index", "b")];
      const left = validateDocumentPublicationGeneration(input(scopes));
      const right = validateDocumentPublicationGeneration(input(
        [...scopes].reverse()
      ));
      expect(left).toEqual(right);
      expect(left.state).toBe("passed");
      expect(left.outputFingerprintSha256).toMatch(/^[0-9a-f]{64}$/u);
    });

  it("rejects incomplete dependencies and broken portable evidence", () => {
    expect(validateDocumentPublicationGeneration({
      ...input([scope("source:a", "a")]),
      incompleteScopeCount: 1,
      incompleteDependencyCount: 1,
      evidence: [{
        scopeIdentity: "source:a",
        sourceTargets: { checked: 1, missing: 0 },
        linkTargets: { checked: 2, missing: 1 },
        continuationChains: { checked: 1, broken: 0 },
        navigation: { expected: 1, actual: 1 },
        graph: { outgoing: 0, incoming: 0 },
        indexes: { expected: 1, actual: 1 },
        tombstones: { expected: 0, actual: 0 },
        search: { expected: 1, ready: 1 }
      }]
    })).toMatchObject({
      state: "failed",
      failedChecks: ["dependency_closure", "link_targets", "scope_completion"]
    });
  });

  it.each([1, 4, 16, 32])(
    "keeps the serial checksum at projection capacity %i",
    (capacity) => {
      const scopes = Array.from({ length: 64 }, (_, index) =>
        capacityScope(index));
      const serial = validateDocumentPublicationGeneration(input(scopes));
      const scheduled = [...scopes]
        .sort((left, right) => completionRank(left.scopeIdentity, capacity)
          - completionRank(right.scopeIdentity, capacity));
      const completed = Array.from(
        { length: Math.ceil(scheduled.length / capacity) },
        (_, page) => scheduled.slice(page * capacity, (page + 1) * capacity)
          .reverse()
      ).flat();

      expect(validateDocumentPublicationGeneration(input(completed)))
        .toEqual(serial);
    }
  );
});

function input(scopes: ReturnType<typeof scope>[]) {
  return {
    generationPublicId: "generation-1",
    generationDocumentCount: 1,
    includedFactCount: 1,
    scopeCount: scopes.length,
    incompleteScopeCount: 0,
    incompleteDependencyCount: 0,
    putCount: 2,
    deleteCount: 0,
    unverifiedObjectCount: 0,
    missingObjectReferenceCount: 0,
    duplicatePathCount: 0,
    duplicateDirectoryOwnerCount: 0,
    scopes,
    evidence: [{
      scopeIdentity: "source:a",
      sourceTargets: { checked: 1, missing: 0 },
      linkTargets: { checked: 2, missing: 0 },
      continuationChains: { checked: 1, broken: 0 },
      navigation: { expected: 1, actual: 1 },
      graph: { outgoing: 1, incoming: 1 },
      indexes: { expected: 1, actual: 1 },
      tombstones: { expected: 0, actual: 0 },
      search: { expected: 1, ready: 1 }
    }]
  };
}

function scope(scopeIdentity: string, marker: string) {
  return {
    scopeIdentity,
    inputFingerprintSha256: marker.repeat(64),
    outputFingerprintSha256: marker.repeat(64),
    pages: [{
      normalizedPath: `${marker}.md`,
      action: "put" as const,
      checksumSha256: marker.repeat(64)
    }]
  };
}

function capacityScope(index: number) {
  const identity = `source:capacity-${index.toString().padStart(3, "0")}`;
  const fingerprint = createHash("sha256").update(identity).digest("hex");
  return {
    scopeIdentity: identity,
    inputFingerprintSha256: fingerprint,
    outputFingerprintSha256: fingerprint,
    pages: [{
      normalizedPath: `pages/capacity-${index.toString().padStart(3, "0")}.md`,
      action: "put" as const,
      checksumSha256: fingerprint
    }]
  };
}

function completionRank(scopeIdentity: string, capacity: number): number {
  return Number.parseInt(createHash("sha256")
    .update(`${capacity}:${scopeIdentity}`).digest("hex").slice(0, 8), 16);
}
