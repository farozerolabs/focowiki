import { describe, expect, it, vi } from "vitest";
import { readNonCritical } from "../src/read-safeguards.js";

describe("read safeguards", () => {
  it("returns operation output when it completes before timeout", async () => {
    await expect(
      readNonCritical({
        timeoutMs: 50,
        fallback: "fallback",
        operation: async () => "value"
      })
    ).resolves.toBe("value");
  });

  it("returns fallback when operation fails", async () => {
    await expect(
      readNonCritical({
        timeoutMs: 50,
        fallback: "fallback",
        operation: async () => {
          throw new Error("non-critical failure");
        }
      })
    ).resolves.toBe("fallback");
  });

  it("returns fallback when operation exceeds timeout", async () => {
    vi.useFakeTimers();

    const result = readNonCritical({
      timeoutMs: 5,
      fallback: "fallback",
      operation: () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("late"), 50);
        })
    });

    await vi.advanceTimersByTimeAsync(5);
    await expect(result).resolves.toBe("fallback");

    vi.useRealTimers();
  });
});
