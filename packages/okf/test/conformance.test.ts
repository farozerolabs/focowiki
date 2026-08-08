import { describe, expect, it } from "vitest";
import {
  OkfConformanceError,
  inspectOkfBundleProfile,
  validateOkfBundle,
  validateOkfBundleProfile
} from "../src/conformance.js";
import {
  OKF_CONFORMANCE_BASELINE,
  OKF_CONFORMANCE_RULE_MATRIX,
  OKF_NORMATIVE_RULES,
  OKF_PRODUCER_RULES,
  OKF_RECOMMENDED_RULES
} from "../src/conformance-baseline.js";
import { createConformanceIssue } from "../src/conformance-types.js";

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

  it("reports source conformance gaps without blocking safe Markdown", () => {
    const missingType = {
      path: "pages/missing-type.md",
      content: "---\ntitle: Missing type\n---\n# Missing type"
    };
    expect(() => validateOkfBundle([missingType])).not.toThrow();
    expect(inspectOkfBundleProfile([missingType], "normative"))
      .toContainEqual(expect.objectContaining({
        ruleId: "OKF-0.2-CONCEPT-TYPE",
        disposition: "advisory"
      }));
    const missingFrontmatter = {
      path: "pages/plain.md",
      content: "# Plain Markdown\n\nStill readable."
    };
    expect(() => validateOkfBundle([missingFrontmatter])).not.toThrow();
    expect(inspectOkfBundleProfile([missingFrontmatter], "normative"))
      .toContainEqual(expect.objectContaining({
        ruleId: "OKF-0.2-CONCEPT-FRONTMATTER",
        disposition: "advisory"
      }));

    expect(() =>
      validateOkfBundle([
        {
          path: "pages/missing-title.md",
          content: "---\ntype: page\n---\n# Missing title"
        }
      ])
    ).not.toThrow();

    expect(() =>
      validateOkfBundleProfile(
        [
          {
            path: "pages/missing-title.md",
            content: "---\ntype: page\n---\n# Missing title"
          }
        ],
        "focowiki_quality"
      )
    ).toThrow(/title/);
  });

  it("accepts nested reserved files without frontmatter", () => {
    expect(() =>
      validateOkfBundle([
        { path: "pages/index.md", content: "# Pages\n\n- [Team](team/index.md)" },
        { path: "pages/team/index.md", content: "# Team\n\n- [Guide](guide.md)" },
        { path: "pages/team/log.md", content: "# Directory Update Log\n\n## 2026-07-10\n\n* **Update**: Added guide." }
      ])
    ).not.toThrow();
  });

  it("keeps legacy root declarations readable but requires 0.2 from Focowiki", () => {
    const legacy = [{
      path: "index.md",
      content: "---\nokf_version: \"0.1\"\n---\n# Knowledge base"
    }];
    expect(() => validateOkfBundle(legacy)).not.toThrow();
    expect(() => validateOkfBundleProfile(legacy, "focowiki_quality"))
      .toThrow(/okf_version 0\.2/iu);
  });

  it("rejects frontmatter on nested index and log files", () => {
    expect(() =>
      validateOkfBundle([
        { path: "pages/index.md", content: "---\ntype: index\n---\n# Pages" }
      ])
    ).toThrow(/OKF-0.2-INDEX-STRUCTURE.*Nested index/);
    expect(() =>
      validateOkfBundle([
        { path: "pages/log.md", content: "---\ntype: log\n---\n# Directory Update Log" }
      ])
    ).toThrow(/OKF-0.2-LOG-STRUCTURE.*Log files must not contain frontmatter/);
  });

  it("rejects non-standard wiki links", () => {
    const files = [
      {
        path: "pages/intro.md",
        content: "---\ntype: page\ntitle: Intro\n---\n# Intro\n\n[[Related]]"
      }
    ];

    expect(() =>
      validateOkfBundle(files)
    ).not.toThrow();
    expect(() =>
      validateOkfBundleProfile(files, "focowiki_quality")
    ).toThrow(/standard markdown/i);
  });

  it("rejects log date groups that are not newest first", () => {
    expect(() =>
      validateOkfBundle([
        {
          path: "log.md",
          content: "# Directory Update Log\n\n## 2026-07-09\n\n* **Update**: First.\n\n## 2026-07-10\n\n* **Update**: Second."
        }
      ])
    ).toThrow(/newest first/i);
  });

  it("requires the official reserved log heading", () => {
    expect(() =>
      validateOkfBundle([
        {
          path: "log.md",
          content: "# Update log\n\n## 2026-07-10\n\n* **Update**: Added guide."
        }
      ])
    ).toThrow(/Directory Update Log/);
  });

  it("reports malformed YAML with the rule ID and file path", () => {
    try {
      validateOkfBundle([
        {
          path: "pages/malformed.md",
          content: "---\ntype: [page\n---\n# Malformed"
        }
      ]);
      throw new Error("Expected malformed frontmatter to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OkfConformanceError);
      expect(error).toMatchObject({
        issues: [
          expect.objectContaining({
            ruleId: "OKF-0.2-CONCEPT-FRONTMATTER",
            path: "pages/malformed.md"
          })
        ]
      });
    }
  });

  it("requires navigation_only on numbered Focowiki navigation concepts", () => {
    const file = {
      path: "pages/team/index-000001.md",
      content: "---\ntype: Directory Index Page\ntitle: Team index\n---\n# Team index"
    };

    expect(() => validateOkfBundle([file])).not.toThrow();
    expect(() => validateOkfBundleProfile([file], "focowiki_extension"))
      .toThrow(/FOCOWIKI-EXTENSION-NAVIGATION/);
  });

  it("reports title-equivalent descriptions as Focowiki quality issues", () => {
    const file = {
      path: "pages/guide.md",
      content: "---\ntype: Guide\ntitle: Operations guide\ndescription: Operations guide.\n---\n# Operations guide"
    };

    expect(() => validateOkfBundle([file])).not.toThrow();
    expect(() => validateOkfBundleProfile([file], "focowiki_quality"))
      .toThrow(/description should add information/i);
  });

  it("validates generated graph discovery and descriptive index entries", () => {
    const files = [
      {
        path: "index.md",
        content: "---\nokf_version: '0.2'\n---\n# Knowledge base\n\n* [Documents](/pages/index.md) - Browse files.\n* [Graph](/_graph/index.md) - Browse relationships."
      },
      {
        path: "pages/index.md",
        content: "# Pages\n\n* [Operations guide](/pages/guide.md) - Explains the rollout workflow."
      },
      {
        path: "pages/guide.md",
        content: "---\ntype: Guide\ntitle: Operations guide\ndescription: Explains the rollout workflow.\n---\n# Operations guide"
      },
      {
        path: "_graph/index.md",
        content: "# File graph"
      }
    ];

    expect(() => validateOkfBundleProfile(files, "focowiki_quality")).not.toThrow();
    expect(() => validateOkfBundleProfile(
      files.map((file) => file.path === "index.md"
        ? { ...file, content: "# Knowledge base\n\n* [Documents](/pages/index.md) - Browse files." }
        : file),
      "focowiki_quality"
    )).toThrow(/generated file graph/i);
    expect(() => validateOkfBundleProfile(
      files.map((file) => file.path === "pages/index.md"
        ? { ...file, content: "# Pages\n\n* [guide](/pages/guide.md)" }
        : file),
      "focowiki_quality"
    )).toThrow(/target concept title|target concept description/i);
  });

  it("keeps the pinned normative rule matrix complete and unique", () => {
    const allRules = [
      ...OKF_NORMATIVE_RULES,
      ...OKF_RECOMMENDED_RULES,
      ...OKF_PRODUCER_RULES
    ];
    expect(OKF_CONFORMANCE_BASELINE).toMatchObject({
      version: "0.2",
      repositoryRevision: "930b65fc3f5619d5d0591f88c72ebae8b848d60d"
    });
    expect(OKF_CONFORMANCE_RULE_MATRIX.map((rule) => rule.ruleId).sort())
      .toEqual([...allRules].sort());
    expect(new Set(OKF_CONFORMANCE_RULE_MATRIX.map((rule) => rule.ruleId)).size)
      .toBe(allRules.length);
    expect(OKF_CONFORMANCE_RULE_MATRIX.every((rule) =>
      rule.classification
      && rule.specificationSection
      && rule.implementation
      && rule.validatorAssertion
      && rule.generatedExample
      && rule.manualReviewEvidence
    )).toBe(true);
  });

  it("classifies every official rule as source advisory and owned blocking", () => {
    const officialRules = [...OKF_NORMATIVE_RULES, ...OKF_RECOMMENDED_RULES];
    expect(officialRules).toHaveLength(18);
    for (const ruleId of officialRules) {
      expect(createConformanceIssue(
        ruleId,
        "normative",
        "pages/source.md",
        "source gap"
      )).toMatchObject({ disposition: "advisory" });
      expect(createConformanceIssue(
        ruleId,
        "normative",
        "schema.md",
        "owned defect"
      )).toMatchObject({ disposition: "blocking" });
    }
  });

  it("accepts the nested positive fixture with Focowiki extension concepts", () => {
    const files = [
      {
        path: "index.md",
        content: "---\nokf_version: '0.2'\n---\n# Knowledge base\n\n- [Team](pages/team/index.md)"
      },
      { path: "log.md", content: "# Directory Update Log\n\n## 2026-07-10\n\n* **Update**: Added team guide." },
      { path: "pages/team/index.md", content: "# Team\n\n- [Guide](guide.md)\n- [More](index-000001.md)" },
      { path: "pages/team/log.md", content: "# Directory Update Log\n\n## 2026-07-10\n\n* **Update**: Added guide." },
      {
        path: "pages/team/guide.md",
        content: "---\ntype: page\ntitle: Guide\n---\n# Guide"
      },
      {
        path: "pages/team/index-000001.md",
        content: "---\ntype: Directory Index Page\ntitle: Team index continuation\nnavigation_only: true\n---\n# Team index continuation"
      },
      { path: "_graph/index.md", content: "# File graph\n\nSee graph records." },
      { path: "_index/catalog.json", content: "{\"formatVersion\":1}" }
    ];

    expect(() => validateOkfBundle(files)).not.toThrow();
    expect(() => validateOkfBundleProfile(files, "focowiki_extension")).not.toThrow();
  });
});
