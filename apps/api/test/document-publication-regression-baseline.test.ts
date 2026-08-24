import { describe, expect, it } from "vitest";

describe("publication projection regression baseline", () => {
  it("records only bounded safe production-shaped evidence", () => {
    const baseline = {
      activeDocumentCount: 11_862,
      affectedDocumentCount: 18,
      activeFactEpoch: 11_913,
      targetFactEpoch: 11_931,
      rowsRead: null,
      recordsRendered: null,
      objectPutCount: 24,
      objectPutBytes: 23_757_573,
      maximumObservedHeartbeatAgeMs: 117_000,
      observedLeaseGenerations: [4, 5, 6]
    } as const;

    expect(baseline.targetFactEpoch - baseline.activeFactEpoch)
      .toBe(baseline.affectedDocumentCount);
    expect(baseline).not.toHaveProperty("knowledgeBaseId");
    expect(baseline).not.toHaveProperty("sourceBody");
    expect(baseline).not.toHaveProperty("credentials");
  });
});
