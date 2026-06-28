import { describe, expect, it } from "vitest";
import { buildSourceContentProfile, isUsefulTerm } from "../src/graph/content-profile.js";

describe("content profile", () => {
  it("extracts bounded CJK relationship phrases from titles, headings, and body text", () => {
    const profile = buildSourceContentProfile({
      title: "农村公路养护办法",
      metadata: {
        title: "农村公路养护办法",
        type: "local regulation",
        tags: []
      },
      suggestions: null,
      body: [
        "# 农村公路养护办法",
        "",
        "本文件规定农村公路建设、养护资金、路产路权保护和交通运输主管部门监督管理。",
        "农村公路养护质量评定和养护责任应当与农村公路管理制度衔接。"
      ].join("\n")
    });

    expect(profile.keywords).toContain("农村公路");
    expect(profile.subjects).toContain("农村公路");
    expect(profile.headingOutline).toEqual(["农村公路养护办法"]);
    expect(profile.sourceExcerpt).not.toContain("Related");
  });

  it("filters low-information CJK boilerplate terms", () => {
    expect(isUsefulTerm("制定本条例")).toBe(false);
    expect(isUsefulTerm("本文件规定")).toBe(false);
    expect(isUsefulTerm("监督管理")).toBe(false);
    expect(isUsefulTerm("农村公路")).toBe(true);
  });
});
