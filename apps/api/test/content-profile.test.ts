import { describe, expect, it } from "vitest";
import {
  buildSourceContentProfile,
  CONTENT_PROFILE_SOURCE_CHAR_LIMIT,
  isUsefulTerm
} from "../src/graph/content-profile.js";

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

  it("does not combine unstable single-character CJK segments into broken concepts", () => {
    const profile = buildSourceContentProfile({
      title: "三亚市三亚河保护管理规定",
      metadata: {
        title: "三亚市三亚河保护管理规定",
        type: "reference",
        tags: []
      },
      suggestions: null,
      body: [
        "# 三亚市三亚河保护管理规定",
        "",
        "本资料介绍三亚河保护管理范围和执行流程。"
      ].join("\n")
    });

    expect(profile.subjects).toContain("三亚市三亚河保护管理规定");
    expect(profile.subjects).not.toContain("市三保护");
    expect(profile.keywords).not.toContain("市三保护");
  });

  it("builds graph signals from body content before metadata", () => {
    const profile = buildSourceContentProfile({
      title: "Payment callback handbook",
      metadata: {
        title: "Payment callback handbook",
        type: "guide",
        description: "Metadata-only summary",
        tags: ["operations"]
      },
      suggestions: null,
      body: [
        "# Payment callback handbook",
        "",
        "Payment callback means the notification sent after a payment state changes.",
        "The retry process starts after signature verification and idempotency checks.",
        "Version 2 updated the timeout handling guidance."
      ].join("\n")
    });

    expect(profile.description).toBe("Payment callback means the notification sent after a payment state changes.");
    expect(profile.definitions[0]).toContain("Payment callback means");
    expect(profile.processHints.join(" ")).toContain("retry process");
    expect(profile.versionHints.join(" ")).toContain("Version 2");
  });

  it("filters low-information generic document terms", () => {
    expect(isUsefulTerm("本文件")).toBe(false);
    expect(isUsefulTerm("文档")).toBe(false);
    expect(isUsefulTerm("相关")).toBe(false);
    expect(isUsefulTerm("MERGEFORMAT22")).toBe(false);
    expect(isUsefulTerm("支付配置")).toBe(true);
  });

  it("bounds large Markdown profile extraction before scanning content signals", () => {
    const body = [
      "# Deployment runbook",
      "",
      "Payment callback means the notification sent after a payment state changes.",
      "The retry process starts after signature verification.",
      "x".repeat(CONTENT_PROFILE_SOURCE_CHAR_LIMIT + 1_000),
      "[Hidden Tail Link](hidden-tail.md)",
      "HiddenTailUniqueTerm"
    ].join("\n");

    const profile = buildSourceContentProfile({
      title: "Deployment runbook",
      metadata: {
        title: "Deployment runbook",
        type: "guide",
        tags: []
      },
      suggestions: null,
      body
    });

    expect(profile.description).toBe("Payment callback means the notification sent after a payment state changes.");
    expect(profile.explicitReferences).not.toContain("hidden-tail.md");
    expect(profile.keywords).not.toContain("hiddentailuniqueterm");
    expect(profile.sourceExcerpt.length).toBeLessThanOrEqual(2_000);
  });

  it("builds a usable profile when frontmatter is missing", () => {
    const profile = buildSourceContentProfile({
      title: "Incident response checklist",
      metadata: {},
      suggestions: null,
      body: [
        "# Incident response checklist",
        "",
        "Incident triage means the first review after an alert is opened.",
        "The escalation process starts after owner assignment."
      ].join("\n")
    });

    expect(profile.description).toBe("Incident triage means the first review after an alert is opened.");
    expect(profile.subjects).toEqual(expect.arrayContaining(["incident", "response", "checklist"]));
    expect(profile.definitions).toEqual(
      expect.arrayContaining(["Incident triage means the first review after an alert is opened."])
    );
    expect(profile.processHints).toEqual(
      expect.arrayContaining(["The escalation process starts after owner assignment."])
    );
  });

  it("extracts domain-agnostic signals from uncommon professional documents", () => {
    const profile = buildSourceContentProfile({
      title: "Clinical sample handling protocol",
      metadata: {
        title: "Clinical sample handling protocol",
        type: "protocol",
        tags: ["laboratory"]
      },
      suggestions: null,
      body: [
        "# Clinical sample handling protocol",
        "",
        "Chain of custody means the documented control of each sample transfer.",
        "The preservation process starts after barcode verification.",
        "Version 4 changed the frozen-storage exception."
      ].join("\n")
    });

    expect(profile.definitions.join(" ")).toContain("Chain of custody means");
    expect(profile.processHints.join(" ")).toContain("preservation process");
    expect(profile.versionHints.join(" ")).toContain("Version 4");
    expect(profile.tags).toContain("laboratory");
  });

  it("ignores generated sections and noisy boilerplate when extracting signals", () => {
    const profile = buildSourceContentProfile({
      title: "Data retention policy",
      metadata: {
        title: "Data retention policy",
        type: "policy",
        tags: []
      },
      suggestions: null,
      body: [
        "# Data retention policy",
        "",
        "Retention review means the recurring check before archived records are deleted.",
        "This document contains related information and current content for reference.",
        "",
        "## Related",
        "",
        "- [Generated Link](generated.md)",
        "",
        "## Citations",
        "",
        "- https://example.com/generated"
      ].join("\n")
    });

    expect(profile.definitions).toEqual(
      expect.arrayContaining(["Retention review means the recurring check before archived records are deleted."])
    );
    expect(profile.explicitReferences).not.toContain("generated.md");
    expect(profile.keywords).not.toContain("related");
    expect(profile.keywords).not.toContain("citations");
  });

  it("uses substantive content for summaries and keeps update provenance out of core subjects", () => {
    const profile = buildSourceContentProfile({
      title: "Access policy",
      metadata: {
        title: "Access policy",
        type: "policy",
        tags: []
      },
      suggestions: null,
      body: [
        "# Access policy",
        "",
        "(Updated in 2026 by the \"Platform documentation batch\".)",
        "",
        "Access control defines how service owners grant and review permissions.",
        "The approval process starts after the owner verifies the request.",
        "The workflow status is shown after every approval."
      ].join("\n")
    });

    expect(profile.description).toBe(
      "Access control defines how service owners grant and review permissions."
    );
    expect(profile.subjects.join(" ").toLowerCase()).not.toContain("platform documentation batch");
    expect(profile.versionHints.join(" ")).toContain("Updated in 2026");
    expect(profile.versionHints.join(" ")).not.toContain("workflow status");
  });

  it("preserves the start of a substantive statement after long update provenance", () => {
    const profile = buildSourceContentProfile({
      title: "Access policy",
      metadata: { title: "Access policy", type: "policy", tags: [] },
      suggestions: null,
      body: [
        "# Access policy",
        "",
        `(Updated in 2026 under ${"release context ".repeat(30)}.)`,
        "",
        "Access control defines how service owners grant and review permissions."
      ].join("\n")
    });

    expect(profile.description).toBe(
      "Access control defines how service owners grant and review permissions."
    );
  });

  it("skips plain-text outline rows when selecting the content summary", () => {
    const profile = buildSourceContentProfile({
      title: "Operations handbook",
      metadata: { title: "Operations handbook", type: "handbook", tags: [] },
      suggestions: null,
      body: [
        "# Operations handbook",
        "",
        "Table of contents",
        "Chapter 1",
        "Chapter 2 Service ownership",
        "",
        "Service ownership defines who approves and reviews production changes."
      ].join("\n")
    });

    expect(profile.description).toBe(
      "Service ownership defines who approves and reviews production changes."
    );
  });

  it("keeps model candidate links out of content-derived relationship hints", () => {
    const profile = buildSourceContentProfile({
      title: "Procurement approval workflow",
      metadata: { title: "Procurement approval workflow", type: "workflow", tags: [] },
      suggestions: {
        type: "workflow",
        title: "Procurement approval workflow",
        description: "",
        tags: [],
        keywords: [],
        related_links: [
          { title: "Unrelated onboarding guide", path: "pages/onboarding.md" }
        ]
      },
      body: [
        "# Procurement approval workflow",
        "",
        "The approval process starts after budget verification."
      ].join("\n")
    });

    expect(profile.relationshipHints.join(" ")).toContain("approval process");
    expect(profile.relationshipHints).not.toContain("Unrelated onboarding guide");
    expect(profile.relationshipHints).not.toContain("pages/onboarding.md");
  });
});
