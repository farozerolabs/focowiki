export const WEBHOOK_EVENT_TYPES = [
  "source_file.accepted",
  "source_file.progress",
  "source_file.completed",
  "source_file.failed",
  "generation.activated",
  "file.deleted",
  "knowledge_base.deleted"
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return WEBHOOK_EVENT_TYPES.includes(value as WebhookEventType);
}
