import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { testLexicalTokenizer } from "./helpers/test-lexical-tokenizer.js";
import {
  createStorageVnextSourceGraphExtractor,
  reconcileStorageVnextGraphEdges
} from "../src/storage-vnext/source-processing/graph-extractor.js";
import type { StorageVnextGraphNodeFact } from
  "../src/storage-vnext/graph/ports.js";

describe("storage vNext source graph extractor", () => {
  it("preserves body-derived semantic graph relations without PostgreSQL lexical rows", async () => {
    const body = [
      "# 支付配置指南",
      "",
      "本文介绍支付配置、回调地址、密钥轮换和错误排查。"
    ].join("\n");
    const sourceBody = [
      "---",
      "title: 支付配置指南",
      "type: guide",
      "---",
      body
    ].join("\n");
    const checksum = createHash("sha256").update(sourceBody).digest("hex");
    const candidate = candidateNode();
    const findCandidates = vi.fn(async () => [candidate]);
    const extractor = createStorageVnextSourceGraphExtractor({
      tokenizer: testLexicalTokenizer,
      candidates: { findCandidates },
      limits: {
        maximumCandidateNodes: 20,
        acceptedEdgeLimit: 20,
        genericPhraseThreshold: 4
      }
    });

    const result = await extractor({
      knowledgeBaseId: "kb-graph",
      sourceFilePublicId: "source-payment-setup",
      sourceRevisionPublicId: "revision-payment-setup",
      sourceLogicalPath: "payments/payment-setup.md",
      checksum,
      revision: 1,
      parsedMetadata: {
        title: "支付配置指南",
        type: "guide",
        tags: []
      },
      suggestions: {
        title: "支付配置指南",
        type: "guide",
        description: "支付配置、回调与密钥轮换说明。",
        tags: [],
        related_links: [],
        keywords: []
      },
      modelAssistanceSelected: true,
      body,
      sourceBody,
      signal: new AbortController().signal
    });

    expect(findCandidates).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-graph",
      sourceFilePublicId: "source-payment-setup",
      terms: expect.arrayContaining(["支付配置"]),
      limit: 20
    }));
    expect(result.node).toMatchObject({
      knowledgeBaseId: "kb-graph",
      sourceFilePublicId: "source-payment-setup",
      sourceRevisionPublicId: "revision-payment-setup",
      logicalPath: "pages/payments/payment-setup.md",
      label: "支付配置指南",
      kind: "guide",
      metadata: {
        presentationSuggestion: {
          description: "支付配置、回调与密钥轮换说明。"
        },
        contentProfile: expect.objectContaining({
          subjects: expect.arrayContaining(["支付配置"]),
          keywords: expect.arrayContaining(["回调", "密钥"])
        })
      }
    });
    expect(result.edges).toEqual([
      expect.objectContaining({
        knowledgeBaseId: "kb-graph",
        fromNodePublicId: result.node.publicId,
        toNodePublicId: candidate.publicId,
        relation: "same_specific_subject",
        source: "deterministic",
        metadata: expect.any(Object),
        evidence: [expect.objectContaining({
          sourceFilePublicId: "source-payment-setup",
          sourceRevisionPublicId: "revision-payment-setup",
          logicalPath: "pages/payments/payment-setup.md",
          checksum
        })]
      })
    ]);
    const evidence = result.edges[0]!.evidence[0]!;
    expect(sourceBody.slice(evidence.startOffset, evidence.endOffset)).toContain("支付配置");
  });

  it("reconciles stored node profiles against the unified candidate index without rerunning suggestions", async () => {
    const body = [
      "# 支付配置指南",
      "",
      "本文介绍支付配置、回调地址、密钥轮换和错误排查。"
    ].join("\n");
    const checksum = createHash("sha256").update(body).digest("hex");
    const baseExtractor = createStorageVnextSourceGraphExtractor({
      tokenizer: testLexicalTokenizer,
      candidates: { findCandidates: vi.fn(async () => []) },
      limits: {
        maximumCandidateNodes: 20,
        acceptedEdgeLimit: 20,
        genericPhraseThreshold: 4
      }
    });
    const base = await baseExtractor({
      knowledgeBaseId: "kb-graph",
      sourceFilePublicId: "source-payment-setup",
      sourceRevisionPublicId: "revision-payment-setup",
      sourceLogicalPath: "payments/payment-setup.md",
      checksum,
      revision: 1,
      parsedMetadata: { title: "支付配置指南", type: "guide", tags: [] },
      suggestions: null,
      modelAssistanceSelected: false,
      body,
      sourceBody: body,
      signal: new AbortController().signal
    });
    const findCandidates = vi.fn(async () => [candidateNode()]);

    const edges = await reconcileStorageVnextGraphEdges({
      tokenizer: testLexicalTokenizer,
      candidates: { findCandidates },
      limits: {
        maximumCandidateNodes: 20,
        acceptedEdgeLimit: 20,
        genericPhraseThreshold: 4
      }
    }, {
      node: base.node,
      checksum,
      body,
      signal: new AbortController().signal
    });

    expect(findCandidates).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-graph",
      sourceFilePublicId: "source-payment-setup"
    }));
    expect(edges).toEqual([
      expect.objectContaining({
        fromNodePublicId: base.node.publicId,
        toNodePublicId: "node-payment-troubleshooting",
        relation: "same_specific_subject"
      })
    ]);
  });

  it("grounds resolved explicit-reference relationships in the original source text", async () => {
    const body = "See ../datasets/transactions.md for the source table.";
    const checksum = createHash("sha256").update(body).digest("hex");
    const profile = {
      summary: "Profiled content.",
      subjects: [],
      keywords: [],
      entities: [],
      explicitReferences: [
        "../datasets/transactions.md",
        "pages/datasets/transactions.md"
      ],
      relationshipHints: ["pages/datasets/transactions.md"],
      definitions: [],
      processHints: [],
      versionHints: [],
      evidencePhrases: [],
      headingOutline: [],
      language: "en",
      profileVersion: "content-profile-v3",
      profileSource: "deterministic",
      tokenizerContractVersion: "nodejieba-v1"
    };
    const source: StorageVnextGraphNodeFact = {
      publicId: "node-source-ungrounded",
      knowledgeBaseId: "kb-graph",
      sourceFilePublicId: "source-ungrounded",
      sourceRevisionPublicId: "revision-ungrounded",
      logicalPath: "pages/notes/source.md",
      label: "Source record",
      kind: "note",
      metadata: { contentProfile: profile },
      evidence: [],
      revision: 1
    };
    const target: StorageVnextGraphNodeFact = {
      ...source,
      publicId: "node-target-ungrounded",
      sourceFilePublicId: "target-ungrounded",
      sourceRevisionPublicId: "target-revision-ungrounded",
      logicalPath: "pages/datasets/transactions.md",
      label: "Transaction table",
      metadata: { contentProfile: { ...profile, explicitReferences: [] } }
    };

    const edges = await reconcileStorageVnextGraphEdges({
      tokenizer: testLexicalTokenizer,
      candidates: { findCandidates: vi.fn(async () => [target]) },
      limits: {
        maximumCandidateNodes: 20,
        acceptedEdgeLimit: 20,
        genericPhraseThreshold: 4
      }
    }, {
      node: source,
      checksum,
      body,
      signal: new AbortController().signal
    });

    expect(edges).toEqual([
      expect.objectContaining({
        relation: "direct_reference",
        evidence: [expect.objectContaining({
          sourceFilePublicId: "source-ungrounded",
          sourceRevisionPublicId: "revision-ungrounded"
        })]
      })
    ]);
    const evidence = edges[0]!.evidence[0]!;
    expect(body.slice(evidence.startOffset, evidence.endOffset))
      .toBe("../datasets/transactions.md");
  });

  it("grounds normalized title mentions at their original source offsets", async () => {
    const body = "See bitcoin   transactions-table for the source data.";
    const checksum = createHash("sha256").update(body).digest("hex");
    const source = {
      ...candidateNode(),
      publicId: "node-title-source",
      sourceFilePublicId: "source-title-source",
      sourceRevisionPublicId: "revision-title-source",
      logicalPath: "pages/notes/title-source.md",
      label: "Source record",
      metadata: {},
      evidence: []
    };
    const target = {
      ...candidateNode(),
      publicId: "node-title-target",
      sourceFilePublicId: "source-title-target",
      sourceRevisionPublicId: "revision-title-target",
      logicalPath: "pages/datasets/transactions.md",
      label: "Bitcoin Transactions Table"
    };

    const edges = await reconcileStorageVnextGraphEdges({
      tokenizer: testLexicalTokenizer,
      candidates: { findCandidates: vi.fn(async () => [target]) },
      limits: {
        maximumCandidateNodes: 20,
        acceptedEdgeLimit: 20,
        genericPhraseThreshold: 4
      }
    }, {
      node: source,
      checksum,
      body,
      signal: new AbortController().signal
    });

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      relation: "direct_reference",
      evidence: [expect.objectContaining({
        sourceFilePublicId: "source-title-source",
        sourceRevisionPublicId: "revision-title-source"
      })]
    });
    const evidence = edges[0]!.evidence[0]!;
    expect(body.slice(evidence.startOffset, evidence.endOffset))
      .toBe("bitcoin   transactions-table");
  });

  it("grounds filename-stem title signals when the full title is absent", async () => {
    const body = "SELECT * FROM `bigquery-public-data.crypto_bitcoin.transactions`;";
    const checksum = createHash("sha256").update(body).digest("hex");
    const source = {
      ...candidateNode(),
      publicId: "node-stem-source",
      sourceFilePublicId: "source-stem-source",
      sourceRevisionPublicId: "revision-stem-source",
      logicalPath: "pages/notes/stem-source.md",
      label: "Join path",
      metadata: {},
      evidence: []
    };
    const target = {
      ...candidateNode(),
      publicId: "node-stem-target",
      sourceFilePublicId: "source-stem-target",
      sourceRevisionPublicId: "revision-stem-target",
      logicalPath: "pages/datasets/transactions.md",
      label: "Bitcoin Transactions Table"
    };

    const edges = await reconcileStorageVnextGraphEdges({
      tokenizer: testLexicalTokenizer,
      candidates: { findCandidates: vi.fn(async () => [target]) },
      limits: {
        maximumCandidateNodes: 20,
        acceptedEdgeLimit: 20,
        genericPhraseThreshold: 4
      }
    }, {
      node: source,
      checksum,
      body,
      signal: new AbortController().signal
    });

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      relation: "direct_reference",
      evidence: [expect.objectContaining({
        sourceFilePublicId: "source-stem-source",
        sourceRevisionPublicId: "revision-stem-source"
      })]
    });
    const evidence = edges[0]!.evidence[0]!;
    expect(body.slice(evidence.startOffset, evidence.endOffset))
      .toBe("transactions");
  });

  it("deterministically bounds large graph profiles below the PostgreSQL JSONB limit", async () => {
    const body = Array.from({ length: 80 }, (_, index) => [
      `## 第${index + 1}项长期治理流程及适用范围`,
      `长期治理流程${index + 1}是指${"跨部门协作、复核、记录和持续改进".repeat(10)}。`
    ].join("\n")).join("\n\n");
    const checksum = createHash("sha256").update(body).digest("hex");
    const extractor = createStorageVnextSourceGraphExtractor({
      tokenizer: testLexicalTokenizer,
      candidates: { findCandidates: vi.fn(async () => []) },
      limits: {
        maximumCandidateNodes: 20,
        acceptedEdgeLimit: 20,
        genericPhraseThreshold: 4
      }
    });

    const result = await extractor({
      knowledgeBaseId: "kb-graph",
      sourceFilePublicId: "source-large-profile",
      sourceRevisionPublicId: "revision-large-profile",
      sourceLogicalPath: "guides/large-profile.md",
      checksum,
      revision: 1,
      parsedMetadata: { title: "长期治理流程", type: "guide", tags: [] },
      suggestions: null,
      modelAssistanceSelected: false,
      body,
      sourceBody: body,
      signal: new AbortController().signal
    });

    expect(Buffer.byteLength(JSON.stringify(result.node.metadata), "utf8"))
      .toBeLessThanOrEqual(7_500);
    expect(result.node.metadata.contentProfile).toMatchObject({
      profileVersion: "content-profile-v3",
      profileSource: "deterministic"
    });
  });
});

function candidateNode(): StorageVnextGraphNodeFact {
  return {
    publicId: "node-payment-troubleshooting",
    knowledgeBaseId: "kb-graph",
    sourceFilePublicId: "source-payment-troubleshooting",
    sourceRevisionPublicId: "revision-payment-troubleshooting",
    logicalPath: "pages/payments/payment-troubleshooting.md",
    label: "支付配置故障排查",
    kind: "guide",
    metadata: {
      tags: [],
      contentProfile: {
        summary: "支付配置故障排查。",
        subjects: ["支付配置故障排查", "支付配置"],
        keywords: ["支付配置", "回调地址", "密钥轮换"],
        entities: ["支付配置"],
        explicitReferences: [],
        relationshipHints: [],
        definitions: [],
        processHints: [],
        versionHints: [],
        evidencePhrases: [],
        headingOutline: ["支付配置故障排查"],
        language: "zh",
        profileVersion: "content-profile-v1",
        profileSource: "deterministic",
        tokenizerContractVersion: "nodejieba-v1"
      }
    },
    evidence: [],
    revision: 1
  };
}
