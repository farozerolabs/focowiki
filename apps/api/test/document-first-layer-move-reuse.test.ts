import { describe, expect, it } from "vitest";
import { relationshipDeltaEdgesForOperation } from
  "../src/document-indexing/infrastructure/production-document-first-layer-work-handler.js";
import { documentWorkResourceLane } from
  "../src/document-indexing/application/document-work-resource-map.js";

describe("document first-layer move reuse", () => {
  const edge = {
    fromFileId: "source-file-a",
    toFileId: "source-file-b",
    relationKind: "related" as const,
    evidence: "source-grounded candidate"
  };

  it("does not request candidate-delta model work for a path-only move", () => {
    expect(relationshipDeltaEdgesForOperation("source_file_move", [edge]))
      .toEqual([]);
    expect(relationshipDeltaEdgesForOperation("source_directory_move", [edge]))
      .toEqual([]);
  });

  it("keeps candidate-delta work for content-bearing operations", () => {
    expect(relationshipDeltaEdgesForOperation("source_replace", [edge]))
      .toEqual([edge]);
  });

  it("admits content projection by embedding capacity before claiming work", () => {
    expect(documentWorkResourceLane("content_projection")).toBe("embedding");
  });

  it("does not serialize deterministic relation reconciliation behind model work", () => {
    expect(documentWorkResourceLane("relation_reconcile")).toBe("coordination");
  });

  it("separates concurrent knowledge projection from short activation", () => {
    expect(documentWorkResourceLane("knowledge_projection")).toBe("projection");
    expect(documentWorkResourceLane("activate")).toBe("activation");
  });
});
