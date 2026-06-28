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
    const source = createSourceFile("source-zunyi-gas", "zunyi-gas.md");
    const candidates = [
      {
        ...createGraphNode("source-national-prosecutor", "national-prosecutor.md"),
        title: "National prosecutor guidance",
        tags: ["effective"],
        headings: ["Related", "Citations"],
        keywords: ["effective"],
        metadata: {
          title: "National prosecutor guidance",
          type: "local regulation",
          tags: ["effective"],
          status: "effective"
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
        title: "Zunyi gas safety",
        type: "local regulation",
        tags: ["effective"],
        status: "effective"
      },
      body: "# Zunyi gas safety\n\nThis document regulates city gas safety and facility operation.",
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });

  it("does not publish relationships from external source links or generic fragments", async () => {
    const source = createSourceFile("source-zunyi-heritage", "zunyi-heritage.md");
    const candidates = [
      {
        ...createGraphNode("source-prosecutor", "prosecutor.md"),
        title: "Supreme prosecutor salt case interpretation",
        subjects: ["official source", "protection regulation"],
        entities: ["Official source", "Protection regulation"],
        keywords: ["official", "source", "protection", "regulation"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "Zunyi heritage protection regulation",
        type: "local regulation",
        tags: ["effective"]
      },
      body: [
        "# Zunyi heritage protection regulation",
        "",
        "This source describes cultural heritage protection in one city.",
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
    const source = createSourceFile("source-sanya-river", "sanya-river.md");
    const candidates = [
      {
        ...createGraphNode("source-sanya-river-ecology", "sanya-river-ecology.md"),
        title: "三亚市河道生态保护管理条例",
        subjects: ["三亚市", "河道生态保护"],
        entities: ["三亚市", "河道"],
        keywords: ["三亚市", "河道", "生态保护", "监督管理"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "三亚市河道管理条例",
        type: "local regulation",
        tags: []
      },
      body:
        "# 三亚市河道管理条例\n\n本文件规定三亚市河道保护、生态治理、建设、养护和监督管理，并与三亚市河道生态保护管理条例衔接。",
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(1);
    expect(storedEdges[0]?.toFileId).toBe("source-sanya-river-ecology");
  });

  it("connects related Chinese files through body-derived key phrase overlap", async () => {
    const source = createSourceFile("source-rural-road-maintenance", "rural-road-maintenance.md");
    const candidates = [
      {
        ...createGraphNode("source-rural-road-management", "rural-road-management.md"),
        title: "农村公路管理规定",
        subjects: ["农村公路管理"],
        entities: ["农村公路"],
        keywords: ["农村公路", "公路养护", "交通运输"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "农村公路养护办法",
        type: "local regulation",
        tags: []
      },
      body: [
        "# 农村公路养护办法",
        "",
        "本文件规定农村公路建设、养护资金、路产路权保护和交通运输主管部门监督管理。",
        "农村公路养护质量评定、养护责任和安全保障应当与农村公路管理制度衔接。"
      ].join("\n"),
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(1);
    expect(storedEdges[0]?.toFileId).toBe("source-rural-road-management");
    expect(storedEdges[0]?.evidence).toMatchObject({
      matchedTerms: expect.arrayContaining(["农村公路"])
    });
  });

  it("does not publish cross-scope relationships from boilerplate body phrases", async () => {
    const source = createSourceFile("source-qitaihe-park", "qitaihe-park.md");
    const candidates = [
      {
        ...createGraphNode("source-zunyi-gas", "zunyi-gas.md"),
        title: "遵义市城镇燃气安全管理条例",
        subjects: ["遵义市", "城镇燃气安全管理"],
        entities: ["遵义市", "城镇燃气安全管理"],
        keywords: ["结合本市实际", "制定本条例", "法规的规定"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "七台河市城市公园条例",
        type: "local regulation",
        tags: []
      },
      body:
        "# 七台河市城市公园条例\n\n为了加强城市公园管理，根据有关法律法规的规定，结合本市实际，制定本条例。",
      suggestions: null,
      pageSize: 10
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });

  it("does not promote model related-link hints to explicit references without content evidence", async () => {
    const source = createSourceFile("source-hunan-traffic", "hunan-traffic.md");
    const candidates = [
      {
        ...createGraphNode("source-hunan-seed", "hunan-seed.md"),
        title: "《湖南省实施<中华人民共和国种子法>办法》",
        subjects: ["湖南省", "种子法"],
        entities: ["湖南省", "种子"],
        keywords: ["湖南省", "种子", "农业"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "《湖南省水上交通安全条例》",
        type: "local regulation",
        tags: []
      },
      body: "# 《湖南省水上交通安全条例》\n\n本文件规定水上交通安全、船舶航行和港口监督管理。",
      suggestions: {
        type: "local regulation",
        title: "《湖南省水上交通安全条例》",
        description: "",
        tags: [],
        keywords: [],
        related_links: [
          {
            title: "《湖南省实施<中华人民共和国种子法>办法》",
            path: "pages/hunan-seed.md"
          }
        ]
      },
      pageSize: 10
    });

    expect(result.edgeCount).toBe(0);
    expect(storedEdges).toHaveLength(0);
  });

  it("does not promote stale generated Related sections to explicit references", async () => {
    const source = createSourceFile("source-hunan-traffic", "hunan-traffic.md");
    const candidates = [
      {
        ...createGraphNode("source-hunan-seed", "hunan-seed.md"),
        title: "《湖南省实施<中华人民共和国种子法>办法》",
        subjects: ["湖南省", "种子法"],
        entities: ["湖南省", "种子"],
        keywords: ["湖南省", "种子", "农业"]
      }
    ];
    const storedEdges: OkfGraphEdge[] = [];
    const graph = createMemoryGraphRepository({ candidates, storedEdges });

    const result = await buildSourceFileGraph({
      graph,
      knowledgeBaseId: source.knowledgeBaseId,
      source,
      metadata: {
        title: "《湖南省水上交通安全条例》",
        type: "local regulation",
        tags: []
      },
      body: [
        "# 《湖南省水上交通安全条例》",
        "",
        "本文件规定水上交通安全、船舶航行和港口监督管理。",
        "",
        "## Related",
        "",
        "- [《湖南省实施<中华人民共和国种子法>办法》](hunan-seed.md)"
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
