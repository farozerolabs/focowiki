import { describe, expect, it } from "vitest";
import {
  documentProjectionAvailableSourceFileIds,
  documentProjectionRenderableSourceFileIds,
  readDocumentRelationPlan
} from
  "../src/document-indexing/infrastructure/document-knowledge-projection-support.js";

describe("document knowledge projection support", () => {
  it("loads affected and relationship-neighbor sources exactly once", () => {
    expect(documentProjectionRenderableSourceFileIds({
      currentSourceFilePublicId: "source-current",
      affectedSourceFilePublicIds: ["source-affected", "source-current"],
      relations: [{
        firstSourceFilePublicId: "source-affected",
        secondSourceFilePublicId: "source-neighbor"
      }]
    })).toEqual([
      "source-affected",
      "source-current",
      "source-neighbor"
    ]);
  });

  it("retains the current source and only available neighbors", () => {
    expect(documentProjectionAvailableSourceFileIds({
      currentSourceFilePublicId: "source-current",
      requestedSourceFilePublicIds: [
        "source-current", "source-available", "source-missing"
      ],
      availableBaseSourceFilePublicIds: ["source-available"]
    })).toEqual(["source-current", "source-available"]);
  });

  it("parses the persisted relation reconciliation contract", () => {
    expect(readDocumentRelationPlan({
      schemaVersion: "document-relation-reconciliation-receipt-v1",
      pairPublicIds: ["pair-a"],
      relationPublicIds: ["relation-a"],
      affectedSourceFilePublicIds: ["source-a", "source-b"]
    })).toEqual({
      pairPublicIds: ["pair-a"],
      relationPublicIds: ["relation-a"],
      affectedSourceFilePublicIds: ["source-a", "source-b"]
    });
    expect(() => readDocumentRelationPlan({
      schemaVersion: "document-relation-reconciliation-receipt-v1",
      pairPublicIds: [1],
      affectedSourceFilePublicIds: []
    })).toThrow("relation_reconciliation_receipt_invalid");
  });
});
