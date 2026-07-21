import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { waitForPublicationLock } from "../src/admin/source-file-processor-support.js";
import type { RedisCoordinator } from "../src/redis/coordination.js";

const processorPath = resolve(import.meta.dirname, "../src/admin/source-file-processor.ts");

function readProcessor(): string {
  return readFileSync(processorPath, "utf8").replace(/\s+/g, " ").toLowerCase();
}

describe("source file processor support", () => {
  it("retries the publication lock before failing", async () => {
    let attempts = 0;
    const redis = {
      async acquireKnowledgeBasePublicationLock() {
        attempts += 1;
        return attempts === 3;
      }
    } as Pick<RedisCoordinator, "acquireKnowledgeBasePublicationLock"> as RedisCoordinator;

    const acquired = await waitForPublicationLock({
      redis,
      knowledgeBaseId: "kb-test",
      ownerId: "owner-test",
      ttlSeconds: 60,
      maxWaitMs: 100,
      retryIntervalMs: 1
    });

    expect(acquired).toBe(true);
    expect(attempts).toBe(3);
  });

  it("checks deletion eligibility before storage and graph work without per-stage reads", () => {
    const processor = readProcessor();

    for (const stage of ["upload_storage", "graph_generation"]) {
      const stageOffset = processor.indexOf(`currentstage = \"${stage}\"`);
      const boundary = processor.slice(stageOffset, stageOffset + 220);

      expect(stageOffset).toBeGreaterThanOrEqual(0);
      expect(boundary).toContain("await assertsourcefileprocessingeligible()");
    }
    expect(processor).toContain("sourcefileprocessingcancellederror");
    expect(processor).toContain("completion.complete({");
    expect(processor).not.toContain("repositories.knowledgebases.getknowledgebase");
  });
});
