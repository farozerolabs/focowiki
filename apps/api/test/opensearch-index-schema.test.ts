import { describe, expect, it, vi } from "vitest";
import type { LexicalTokenizer } from
  "../src/application/ports/lexical-tokenizer.js";
import {
  createOpenSearchIndexBody,
  serializeOpenSearchDocument
} from "../src/infrastructure/opensearch/opensearch-index-schema.js";
import {
  createStorageVnextContentDocument,
  createStorageVnextFileRelationshipDocument,
  createStorageVnextGraphSeedDocument
} from "../src/storage-vnext/search/documents.js";
import { createStorageVnextSearchSettings } from
  "../src/storage-vnext/search/settings.js";

describe("OpenSearch index schema", () => {
  it("uses strict explicit mappings and built-in analyzers only", () => {
    const body = createOpenSearchIndexBody({
      definition: createStorageVnextSearchSettings({ searchCutoffMs: 750 }),
      tokenizerContractVersion: "lexical-tokenizer-v1-test"
    });

    expect(body.mappings).toMatchObject({
      dynamic: "strict",
      _meta: {
        provider: "opensearch",
        tokenizerContractVersion: "lexical-tokenizer-v1-test"
      },
      properties: {
        id: { type: "keyword" },
        knowledgeBaseId: { type: "keyword" },
        sourceFilePublicId: { type: "keyword" },
        sourceRevisionPublicId: { type: "keyword" },
        documentKind: { type: "keyword" },
        schemaVersion: { type: "keyword" },
        segmentOrdinal: { type: "integer" },
        relationPublicId: { type: "keyword" },
        targetSourceFilePublicId: { type: "keyword" },
        targetLogicalPath: { type: "text", analyzer: "standard" },
        okfSignals: {
          type: "object",
          dynamic: "strict",
          properties: {
            status: { type: "keyword" },
            trustTier: { type: "keyword" },
            staleAfterEpochDay: { type: "long" },
            generatedAtEpochMs: { type: "long" },
            latestVerifiedAtEpochMs: { type: "long" },
            sourceCount: { type: "integer" }
          }
        },
        searchText: { type: "text", analyzer: "standard" },
        _focowikiJiebaText: {
          type: "text",
          analyzer: "focowiki_jieba_evidence"
        },
        _focowikiTitleExact: { type: "keyword" },
        _focowikiPathExact: { type: "keyword" }
      }
    });
    expect(body.settings).toMatchObject({
      analysis: {
        analyzer: {
          focowiki_jieba_evidence: {
            type: "custom",
            tokenizer: "whitespace",
            filter: ["lowercase"]
          }
        }
      }
    });
    expect(JSON.stringify(body)).not.toMatch(/\b(?:icu|ik|jieba)_/iu);
  });

  it("preserves canonical raw text and adds bounded adapter-owned Jieba evidence", () => {
    const tokenizer = createTokenizer();
    const document = createStorageVnextContentDocument({
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "Guides/合同.md",
      fileKind: "markdown",
      title: "Employment 合同",
      contentKind: "segment",
      segmentOrdinal: 3,
      headingAncestors: ["Terms", "终止"],
      searchText: "The complete 原始 body remains unchanged."
    });

    const serialized = serializeOpenSearchDocument({ document, tokenizer });

    expect(serialized._id).toBe(document.id);
    expect(serialized._source).toMatchObject({
      ...document,
      searchText: "The complete 原始 body remains unchanged.",
      _focowikiTitleExact: "employment 合同",
      _focowikiPathExact: "guides/合同.md",
      _focowikiJiebaText: "employment 合同 guides terms 终止 complete 原始 body"
    });
    expect(tokenizer.tokenizeDocument).toHaveBeenCalledWith(
      expect.stringContaining(document.searchText),
      expect.any(Number)
    );
    expect(vi.mocked(tokenizer.tokenizeDocument).mock.calls.every(
      ([, limit]) => limit <= 2_000
    )).toBe(true);
  });

  it("serializes graph seeds with the same deterministic identity contract", () => {
    const tokenizer = createTokenizer();
    const document = createStorageVnextGraphSeedDocument({
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "guides/a.md",
      title: "Graph A",
      searchText: "related contract concepts",
      rankingTerms: ["contract", "relation"]
    });

    expect(serializeOpenSearchDocument({ document, tokenizer })).toMatchObject({
      _id: document.id,
      _source: {
        id: document.id,
        documentKind: "graph_seed",
        rankingTerms: ["contract", "relation"]
      }
    });
  });

  it("serializes canonical relationship evidence under strict mappings", () => {
    const tokenizer = createTokenizer();
    const document = createStorageVnextFileRelationshipDocument({
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "guides/a.md",
      title: "Graph A",
      relationPublicId: "relation-ab",
      evidencePublicId: "evidence-ab",
      targetSourceFilePublicId: "file-b",
      targetSourceRevisionPublicId: "revision-b",
      targetLogicalPath: "guides/b.md",
      targetTitle: "Graph B",
      relationKind: "references",
      direction: "outgoing",
      searchText: "Graph A references Graph B",
      rankingTerms: ["Graph B", "guides/b.md"]
    });

    expect(serializeOpenSearchDocument({ document, tokenizer })).toMatchObject({
      _id: document.id,
      _source: {
        documentKind: "file_relationship",
        relationPublicId: "relation-ab",
        targetSourceFilePublicId: "file-b",
        targetLogicalPath: "guides/b.md",
        rankingTerms: ["Graph B", "guides/b.md"]
      }
    });
  });

  it("rejects unexpected fields and unbounded heading metadata before write", async () => {
    const tokenizer = createTokenizer();
    const document = createStorageVnextContentDocument({
      knowledgeBaseId: "kb-a",
      sourceFilePublicId: "file-a",
      sourceRevisionPublicId: "revision-a",
      logicalPath: "a.md",
      fileKind: "markdown",
      title: "A",
      contentKind: "file",
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: "alpha"
    });
    await expect(Promise.resolve().then(() => serializeOpenSearchDocument({
      document: { ...document, unexpected: "value" } as never,
      tokenizer
    }))).rejects.toMatchObject({ code: "SEARCH_ENGINE_MAPPING_INVALID" });
    await expect(Promise.resolve().then(() => serializeOpenSearchDocument({
      document: {
        ...document,
        headingAncestors: Array.from({ length: 257 }, () => "heading")
      },
      tokenizer
    }))).rejects.toMatchObject({ code: "SEARCH_ENGINE_MAPPING_INVALID" });
  });
});

function createTokenizer(): LexicalTokenizer & {
  tokenizeDocument: ReturnType<typeof vi.fn>;
} {
  return {
    contractVersion: "lexical-tokenizer-v1-test",
    tokenizeDocument: vi.fn(() => [
      "employment", "合同", "guides", "合同", "terms", "终止",
      "complete", "原始", "body"
    ]),
    tokenizeQuery: vi.fn(() => [])
  };
}
