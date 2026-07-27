import { describe, expect, it } from "vitest";
import {
  invalidSelectedUploadPaths,
  setFileRelativePath
} from "../src/lib/upload-selection";

describe("upload selection path policy", () => {
  it.each([
    "boundary/report\u202Efdp.md",
    "boundary/report\u2066safe.md"
  ])("rejects bidirectional control characters in %s", (relativePath) => {
    const file = setFileRelativePath(
      new File(["# Boundary"], "boundary.md", { type: "text/markdown" }),
      relativePath
    );

    expect(invalidSelectedUploadPaths([file])).toEqual([relativePath]);
  });

  it("accepts full-width characters in a safe Markdown path", () => {
    const file = setFileRelativePath(
      new File(["# Boundary"], "boundary.md", { type: "text/markdown" }),
      "boundary/\uFF26\uFF55\uFF4C\uFF4C\uFF37\uFF49\uFF44\uFF54\uFF48.md"
    );

    expect(invalidSelectedUploadPaths([file])).toEqual([]);
  });
});
