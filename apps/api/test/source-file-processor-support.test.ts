import { describe, expect, it } from "vitest";
import { waitForPublicationLock } from "../src/admin/source-file-processor-support.js";
import type { RedisCoordinator } from "../src/redis/coordination.js";

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
});
