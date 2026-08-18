import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import { enqueuePostgresStorageVnextWebhookEvents } from
  "../../storage-vnext/webhook/postgres-repository.js";
import type { DocumentResourceDeletionAction } from
  "../application/document-resource-deletion-worker.js";

export async function enqueueTerminalDeletionEvent(
  sql: TransactionSql,
  action: DocumentResourceDeletionAction,
  occurredAt: string,
  options: { webhookRetentionMilliseconds?: number }
): Promise<void> {
  const retention = options.webhookRetentionMilliseconds;
  if (retention === undefined) return;
  const eventType = action.targetKind === "knowledge_base"
    ? "knowledge_base.deleted" as const
    : "file.deleted" as const;
  const payload = action.targetKind === "source_file"
    ? {
        knowledgeBaseId: action.knowledgeBaseId,
        sourceFileId: action.targetPublicId,
        operationId: action.operationPublicId,
        occurredAt
      }
    : action.targetKind === "source_directory"
      ? {
          knowledgeBaseId: action.knowledgeBaseId,
          sourceDirectoryId: action.targetPublicId,
          operationId: action.operationPublicId,
          occurredAt
        }
      : {
          knowledgeBaseId: action.knowledgeBaseId,
          operationId: action.operationPublicId,
          occurredAt
        };
  await enqueuePostgresStorageVnextWebhookEvents(sql, [{
    eventPublicId: `deletion-event-${createHash("sha256").update(JSON.stringify([
      action.operationPublicId,
      action.targetKind,
      action.targetPublicId,
      eventType
    ])).digest("hex")}`,
    eventType,
    payload,
    createdAt: occurredAt,
    expiresAt: new Date(Date.parse(occurredAt) + retention).toISOString()
  }]);
}
