import { WEBHOOK_EVENT_TYPES } from "../webhooks/events.js";

type KnowledgeBaseRecord = {
  id: string;
  name: string;
  description: string | null;
  activeGenerationId: string | null;
  resourceRevision?: number;
  catalogGeneration?: number;
  createdAt: string;
  updatedAt: string;
};

type SourceFileEventRecord = {
  id: string;
  knowledgeBaseId: string;
  sourceFileId: string;
  stageKey: string;
  messageKey: string;
  startedAt: string | null;
  endedAt: string | null;
  severity: "info" | "warning" | "error";
  createdAt: string;
};

type WebhookSubscriptionRecord = {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastDeliveryAt: string | null;
};

type WebhookDeliveryRecord = {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  status: "pending" | "success" | "failed";
  attemptCount: number;
  httpStatus: number | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

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
    events: record.events.length > 0 ? record.events : [...WEBHOOK_EVENT_TYPES],
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
