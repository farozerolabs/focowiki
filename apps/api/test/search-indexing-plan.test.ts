import { describe, expect, it } from "vitest";
import {
  createSearchProjectionWorkPlan,
  type SearchProjectionRecord
} from "../src/search/search-indexing-plan.js";

describe("search indexing plan", () => {
  it("creates deterministic bounded work without persisting document bodies", () => {
    const content = records("content", 5);
    const graph = records("graph", 3);

    const first = createSearchProjectionWorkPlan({
      knowledgeBaseId: "kb-one",
      generationId: "generation-one",
      maintenanceRequestId: null,
      epoch: 1,
      content,
      graph,
      maxDocuments: 2,
      maxCompressedBytes: 2_048,
      maxAttempts: 5
    });
    const second = createSearchProjectionWorkPlan({
      knowledgeBaseId: "kb-one",
      generationId: "generation-one",
      maintenanceRequestId: null,
      epoch: 1,
      content,
      graph,
      maxDocuments: 2,
      maxCompressedBytes: 2_048,
      maxAttempts: 5
    });

    expect(first).toEqual(second);
    expect(first.filter((work) => work.workKind === "prepare_index"))
      .toHaveLength(2);
    expect(first.filter((work) => work.workKind === "validate"))
      .toHaveLength(2);
    expect(first.filter((work) => work.workKind === "activate"))
      .toHaveLength(1);
    expect(first.filter((work) => work.workKind === "cleanup"))
      .toHaveLength(2);

    const documentWork = first.filter((work) => work.workKind === "documents");
    expect(documentWork.map((work) => work.documentCount)).toEqual([2, 2, 1, 2, 1]);
    expect(documentWork.every((work) =>
      Array.isArray(work.checkpoint?.recordKeys)
      && !JSON.stringify(work.checkpoint).includes("body-")
    )).toBe(true);
    expect(new Set(first.map((work) => work.id)).size).toBe(first.length);
    expect(first.every((work) => /^[a-f0-9]{64}$/u.test(work.payloadChecksum)))
      .toBe(true);
  });

  it("rejects record keys that cannot fit the durable checkpoint", () => {
    expect(() => createSearchProjectionWorkPlan({
      knowledgeBaseId: "kb-one",
      generationId: "generation-one",
      maintenanceRequestId: null,
      epoch: 1,
      content: [{
        key: `content:${"x".repeat(70_000)}`,
        document: { id: "segment-one", body: "body" }
      }],
      graph: [],
      maxDocuments: 10,
      maxCompressedBytes: 2_048,
      maxAttempts: 5
    })).toThrow(/checkpoint/u);
  });
});

function records(kind: "content" | "graph", count: number): SearchProjectionRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `${kind}:record-${index}`,
    document: {
      id: `${kind}-document-${index}`,
      body: `body-${index}-${"content ".repeat(10)}`
    }
  }));
}
