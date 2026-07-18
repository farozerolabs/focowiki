import { describe, expect, it } from "vitest";

import {
  GeneratedTextIdentityError,
  canonicalizeGeneratedTextIdentity,
  decodeMarkdownIdentityLabel,
  renderMarkdownIdentityLabel,
  sameGeneratedTextIdentity
} from "../src/text-identity.js";

describe("generated text identity", () => {
  it.each([
    [" repeated whitespace ", "repeated whitespace"],
    ["tabs\tand\tspaces", "tabs and spaces"],
    ["line\r\nbreak", "line break"],
    ["non\u00a0breaking", "non breaking"],
    ["ideographic\u3000space", "ideographic space"],
    ["Cafe\u0301", "Caf\u00e9"]
  ])("canonicalizes %j to %j", (input, expected) => {
    expect(canonicalizeGeneratedTextIdentity(input)).toBe(expected);
  });

  it("preserves case, punctuation, script, wording, and meaningful symbols", () => {
    expect(canonicalizeGeneratedTextIdentity("API-v2: [Alpha] / 中文 (A+B)"))
      .toBe("API-v2: [Alpha] / 中文 (A+B)");
    expect(sameGeneratedTextIdentity("API", "api")).toBe(false);
  });

  it.each([
    "",
    " \t\r\n ",
    "unsafe\u0000value",
    "unsafe\u0007value",
    "unsafe\u007fvalue",
    "unsafe\u202evalue",
    "unsafe\u2066value"
  ])("rejects unsafe or empty identity %j", (input) => {
    expect(() => canonicalizeGeneratedTextIdentity(input)).toThrow(
      GeneratedTextIdentityError
    );
  });

  it("keeps Markdown rendering separate from semantic identity", () => {
    const identity = String.raw`[Guide] (A_B) *draft* \\ reference`;
    const rendered = renderMarkdownIdentityLabel(identity);

    expect(rendered).not.toBe(identity);
    expect(decodeMarkdownIdentityLabel(rendered)).toBe(identity);
    expect(sameGeneratedTextIdentity(decodeMarkdownIdentityLabel(rendered), identity)).toBe(true);
  });
});
