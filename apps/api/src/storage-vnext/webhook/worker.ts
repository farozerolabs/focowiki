import { createHmac } from "node:crypto";
import type {
  StorageVnextClaimedWebhookDelivery,
  StorageVnextWebhookRepository
} from "./ports.js";

type DeliveryOutcome = "completed" | "retried" | "failed";

export function createStorageVnextWebhookWorker(input: {
  repository: Pick<StorageVnextWebhookRepository, "claim" | "settle">;
  fetchImpl?: typeof fetch;
  owner: string;
  claimLimit: number;
  maximumAttempts: number;
  retryDelayMilliseconds: number;
  requestTimeoutMilliseconds: number;
  clock: () => string;
}) {
  validateConfiguration(input);
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    async runBatch(request: {
      leaseExpiresAt: string;
      signal?: AbortSignal;
    }): Promise<{ claimed: number; completed: number; retried: number; failed: number }> {
      const cycleAt = input.clock();
      assertTimestamp(cycleAt);
      assertTimestamp(request.leaseExpiresAt);
      const deliveries = await input.repository.claim({
        owner: input.owner,
        limit: input.claimLimit,
        now: cycleAt,
        leaseExpiresAt: request.leaseExpiresAt
      });
      const outcomes: DeliveryOutcome[] = [];
      for (const delivery of deliveries) {
        outcomes.push(await deliver({
          ...input,
          fetchImpl,
          delivery,
          ...(request.signal ? { signal: request.signal } : {})
        }));
      }
      return {
        claimed: deliveries.length,
        completed: outcomes.filter((value) => value === "completed").length,
        retried: outcomes.filter((value) => value === "retried").length,
        failed: outcomes.filter((value) => value === "failed").length
      };
    }
  };
}

async function deliver(input: {
  repository: Pick<StorageVnextWebhookRepository, "settle">;
  fetchImpl: typeof fetch;
  owner: string;
  maximumAttempts: number;
  retryDelayMilliseconds: number;
  requestTimeoutMilliseconds: number;
  clock: () => string;
  delivery: StorageVnextClaimedWebhookDelivery;
  signal?: AbortSignal;
}): Promise<DeliveryOutcome> {
  assertDelivery(input.delivery);
  const body = JSON.stringify({
    eventId: input.delivery.eventPublicId,
    eventType: input.delivery.eventType,
    deliveryId: input.delivery.publicId,
    payload: input.delivery.payload
  });
  const timestamp = input.clock();
  assertTimestamp(timestamp);
  const signature = createHmac("sha256", input.delivery.signingSecret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const controller = new AbortController();
  const abort = () => controller.abort(
    input.signal?.reason ?? new DOMException("Webhook worker shutting down", "AbortError")
  );
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  const timeout = setTimeout(() => controller.abort(
    new DOMException("Webhook delivery timed out", "TimeoutError")
  ), input.requestTimeoutMilliseconds);
  timeout.unref?.();
  try {
    const response = await input.fetchImpl(input.delivery.endpointUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-focowiki-event": input.delivery.eventType,
        "x-focowiki-delivery-id": input.delivery.publicId,
        "x-focowiki-signature": `sha256=${signature}`,
        "x-focowiki-timestamp": timestamp
      },
      body,
      signal: controller.signal
    });
    if (response.ok) {
      await settle(input, {
        state: "completed",
        httpStatus: response.status,
        safeErrorCode: null,
        nextAttemptAt: null,
        completedAt: timestamp
      });
      return "completed";
    }
    return await retryOrFail(input, response.status, "WEBHOOK_HTTP_ERROR", timestamp);
  } catch {
    return await retryOrFail(input, null, "WEBHOOK_DELIVERY_FAILED", timestamp);
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
  }
}

async function retryOrFail(
  input: Parameters<typeof deliver>[0],
  httpStatus: number | null,
  safeErrorCode: string,
  completedAt: string
): Promise<DeliveryOutcome> {
  if (input.delivery.attemptCount < input.maximumAttempts) {
    await settle(input, {
      state: "retry",
      httpStatus,
      safeErrorCode,
      nextAttemptAt: new Date(
        Date.parse(completedAt) + input.retryDelayMilliseconds
      ).toISOString(),
      completedAt: null
    });
    return "retried";
  }
  await settle(input, {
    state: "failed",
    httpStatus,
    safeErrorCode,
    nextAttemptAt: null,
    completedAt
  });
  return "failed";
}

async function settle(
  input: Pick<Parameters<typeof deliver>[0], "repository" | "owner" | "delivery">,
  result: {
    state: "retry" | "completed" | "failed";
    httpStatus: number | null;
    safeErrorCode: string | null;
    nextAttemptAt: string | null;
    completedAt: string | null;
  }
): Promise<void> {
  const settled = await input.repository.settle({
    publicId: input.delivery.publicId,
    owner: input.owner,
    ...result
  });
  if (!settled) throw new Error("Storage vNext webhook delivery lease was lost");
}

function assertDelivery(delivery: StorageVnextClaimedWebhookDelivery): void {
  if (
    !delivery.publicId
    || !delivery.subscriptionPublicId
    || !delivery.eventPublicId
    || !delivery.endpointUrl.startsWith("https://")
    || !delivery.signingSecret
    || !Number.isSafeInteger(delivery.attemptCount)
    || delivery.attemptCount < 1
  ) throw new Error("Invalid storage vNext webhook delivery");
}

function validateConfiguration(input: {
  owner: string;
  claimLimit: number;
  maximumAttempts: number;
  retryDelayMilliseconds: number;
  requestTimeoutMilliseconds: number;
}): void {
  if (
    !input.owner
    || Buffer.byteLength(input.owner, "utf8") > 255
    || !Number.isSafeInteger(input.claimLimit)
    || input.claimLimit < 1
    || input.claimLimit > 100
    || !Number.isSafeInteger(input.maximumAttempts)
    || input.maximumAttempts < 1
    || !Number.isSafeInteger(input.retryDelayMilliseconds)
    || input.retryDelayMilliseconds < 1
    || !Number.isSafeInteger(input.requestTimeoutMilliseconds)
    || input.requestTimeoutMilliseconds < 1
  ) throw new Error("Invalid storage vNext webhook worker configuration");
}

function assertTimestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Invalid storage vNext webhook timestamp");
  }
}
