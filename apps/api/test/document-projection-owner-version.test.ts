import { describe, expect, it } from "vitest";
import { resolveDocumentProjectionOwnerVersion } from
  "../src/document-indexing/infrastructure/document-projection-owner-version.js";

describe("document projection owner version", () => {
  it("prefers the current scope snapshot over a stale manifest version", () => {
    expect(resolveDocumentProjectionOwnerVersion({
      scopeOutputVersion: 7,
      manifestVersion: 3
    })).toBe(7);
  });

  it("uses the manifest only when no scope output owns the effect", () => {
    expect(resolveDocumentProjectionOwnerVersion({
      scopeOutputVersion: undefined,
      manifestVersion: 3
    })).toBe(3);
  });
});
