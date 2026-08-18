import { describe, expect, it } from "vitest";
import {
  DOCUMENT_NAVIGATION_TERM_ABSOLUTE_LIMIT,
  DOCUMENT_NAVIGATION_TERM_DEFAULT_LIMIT,
  selectDocumentNavigationTerms
} from "../src/document-indexing/application/document-navigation-terms.js";
import { createNodeJiebaTokenizer } from
  "../src/infrastructure/tokenization/nodejieba-tokenizer.js";

describe("document navigation terms", () => {
  it("uses the canonical nodejieba contract for high-entropy Chinese text", () => {
    const tokenizer = createNodeJiebaTokenizer();
    const result = selectDocumentNavigationTerms({
      path: "pages/platform/缓存恢复与租约一致性.md",
      title: "缓存恢复与租约一致性",
      aliases: ["分布式缓存恢复"],
      headings: ["版本校验", "租约恢复"],
      metadata: ["可靠性", "并发控制"],
      entities: ["Redis", "PostgreSQL"],
      modelKeywords: ["故障恢复"],
      body: highEntropyBody()
    }, tokenizer);

    expect(result.terms.map((item) => item.term)).toEqual(expect.arrayContaining([
      "缓存", "一致性", "版本", "校验", "租约", "恢复"
    ]));
    expect(result.terms).toHaveLength(DOCUMENT_NAVIGATION_TERM_DEFAULT_LIMIT);
    expect(result.terms.every((item) => item.fields.length > 0)).toBe(true);
    expect(result.terms.some((item) => item.term.length === 1
      && /^\p{Script=Han}$/u.test(item.term))).toBe(false);
    expect(result.terms.map((item) => item.term)).not.toEqual(expect.arrayContaining([
      "存一", "约一", "致需"
    ]));
  });

  it("enforces the default and absolute term budgets deterministically", () => {
    const tokenizer = createNodeJiebaTokenizer();
    const input = {
      path: "pages/multilingual/high-entropy.md",
      title: "Multilingual navigation vocabulary",
      aliases: ["多语言导航词汇"],
      headings: ["Search recovery", "検索復旧", "검색 복구"],
      metadata: Array.from({ length: 80 }, (_, index) => `metadata-${index}`),
      entities: Array.from({ length: 80 }, (_, index) => `entity-${index}`),
      modelKeywords: Array.from({ length: 80 }, (_, index) => `keyword-${index}`),
      body: highEntropyBody()
    };

    const first = selectDocumentNavigationTerms(input, tokenizer);
    const second = selectDocumentNavigationTerms(input, tokenizer);
    const absolute = selectDocumentNavigationTerms(input, tokenizer, {
      maximumTerms: DOCUMENT_NAVIGATION_TERM_ABSOLUTE_LIMIT
    });

    expect(first).toEqual(second);
    expect(first.terms).toHaveLength(DOCUMENT_NAVIGATION_TERM_DEFAULT_LIMIT);
    expect(absolute.terms).toHaveLength(DOCUMENT_NAVIGATION_TERM_ABSOLUTE_LIMIT);
    expect(() => selectDocumentNavigationTerms(input, tokenizer, {
      maximumTerms: DOCUMENT_NAVIGATION_TERM_ABSOLUTE_LIMIT + 1
    })).toThrowError(/document_navigation_term_limit_invalid/u);
  });

  it("invalidates the selection fingerprint when the tokenizer contract changes", () => {
    const base = createNodeJiebaTokenizer();
    const input = {
      path: "pages/recovery.md",
      title: "缓存恢复",
      aliases: [],
      headings: [],
      metadata: [],
      entities: [],
      modelKeywords: [],
      body: "缓存恢复需要租约校验。"
    };
    const changed = {
      ...base,
      contractVersion: `${base.contractVersion}-changed`
    };

    expect(selectDocumentNavigationTerms(input, base).fingerprint).not.toBe(
      selectDocumentNavigationTerms(input, changed).fingerprint
    );
  });
});

function highEntropyBody(): string {
  const chinese = [
    "缓存一致性需要版本校验和租约恢复",
    "增量投影必须避免全库扫描和重复对象写入",
    "故障重试不得覆盖仍然有效的工作租约",
    "静态知识包通过有限路由定位语义资源",
    "并发协调依赖持久序列和独立完成回执"
  ];
  const multilingual = Array.from({ length: 180 }, (_, index) =>
    `topic-${index} recovery-${index} 検索復旧${index} 검색복구${index}`);
  return [...chinese, ...multilingual].join("。\n");
}
