import { describe, expect, it } from "vitest";
import { resolveGenerationSchedule } from "../src/publication/generation-schedule.js";

describe("publication generation schedule", () => {
  it("keeps the first batch deadline while the batch remains below threshold", () => {
    const first = resolveGenerationSchedule({
      settingsSnapshot: publicationSnapshot({ batchSize: 50, intervalSeconds: 30 }),
      generationCreatedAt: "2026-07-17T01:00:00.000Z",
      completedAt: "2026-07-17T01:00:00.000Z",
      changeCount: 1
    });
    const later = resolveGenerationSchedule({
      settingsSnapshot: publicationSnapshot({ batchSize: 50, intervalSeconds: 30 }),
      generationCreatedAt: "2026-07-17T01:00:00.000Z",
      completedAt: "2026-07-17T01:00:20.000Z",
      changeCount: 20
    });

    expect(first).toEqual({
      enqueue: true,
      runAfter: "2026-07-17T01:00:30.000Z"
    });
    expect(later).toEqual(first);
  });

  it("makes the existing generation immediately eligible at the batch threshold", () => {
    expect(resolveGenerationSchedule({
      settingsSnapshot: publicationSnapshot({ batchSize: 50, intervalSeconds: 30 }),
      generationCreatedAt: "2026-07-17T01:00:00.000Z",
      completedAt: "2026-07-17T01:00:12.000Z",
      changeCount: 50
    })).toEqual({
      enqueue: true,
      runAfter: "2026-07-17T01:00:12.000Z"
    });
  });

  it("supports per-file and manual publication without hidden fallbacks", () => {
    expect(resolveGenerationSchedule({
      settingsSnapshot: publicationSnapshot({ mode: "per_file" }),
      generationCreatedAt: "2026-07-17T01:00:00.000Z",
      completedAt: "2026-07-17T01:00:12.000Z",
      changeCount: 1
    })).toEqual({ enqueue: true, runAfter: "2026-07-17T01:00:12.000Z" });
    expect(resolveGenerationSchedule({
      settingsSnapshot: publicationSnapshot({ mode: "manual" }),
      generationCreatedAt: "2026-07-17T01:00:00.000Z",
      completedAt: "2026-07-17T01:00:12.000Z",
      changeCount: 1
    })).toEqual({ enqueue: false, runAfter: null });
  });
});

function publicationSnapshot(overrides: Partial<{
  mode: "batch" | "manual" | "per_file";
  batchSize: number;
  intervalSeconds: number;
}> = {}) {
  return {
    publication: {
      mode: "batch",
      batchSize: 50,
      intervalSeconds: 30,
      ...overrides
    }
  };
}
