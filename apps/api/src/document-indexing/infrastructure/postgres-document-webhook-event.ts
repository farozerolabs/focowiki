import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type { WebhookEventType } from "../../webhooks/events.js";
import { enqueuePostgresStorageVnextWebhookEvents } from
  "../../storage-vnext/webhook/postgres-repository.js";

export async function enqueuePostgresDocumentWebhookEvent(
  sql: DatabaseClient | TransactionSql,
  input: {
    documentJobPublicId: string;
    documentJobRevision: number;
    knowledgeBaseId: string;
    operationPublicId: string;
    sourceFilePublicId: string;
    eventType: Extract<WebhookEventType,
      "document.waiting" | "document.processing" | "document.available"
      | "document.error" | "document.deleting">;
    state: "waiting" | "processing" | "available" | "error" | "deleting";
    safeErrorCode?: string | null;
    occurredAt: string;
    expiresAt: string;
  }
): Promise<void> {
  validate(input);
  await enqueuePostgresStorageVnextWebhookEvents(sql, [{
    eventPublicId: eventIdentity(input),
    eventType: input.eventType,
    payload: {
      knowledgeBaseId: input.knowledgeBaseId,
      operationId: input.operationPublicId,
      sourceFileId: input.sourceFilePublicId,
      state: input.state,
      errorCode: input.safeErrorCode ?? null,
      occurredAt: input.occurredAt
    },
    createdAt: input.occurredAt,
    expiresAt: input.expiresAt
  }]);
}

function eventIdentity(input: {
  documentJobPublicId: string;
  documentJobRevision: number;
  eventType: string;
}): string {
  return `document-event-${createHash("sha256").update(JSON.stringify([
    input.documentJobPublicId,
    input.documentJobRevision,
    input.eventType
  ])).digest("hex")}`;
}

function validate(input: {
  documentJobRevision: number;
  occurredAt: string;
  expiresAt: string;
}): void {
  if (!Number.isSafeInteger(input.documentJobRevision)
    || input.documentJobRevision < 0
    || !Number.isFinite(Date.parse(input.occurredAt))
    || Date.parse(input.expiresAt) <= Date.parse(input.occurredAt)) {
    throw new Error("Document webhook event is invalid");
  }
}
