import { describe, expect, it } from "vitest";
import { resolveSemanticStageConcurrency } from
  "../src/semantic/application/stage-concurrency.js";

describe("semantic stage concurrency", () => {
  it("uses the configured claim window for cheap and external-waiting stages", () => {
    expect(resolveSemanticStageConcurrency(10)).toBe(10);
    expect(resolveSemanticStageConcurrency(32)).toBe(32);
    expect(resolveSemanticStageConcurrency(1_000)).toBe(32);
  });

  it("rejects invalid claim windows", () => {
    expect(() => resolveSemanticStageConcurrency(0)).toThrow("invalid");
    expect(() => resolveSemanticStageConcurrency(1.5)).toThrow("invalid");
  });
});
