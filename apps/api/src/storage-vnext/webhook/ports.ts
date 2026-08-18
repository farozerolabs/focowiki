import type { WebhookEventType } from "../../webhooks/events.js";

export type StorageVnextWebhookPayload = Record<string, unknown>;

export type StorageVnextWebhookEnqueue = {
  eventPublicId: string;
  eventType: WebhookEventType;
  payload: StorageVnextWebhookPayload;
  createdAt: string;
  expiresAt: string;
};

export type StorageVnextClaimedWebhookDelivery = {
  publicId: string;
  subscriptionPublicId: string;
  eventPublicId: string;
  eventType: WebhookEventType;
  payload: StorageVnextWebhookPayload;
  endpointUrl: string;
  signingSecret: string;
  attemptCount: number;
  createdAt: string;
};

export type StorageVnextWebhookRepository = {
  enqueue(input: StorageVnextWebhookEnqueue): Promise<number>;
  claim(input: {
    owner: string;
    limit: number;
    now: string;
    leaseExpiresAt: string;
  }): Promise<readonly StorageVnextClaimedWebhookDelivery[]>;
  settle(input: {
    publicId: string;
    owner: string;
    state: "retry" | "completed" | "failed";
    httpStatus: number | null;
    safeErrorCode: string | null;
    nextAttemptAt: string | null;
    completedAt: string | null;
  }): Promise<boolean>;
};
