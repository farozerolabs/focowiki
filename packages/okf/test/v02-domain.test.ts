import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OKF_V02_MAX_DIAGNOSTICS,
  OKF_V02_PROFILE,
  analyzeOkfMetadata,
  classifyOkfActor,
  compareOkfDateOnly,
  normalizeOkfDateOnly,
  normalizeOkfDateTime,
  okfDateOnlyToEpochDay
} from "../src/index.js";

describe("OKF 0.2 dates", () => {
  it.each([
    ["2024-02-29", "2024-02-29"],
    ["2023-02-29", null],
    ["2026-13-01", null],
    ["2026-08-07T00:00:00Z", null],
    [42, null]
  ])("normalizes date-only input %j", (input, expected) => {
    expect(normalizeOkfDateOnly(input)).toBe(expected);
  });

  it("normalizes instants to UTC and rejects date-only values", () => {
    expect(normalizeOkfDateTime("2026-08-07T12:30:00+02:00"))
      .toBe("2026-08-07T10:30:00.000Z");
    expect(normalizeOkfDateTime("2026-08-07")).toBeNull();
    expect(normalizeOkfDateTime("2026-08-07T10:30:00")).toBeNull();
  });

  it("uses exact UTC calendar boundaries", () => {
    expect(compareOkfDateOnly("2026-08-07", "2026-08-07")).toBe(0);
    expect(compareOkfDateOnly("2026-08-08", "2026-08-07")).toBe(1);
    expect(okfDateOnlyToEpochDay("1970-01-01")).toBe(0);
  });
});

describe("OKF 0.2 actor and analysis policy", () => {
  it.each([
    ["human:reviewer", "human"],
    ["process:nightly", "process"],
    ["reference_agent/gemini-2.5-pro", "agent"],
    ["vendor:unknown", "unknown"],
    ["", null]
  ])("classifies %j exactly", (actor, expected) => {
    expect(classifyOkfActor(actor)).toBe(expected);
  });

  it("keeps independent valid fields when another optional family is malformed", () => {
    const result = analyzeOkfMetadata({
      type: "Guide",
      status: "draft",
      stale_after: "invalid",
      verified: { by: "human:reviewer", at: "invalid" },
      sources: "invalid",
      generated: { by: "process:publisher", at: "2026-08-07T10:00:00Z" }
    }, { today: "2026-08-07" });

    expect(result.signals).toMatchObject({
      effectiveStatus: "draft",
      trustTier: null,
      isStale: null,
      sourceCount: null,
      generatedAt: "2026-08-07T10:00:00.000Z"
    });
    expect(result.diagnostics.every((item) => item.disposition === "advisory")).toBe(true);
  });

  it("bounds safe diagnostics without carrying source values", () => {
    const sources = Array.from({ length: 200 }, (_, index) => ({
      id: `source-${index}`
    }));
    const result = analyzeOkfMetadata({ type: "Guide", sources });
    expect(result.diagnostics.length).toBeLessThanOrEqual(OKF_V02_MAX_DIAGNOSTICS);
    expect(JSON.stringify(result.diagnostics)).not.toContain("source-199");
  });

  it("pins the official profile without a runtime fetch", () => {
    expect(OKF_V02_PROFILE).toMatchObject({
      version: "0.2",
      repositoryRevision: "930b65fc3f5619d5d0591f88c72ebae8b848d60d"
    });
  });
});

describe("OKF 0.2 package boundaries", () => {
  it("keeps v02 domain modules independent from application adapters", () => {
    const directory = resolve(import.meta.dirname, "../src/v02");
    for (const fileName of readdirSync(directory).filter((name) => name.endsWith(".ts"))) {
      const source = readFileSync(resolve(directory, fileName), "utf8");
      expect(source).not.toMatch(
        /from\s+["'](?:postgres|redis|meilisearch|@opensearch-project|@aws-sdk|hono|\.\.\/\.\.\/apps)/u
      );
    }
  });
});
