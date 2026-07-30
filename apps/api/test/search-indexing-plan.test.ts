import { describe, expect, it } from "vitest";
import {
  createSearchDocumentWork,
  createSearchLifecycleWork
} from "../src/search/search-indexing-plan.js";

describe("search indexing plan", () => {
  it("creates deterministic bounded work without persisting document bodies", () => {
    const input = {
      knowledgeBaseId: "kb-one",
      generationId: "generation-one",
      maintenanceRequestId: null,
      epoch: 1,
      maxAttempts: 5
    };
    const documents = [
      { id: "content-document-1", body: "body-one" },
      { id: "content-document-2", body: "body-two" }
    ];
    const first = [
      createSearchLifecycleWork(input, "content", "prepare_index"),
      createSearchDocumentWork({
        ...input,
        indexKind: "content",
        batchOrdinal: 0,
        recordKeys: ["content:record-1", "content:record-2"],
        documents
      }),
      createSearchLifecycleWork(input, "content", "validate")
    ];
    const second = [
      createSearchLifecycleWork(input, "content", "prepare_index"),
      createSearchDocumentWork({
        ...input,
        indexKind: "content",
        batchOrdinal: 0,
        recordKeys: ["content:record-1", "content:record-2"],
        documents
      }),
      createSearchLifecycleWork(input, "content", "validate")
    ];

    expect(first).toEqual(second);
    expect(first.filter((work) => work.workKind === "prepare_index"))
      .toHaveLength(1);
    expect(first.filter((work) => work.workKind === "validate"))
      .toHaveLength(1);

    const documentWork = first.filter((work) => work.workKind === "documents");
    expect(documentWork.map((work) => work.documentCount)).toEqual([2]);
    expect(documentWork.every((work) =>
      Array.isArray(work.checkpoint?.recordKeys)
      && !JSON.stringify(work.checkpoint).includes("body-")
    )).toBe(true);
    expect(new Set(first.map((work) => work.id)).size).toBe(first.length);
    expect(first.every((work) => /^[a-f0-9]{64}$/u.test(work.payloadChecksum)))
      .toBe(true);
  });

  it("rejects record keys that cannot fit the durable checkpoint", () => {
    expect(() => createSearchDocumentWork({
      knowledgeBaseId: "kb-one",
      generationId: "generation-one",
      maintenanceRequestId: null,
      epoch: 1,
      maxAttempts: 5,
      indexKind: "content",
      batchOrdinal: 0,
      recordKeys: [`content:${"x".repeat(70_000)}`],
      documents: [{ id: "segment-one", body: "body" }]
    })).toThrow(/checkpoint/u);
  });
});
