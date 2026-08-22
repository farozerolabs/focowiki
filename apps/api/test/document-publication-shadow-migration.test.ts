import { describe, expect, it } from "vitest";
import {
  decideDocumentPublicationShadowContinuation,
  orderDocumentPublicationCanaries
} from "../src/document-indexing/application/document-publication-shadow-migration.js";

describe("document publication shadow migration", () => {
  it("resumes from the durable path cursor until the expected snapshot ends", () => {
    expect(decideDocumentPublicationShadowContinuation({
      expectedPathCount: 3,
      processedPathCount: 1,
      pageItemCount: 1,
      nextCursor: "pages/a.md"
    })).toEqual({ state: "building", nextCursor: "pages/a.md" });
    expect(decideDocumentPublicationShadowContinuation({
      expectedPathCount: 3,
      processedPathCount: 2,
      pageItemCount: 1,
      nextCursor: null
    })).toEqual({ state: "complete", nextCursor: null });
  });

  it("rejects drift and impossible progress without advancing cutover", () => {
    expect(() => decideDocumentPublicationShadowContinuation({
      expectedPathCount: 2,
      processedPathCount: 2,
      pageItemCount: 1,
      nextCursor: null
    })).toThrowError("SHADOW_PROGRESS_EXCEEDS_SNAPSHOT");
    expect(() => decideDocumentPublicationShadowContinuation({
      expectedPathCount: 5,
      processedPathCount: 2,
      pageItemCount: 1,
      nextCursor: null
    })).toThrowError("SHADOW_SNAPSHOT_DRIFT");
  });

  it("orders empty, representative, and remaining knowledge bases", () => {
    expect(orderDocumentPublicationCanaries([
      { knowledgeBaseId: "large", activePathCount: 100 },
      { knowledgeBaseId: "empty", activePathCount: 0 },
      { knowledgeBaseId: "small", activePathCount: 5 },
      { knowledgeBaseId: "medium", activePathCount: 20 }
    ])).toEqual(["empty", "small", "medium", "large"]);
  });
});
