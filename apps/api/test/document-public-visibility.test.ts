import { describe, expect, it } from "vitest";
import {
  resolveDocumentPublicVisibility,
  type DocumentVisibilityInput
} from "../src/document-indexing/domain/document-public-visibility.js";

const completeClosure = {
  source: true,
  firstLayer: true,
  graphPolicy: true,
  relationships: true,
  embeddings: true,
  searchFamilies: true,
  generatedPaths: true,
  generatedLinks: true,
  checksums: true,
  cleanupIntent: true
} as const;

describe("document public visibility", () => {
  it("keeps a newly added candidate absent from every public surface", () => {
    const visibility = resolveDocumentPublicVisibility(input({
      activeRevisionId: null,
      candidateState: "processing"
    }));
    expect(visibility).toEqual({
      treeRevisionId: null,
      contentRevisionId: null,
      graphRevisionId: null,
      generatedPageRevisionId: null,
      searchRevisionId: null
    });
  });

  it("switches every public surface only after complete activation", () => {
    expect(resolveDocumentPublicVisibility(input({
      activeRevisionId: null,
      candidateState: "available",
      activatedRevisionId: "revision-new",
      closure: completeClosure
    }))).toEqual({
      treeRevisionId: "revision-new",
      contentRevisionId: "revision-new",
      graphRevisionId: "revision-new",
      generatedPageRevisionId: "revision-new",
      searchRevisionId: "revision-new"
    });
  });

  it("preserves the previous active revision when a replacement fails", () => {
    expect(resolveDocumentPublicVisibility(input({
      activeRevisionId: "revision-old",
      candidateState: "error"
    }))).toEqual({
      treeRevisionId: "revision-old",
      contentRevisionId: "revision-old",
      graphRevisionId: "revision-old",
      generatedPageRevisionId: "revision-old",
      searchRevisionId: "revision-old"
    });
  });

  it("rejects an activation whose closure is incomplete", () => {
    expect(() => resolveDocumentPublicVisibility(input({
      activeRevisionId: "revision-old",
      candidateState: "available",
      activatedRevisionId: "revision-new",
      closure: { ...completeClosure, generatedLinks: false }
    }))).toThrowError(/DOCUMENT_ACTIVATION_CLOSURE_INCOMPLETE/u);
  });
});

function input(overrides: Partial<DocumentVisibilityInput>): DocumentVisibilityInput {
  return {
    activeRevisionId: null,
    candidateRevisionId: "revision-new",
    candidateState: "processing",
    activatedRevisionId: null,
    closure: null,
    ...overrides
  };
}
