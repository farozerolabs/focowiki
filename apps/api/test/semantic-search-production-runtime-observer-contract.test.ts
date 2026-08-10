import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL(
  "../src/semantic/search/production-runtime.ts",
  import.meta.url
), "utf8");

describe("semantic search production runtime observer contract", () => {
  it("accepts and forwards only the private rank observer", () => {
    expect(source).toMatch(/observer\?: SemanticRankObserver/u);
    expect(source).toMatch(/input\.observer \? \{ observer: input\.observer \} : \{\}/u);
    expect(source).not.toMatch(/process\.env|RANK_OBSERVER|observer.*route/iu);
  });
});
