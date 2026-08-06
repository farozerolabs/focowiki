import { randomUUID } from "node:crypto";
import type { WebhookDispatcher, WebhookEvent } from "../../webhooks/dispatcher.js";
import { isWebhookEventType } from "../../webhooks/events.js";
import type { StorageVnextWebhookRepository } from "./ports.js";

const MAXIMUM_EVENT_BYTES = 32_768;

export function createStorageVnextWebhookOutbox(input: {
  repository: Pick<StorageVnextWebhookRepository, "enqueue">;
  resultRetentionMilliseconds: number;
  clock: () => string;
}): Pick<WebhookDispatcher, "dispatch"> {
  if (
    !Number.isSafeInteger(input.resultRetentionMilliseconds)
    || input.resultRetentionMilliseconds < 1
  ) throw new Error("Invalid storage vNext webhook retention");

  return {
    async dispatch(event: WebhookEvent): Promise<void> {
      const createdAt = event.createdAt ?? input.clock();
      const eventPublicId = event.eventId ?? `event-${randomUUID()}`;
      assertTimestamp(createdAt);
      assertIdentifier(eventPublicId);
      if (!isWebhookEventType(event.eventType)) {
        throw new Error("Invalid storage vNext webhook event type");
      }
      assertPayload(event.payload);
      await input.repository.enqueue({
        eventPublicId,
        eventType: event.eventType,
        payload: event.payload,
        createdAt,
        expiresAt: new Date(
          Date.parse(createdAt) + input.resultRetentionMilliseconds
        ).toISOString()
      });
    }
  };
}

function assertIdentifier(value: string): void {
  if (!value || Buffer.byteLength(value, "utf8") > 255) {
    throw new Error("Invalid storage vNext webhook event identity");
  }
}

function assertTimestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("Invalid storage vNext webhook timestamp");
  }
}

function assertPayload(value: Record<string, unknown>): void {
  if (
    !value
    || Array.isArray(value)
    || Buffer.byteLength(JSON.stringify(value), "utf8") > MAXIMUM_EVENT_BYTES
  ) throw new Error("Invalid storage vNext webhook payload");
}
