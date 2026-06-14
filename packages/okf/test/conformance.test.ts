import { describe, expect, it } from "vitest";
import { validateOkfBundle } from "../src/conformance.js";

describe("validateOkfBundle", () => {
  it("accepts reserved root Markdown and valid concept Markdown", () => {
    expect(() =>
      validateOkfBundle([
        {
          path: "index.md",
          content: "# Index\n\n- [Intro](/pages/intro.md)"
        },
        {
          path: "pages/intro.md",
          content: "---\ntype: page\ntitle: Intro\n---\n# Intro"
        },
        {
          path: "_index/search.json",
          content: "{}"
        }
      ])
    ).not.toThrow();
  });

  it("rejects non-reserved Markdown without required frontmatter", () => {
    expect(() =>
      validateOkfBundle([
        {
          path: "pages/missing-type.md",
          content: "---\ntitle: Missing type\n---\n# Missing type"
        }
      ])
    ).toThrow(/type/);

    expect(() =>
      validateOkfBundle([
        {
          path: "pages/missing-title.md",
          content: "---\ntype: page\n---\n# Missing title"
        }
      ])
    ).toThrow(/title/);
  });

  it("rejects non-standard wiki links", () => {
    expect(() =>
      validateOkfBundle([
        {
          path: "pages/intro.md",
          content: "---\ntype: page\ntitle: Intro\n---\n# Intro\n\n[[Related]]"
        }
      ])
    ).toThrow(/standard markdown/i);
  });
});
