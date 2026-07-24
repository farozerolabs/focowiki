import { describe, expect, it } from "vitest";
import {
  assertNodeJiebaRuntimeAvailable,
  createNodeJiebaTokenizer,
  NODEJIEBA_PACKAGE_VERSION
} from "../src/infrastructure/tokenization/nodejieba-tokenizer.js";

describe("nodejieba lexical tokenizer", () => {
  it("uses the exact accepted package and a deterministic dictionary contract", () => {
    expect(() => assertNodeJiebaRuntimeAvailable()).not.toThrow();
    const first = createNodeJiebaTokenizer();
    const second = createNodeJiebaTokenizer();

    expect(NODEJIEBA_PACKAGE_VERSION).toBe("3.5.8");
    expect(first.contractVersion).toBe(second.contractVersion);
    expect(first.contractVersion).toMatch(/^lexical-tokenizer-v1-[a-f0-9]{64}$/u);
  });

  it("uses one search-mode contract for Chinese document and query text", () => {
    const tokenizer = createNodeJiebaTokenizer();
    const value = "缓存一致性需要版本校验和租约恢复";

    expect(tokenizer.tokenizeDocument(value, 32)).toEqual(
      tokenizer.tokenizeQuery(value, 32)
    );
    expect(tokenizer.tokenizeQuery(value, 32)).toEqual(expect.arrayContaining([
      "缓存",
      "一致性",
      "版本",
      "校验",
      "租约",
      "恢复"
    ]));
  });

  it("normalizes compatibility forms and keeps mixed-script evidence", () => {
    const tokenizer = createNodeJiebaTokenizer();

    expect(tokenizer.tokenizeQuery("ＡＰＩ v2 缓存恢复", 32)).toEqual(
      expect.arrayContaining(["api", "v2", "缓存", "恢复"])
    );
  });

  it("keeps meaningful two-character Chinese terms across punctuation and whitespace variants", () => {
    const tokenizer = createNodeJiebaTokenizer();
    const compact = tokenizer.tokenizeQuery("重婚，证据", 32);
    const spaced = tokenizer.tokenizeQuery("重婚  证据", 32);

    expect(compact).toEqual(expect.arrayContaining(["重婚", "证据"]));
    expect(spaced).toEqual(expect.arrayContaining(["重婚", "证据"]));
  });

  it("filters punctuation and bounds native output", () => {
    const tokenizer = createNodeJiebaTokenizer();
    const terms = tokenizer.tokenizeDocument(
      Array.from({ length: 500 }, (_, index) => `缓存term${index}`).join("，"),
      40
    );

    expect(terms).toHaveLength(40);
    expect(terms.every((term) => !/^[\s\p{P}]+$/u.test(term))).toBe(true);
  });
});
