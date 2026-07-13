import { describe, expect, it } from "vitest";
import { renderGeneratedCitations } from "../src/generated-citations.js";
import { validateGeneratedCitationSection } from "../src/citation-validation.js";

describe("renderGeneratedCitations", () => {
  it("renders deterministic numbered Markdown links", () => {
    expect(renderGeneratedCitations([
      { label: "Primary source", target: "https://example.com/primary" },
      { label: "Background", target: "/references/background.md" }
    ])).toEqual([
      "",
      "# Citations",
      "",
      "[1] [Primary source](https://example.com/primary)",
      "[2] [Background](/references/background.md)"
    ]);
  });

  it("omits missing and unsafe evidence", () => {
    expect(renderGeneratedCitations([
      { label: "Unsafe", target: "javascript:alert(1)" },
      { label: "Traversal", target: "/../secret.md" },
      { label: "", target: "https://example.com" }
    ])).toEqual([]);
  });

  it("validates consecutive numbered generated citation entries", () => {
    const markdown = [
      "# Page",
      ...renderGeneratedCitations([
        { label: "Primary source", target: "https://example.com/primary" },
        { label: "Background", target: "/references/background.md" }
      ])
    ].join("\n");

    expect(validateGeneratedCitationSection(markdown)).toEqual([]);
    expect(validateGeneratedCitationSection(
      "# Page\n\n# Citations\n\n[2] [Source](https://example.com)"
    )).toEqual([expect.objectContaining({ line: 5 })]);
  });
});
