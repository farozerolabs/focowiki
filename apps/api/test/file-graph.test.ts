import { describe, expect, it } from "vitest";
import type { OkfGraphEdge, OkfGraphNode } from "@focowiki/okf";
import { buildSourceFileGraph } from "../src/graph/file-graph.js";
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
    expect(nodePageCalls).toBe(2);
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

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
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
        title: "用户权限配置指南",
        type: "guide",
        tags: []
      },
      body: [
        "# 用户权限配置指南",
        "",
        "本文介绍用户权限分配、角色继承、访问控制和审批流程。",
        "用户权限配置需要与用户权限审计制度衔接。"
      ].join("\n"),
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(1);
    expect(storedEdges[0]?.toFileId).toBe("source-user-permission-audit");
    expect(storedEdges[0]?.evidence).toMatchObject({
      matchedTerms: expect.arrayContaining(["用户权限"])
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
      relationType: "shared_key_phrase"
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
                    relationType: "title_mention",
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

  it("does not let model confirmation upgrade weak shared phrase edges", async () => {
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
              throw new Error("Weak phrase edges must not be sent to the model.");
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
                    relationType: "same_subject",
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
        relationType: "shared_key_phrase",
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
        return;
      }

      for (let index = input.storedEdges.length - 1; index >= 0; index -= 1) {
        if (input.storedEdges[index]?.fromFileId === request.sourceFileId) {
          input.storedEdges.splice(index, 1);
        }
      }
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

function createSourceFile(id: string, originalName: string): SourceFileRecord {
  return {
    id,
    knowledgeBaseId: "kb-graph",
    originalName,
    objectKey: `tenant/demo/knowledge-bases/kb-graph/sources/${id}/${originalName}`,
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 10,
    checksumSha256: "checksum",
    metadata: {},
    modelSuggestions: null,
    processingStatus: "completed",
    processingStage: "release_activation",
    processingStartedAt: now,
    processingEndedAt: now,
    processingErrorCode: null,
    processingErrorMessage: null,
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
