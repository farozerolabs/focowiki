import { describe, expect, it } from "vitest";
import { reuseDocumentProjectionScopeOutput } from
  "../src/document-indexing/infrastructure/production-document-projection-scope-output-reuse.js";

describe("production document projection scope output reuse", () => {
  it("reuses an already persisted snapshot without new storage work", () => {
    const output = {
      scopePublicId: "dirty-scope-1",
      renderedSequence: 17,
      knowledgeBaseId: "knowledge-base-1",
      outputFingerprintSha256: "a".repeat(64),
      pages: [{
        logicalPath: "pages/index.md",
        normalizedPath: "pages/index.md",
        entryKind: "directory-index",
        sourceFilePublicId: null,
        sourceRevisionPublicId: null,
        objectId: "object-1",
        checksumSha256: "b".repeat(64),
        byteCount: 128
      }],
      removedNormalizedPaths: [],
      navigationMutations: [],
      activationOwnerVersions: [{
        kind: "page_head" as const,
        key: "pages/index.md",
        expectedVersion: 3
      }],
      createdAt: "2026-08-18T01:02:03.000Z"
    };

    expect(reuseDocumentProjectionScopeOutput(output)).toEqual({
      outputFingerprintSha256: output.outputFingerprintSha256,
      pages: output.pages,
      removedNormalizedPaths: [],
      navigationMutations: [],
      verifiedReservations: [],
      storageRequests: {
        put: 0,
        head: 0,
        verification: 0,
        attemptedBytes: 0,
        retries: 0,
        latencyMilliseconds: 0
      },
      factCount: 1,
      renderStartedAt: output.createdAt
    });
  });
});
