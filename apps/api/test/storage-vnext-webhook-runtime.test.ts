import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { StorageVnextClaimedWebhookDelivery } from
  "../src/storage-vnext/webhook/ports.js";
import { createStorageVnextWebhookWorker } from
  "../src/storage-vnext/webhook/worker.js";

const now = "2026-08-17T08:00:00.000Z";

describe("storage vNext webhook delivery worker", () => {
  it("claims, signs, and completes a document delivery", async () => {
    const delivery = claimedDelivery({ attemptCount: 1 });
    const repository = {
      claim: vi.fn(async () => [delivery]),
      settle: vi.fn(async () => true)
    };
    let sentRequest: Request | null = null;
    const worker = createStorageVnextWebhookWorker({
      repository,
      fetchImpl: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        sentRequest = new Request(url, init);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      owner: "webhook-worker-one",
      claimLimit: 4,
      maximumAttempts: 3,
      retryDelayMilliseconds: 5_000,
      requestTimeoutMilliseconds: 30_000,
      clock: () => now
    });

    await expect(worker.runBatch({
      leaseExpiresAt: "2026-08-17T08:01:00.000Z"
    })).resolves.toEqual({ claimed: 1, completed: 1, retried: 0, failed: 0 });

    expect(sentRequest).not.toBeNull();
    const request = sentRequest as unknown as Request;
    const body = await request.text();
    const timestamp = request.headers.get("x-focowiki-timestamp") ?? "";
    expect(request.redirect).toBe("error");
    expect(request.headers.get("x-focowiki-event")).toBe("document.available");
    expect(request.headers.get("x-focowiki-delivery-id")).toBe("delivery-one");
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

  it("retries a delivery failure and terminalizes the last attempt", async () => {
    const repository = {
      claim: vi.fn(async () => [
        claimedDelivery({ publicId: "delivery-retry", attemptCount: 1 }),
        claimedDelivery({ publicId: "delivery-failed", attemptCount: 3 })
      ]),
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
      leaseExpiresAt: "2026-08-17T08:01:00.000Z"
    })).resolves.toEqual({ claimed: 2, completed: 0, retried: 1, failed: 1 });
    expect(repository.settle).toHaveBeenNthCalledWith(1, expect.objectContaining({
      publicId: "delivery-retry",
      state: "retry",
      httpStatus: 503,
      safeErrorCode: "WEBHOOK_HTTP_ERROR",
      nextAttemptAt: "2026-08-17T08:00:05.000Z"
    }));
    expect(repository.settle).toHaveBeenNthCalledWith(2, expect.objectContaining({
      publicId: "delivery-failed",
      state: "failed",
      httpStatus: 503,
      safeErrorCode: "WEBHOOK_HTTP_ERROR",
      completedAt: now
    }));
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
    eventType: "document.available",
    payload: {
      knowledgeBaseId: "knowledge-base-one",
      sourceFileId: "source-file-one"
    },
    endpointUrl: "https://hooks.example.com/document",
    signingSecret: "secret-one",
    attemptCount: overrides.attemptCount,
    createdAt: now
  };
}
