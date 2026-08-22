import { describe, expect, it } from "vitest";
import { mergeDirtyScopeSequence } from
  "../src/document-indexing/infrastructure/postgres-projection-dirty-scope-repository.js";
import { isDocumentPublicationGenerationCoherent } from
  "../src/document-indexing/application/document-publication-coherence.js";

describe("document projection coherence contract", () => {
  it("does not treat independently completed scope counters as one coherent snapshot", () => {
    const root = mergeDirtyScopeSequence({
      currentRequiredSequence: 7,
      currentCompletedSequence: 7,
      incomingRequiredSequence: 7
    });
    const graph = mergeDirtyScopeSequence({
      currentRequiredSequence: 11,
      currentCompletedSequence: 11,
      incomingRequiredSequence: 11
    });

    expect([root, graph].every((scope) => scope.state === "completed"))
      .toBe(true);

    expect(isDocumentPublicationGenerationCoherent({
      generationPublicId: "generation-1",
      targetFactEpoch: 11,
      requiredScopeIdentities: ["root:index", "_graph:catalog"],
      scopes: [{
        scopeIdentity: "root:index",
        publicationGenerationPublicId: null,
        factEpoch: null,
        state: root.state
      }, {
        scopeIdentity: "_graph:catalog",
        publicationGenerationPublicId: null,
        factEpoch: null,
        state: graph.state
      }]
    })).toBe(false);
  });
});
