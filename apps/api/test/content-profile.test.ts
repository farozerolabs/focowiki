import { describe, expect, it } from "vitest";
import { buildSourceContentProfile, isUsefulTerm } from "../src/graph/content-profile.js";

describe("content profile", () => {
  it("extracts bounded CJK relationship phrases from titles, headings, and body text", () => {
    const profile = buildSourceContentProfile({
      title: "支付配置指南",
      metadata: {
        title: "支付配置指南",
        type: "guide",
        tags: []
      },
      suggestions: null,
      body: [
        "# 支付配置指南",
        "",
        "本文介绍支付配置、回调地址、密钥轮换和错误排查。",
        "支付配置需要与部署指南和用户权限设置保持一致。"
      ].join("\n")
    });

    expect(profile.keywords).toContain("支付配置");
    expect(profile.subjects).toContain("支付配置");
    expect(profile.headingOutline).toEqual(["支付配置指南"]);
    expect(profile.sourceExcerpt).not.toContain("Related");
  });

  it("filters low-information generic document terms", () => {
    expect(isUsefulTerm("本文件")).toBe(false);
    expect(isUsefulTerm("文档")).toBe(false);
    expect(isUsefulTerm("相关")).toBe(false);
    expect(isUsefulTerm("支付配置")).toBe(true);
  });
});
