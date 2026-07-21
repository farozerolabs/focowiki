import { describe, expect, it } from "vitest";
import {
  buildGraphQueryTerms,
  buildGraphTermDocument
} from "../src/graph/graph-term-document.js";

describe("graph term document", () => {
  it("derives bounded terms from Markdown body, headings, and explicit references", () => {
    const document = buildGraphTermDocument({
      sourceFileId: "source-1",
      sourceRevisionId: "revision-1",
      title: "Distributed Cache Operations",
      body: [
        "# Cache invalidation",
        "A write-through cache keeps database changes consistent.",
        "See [Recovery](./recovery.md) for lease recovery."
      ].join("\n"),
      headings: ["Cache invalidation"],
      phrases: ["write-through cache"],
      entities: ["PostgreSQL"],
      explicitReferences: ["./recovery.md"],
      supplementalTerms: ["operations"]
    });

    expect(document.exactTerms).toEqual(expect.arrayContaining([
      "cache",
      "invalidation",
      "database",
      "postgresql",
      "operations"
    ]));
    expect(document.phraseTerms).toEqual(expect.arrayContaining([
      "cache invalidation",
      "write-through cache"
    ]));
    expect(document.explicitReferences).toEqual(["recovery.md"]);
    expect(document.lexicalText).toContain("cache");
    expect(document.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("indexes non-whitespace text with bounded Unicode n-grams", () => {
    const document = buildGraphTermDocument({
      sourceFileId: "source-2",
      sourceRevisionId: "revision-2",
      title: "分布式缓存一致性",
      body: "缓存失效需要版本校验和租约恢复。",
      headings: [],
      phrases: [],
      entities: [],
      explicitReferences: [],
      supplementalTerms: []
    });

    expect(document.exactTerms).toEqual(expect.arrayContaining([
      "分布",
      "缓存",
      "一致",
      "版本",
      "租约"
    ]));
    expect(document.exactTerms.length).toBeLessThanOrEqual(600);
  });

  it("is deterministic and enforces every term cap", () => {
    const input = {
      sourceFileId: "source-3",
      sourceRevisionId: "revision-3",
      title: "Bounded terms",
      body: Array.from({ length: 2_000 }, (_, index) => `term${index}`).join(" "),
      headings: Array.from({ length: 500 }, (_, index) => `Heading ${index}`),
      phrases: Array.from({ length: 500 }, (_, index) => `Phrase ${index}`),
      entities: Array.from({ length: 500 }, (_, index) => `Entity ${index}`),
      explicitReferences: Array.from({ length: 500 }, (_, index) => `./ref-${index}.md`),
      supplementalTerms: Array.from({ length: 500 }, (_, index) => `Tag ${index}`)
    };

    const first = buildGraphTermDocument(input);
    const second = buildGraphTermDocument(input);

    expect(second).toEqual(first);
    expect(first.exactTerms.length).toBeLessThanOrEqual(600);
    expect(first.phraseTerms.length).toBeLessThanOrEqual(120);
    expect(first.explicitReferences.length).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(first.lexicalText)).toBeLessThanOrEqual(64 * 1024);
  });

  it("bounds intermediate token scans for very large repetitive bodies", () => {
    const input = {
      sourceFileId: "source-large",
      sourceRevisionId: "revision-large",
      title: "Large repetitive document",
      body: `${"重复内容".repeat(100_000)} ${"same-term ".repeat(100_000)}`,
      headings: ["Bounded extraction"],
      phrases: [],
      entities: [],
      explicitReferences: [],
      supplementalTerms: []
    };
    const first = buildGraphTermDocument(input);
    const second = buildGraphTermDocument(input);

    expect(first).toEqual(second);
    expect(first.exactTerms.length).toBeLessThanOrEqual(600);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("normalizes whitespace, non-whitespace, phrase, and reference query terms", () => {
    const terms = buildGraphQueryTerms([
      "  Distributed   Cache ",
      "缓存一致性",
      "/pages/guides/recovery.md#lease"
    ]);

    expect(terms.exactTerms).toEqual(expect.arrayContaining([
      "distributed",
      "cache",
      "缓存",
      "一致"
    ]));
    expect(terms.phraseTerms).toContain("distributed cache");
    expect(terms.explicitReferences).toContain("pages/guides/recovery.md");
    expect(terms.lexicalText).not.toContain("  ");
  });

  it("bounds query terms independently from the richer document index", () => {
    const terms = buildGraphQueryTerms(
      Array.from({ length: 500 }, (_, index) => `query phrase ${index}`)
    );

    expect(terms.exactTerms.length).toBeLessThanOrEqual(100);
    expect(terms.phraseTerms.length).toBeLessThanOrEqual(32);
  });

  it("does not classify one ordinary keyword as a phrase or file reference", () => {
    const terms = buildGraphQueryTerms(["cache-invalidation"]);
    expect(terms.exactTerms).toContain("cache-invalidation");
    expect(terms.phraseTerms).toEqual([]);
    expect(terms.explicitReferences).toEqual([]);
  });
});
