import { describe, expect, it } from "vitest";
import { formatDisplayFileName, formatDisplayFileReference } from "../src/lib/display-file-name";

describe("display file names", () => {
  it("keeps normal Markdown file names unchanged", () => {
    expect(formatDisplayFileName("foreign-company-registration.md")).toBe(
      "foreign-company-registration.md"
    );
  });

  it("normalizes legacy generated Markdown file names for display only", () => {
    expect(
      formatDisplayFileName(
        "ff8081819c46fdc3019cd19068731f64-foreign-company-registration-e656df554f9e.md"
      )
    ).toBe("foreign-company-registration.md");
  });

  it("normalizes legacy generated Markdown references inside preview labels", () => {
    expect(
      formatDisplayFileReference(
        "Source: ff8081819c46fdc3019cd19068731f64-foreign-company-registration-e656df554f9e.md"
      )
    ).toBe("Source: foreign-company-registration.md");
  });
});
