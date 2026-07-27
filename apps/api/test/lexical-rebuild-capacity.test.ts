import { describe, expect, it, vi } from "vitest";
import { runLexicalCapacityRefill } from "../src/maintenance/lexical-rebuild-capacity.js";

describe("lexical rebuild capacity refill", () => {
  it("claims another eligible batch immediately after capacity is released", async () => {
    const batches = [["source-1"], ["source-2"], []];
    const claim = vi.fn(async () => batches.shift() ?? []);
    const processed: string[] = [];

    const result = await runLexicalCapacityRefill({
      concurrency: 1,
      databaseBatchSize: 1,
      maxClaimCycles: 3,
      claim,
      async process(claims) {
        processed.push(...claims);
        return { completed: claims.length, retried: 0 };
      }
    });

    expect(result).toEqual({
      claimCycles: 3,
      claimed: 2,
      completed: 2,
      retried: 0,
      drained: true
    });
    expect(processed).toEqual(["source-1", "source-2"]);
    expect(claim).toHaveBeenCalledTimes(3);
  });

  it("dynamically fills free slots from bounded database micro-batches", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const run = runLexicalCapacityRefill({
      concurrency: 2,
      databaseBatchSize: 1,
      maxClaimCycles: 1,
      claim: async () => ["source-1", "source-2", "source-3"],
      async process([sourceId]) {
        started.push(sourceId!);
        await new Promise<void>((resolve) => releases.set(sourceId!, resolve));
        return { completed: 1, retried: 0 };
      }
    });

    await vi.waitFor(() => expect(started).toEqual(["source-1", "source-2"]));
    releases.get("source-1")!();
    await vi.waitFor(() => expect(started).toEqual([
      "source-1",
      "source-2",
      "source-3"
    ]));
    releases.get("source-2")!();
    releases.get("source-3")!();

    await expect(run).resolves.toMatchObject({
      claimed: 3,
      completed: 3,
      drained: false
    });
  });
});
