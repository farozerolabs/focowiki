export const WEBHOOK_EVENT_TYPES = [
  "document.waiting",
  "document.processing",
  "document.available",
  "document.error",
  "document.deleting",
  "file.deleted",
  "knowledge_base.deleted"
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return WEBHOOK_EVENT_TYPES.includes(value as WebhookEventType);
}
