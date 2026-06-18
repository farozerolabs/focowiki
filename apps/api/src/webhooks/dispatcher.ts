import { createHmac, randomUUID } from "node:crypto";
import type {
  AdminRepositories,
  WebhookDeliveryRecord,
  WebhookSubscriptionRecord
} from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";

export type WebhookEventType =
  | "source_file.accepted"
  | "source_file.progress"
  | "source_file.completed"
  | "source_file.failed"
  | "release.published"
  | "file.deleted"
  | "knowledge_base.deleted";

export type WebhookEvent = {
  eventId?: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
  createdAt?: string;
};

export type WebhookDispatcher = {
  dispatch: (event: WebhookEvent) => Promise<void>;
  redeliver: (delivery: WebhookDeliveryRecord) => Promise<WebhookDeliveryRecord>;
};

type DispatchWebhookRepository = NonNullable<AdminRepositories["webhooks"]> &
  Required<
    Pick<
      NonNullable<AdminRepositories["webhooks"]>,
      "createWebhookDelivery" | "updateWebhookDeliveryResult" | "getWebhookSubscription"
    >
  >;

export function createWebhookDispatcher(input: {
  repositories: AdminRepositories | null;
  redis: RedisCoordinator | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pageSize?: number;
}): WebhookDispatcher | null {
  const candidate = input.repositories?.webhooks;

  if (
    !candidate?.createWebhookDelivery ||
    !candidate.updateWebhookDeliveryResult ||
    !candidate.getWebhookSubscription
  ) {
    return null;
  }

  const repo: DispatchWebhookRepository = candidate as DispatchWebhookRepository;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;
  const pageSize = input.pageSize ?? 100;

  return {
    async dispatch(event) {
      let cursor: string | null = null;

      do {
        const page = await repo.listWebhookSubscriptions({ limit: pageSize, cursor });
        for (const webhook of page.items) {
          if (acceptsEvent(webhook, event.eventType)) {
            const delivery = await repo.createWebhookDelivery({
              id: `delivery-${randomUUID()}`,
              webhookId: webhook.id,
              eventId: event.eventId ?? `event-${randomUUID()}`,
              eventType: event.eventType,
              payload: event.payload,
              status: "pending",
              attemptCount: 0,
              httpStatus: null,
              errorCode: null,
              createdAt: event.createdAt ?? new Date().toISOString()
            });
            await sendDelivery({ repo, webhook, delivery, fetchImpl, timeoutMs, redis: input.redis });
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
    },
    async redeliver(delivery) {
      const webhook = await repo.getWebhookSubscription(delivery.webhookId);

      if (!webhook) {
        return delivery;
      }

      const next = await repo.createWebhookDelivery({
        id: `delivery-${randomUUID()}`,
        webhookId: webhook.id,
        eventId: delivery.eventId,
        eventType: delivery.eventType,
        payload: delivery.payload,
        status: "pending",
        attemptCount: 0,
        httpStatus: null,
        errorCode: null,
        createdAt: new Date().toISOString()
      });

      return sendDelivery({ repo, webhook, delivery: next, fetchImpl, timeoutMs, redis: input.redis });
    }
  };
}

function acceptsEvent(webhook: WebhookSubscriptionRecord, eventType: string): boolean {
  return webhook.events.length === 0 || webhook.events.includes(eventType);
}

async function sendDelivery(input: {
  repo: NonNullable<AdminRepositories["webhooks"]>;
  webhook: WebhookSubscriptionRecord;
  delivery: WebhookDeliveryRecord;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  redis: RedisCoordinator | null;
}): Promise<WebhookDeliveryRecord> {
  const ownerId = `webhook-${randomUUID()}`;
  const locked = input.redis
    ? await input.redis.acquireLock("webhook-delivery", input.delivery.id, ownerId, 60)
    : true;

  if (!locked) {
    return input.delivery;
  }

  const body = JSON.stringify({
    eventId: input.delivery.eventId,
    eventType: input.delivery.eventType,
    deliveryId: input.delivery.id,
    payload: input.delivery.payload
  });
  const timestamp = new Date().toISOString();
  const signature = createHmac("sha256", input.webhook.signingSecret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await input.fetchImpl(input.webhook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-focowiki-event": input.delivery.eventType,
        "x-focowiki-delivery-id": input.delivery.id,
        "x-focowiki-signature": `sha256=${signature}`,
        "x-focowiki-timestamp": timestamp
      },
      body,
      signal: controller.signal
    });

    return updateDelivery(input, {
      status: response.ok ? "success" : "failed",
      httpStatus: response.status,
      errorCode: response.ok ? null : "WEBHOOK_HTTP_ERROR"
    });
  } catch {
    return updateDelivery(input, {
      status: "failed",
      httpStatus: null,
      errorCode: "WEBHOOK_DELIVERY_FAILED"
    });
  } finally {
    clearTimeout(timeout);
    await input.redis?.releaseLock("webhook-delivery", input.delivery.id, ownerId);
  }
}

async function updateDelivery(
  input: {
    repo: NonNullable<AdminRepositories["webhooks"]>;
    delivery: WebhookDeliveryRecord;
    redis: RedisCoordinator | null;
    webhook: WebhookSubscriptionRecord;
    fetchImpl: typeof fetch;
    timeoutMs: number;
  },
  result: {
    status: WebhookDeliveryRecord["status"];
    httpStatus: number | null;
    errorCode: string | null;
  }
): Promise<WebhookDeliveryRecord> {
  const updated = await input.repo.updateWebhookDeliveryResult?.({
    id: input.delivery.id,
    status: result.status,
    attemptCount: input.delivery.attemptCount + 1,
    httpStatus: result.httpStatus,
    errorCode: result.errorCode,
    updatedAt: new Date().toISOString()
  });

  return updated ?? input.delivery;
}
