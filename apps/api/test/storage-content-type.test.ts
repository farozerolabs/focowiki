import { describe, expect, it } from "vitest";
import { areContentTypesEquivalent } from "../src/storage/content-type.js";

describe("storage content type equivalence", () => {
  it("accepts provider-normalized MIME syntax", () => {
    expect(areContentTypesEquivalent(
      "text/markdown;charset=UTF-8",
      "text/markdown; charset=utf-8"
    )).toBe(true);
    expect(areContentTypesEquivalent(
      "application/json; profile=portable; charset=utf-8",
      "APPLICATION/JSON;charset=UTF-8;profile=portable"
    )).toBe(true);
  });

  it("rejects different or invalid MIME semantics", () => {
    expect(areContentTypesEquivalent("text/plain", "text/markdown")).toBe(false);
    expect(areContentTypesEquivalent(
      "text/markdown; charset=utf-8; profile=extra",
      "text/markdown; charset=utf-8"
    )).toBe(false);
    expect(areContentTypesEquivalent("invalid", "text/markdown")).toBe(false);
  });
});
