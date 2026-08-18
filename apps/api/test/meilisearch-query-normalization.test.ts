import { describe, expect, it, vi } from "vitest";
import { normalizeMeilisearchQuery } from
  "../src/infrastructure/meilisearch/meilisearch-query-normalization.js";

describe("Meilisearch query normalization", () => {
  it("removes a Han base term from blended negated retrieval", () => {
    const lexical = tokenizer([
      "存在", "火星", "海洋", "采矿", "许可", "如何", "续期"
    ]);
    expect(normalizeMeilisearchQuery({
      request: {
        query: "不存在的火星海洋采矿许可如何续期？",
        evidenceFamilies: ["exact", "text", "phrase", "typo", "jieba", "graph"],
        matchingStrategy: "last"
      },
      tokenizer: lexical
    })).toEqual({
      query: "火星 海洋 采矿 许可 续期",
      matchingStrategy: "last"
    });
    expect(lexical.tokenizeQuery).toHaveBeenCalledOnce();
  });

  it("preserves candidate Han boundaries for the native Meilisearch tokenizer", () => {
    const lexical = tokenizer(["知识", "图谱", "搜索"]);
    expect(normalizeMeilisearchQuery({
      request: {
        query: "知识图谱 search",
        evidenceFamilies: ["jieba", "text"],
        matchingStrategy: "all"
      },
      tokenizer: lexical
    })).toEqual({
      query: "知识图谱 search",
      matchingStrategy: "all"
    });
    expect(lexical.tokenizeQuery).not.toHaveBeenCalled();
  });

  it("leaves exact-only requests byte-for-byte unchanged", () => {
    const lexical = tokenizer(["ignored"]);
    expect(normalizeMeilisearchQuery({
      request: {
        query: "Guides/Exact File.md",
        evidenceFamilies: ["exact"],
        matchingStrategy: "all"
      },
      tokenizer: lexical
    })).toEqual({
      query: "Guides/Exact File.md",
      matchingStrategy: "all"
    });
    expect(lexical.tokenizeQuery).not.toHaveBeenCalled();
  });
});

function tokenizer(terms: string[]) {
  return {
    contractVersion: "lexical-tokenizer-test-v1",
    tokenizeDocument: vi.fn(() => []),
    tokenizeQuery: vi.fn(() => terms)
  };
}
