import { describe, expect, it } from "vitest";
import {
  DOCUMENT_WORK_KINDS,
  documentWorkPrerequisites,
  nextDocumentWork
} from "../src/document-indexing/domain/document-work-graph.js";

describe("fixed document work graph", () => {
  it("uses only the closed resource-owned work vocabulary", () => {
    expect(DOCUMENT_WORK_KINDS).toEqual([
      "prepare",
      "first_layer",
      "content_projection",
      "graphrag",
      "relation_reconcile",
      "knowledge_projection",
      "activate",
      "cleanup"
    ]);
  });

  it("fans preparation out without waiting for an artificial phase", () => {
    expect(nextDocumentWork(new Set(["prepare"]))).toEqual([
      "first_layer",
      "content_projection"
    ]);
  });

  it("joins each work kind only on its real durable prerequisites", () => {
    expect(documentWorkPrerequisites("first_layer")).toEqual(["prepare"]);
    expect(documentWorkPrerequisites("content_projection")).toEqual(["prepare"]);
    expect(documentWorkPrerequisites("graphrag")).toEqual(["first_layer"]);
    expect(documentWorkPrerequisites("relation_reconcile")).toEqual([
      "first_layer",
      "content_projection",
      "graphrag"
    ]);
    expect(documentWorkPrerequisites("knowledge_projection")).toEqual([
      "content_projection",
      "relation_reconcile"
    ]);
    expect(documentWorkPrerequisites("activate")).toEqual(["knowledge_projection"]);
    expect(documentWorkPrerequisites("cleanup")).toEqual(["activate"]);
  });

  it("has no configurable workflow, dependency edge, publication group, or batch", () => {
    const graphApi = { DOCUMENT_WORK_KINDS, documentWorkPrerequisites, nextDocumentWork };
    expect(graphApi).not.toHaveProperty("workflow");
    expect(graphApi).not.toHaveProperty("dependencies");
    expect(graphApi).not.toHaveProperty("publicationGroup");
    expect(graphApi).not.toHaveProperty("batch");
  });
});
