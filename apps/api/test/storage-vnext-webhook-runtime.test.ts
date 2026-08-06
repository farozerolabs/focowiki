import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createStorageVnextWebhookOutbox } from
  "../src/storage-vnext/webhook/outbox.js";
import { createStorageVnextWebhookWorker } from
  "../src/storage-vnext/webhook/worker.js";
import type { StorageVnextClaimedWebhookDelivery } from
  "../src/storage-vnext/webhook/ports.js";

const now = "2026-08-02T00:00:00.000Z";

describe("storage vNext webhook runtime", () => {
  it("enqueues one bounded event with deterministic retention", async () => {
    const enqueue = vi.fn(async () => 2);
    const outbox = createStorageVnextWebhookOutbox({
      repository: { enqueue },
      resultRetentionMilliseconds: 86_400_000,
      clock: () => now
    });

    await expect(outbox.dispatch({
      eventId: "event-source-completed-revision-one",
      eventType: "source_file.completed",
      payload: {
        knowledgeBaseId: "knowledge-base-one",
        sourceFileId: "source-file-one",
        sourceRevisionId: "source-revision-one"
      },
      createdAt: now
    })).resolves.toBeUndefined();

    expect(enqueue).toHaveBeenCalledWith({
      eventPublicId: "event-source-completed-revision-one",
      eventType: "source_file.completed",
      payload: {
        knowledgeBaseId: "knowledge-base-one",
        sourceFileId: "source-file-one",
        sourceRevisionId: "source-revision-one"
      },
      createdAt: now,
      expiresAt: "2026-08-03T00:00:00.000Z"
    });
  });

  it("claims, signs, and completes successful deliveries", async () => {
    const delivery = claimedDelivery({ attemptCount: 1 });
    const repository = {
      claim: vi.fn(async () => [delivery]),
      settle: vi.fn(async () => true)
    };
    let sentUrl: string | URL | Request = "https://hooks.example.com/source";
    let sentInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sentUrl = url;
      sentInit = init;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const worker = createStorageVnextWebhookWorker({
      repository,
      fetchImpl,
      owner: "webhook-worker-one",
      claimLimit: 4,
      maximumAttempts: 3,
      retryDelayMilliseconds: 5_000,
      requestTimeoutMilliseconds: 30_000,
      clock: () => now
    });

    await expect(worker.runBatch({
      leaseExpiresAt: "2026-08-02T00:01:00.000Z"
    })).resolves.toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });

    const request = new Request(sentUrl, sentInit);
    expect(request.headers.get("x-focowiki-event"))
      .toBe("source_file.completed");
    expect(request.headers.get("x-focowiki-delivery-id"))
      .toBe("delivery-one");
    const body = await request.text();
    const timestamp = request.headers.get("x-focowiki-timestamp") ?? "";
    expect(request.headers.get("x-focowiki-signature")).toBe(
      `sha256=${createHmac("sha256", "secret-one")
        .update(`${timestamp}.${body}`)
        .digest("hex")}`
    );
    expect(repository.settle).toHaveBeenCalledWith({
      publicId: "delivery-one",
      owner: "webhook-worker-one",
      state: "completed",
      httpStatus: 204,
      safeErrorCode: null,
      nextAttemptAt: null,
      completedAt: now
    });
  });

  it("retries safe delivery failures and terminalizes the final attempt", async () => {
    const deliveries = [
      claimedDelivery({ publicId: "delivery-retry", attemptCount: 1 }),
      claimedDelivery({ publicId: "delivery-failed", attemptCount: 3 })
    ];
    const repository = {
      claim: vi.fn(async () => deliveries),
      settle: vi.fn(async () => true)
    };
    const worker = createStorageVnextWebhookWorker({
      repository,
      fetchImpl: vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch,
      owner: "webhook-worker-one",
      claimLimit: 4,
      maximumAttempts: 3,
      retryDelayMilliseconds: 5_000,
      requestTimeoutMilliseconds: 30_000,
      clock: () => now
    });

    await expect(worker.runBatch({
      leaseExpiresAt: "2026-08-02T00:01:00.000Z"
    })).resolves.toEqual({ claimed: 2, completed: 0, retried: 1, failed: 1 });
    expect(repository.settle).toHaveBeenNthCalledWith(1, {
      publicId: "delivery-retry",
      owner: "webhook-worker-one",
      state: "retry",
      httpStatus: 503,
      safeErrorCode: "WEBHOOK_HTTP_ERROR",
      nextAttemptAt: "2026-08-02T00:00:05.000Z",
      completedAt: null
    });
    expect(repository.settle).toHaveBeenNthCalledWith(2, {
      publicId: "delivery-failed",
      owner: "webhook-worker-one",
      state: "failed",
      httpStatus: 503,
      safeErrorCode: "WEBHOOK_HTTP_ERROR",
      nextAttemptAt: null,
      completedAt: now
    });
  });
});

function claimedDelivery(overrides: {
  publicId?: string;
  attemptCount: number;
}): StorageVnextClaimedWebhookDelivery {
  return {
    publicId: overrides.publicId ?? "delivery-one",
    subscriptionPublicId: "webhook-one",
    eventPublicId: "event-one",
    eventType: "source_file.completed",
    payload: {
      knowledgeBaseId: "knowledge-base-one",
      sourceFileId: "source-file-one"
    },
    endpointUrl: "https://hooks.example.com/source",
    signingSecret: "secret-one",
    attemptCount: overrides.attemptCount,
    createdAt: now
  };
}
