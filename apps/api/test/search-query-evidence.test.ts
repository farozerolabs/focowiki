import { describe, expect, it } from "vitest";
import type { LexicalTokenizer } from "../src/application/ports/lexical-tokenizer.js";
import { createSearchQueryEvidence } from "../src/search/search-query-evidence.js";

const calls: string[] = [];
const tokenizer: LexicalTokenizer = {
  contractVersion: "query-test-v1",
  tokenizeDocument(value, limit) {
    return value.normalize("NFKC").toLowerCase().split(/\s+/u).filter(Boolean).slice(0, limit);
  },
  tokenizeQuery(value, limit) {
    calls.push(value);
    return value
      .normalize("NFKC")
      .toLowerCase()
      .split(/[\s,，。；、]+/u)
      .filter(Boolean)
      .flatMap((term) => term === "缓存一致性" ? ["缓存", "一致性", term] : [term])
      .slice(0, limit);
  }
};

describe("search query evidence", () => {
  it("preserves the normalized phrase and uses the shared query tokenizer", () => {
    calls.length = 0;
    const evidence = createSearchQueryEvidence("  缓存一致性，版本 recovery  ", tokenizer);

    expect(evidence.phrase).toBe("缓存一致性,版本 recovery");
    expect(evidence.terms).toEqual(["缓存", "一致性", "缓存一致性", "版本", "recovery"]);
    expect(evidence.tokenizerContractVersion).toBe("query-test-v1");
    expect(calls).toEqual(["缓存一致性,版本 recovery"]);
  });

  it("normalizes compatibility forms, punctuation, and repeated whitespace deterministically", () => {
    const first = createSearchQueryEvidence("ＡＰＩ　迁移；恢复", tokenizer);
    const second = createSearchQueryEvidence("API 迁移,恢复", tokenizer);

    expect(first).toEqual(second);
    expect(first.terms).toEqual(["api", "迁移", "恢复"]);
  });

  it("bounds query token expansion", () => {
    const evidence = createSearchQueryEvidence(
      Array.from({ length: 100 }, (_, index) => `term${index}`).join(" "),
      tokenizer
    );

    expect(evidence.terms.length).toBeLessThanOrEqual(32);
  });

  it("removes low-selectivity numeric fragments from multi-term queries", () => {
    const fragmentedTokenizer: LexicalTokenizer = {
      ...tokenizer,
      tokenizeQuery() {
        return ["景德镇", "陶瓷", "2", "0", "4", "3", "2024-04-03__"];
      }
    };

    expect(createSearchQueryEvidence(
      "景德镇陶瓷保护条例__2024-04-03",
      fragmentedTokenizer
    ).terms).toEqual(["景德镇", "陶瓷", "2024-04-03__"]);
  });

  it("retains a single numeric term when it is the complete query evidence", () => {
    const numericTokenizer: LexicalTokenizer = {
      ...tokenizer,
      tokenizeQuery() {
        return ["2"];
      }
    };

    expect(createSearchQueryEvidence("2", numericTokenizer).terms).toEqual(["2"]);
  });
});
