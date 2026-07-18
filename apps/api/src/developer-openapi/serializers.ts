import type {
  KnowledgeBaseRecord,
  SourceFileEventRecord,
  WebhookDeliveryRecord,
  WebhookSubscriptionRecord
} from "../db/admin-repositories.js";

export function toDeveloperKnowledgeBase(record: KnowledgeBaseRecord) {
  return {
    knowledgeBaseId: record.id,
    name: record.name,
    description: record.description,
    activeGenerationId: record.activeGenerationId ?? null,
    resourceRevision: record.resourceRevision ?? 1,
    catalogGeneration: record.catalogGeneration ?? 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export function toDeveloperSourceFileEvent(record: SourceFileEventRecord) {
  return {
    eventId: record.id,
    knowledgeBaseId: record.knowledgeBaseId,
    sourceFileId: record.sourceFileId,
    stageKey: record.stageKey,
    messageKey: record.messageKey,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    severity: record.severity,
    createdAt: record.createdAt
  };
}

export function toDeveloperWebhook(record: WebhookSubscriptionRecord) {
  return {
    webhookId: record.id,
    name: record.name,
    endpointHost: safeUrlHost(record.url),
    events: record.events,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastDeliveryAt: record.lastDeliveryAt
  };
}

export function toDeveloperWebhookDelivery(record: WebhookDeliveryRecord) {
  return {
    deliveryId: record.id,
    webhookId: record.webhookId,
    eventId: record.eventId,
    eventType: record.eventType,
    status: record.status,
    attemptCount: record.attemptCount,
    httpStatus: record.httpStatus,
    errorCode: record.errorCode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function safeUrlHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}
