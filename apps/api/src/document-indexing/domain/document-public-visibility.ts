import type { DocumentState } from "./contracts.js";

export type DocumentActivationClosure = {
  source: boolean;
  firstLayer: boolean;
  graphPolicy: boolean;
  relationships: boolean;
  embeddings: boolean;
  searchFamilies: boolean;
  generatedPaths: boolean;
  generatedLinks: boolean;
  checksums: boolean;
  cleanupIntent: boolean;
};

export type DocumentVisibilityInput = {
  activeRevisionId: string | null;
  candidateRevisionId: string;
  candidateState: DocumentState;
  activatedRevisionId: string | null;
  closure: DocumentActivationClosure | null;
};

export type DocumentPublicVisibility = {
  treeRevisionId: string | null;
  contentRevisionId: string | null;
  graphRevisionId: string | null;
  generatedPageRevisionId: string | null;
  searchRevisionId: string | null;
};

export function resolveDocumentPublicVisibility(
  input: DocumentVisibilityInput
): DocumentPublicVisibility {
  if (input.candidateState === "available") {
    if (
      input.activatedRevisionId !== input.candidateRevisionId
      || input.closure === null
      || Object.values(input.closure).some((value) => !value)
    ) {
      throw new Error("DOCUMENT_ACTIVATION_CLOSURE_INCOMPLETE");
    }
    return visibleRevision(input.candidateRevisionId);
  }
  return visibleRevision(input.activeRevisionId);
}

function visibleRevision(revisionId: string | null): DocumentPublicVisibility {
  return {
    treeRevisionId: revisionId,
    contentRevisionId: revisionId,
    graphRevisionId: revisionId,
    generatedPageRevisionId: revisionId,
    searchRevisionId: revisionId
  };
}
