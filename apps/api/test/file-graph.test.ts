import { describe, expect, it } from "vitest";
import type { OkfGraphEdge, OkfGraphNode } from "@focowiki/okf";
import { buildSourceFileGraph } from "../src/graph/file-graph.js";
import { createGraphNode as createContentGraphNode } from "../src/graph/graph-node-profile.js";
import type { FileGraphRepository, SourceFileRecord } from "../src/db/admin-repositories.js";

const now = "2026-06-18T00:00:00.000Z";

describe("file graph", () => {
  it("builds graph edges with bounded candidate reads", async () => {
    const source = createSourceFile("source-current", "current.md");
    const candidates = Array.from({ length: 5 }, (_, index) =>
      createGraphNode(`source-${index}`, `related-${index}.md`)
    );
    const storedNodes = new Map<string, OkfGraphNode>();
    const storedEdges: OkfGraphEdge[] = [];
    let nodePageCalls = 0;
    const graph: FileGraphRepository = {
      async upsertGraphNode(input) {
        storedNodes.set(input.node.fileId, input.node);
      },
      async upsertGraphEdges(input) {
        storedEdges.push(...input.edges);
      },
      async listGraphNodes(input) {
        nodePageCalls += 1;
        const offset = input.cursor ? Number(input.cursor) : 0;
        const items = candidates.slice(offset, offset + input.limit);
        const nextOffset = offset + input.limit;
        return {
          items,
          nextCursor: nextOffset < candidates.length ? String(nextOffset) : null
        };
      },
      async listGraphEdges() {
        return { items: storedEdges, nextCursor: null };
      },
      async listGraphNeighborhood() {
        return { items: [], nextCursor: null };
      },
      async deleteGraphForSourceFile() {
        return undefined;
      }
    };

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Current",
        type: "page",
        tags: ["shared"]
      },
      body: "# Current\n\nThis file mentions related-0, related-1, and related-2 as relevant documents.",
      suggestions: null,
      pageSize: 2,
      maxCandidateNodes: 3
    });

    expect(storedNodes.get(source.id)?.path).toBe("pages/current.md");
    expect(result.edgeCount).toBe(3);
    expect(storedEdges).toHaveLength(3);
    expect(storedEdges.map((edge) => edge.toFileId)).toEqual(["source-0", "source-1", "source-2"]);
    expect(storedEdges.every((edge) => edge.reason.trim().length > 0)).toBe(true);
    expect(storedEdges.every((edge) => !edge.reason.startsWith("Relationship from"))).toBe(true);
    expect(storedEdges.every((edge) => !/current file|target file|this document/iu.test(edge.reason))).toBe(
      true
    );
    expect(nodePageCalls).toBe(2);
  });

  it("preserves nested source paths without using directory names as the fallback title", async () => {
    const source = createSourceFile("source-nested", "handbook/setup/install.md");
    const storedNodes: OkfGraphNode[] = [];
    const graph: FileGraphRepository = {
      async upsertGraphNode(input) {
        storedNodes.push(input.node);
      },
      async upsertGraphEdges() {},
      async listGraphNodes() {
        return { items: [], nextCursor: null };
      },
      async listGraphEdges() {
        return { items: [], nextCursor: null };
      },
      async listGraphNeighborhood() {
        return { items: [], nextCursor: null };
      },
      async deleteGraphForSourceFile() {}
    };

    await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: { type: "page" },
      body: "# Install\n\nInstallation instructions.",
      suggestions: null,
      pageSize: 10
    });

    expect(storedNodes[0]?.path).toBe("pages/handbook/setup/install.md");
    expect(storedNodes[0]?.title).toBe("install");
  });

  it("stores canonical source-link paths for order-independent graph matching", () => {
    const node = createContentGraphNode({
      sourceFileId: "source-referrer",
      sourceRelativePath: "guides/setup/current.md",
      metadata: {
        type: "guide",
        title: "Current guide"
      },
      body: "# Current guide\n\nRead [Target guide](../reference/target.md).",
      suggestions: null
    });

    expect(node.explicitReferences).toContain("/pages/guides/reference/target.md");
  });

  it("reconciles explicit referrers when their target node arrives later", async () => {
    const source = createSourceFile("source-target", "guides/reference/target.md");
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({
      candidates: [],
      storedEdges,
      explicitReconciliationResult: {
        edgeCount: 1,
        sourceFileIds: ["source-referrer"],
        edge: {
          fromFileId: "source-referrer",
          toFileId: source.id,
          relationType: "direct_reference",
          weight: 0.95,
          reason: "The source explicitly references this file.",
          source: "deterministic",
          evidence: {
            signal: "direct_reference",
            reconciliation: "explicit_reference"
          }
        }
      }
    });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        type: "guide",
        title: "Target guide"
      },
      body: "# Target guide\n\nReference material.",
      suggestions: null,
      pageSize: 10
    });

    expect(storedEdges).toContainEqual(
      expect.objectContaining({
        fromFileId: "source-referrer",
        toFileId: source.id,
        relationType: "direct_reference"
      })
    );
    expect(result.edgeCount).toBe(1);
    expect(result.affectedSourceFileIds).toEqual(
      expect.arrayContaining([source.id, "source-referrer"])
    );
  });

  it("prefers indexed graph candidates before falling back to node pages", async () => {
    const source = createSourceFile("source-current", "current.md");
    const target = {
      ...createGraphNode("source-target", "target-policy.md"),
      title: "Target policy",
      subjects: ["pilot zone"],
      tags: ["policy"],
      entities: ["Target policy"],
      keywords: ["target", "policy"]
    };
    const storedEdges: OkfGraphEdge[] = [];
    let candidateCalls = 0;
    let nodePageCalls = 0;
    const graph: FileGraphRepository = {
      async upsertGraphNode() {
        return undefined;
      },
      async upsertGraphEdges(input) {
        storedEdges.push(...input.edges);
      },
      async listGraphCandidates(input) {
        candidateCalls += 1;
        expect(input.terms).toContain("pilot zone");
        return [target];
      },
      async listGraphNodes() {
        nodePageCalls += 1;
        return { items: [createGraphNode("source-unrelated", "unrelated.md")], nextCursor: null };
      },
      async listGraphEdges() {
        return { items: storedEdges, nextCursor: null };
      },
      async listGraphNeighborhood() {
        return { items: [], nextCursor: null };
      },
      async deleteGraphForSourceFile() {
        return undefined;
      }
    };

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Current pilot zone policy",
        type: "page",
        tags: ["pilot zone"]
      },
      body: "# Current\n\nThis file explicitly discusses Target policy.",
      suggestions: null,
      pageSize: 10,
      maxCandidateNodes: 1
    });

    expect(candidateCalls).toBe(1);
    expect(nodePageCalls).toBe(0);
    expect(result.edgeCount).toBe(1);
    expect(storedEdges[0]?.toFileId).toBe("source-target");
  });

  it("uses prior graph context as bounded candidates while requiring current content evidence", async () => {
    const source = createSourceFile("source-current", "current.md");
    const storedEdges: OkfGraphEdge[] = [];
    let neighborhoodCalls = 0;
    let nodePageCalls = 0;
    const graph: FileGraphRepository = {
      async upsertGraphNode() {
        return undefined;
      },
      async upsertGraphEdges(input) {
        storedEdges.push(...input.edges);
      },
      async listGraphCandidates() {
        return [];
      },
      async listGraphNeighborhood(input) {
        neighborhoodCalls += 1;
        expect(input.limit).toBe(1);
        return {
          items: [
            {
              fileId: "source-related",
              sourceFileId: "source-related",
              generatedFileId: "bundle-related",
              path: "pages/related-policy.md",
              title: "Related policy",
              relationType: "same_specific_subject",
              direction: "outgoing",
              weight: 0.7,
              reason: "Prior graph context.",
              source: "deterministic",
              evidence: {},
              contentAvailable: true
            }
          ],
          nextCursor: null
        };
      },
      async listGraphNodes() {
        nodePageCalls += 1;
        return { items: [createGraphNode("source-unrelated", "unrelated.md")], nextCursor: null };
      },
      async listGraphEdges() {
        return { items: storedEdges, nextCursor: null };
      },
      async deleteGraphForSourceFile() {
        return undefined;
      }
    };

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Current",
        type: "page",
        tags: []
      },
      body: "# Current\n\nRead Related policy before changing the rollout process.",
      suggestions: null,
      pageSize: 10,
      maxCandidateNodes: 1
    });

    expect(neighborhoodCalls).toBe(1);
    expect(nodePageCalls).toBe(0);
    expect(result.edgeCount).toBe(1);
    expect(storedEdges[0]).toMatchObject({
      toFileId: "source-related",
      relationType: "direct_reference"
    });
  });

  it("does not publish relationships from weak shared metadata alone", async () => {
    const source = createSourceFile("source-api-security", "api-security.md");
    const candidates = [
      {
        ...createGraphNode("source-support-playbook", "support-playbook.md"),
        title: "Support playbook",
        tags: ["active"],
        headings: ["Related", "Citations"],
        keywords: ["active"],
        metadata: {
          title: "Support playbook",
          type: "guide",
          tags: ["active"],
          status: "active"
        }
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "API security checklist",
        type: "checklist",
        tags: ["active"],
        status: "active"
      },
      body: "# API security checklist\n\nThis document covers token rotation, request signing, and audit logging.",
      suggestions: null,
      pageSize: 10
    });

    expect(storedEdges).toHaveLength(0);
    expect(result.edgeCount).toBe(0);
  });

  it("does not connect unrelated files through a generic shared title suffix", async () => {
    const source = createSourceFile("source-payment", "payment-callback.md");
    const candidates = [
      {
        ...createGraphNode("source-permissions", "user-permissions.md"),
        title: "用户权限配置指南",
        subjects: ["用户权限配置指南", "配置指南"],
        entities: ["用户权限", "配置指南"],
        keywords: ["用户权限", "角色继承", "配置指南"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "支付回调配置指南",
        type: "guide",
        tags: ["active"]
      },
      body: "# 支付回调配置指南\n\n本文介绍支付回调签名、幂等处理和失败重试。",
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });

  it("does not treat a shared publisher prefix as a specific subject", async () => {
    const source = createSourceFile("source-platform-access", "platform-access-policy.md");
    const candidates = [
      {
        ...createGraphNode("source-platform-retention", "platform-retention-policy.md"),
        title: "Platform Operations Retention Guide",
        subjects: ["Platform Operations", "Data Retention"],
        entities: ["Platform Operations"],
        keywords: ["Platform Operations", "Retention Period"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Platform Operations Access Guide",
        type: "procedure",
        tags: []
      },
      body:
        "# Platform Operations Access Guide\n\nPlatform Operations publishes this guide for account access reviews.",
      suggestions: null,
      pageSize: 10
    });

    expect(storedEdges).toHaveLength(0);
    expect(result.edgeCount).toBe(0);
  });

  it("does not connect files through one shared organization namespace", async () => {
    const source = createSourceFile("source-security", "security.md");
    const candidates = [
      {
        ...createGraphNode("source-finance", "finance.md"),
        title: "示例集团财务",
        subjects: ["示例集团"],
        entities: ["示例集团"],
        keywords: ["示例集团"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "示例集团安全",
        type: "guide",
        tags: []
      },
      body: "# 示例集团安全\n\n示例集团发布账号安全和访问控制说明。",
      suggestions: null,
      pageSize: 10
    });

    expect(storedEdges).toHaveLength(0);
    expect(result.edgeCount).toBe(0);
  });

  it("does not connect unrelated files through one long shared title namespace", async () => {
    const source = createSourceFile("source-oversight", "oversight.md");
    const candidates = [
      {
        ...createGraphNode("source-invention", "invention.md"),
        title: "中华人民共和国专利法",
        subjects: [
          "中华人民共和国专利法",
          "中华人民共和国行政诉讼法",
          "中华人民共和国民事诉讼法"
        ],
        entities: [
          "中华人民共和国专利法",
          "中华人民共和国行政诉讼法",
          "中华人民共和国民事诉讼法"
        ],
        keywords: ["发明创造", "专利申请", "专利权"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "中华人民共和国监察法实施条例",
        type: "reference",
        tags: []
      },
      body:
        "# 中华人民共和国监察法实施条例\n\n本文规定监督调查、证据审查和履职程序。",
      suggestions: null,
      pageSize: 10
    });

    expect(storedEdges).toHaveLength(0);
    expect(result.edgeCount).toBe(0);
  });

  it("does not connect files through phrases that are common across the candidate set", async () => {
    const source = createSourceFile("source-meeting-rules", "meeting-rules.md");
    const sharedPhrases = ["市人民代表大会常务委员会", "以下简称常务委员会"];
    const candidates = [
      {
        ...createGraphNode("source-amendment", "amendment.md"),
        title: "七台河市人民代表大会常务委员会关于修改立法条例的决定",
        subjects: sharedPhrases,
        entities: sharedPhrases,
        keywords: sharedPhrases
      },
      {
        ...createGraphNode("source-budget", "budget.md"),
        title: "甲市人民代表大会常务委员会预算审查办法",
        subjects: sharedPhrases,
        entities: sharedPhrases,
        keywords: sharedPhrases
      },
      {
        ...createGraphNode("source-appointments", "appointments.md"),
        title: "乙市人民代表大会常务委员会任免工作规则",
        subjects: sharedPhrases,
        entities: sharedPhrases,
        keywords: sharedPhrases
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "三沙市人民代表大会常务委员会议事规则",
        type: "reference",
        tags: []
      },
      body: [
        "# 三沙市人民代表大会常务委员会议事规则",
        "",
        "市人民代表大会常务委员会依照本议事规则召开会议，以下简称常务委员会。"
      ].join("\n"),
      suggestions: null,
      pageSize: 10
    });

    expect(storedEdges).toHaveLength(0);
    expect(result.edgeCount).toBe(0);
  });

  it("does not publish relationships from external source links or generic fragments", async () => {
    const source = createSourceFile("source-brand-assets", "brand-assets.md");
    const candidates = [
      {
        ...createGraphNode("source-help-center", "help-center.md"),
        title: "Help center reference",
        subjects: ["official source", "reference page"],
        entities: ["Official source", "Reference page"],
        keywords: ["official", "source", "reference", "page"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Brand asset usage",
        type: "guide",
        tags: ["active"]
      },
      body: [
        "# Brand asset usage",
        "",
        "This source describes logo files, image usage, and review steps.",
        "",
        "[Official source](https://example.com/source)"
      ].join("\n"),
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });

  it("keeps content-scoped relationships from specific body-derived subjects", async () => {
    const source = createSourceFile("source-payment-callback", "payment-callback.md");
    const candidates = [
      {
        ...createGraphNode("source-payment-callback-retry", "payment-callback-retry.md"),
        title: "支付回调重试指南",
        subjects: ["支付回调", "重试策略"],
        entities: ["支付回调"],
        keywords: ["支付回调", "重试策略", "幂等处理"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "支付回调配置指南",
        type: "guide",
        tags: []
      },
      body:
        "# 支付回调配置指南\n\n本文介绍支付回调地址、签名校验、幂等处理和失败重试，并与支付回调重试指南衔接。",
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(1);
    expect(storedEdges[0]?.toFileId).toBe("source-payment-callback-retry");
  });

  it("connects related Chinese files through body-derived key phrase overlap", async () => {
    const source = createSourceFile("source-user-permission-setup", "user-permission-setup.md");
    const candidates = [
      {
        ...createGraphNode("source-user-permission-audit", "user-permission-audit.md"),
        title: "用户权限审计指南",
        subjects: ["用户权限审计"],
        entities: ["用户权限"],
        keywords: ["用户权限", "权限审计", "访问控制"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "用户权限审计配置指南",
        type: "guide",
        tags: []
      },
      body: [
        "# 用户权限审计配置指南",
        "",
        "本文介绍用户权限审计、角色继承、访问控制和审批流程。",
        "用户权限审计配置需要与用户权限审计制度衔接。"
      ].join("\n"),
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(1);
    expect(storedEdges[0]?.toFileId).toBe("source-user-permission-audit");
    expect(storedEdges[0]?.evidence).toMatchObject({
      signal: "same_specific_subject",
      matchedTerms: expect.arrayContaining(["用户权限审计"])
    });
  });

  it("does not connect unrelated files through generic document phrases", async () => {
    const source = createSourceFile("source-payment", "payment.md");
    const candidates = [
      {
        ...createGraphNode("source-release", "release.md"),
        title: "发布说明",
        subjects: ["发布说明", "文档", "当前版本"],
        entities: ["发布说明"],
        keywords: ["文档", "当前版本", "相关内容"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "支付配置指南",
        type: "guide",
        tags: []
      },
      body: [
        "# 支付配置指南",
        "",
        "本文介绍支付配置、回调地址、密钥轮换和错误排查。",
        "当前文档提供配置步骤和常见问题。"
      ].join("\n"),
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });

  it("keeps same-subject Chinese files when the shared phrase names the subject", async () => {
    const source = createSourceFile("source-payment-setup", "payment-setup.md");
    const candidates = [
      {
        ...createGraphNode("source-payment-troubleshooting", "payment-troubleshooting.md"),
        title: "支付配置故障排查",
        subjects: ["支付配置故障排查", "支付配置"],
        entities: ["支付配置"],
        keywords: ["支付配置", "回调地址", "密钥轮换"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "支付配置指南",
        type: "guide",
        tags: []
      },
      body: [
        "# 支付配置指南",
        "",
        "本文介绍支付配置、回调地址、密钥轮换和错误排查。"
      ].join("\n"),
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(1);
    expect(storedEdges[0]).toMatchObject({
      toFileId: "source-payment-troubleshooting",
      relationType: "same_specific_subject"
    });
  });

  it("does not publish cross-scope relationships from boilerplate body phrases", async () => {
    const source = createSourceFile("source-product-roadmap", "product-roadmap.md");
    const candidates = [
      {
        ...createGraphNode("source-support-manual", "support-manual.md"),
        title: "客户支持手册",
        subjects: ["客户支持", "文档"],
        entities: ["客户支持"],
        keywords: ["本文档", "相关信息", "当前内容"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "产品路线图",
        type: "roadmap",
        tags: []
      },
      body:
        "# 产品路线图\n\n本文档提供当前内容和相关信息，用于说明后续计划和参考事项。",
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });

  it("does not promote model related-link hints to explicit references without content evidence", async () => {
    const source = createSourceFile("source-procurement-approval", "procurement-approval.md");
    const candidates = [
      {
        ...createGraphNode("source-onboarding-handbook", "onboarding-handbook.md"),
        title: "员工入职手册",
        subjects: ["员工入职"],
        entities: ["员工入职"],
        keywords: ["入职流程", "账号开通", "培训安排"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "采购审批流程",
        type: "workflow",
        tags: []
      },
      body: "# 采购审批流程\n\n本文介绍采购申请、预算复核、审批节点和供应商确认。",
      suggestions: {
        type: "workflow",
        title: "采购审批流程",
        description: "",
        tags: [],
        keywords: [],
        related_links: [
          {
            title: "员工入职手册",
            path: "pages/onboarding-handbook.md"
          }
        ]
      },
      pageSize: 10
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });

  it("does not promote stale generated Related sections to explicit references", async () => {
    const source = createSourceFile("source-procurement-approval", "procurement-approval.md");
    const candidates = [
      {
        ...createGraphNode("source-onboarding-handbook", "onboarding-handbook.md"),
        title: "员工入职手册",
        subjects: ["员工入职"],
        entities: ["员工入职"],
        keywords: ["入职流程", "账号开通", "培训安排"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "采购审批流程",
        type: "workflow",
        tags: []
      },
      body: [
        "# 采购审批流程",
        "",
        "本文介绍采购申请、预算复核、审批节点和供应商确认。",
        "",
        "## Related",
        "",
        "- [员工入职手册](onboarding-handbook.md)"
      ].join("\n"),
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });

  it("does not turn directory proximity into a semantic relationship", async () => {
    const source = createSourceFile("source-deployment-install", "runbooks/deployment-install.md");
    const candidates = [
      {
        ...createGraphNode("source-deployment-checklist", "deployment-checklist.md"),
        path: "pages/runbooks/deployment-checklist.md",
        title: "检查清单",
        subjects: ["部署目标"],
        entities: [],
        keywords: []
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "部署目标安装指南",
        type: "guide",
        tags: []
      },
      body: "# 部署目标安装指南\n\n本文介绍部署目标的安装步骤、检查顺序和运行要求。",
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });

  it("does not use tree proximity for files from different generated directories", async () => {
    const source = createSourceFile("source-deployment-install", "runbooks/deployment-install.md");
    const candidates = [
      {
        ...createGraphNode("source-deployment-checklist", "deployment-checklist.md"),
        path: "pages/reference/deployment-checklist.md",
        title: "检查清单",
        subjects: ["部署目标"],
        entities: [],
        keywords: []
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "部署目标安装指南",
        type: "guide",
        tags: []
      },
      body: "# 部署目标安装指南\n\n本文介绍部署目标的安装步骤、检查顺序和运行要求。",
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });

  it("excludes generated headings from graph node signals", async () => {
    const source = createSourceFile("source-current", "current.md");
    const storedNodes = new Map<string, OkfGraphNode>();
    const graph = createMemoryGraphRepository({
      candidates: [],
      storedNodes
    });

    await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Current",
        type: "page",
        tags: []
      },
      body: [
        "# Current",
        "",
        "This source describes park management.",
        "",
        "## Related",
        "",
        "- [Other](/pages/other.md)",
        "",
        "# Citations",
        "",
        "- https://example.com"
      ].join("\n"),
      suggestions: null,
      pageSize: 10
    });

    expect(storedNodes.get(source.id)?.headings).toEqual(["Current"]);
    expect(storedNodes.get(source.id)?.keywords).not.toContain("related");
    expect(storedNodes.get(source.id)?.keywords).not.toContain("citations");
  });

  it("stores content-derived profile signals on graph nodes", async () => {
    const source = createSourceFile("source-payment-callback", "payment-callback.md");
    const storedNodes = new Map<string, OkfGraphNode>();
    const graph = createMemoryGraphRepository({
      candidates: [],
      storedNodes
    });

    await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Payment callback handbook",
        type: "guide",
        description: "Metadata-only summary",
        tags: ["operations"]
      },
      body: [
        "# Payment callback handbook",
        "",
        "Payment callback means the notification sent after a payment state changes.",
        "The retry process starts after signature verification and idempotency checks.",
        "Version 2 updated the timeout handling guidance."
      ].join("\n"),
      suggestions: null,
      pageSize: 10
    });

    const node = storedNodes.get(source.id);
    const contentProfile = node?.metadata?.contentProfile as Record<string, unknown>;

    expect(node?.description).toBe("Payment callback means the notification sent after a payment state changes.");
    expect(contentProfile.definitions).toEqual(
      expect.arrayContaining(["Payment callback means the notification sent after a payment state changes."])
    );
    expect(contentProfile.processHints).toEqual(
      expect.arrayContaining(["The retry process starts after signature verification and idempotency checks."])
    );
    expect(contentProfile.versionHints).toEqual(
      expect.arrayContaining(["Version 2 updated the timeout handling guidance."])
    );
  });

  it("does not publish model-rejected candidate edges", async () => {
    const source = createSourceFile("source-current", "current.md");
    const candidates = [createGraphNode("source-related", "related.md")];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Current",
        type: "page",
        tags: []
      },
      body: "# Current\n\nThis file mentions related.",
      suggestions: null,
      pageSize: 10,
      modelConfirmation: {
        modelName: "test-model",
        contextWindowTokens: 100_000,
        receiveTimeouts: {
          idleMs: 1_000,
          maxMs: 5_000
        },
        client: {
          responses: {
            create: async () => ({
              status: "completed",
              output_text: JSON.stringify({
                relationships: [
                  {
                    targetFileId: "source-related",
                    accepted: false,
                    relationType: "direct_reference",
                    weight: 0,
                    reason: "The title mention is not enough evidence."
                  }
                ]
              })
            })
          }
        }
      }
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });

  it("keeps only independently safe edges when model confirmation is unavailable", async () => {
    const source = createSourceFile("source-current", "current.md");
    const candidates = [
      {
        ...createGraphNode("source-direct", "direct-guide.md"),
        title: "Direct guide",
        subjects: ["通用组织名称"],
        entities: ["通用组织名称"],
        keywords: ["通用组织名称"]
      },
      {
        ...createGraphNode("source-generic", "generic-reference.md"),
        title: "Generic reference",
        subjects: ["通用组织名称"],
        entities: ["通用组织名称"],
        keywords: ["通用组织名称"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Current workflow",
        type: "workflow",
        tags: []
      },
      body: [
        "# Current workflow",
        "",
        "The Direct guide defines the next approval step.",
        "通用组织名称只出现在普通背景文字中。"
      ].join("\n"),
      suggestions: null,
      pageSize: 10,
      modelConfirmation: {
        modelName: "unavailable-model",
        contextWindowTokens: 100_000,
        receiveTimeouts: {
          idleMs: 1_000,
          maxMs: 5_000
        },
        client: {
          responses: {
            create: async () => {
              throw new Error("provider unavailable");
            }
          }
        }
      }
    });

    expect(result.warnings.join("\n")).toContain("Model provider error");
    expect(storedEdges).toHaveLength(1);
    expect(storedEdges[0]).toMatchObject({
      toFileId: "source-direct",
      relationType: "direct_reference"
    });
  });

  it("does not publish candidates omitted by model confirmation output", async () => {
    const source = createSourceFile("source-current", "current.md");
    const candidates = [createGraphNode("source-related", "related.md")];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Current",
        type: "page",
        tags: []
      },
      body: "# Current\n\nThis file mentions related.",
      suggestions: null,
      pageSize: 10,
      modelConfirmation: {
        modelName: "test-model",
        contextWindowTokens: 100_000,
        receiveTimeouts: {
          idleMs: 1_000,
          maxMs: 5_000
        },
        client: {
          responses: {
            create: async () => ({
              status: "completed",
              output_text: JSON.stringify({
                relationships: []
              })
            })
          }
        }
      }
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });

  it("does not publish model-confirmed relationships with non-generic relation types", async () => {
    const source = createSourceFile("source-payment-callback", "payment-callback.md");
    const candidates = [
      {
        ...createGraphNode("source-payment-retry", "payment-retry.md"),
        title: "支付回调重试指南",
        subjects: ["支付回调"],
        entities: ["支付回调"],
        keywords: ["支付回调", "重试策略"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "支付回调配置指南",
        type: "guide",
        tags: []
      },
      body: "# 支付回调配置指南\n\n本文介绍支付回调重试指南、签名校验、幂等处理和失败重试。",
      suggestions: null,
      pageSize: 10,
      modelConfirmation: {
        modelName: "test-model",
        contextWindowTokens: 100_000,
        receiveTimeouts: {
          idleMs: 1_000,
          maxMs: 5_000
        },
        client: {
          responses: {
            create: async () => ({
              status: "completed",
              output_text: JSON.stringify({
                relationships: [
                  {
                    targetFileId: "source-payment-retry",
                    accepted: true,
                    relationType: "same_region",
                    weight: 0.85,
                    reason: "Broad grouping is not enough."
                  }
                ]
              })
            })
          }
        }
      }
    });

    expect(result.edgeCount).toBe(0);
    expect(result.warnings.join("\n")).toContain("Graph relationship confirmation failed local schema validation");
    expect(storedEdges).toHaveLength(0);
  });

  it("sends strong shared phrase edges to model confirmation", async () => {
    const source = createSourceFile("source-payment-setup", "payment-setup.md");
    const candidates = [
      {
        ...createGraphNode("source-payment-troubleshooting", "payment-troubleshooting.md"),
        title: "支付配置故障排查",
        subjects: ["支付配置故障排查", "支付配置"],
        entities: ["支付配置"],
        keywords: ["支付配置", "回调地址", "密钥轮换"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });
    let modelCalled = false;

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "支付配置指南",
        type: "guide",
        tags: []
      },
      body: "# 支付配置指南\n\n本文介绍支付配置、回调地址、密钥轮换和错误排查。",
      suggestions: null,
      pageSize: 10,
      modelConfirmation: {
        modelName: "test-model",
        contextWindowTokens: 100_000,
        receiveTimeouts: {
          idleMs: 1_000,
          maxMs: 5_000
        },
        client: {
          responses: {
            create: async () => {
              modelCalled = true;
              return {
                status: "completed",
                output_text: JSON.stringify({
                  relationships: [
                    {
                      targetFileId: "source-payment-troubleshooting",
                      accepted: true,
                      relationType: "same_specific_subject",
                      weight: 0.82,
                      reason: "Both files cover the same specific payment configuration subject."
                    }
                  ]
                })
              };
            }
          }
        }
      }
    });

    expect(modelCalled).toBe(true);
    expect(result.edgeCount).toBe(1);
    expect(storedEdges).toHaveLength(1);
    expect(storedEdges[0]).toMatchObject({
      toFileId: "source-payment-troubleshooting",
      relationType: "same_specific_subject",
      source: "model_confirmed"
    });
  });

  it("classifies files with the same title as versions of the same document", async () => {
    const source = createSourceFile("source-current-version", "access-policy-2026.md");
    const candidates = [
      {
        ...createGraphNode("source-previous-version", "access-policy-2025.md"),
        title: "Access policy",
        subjects: ["access policy"],
        entities: ["access policy"],
        keywords: ["access policy"],
        metadata: {
          contentProfile: {
            versionHints: ["Version 1 was approved in 2025."]
          }
        }
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Access policy",
        type: "policy",
        tags: []
      },
      body: "# Access policy\n\nVersion 2 was approved in 2026. Access reviews run every quarter.",
      suggestions: null,
      pageSize: 10
    });

    expect(storedEdges[0]).toMatchObject({
      toFileId: "source-previous-version",
      relationType: "version_relation"
    });
  });

  it("does not classify same-title duplicate content as a version or direct reference", async () => {
    const source = createSourceFile("source-copy-a", "access-policy-copy-a.md");
    const sharedVersionHint = "Approved in 2026 for the current access review process.";
    const duplicateBody = `# Access policy\n\n${sharedVersionHint}\n\nAccess reviews run every quarter.`;
    const candidates = [
      createContentGraphNode({
        sourceFileId: "source-copy-b",
        sourceRelativePath: "access-policy-copy-b.md",
        metadata: {
          title: "Access policy",
          type: "policy",
          timestamp: "2026-01-01T00:00:00Z",
          tags: []
        },
        body: duplicateBody,
        suggestions: null
      })
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Access policy",
        type: "policy",
        timestamp: "2026-01-01T00:00:00Z",
        tags: []
      },
      body: duplicateBody,
      suggestions: null,
      pageSize: 10
    });

    expect(storedEdges).not.toContainEqual(
      expect.objectContaining({ relationType: "version_relation" })
    );
    expect(storedEdges).not.toContainEqual(
      expect.objectContaining({ relationType: "direct_reference" })
    );
  });

  it("classifies shared update provenance across different documents as collection context", async () => {
    const source = createSourceFile("source-access-policy", "access-policy.md");
    const sharedUpdate = "Updated under the 2026 platform documentation batch.";
    const candidates = [
      {
        ...createGraphNode("source-retention-policy", "retention-policy.md"),
        title: "Retention policy",
        subjects: ["2026 platform documentation batch"],
        entities: ["2026 platform documentation batch"],
        keywords: ["2026 platform documentation batch"],
        metadata: {
          contentProfile: {
            versionHints: [sharedUpdate]
          }
        }
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Access policy",
        type: "policy",
        tags: []
      },
      body: `# Access policy\n\n${sharedUpdate}\n\nAccess reviews run every quarter.`,
      suggestions: null,
      pageSize: 10
    });

    expect(storedEdges[0]).toMatchObject({
      toFileId: "source-retention-policy",
      relationType: "collection_neighbor"
    });
  });

  it("reports every source file whose published graph projection changed", async () => {
    const source = createSourceFile("source-current", "access-policy-current.md");
    const candidates = [
      {
        ...createGraphNode("source-previous", "access-policy-previous.md"),
        title: "Access policy",
        subjects: ["access policy", "access reviews"],
        keywords: ["access policy", "access reviews"]
      }
    ];
    const graph = createMemoryGraphRepository({
      candidates,
      replacedTargetFileIds: ["source-former-target"]
    });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: { title: "Access policy", type: "policy", tags: [] },
      body:
        "# Access policy\n\nAccess reviews run every quarter. Read [the previous policy](/pages/access-policy-previous.md).",
      suggestions: null,
      pageSize: 10
    });

    expect(result.affectedSourceFileIds).toEqual(
      expect.arrayContaining(["source-current", "source-previous", "source-former-target"])
    );
  });

  it("removes generated navigation sections before model relationship confirmation", async () => {
    const source = createSourceFile("source-payment-guide", "payment-guide.md");
    const candidates = [
      {
        ...createGraphNode("source-payment-reference", "payment-reference.md"),
        title: "Payment reference",
        subjects: ["payment configuration"],
        entities: ["payment configuration"],
        keywords: ["payment configuration", "callback verification"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });
    let serializedRequest = "";

    await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Payment configuration guide",
        type: "guide",
        tags: []
      },
      body: [
        "# Payment configuration guide",
        "",
        "Payment configuration covers callback verification and signature rotation.",
        "",
        "## Related",
        "",
        "- generated-navigation-marker"
      ].join("\n"),
      suggestions: null,
      pageSize: 10,
      modelConfirmation: {
        modelName: "test-model",
        contextWindowTokens: 100_000,
        receiveTimeouts: {
          idleMs: 1_000,
          maxMs: 5_000
        },
        client: {
          responses: {
            create: async (request) => {
              serializedRequest = JSON.stringify(request);
              return {
                status: "completed",
                output_text: JSON.stringify({
                  relationships: [
                    {
                      targetFileId: "source-payment-reference",
                      accepted: true,
                      relationType: "same_specific_subject",
                      weight: 0.8,
                      reason: "Both files cover payment configuration."
                    }
                  ]
                })
              };
            }
          }
        }
      }
    });

    expect(serializedRequest).not.toContain("generated-navigation-marker");
  });

  it("does not send weak shared phrase edges to model confirmation", async () => {
    const source = createSourceFile("source-current-notes", "current-notes.md");
    const candidates = [
      {
        ...createGraphNode("source-reference-notes", "reference-notes.md"),
        title: "参考信息",
        subjects: ["相关信息"],
        entities: ["参考信息"],
        keywords: ["当前内容", "相关信息"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "当前说明",
        type: "guide",
        tags: []
      },
      body: "# 当前说明\n\n本文提供当前内容和相关信息。",
      suggestions: null,
      pageSize: 10,
      modelConfirmation: {
        modelName: "test-model",
        contextWindowTokens: 100_000,
        receiveTimeouts: {
          idleMs: 1_000,
          maxMs: 5_000
        },
        client: {
          responses: {
            create: async () => {
              throw new Error("Weak shared phrases must not be sent to the model.");
            }
          }
        }
      }
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });

  it("rejects model confirmations that change the candidate relationship type", async () => {
    const source = createSourceFile("source-current", "current.md");
    const candidates = [
      {
        ...createGraphNode("source-payment-retry", "payment-retry.md"),
        title: "Payment Retry"
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Current",
        type: "guide",
        tags: []
      },
      body: "# Current\n\nRead Payment Retry for failure handling.",
      suggestions: null,
      pageSize: 10,
      modelConfirmation: {
        modelName: "test-model",
        contextWindowTokens: 100_000,
        receiveTimeouts: {
          idleMs: 1_000,
          maxMs: 5_000
        },
        client: {
          responses: {
            create: async () => ({
              status: "completed",
              output_text: JSON.stringify({
                relationships: [
                  {
                    targetFileId: "source-payment-retry",
                    accepted: true,
                    relationType: "same_specific_subject",
                    weight: 0.9,
                    reason: "The model tried to change the deterministic relationship type."
                  }
                ]
              })
            })
          }
        }
      }
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });

  it("replaces stale outgoing graph edges when a source file is retried", async () => {
    const source = createSourceFile("source-current", "current.md");
    const storedEdges: OkfGraphEdge[] = [
      {
        fromFileId: source.id,
        toFileId: "source-stale",
        relationType: "same_specific_subject",
        weight: 0.7,
        reason: "Stale edge from previous processing.",
        source: "deterministic",
        evidence: {
          matchedTerms: ["stale"]
        }
      }
    ];
    const graph = createMemoryGraphRepository({ candidates: [], storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Current",
        type: "page",
        tags: []
      },
      body: "# Current\n\nThis file no longer references the previous target.",
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });
});

function createMemoryGraphRepository(input: {
  candidates: OkfGraphNode[];
  storedNodes?: Map<string, OkfGraphNode>;
  storedEdges?: OkfGraphEdge[];
  replacedTargetFileIds?: string[];
  explicitReconciliationResult?: {
    edgeCount: number;
    sourceFileIds: string[];
    edge?: OkfGraphEdge;
  };
}): FileGraphRepository {
  return {
    async upsertGraphNode(request) {
      input.storedNodes?.set(request.node.fileId, request.node);
    },
    async upsertGraphEdges(request) {
      input.storedEdges?.push(...request.edges);
    },
    async upsertRejectedGraphEdges() {
      return undefined;
    },
    async replaceGraphEdgesForSourceFile(request) {
      if (!input.storedEdges) {
        return {
          sourceFileIds: input.replacedTargetFileIds ?? [],
          edgeIds: []
        };
      }

      for (let index = input.storedEdges.length - 1; index >= 0; index -= 1) {
        if (input.storedEdges[index]?.fromFileId === request.sourceFileId) {
          input.storedEdges.splice(index, 1);
        }
      }
      return {
        sourceFileIds: input.replacedTargetFileIds ?? [],
        edgeIds: []
      };
    },
    async reconcileExplicitReferenceEdgesForTarget() {
      if (input.explicitReconciliationResult?.edge) {
        input.storedEdges?.push(input.explicitReconciliationResult.edge);
      }
      return input.explicitReconciliationResult ? {
        ...input.explicitReconciliationResult,
        edgeIds: []
      } : {
        edgeCount: 0,
        sourceFileIds: [],
        edgeIds: []
      };
    },
    async listGraphNodes(request) {
      const offset = request.cursor ? Number(request.cursor) : 0;
      const items = input.candidates.slice(offset, offset + request.limit);
      const nextOffset = offset + request.limit;
      return {
        items,
        nextCursor: nextOffset < input.candidates.length ? String(nextOffset) : null
      };
    },
    async listGraphEdges() {
      return { items: input.storedEdges ?? [], nextCursor: null };
    },
    async listGraphNeighborhood() {
      return { items: [], nextCursor: null };
    },
    async deleteGraphForSourceFile() {
      return undefined;
    }
  };
}

function createSourceFile(id: string, relativePath: string): SourceFileRecord {
  const name = relativePath.split("/").at(-1) ?? relativePath;
  return {
    id,
    knowledgeBaseId: "kb-graph",
    name,
    relativePath,
    objectKey: `tenant/demo/knowledge-bases/kb-graph/sources/${id}/${relativePath}`,
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 10,
    checksumSha256: "checksum",
    metadata: {},
    modelSuggestions: null,
    processingStatus: "completed",
    processingStage: "generation_activation",
    processingStartedAt: now,
    processingEndedAt: now,
    terminalFailure: null,
    retryCount: 0,
    createdAt: now,
    deletedAt: null
  };
}

function createGraphNode(fileId: string, fileName: string): OkfGraphNode {
  return {
    fileId,
    path: `pages/${fileName}`,
    title: fileName.replace(/\.md$/u, ""),
    type: "page",
    tags: ["shared"],
    headings: ["Current"],
    keywords: ["shared"],
    metadata: {
      title: fileName.replace(/\.md$/u, ""),
      type: "page",
      tags: ["shared"]
    }
  };
}
