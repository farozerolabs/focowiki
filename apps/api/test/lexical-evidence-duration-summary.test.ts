import { describe, expect, it } from "vitest";
import {
  createOperationTimer,
  summarizeDurations
} from "../scripts/support/lexical-evidence-duration-summary.js";

describe("lexical evidence duration summary", () => {
  it("summarizes more samples than the JavaScript argument limit", () => {
    const values = Array.from({ length: 120_000 }, (_, index) => index / 10);

    expect(summarizeDurations(values)).toEqual({
      count: 120_000,
      averageMs: 5_999.95,
      p50Ms: 5_999.9,
      p95Ms: 11_399.9,
      maximumMs: 11_999.9
    });
  });

  it("returns zero values for an empty sample", () => {
    expect(summarizeDurations([])).toEqual({
      count: 0,
      averageMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      maximumMs: 0
    });
  });

  it("stops operation timing when the tracked promise settles", async () => {
    let now = 10;
    let resolveOperation!: () => void;
    const operation = new Promise<void>((resolve) => {
      resolveOperation = resolve;
    });
    const timer = createOperationTimer(() => now);
    const tracked = timer.track(operation);

    now = 35;
    resolveOperation();
    await tracked;
    now = 90;

    expect(timer.elapsedMs()).toBe(25);
  });
});
