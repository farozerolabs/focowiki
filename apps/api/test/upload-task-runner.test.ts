import { describe, expect, it } from "vitest";
import { createBoundedTaskRunner } from "../src/runtime/task-runner.js";

describe("createBoundedTaskRunner", () => {
  it("limits active queued file work with configured concurrency", async () => {
    const runner = createBoundedTaskRunner(2);
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        runner.run(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          active -= 1;
        })
      )
    );

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("rejects invalid concurrency", () => {
    expect(() => createBoundedTaskRunner(0)).toThrow(/positive integer/i);
  });

  it("spaces queued task starts when a minimum interval is configured", async () => {
    const runner = createBoundedTaskRunner(1, { minStartIntervalMs: 10 });
    const startedAt: number[] = [];

    await Promise.all(
      Array.from({ length: 3 }, () =>
        runner.run(async () => {
          startedAt.push(Date.now());
        })
      )
    );

    expect(startedAt).toHaveLength(3);
    expect((startedAt[1] ?? 0) - (startedAt[0] ?? 0)).toBeGreaterThanOrEqual(8);
    expect((startedAt[2] ?? 0) - (startedAt[1] ?? 0)).toBeGreaterThanOrEqual(8);
  });

  it("rejects invalid minimum start intervals", () => {
    expect(() => createBoundedTaskRunner(1, { minStartIntervalMs: -1 })).toThrow(
      /non-negative integer/i
    );
  });
});
