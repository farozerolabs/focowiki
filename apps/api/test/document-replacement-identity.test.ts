import { describe, expect, it } from "vitest";
import {
  documentRevisionMutationVariant,
  isDocumentRevisionMutationBusy
} from
  "../src/document-indexing/infrastructure/postgres-document-replacement.js";

describe("document replacement identity", () => {
  it("keeps idempotent retries stable and repeated path cycles distinct", () => {
    expect(documentRevisionMutationVariant({
      operationKind: "source_file_move",
      expectedResourceRevision: 3,
      logicalPath: "Guides/Unicode Café.md"
    })).toBe(documentRevisionMutationVariant({
      operationKind: "source_file_move",
      expectedResourceRevision: 3,
      logicalPath: "Guides/Unicode Café.md"
    }));
    expect(documentRevisionMutationVariant({
      operationKind: "source_file_move",
      expectedResourceRevision: 3,
      logicalPath: "Guides/Unicode Café.md"
    })).not.toBe(documentRevisionMutationVariant({
      operationKind: "source_file_move",
      expectedResourceRevision: 1,
      logicalPath: "Guides/Unicode Café.md"
    }));
    expect(documentRevisionMutationVariant({
      operationKind: "source_replace",
      expectedResourceRevision: 4,
      logicalPath: "Guides/Unicode Café.md"
    })).toBe("content:resource:5");
  });

  it("rejects a second mutation while a newer current revision is still processing", () => {
    expect(isDocumentRevisionMutationBusy({
      activeSourceRevisionPublicId: "source-revision-active",
      currentSourceRevisionPublicId: "source-revision-pending",
      currentJobState: "processing"
    })).toBe(true);
    expect(isDocumentRevisionMutationBusy({
      activeSourceRevisionPublicId: "source-revision-active",
      currentSourceRevisionPublicId: "source-revision-failed",
      currentJobState: "error"
    })).toBe(false);
    expect(isDocumentRevisionMutationBusy({
      activeSourceRevisionPublicId: "source-revision-active",
      currentSourceRevisionPublicId: "source-revision-active",
      currentJobState: "available"
    })).toBe(false);
  });
});
