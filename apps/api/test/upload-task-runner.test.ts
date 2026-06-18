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
});
