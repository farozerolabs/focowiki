import { describe, expect, it } from "vitest";
import { selectDocumentPublicationObjectMetrics } from
  "../src/document-indexing/application/document-publication-object-metrics.js";

describe("document publication object metrics", () => {
  it("excludes manifest outputs and fingerprints from structured logs", () => {
    const buildResult = {
      fingerprintSha256: "a".repeat(64),
      outputs: [{ normalizedPath: "pages/private-path.md" }],
      objectPutCount: 3,
      objectReuseCount: 4,
      objectRequestCount: 8,
      objectAttemptedBytes: 1024
    };
    const metrics = selectDocumentPublicationObjectMetrics(buildResult);

    expect(metrics).toEqual({
      objectPutCount: 3,
      objectReuseCount: 4,
      objectRequestCount: 8,
      objectAttemptedBytes: 1024
    });
    expect(metrics).not.toHaveProperty("outputs");
    expect(metrics).not.toHaveProperty("fingerprintSha256");
  });
});
