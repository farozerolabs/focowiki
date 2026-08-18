import { describe, expect, it } from "vitest";
import { safeDocumentDiagnosticPath } from
  "../src/document-indexing/application/document-error-diagnostic-path.js";

describe("document error diagnostic path", () => {
  it("encodes Unicode and reserved path characters without exposing raw controls", () => {
    expect(safeDocumentDiagnosticPath("_graph/指南 (Beta)/A#B.json")).toBe(
      "_graph/%E6%8C%87%E5%8D%97%20%28Beta%29/A%23B.json"
    );
    expect(safeDocumentDiagnosticPath("pages/unsafe\npath.md")).toBeNull();
  });

  it("rejects absent and oversized diagnostic paths", () => {
    expect(safeDocumentDiagnosticPath(null)).toBeNull();
    expect(safeDocumentDiagnosticPath("a".repeat(513))).toBeNull();
  });
});
