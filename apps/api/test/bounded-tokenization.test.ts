import { describe, expect, it } from "vitest";
import type { LexicalTokenizer } from "../src/application/ports/lexical-tokenizer.js";
import {
  LEXICAL_DOCUMENT_CHUNK_MAX_CHARS,
  tokenizeBoundedDocument
} from "../src/application/bounded-tokenization.js";

describe("bounded document tokenization", () => {
  it("keeps native calls bounded and samples the complete document", () => {
    const calls: string[] = [];
    const tokenizer: LexicalTokenizer = {
      contractVersion: "test-tokenizer-v1",
      tokenizeDocument(value) {
        calls.push(value);
        return [value.slice(0, 12)];
      },
      tokenizeQuery() {
        throw new Error("Query tokenization is not used");
      }
    };
    const value = [
      "opening-evidence",
      "x".repeat(LEXICAL_DOCUMENT_CHUNK_MAX_CHARS * 3),
      "closing-evidence"
    ].join("");

    const terms = tokenizeBoundedDocument(tokenizer, value, 8);

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => call.length <= LEXICAL_DOCUMENT_CHUNK_MAX_CHARS)).toBe(true);
    expect(calls[0]).toContain("opening-evid");
    expect(calls.at(-1)).toContain("closing-evidence");
    expect(terms.length).toBeLessThanOrEqual(8);
  });

  it("preserves code points at chunk boundaries", () => {
    const calls: string[] = [];
    const tokenizer: LexicalTokenizer = {
      contractVersion: "test-tokenizer-v1",
      tokenizeDocument(value) {
        calls.push(value);
        return [value];
      },
      tokenizeQuery() {
        return [];
      }
    };
    const value = `${"a".repeat(LEXICAL_DOCUMENT_CHUNK_MAX_CHARS - 1)}😀tail`;

    tokenizeBoundedDocument(tokenizer, value, 16);

    expect(calls.join("")).toBe(value);
  });
});
