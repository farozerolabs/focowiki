import type { DatabaseClient } from "../../db/client.js";
import {
  ensureStorageVnextTimePartitions,
  pruneStorageVnextTimePartitions
} from "./postgres-partitions.js";

export const STORAGE_VNEXT_RESULT_MAX_ROWS = 100_000;
export const STORAGE_VNEXT_RESULT_MAX_BYTES = 192 * 1024 * 1024;
export const STORAGE_VNEXT_SECURITY_AUDIT_MAX_ROWS = 100_000;
export const STORAGE_VNEXT_SECURITY_AUDIT_MAX_BYTES = 128 * 1024 * 1024;
export const STORAGE_VNEXT_WEBHOOK_DELIVERY_MAX_ROWS = 100_000;
export const STORAGE_VNEXT_WEBHOOK_DELIVERY_MAX_BYTES = 128 * 1024 * 1024;
export const STORAGE_VNEXT_SOURCE_EVENT_MAX_ROWS = 100_000;
export const STORAGE_VNEXT_SOURCE_EVENT_MAX_BYTES = 128 * 1024 * 1024;
export const STORAGE_VNEXT_RETENTION_INTERVAL_MS = 60 * 60 * 1_000;

const COMPLETED_RESULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const FAILED_RESULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type StorageVnextRetentionSliceInput = {
  now: Date;
  batchSize: number;
  securityAuditRetentionDays: number;
};

export type StorageVnextRetentionFamilyResult = {
  deletedRows: number;
  remainingRows: number;
  remainingBytes: number;
  hasMore: boolean;
};

export type StorageVnextRetentionSliceResult = {
  operationResults: StorageVnextRetentionFamilyResult;
  sourceEventSummaries: StorageVnextRetentionFamilyResult;
  webhookDeliveries: StorageVnextRetentionFamilyResult;
  securityAudit: StorageVnextRetentionFamilyResult & {
    droppedPartitions: readonly string[];
  };
};

type FamilyStatsRow = {
  row_count: number | string;
  row_bytes: number | string;
};

export async function runStorageVnextRetentionSlice(
  sql: DatabaseClient,
  input: StorageVnextRetentionSliceInput
): Promise<StorageVnextRetentionSliceResult> {
  assertRetentionInput(input);
  await ensureStorageVnextTimePartitions(sql, input.now);
  const operationResults = await pruneStorageVnextOperationResults(sql, input);
  const sourceEventSummaries = await pruneStorageVnextSourceEventSummaries(sql, input);
  const webhookDeliveries = await pruneStorageVnextWebhookDeliveries(sql, input);
  const securityAudit = await pruneStorageVnextSecurityAudit(sql, input);
  return { operationResults, sourceEventSummaries, webhookDeliveries, securityAudit };
}

export async function pruneStorageVnextSourceEventSummaries(
  sql: DatabaseClient,
  input: Pick<StorageVnextRetentionSliceInput, "now" | "batchSize">
): Promise<StorageVnextRetentionFamilyResult> {
  assertValidDate(input.now);
  const batchSize = assertBatchSize(input.batchSize);
  const before = await readSourceEventStats(sql);
  const forceOldest = exceedsLimit(
    before,
    STORAGE_VNEXT_SOURCE_EVENT_MAX_ROWS,
    STORAGE_VNEXT_SOURCE_EVENT_MAX_BYTES
  );
  const rows = await sql<Array<{ public_id: string }>>`
    WITH candidates AS (
      SELECT event.public_id
      FROM focowiki.source_event_summaries AS event
      WHERE event.expires_at <= ${input.now.toISOString()}
         OR ${forceOldest}
      ORDER BY event.created_at, event.sequence_number, event.public_id
      FOR UPDATE OF event SKIP LOCKED
      LIMIT ${batchSize}
    )
    DELETE FROM focowiki.source_event_summaries AS event
    USING candidates
    WHERE event.public_id = candidates.public_id
    RETURNING event.public_id
  `;
  const after = await readSourceEventStats(sql);
  return retentionResult(rows.length, batchSize, after, {
    maxRows: STORAGE_VNEXT_SOURCE_EVENT_MAX_ROWS,
    maxBytes: STORAGE_VNEXT_SOURCE_EVENT_MAX_BYTES
  });
}

export async function pruneStorageVnextWebhookDeliveries(
  sql: DatabaseClient,
  input: Pick<StorageVnextRetentionSliceInput, "now" | "batchSize">
): Promise<StorageVnextRetentionFamilyResult> {
  assertValidDate(input.now);
  const batchSize = assertBatchSize(input.batchSize);
  const before = await readWebhookDeliveryStats(sql);
  const forceOldest = exceedsLimit(
    before,
    STORAGE_VNEXT_WEBHOOK_DELIVERY_MAX_ROWS,
    STORAGE_VNEXT_WEBHOOK_DELIVERY_MAX_BYTES
  );
  const rows = await sql<Array<{ public_id: string }>>`
    WITH candidates AS (
      SELECT delivery.public_id
      FROM focowiki.webhook_deliveries delivery
      WHERE (
          delivery.expires_at <= ${input.now.toISOString()}
          AND (delivery.state <> 'running'
            OR delivery.lease_expires_at <= ${input.now.toISOString()})
        )
        OR (${forceOldest} AND delivery.state IN ('completed', 'failed'))
      ORDER BY delivery.created_at, delivery.public_id
      FOR UPDATE OF delivery SKIP LOCKED
      LIMIT ${batchSize}
    )
    DELETE FROM focowiki.webhook_deliveries delivery
    USING candidates
    WHERE delivery.public_id = candidates.public_id
    RETURNING delivery.public_id
  `;
  const after = await readWebhookDeliveryStats(sql);
  return retentionResult(rows.length, batchSize, after, {
    maxRows: STORAGE_VNEXT_WEBHOOK_DELIVERY_MAX_ROWS,
    maxBytes: STORAGE_VNEXT_WEBHOOK_DELIVERY_MAX_BYTES
  });
}

export async function pruneStorageVnextOperationResults(
  sql: DatabaseClient,
  input: Pick<StorageVnextRetentionSliceInput, "now" | "batchSize">
): Promise<StorageVnextRetentionFamilyResult> {
  assertValidDate(input.now);
  const batchSize = assertBatchSize(input.batchSize);
  const before = await readOperationResultStats(sql);
  const forceOldest = exceedsLimit(
    before,
    STORAGE_VNEXT_RESULT_MAX_ROWS,
    STORAGE_VNEXT_RESULT_MAX_BYTES
  );
  const completedBefore = new Date(
    input.now.getTime() - COMPLETED_RESULT_RETENTION_MS
  ).toISOString();
  const failedBefore = new Date(
    input.now.getTime() - FAILED_RESULT_RETENTION_MS
  ).toISOString();
  const rows = await sql<Array<{ public_id: string }>>`
    WITH candidates AS (
      SELECT result.public_id
      FROM focowiki.operation_results AS result
      WHERE NOT EXISTS (
        SELECT 1
        FROM focowiki.operation_work_items AS live
        WHERE live.operation_public_id = result.public_id
      )
        AND NOT EXISTS (
          SELECT 1
          FROM focowiki.operation_idempotency AS replay
          WHERE replay.operation_public_id = result.public_id
            AND replay.expires_at > ${input.now.toISOString()}
        )
        AND (
          result.expires_at <= ${input.now.toISOString()}
          OR result.completed_at <= CASE
            WHEN result.terminal_state IN ('failed', 'timed_out')
              THEN ${failedBefore}::timestamptz
            ELSE ${completedBefore}::timestamptz
          END
          OR ${forceOldest}
        )
      ORDER BY result.completed_at, result.public_id
      FOR UPDATE OF result SKIP LOCKED
      LIMIT ${batchSize}
    )
    DELETE FROM focowiki.operation_results AS result
    USING candidates
    WHERE result.public_id = candidates.public_id
    RETURNING result.public_id
  `;
  const after = await readOperationResultStats(sql);
  return retentionResult(rows.length, batchSize, after, {
    maxRows: STORAGE_VNEXT_RESULT_MAX_ROWS,
    maxBytes: STORAGE_VNEXT_RESULT_MAX_BYTES
  });
}

export async function pruneStorageVnextSecurityAudit(
  sql: DatabaseClient,
  input: StorageVnextRetentionSliceInput
): Promise<StorageVnextRetentionFamilyResult & {
  droppedPartitions: readonly string[];
}> {
  assertRetentionInput(input);
  const auditCutoff = new Date(
    input.now.getTime() - input.securityAuditRetentionDays * 86_400_000
  );
  const droppedPartitions = await pruneStorageVnextTimePartitions(sql, {
    family: "security_audit_events",
    before: utcMonthStart(auditCutoff)
  });
  const before = await readSecurityAuditStats(sql);
  const forceOldest = exceedsLimit(
    before,
    STORAGE_VNEXT_SECURITY_AUDIT_MAX_ROWS,
    STORAGE_VNEXT_SECURITY_AUDIT_MAX_BYTES
  );
  const rows = await sql<Array<{ public_id: string }>>`
    WITH candidates AS (
      SELECT event.created_at, event.public_id
      FROM focowiki.security_audit_events AS event
      WHERE event.expires_at <= ${input.now.toISOString()}
         OR event.created_at <= ${auditCutoff.toISOString()}
         OR ${forceOldest}
      ORDER BY event.created_at, event.public_id
      FOR UPDATE OF event SKIP LOCKED
      LIMIT ${input.batchSize}
    )
    DELETE FROM focowiki.security_audit_events AS event
    USING candidates
    WHERE event.created_at = candidates.created_at
      AND event.public_id = candidates.public_id
    RETURNING event.public_id
  `;
  const after = await readSecurityAuditStats(sql);
  return {
    ...retentionResult(rows.length, input.batchSize, after, {
      maxRows: STORAGE_VNEXT_SECURITY_AUDIT_MAX_ROWS,
      maxBytes: STORAGE_VNEXT_SECURITY_AUDIT_MAX_BYTES
    }),
    droppedPartitions
  };
}

async function readOperationResultStats(
  sql: DatabaseClient
): Promise<{ rows: number; bytes: number }> {
  const rows = await sql<FamilyStatsRow[]>`
    SELECT count(*)::bigint AS row_count,
           coalesce(sum(pg_column_size(result)), 0)::bigint AS row_bytes
    FROM focowiki.operation_results AS result
  `;
  return mapStats(rows[0]);
}

async function readSourceEventStats(
  sql: DatabaseClient
): Promise<{ rows: number; bytes: number }> {
  const rows = await sql<FamilyStatsRow[]>`
    SELECT count(*)::bigint AS row_count,
           coalesce(sum(pg_column_size(event)), 0)::bigint AS row_bytes
    FROM focowiki.source_event_summaries AS event
  `;
  return mapStats(rows[0]);
}

async function readSecurityAuditStats(
  sql: DatabaseClient
): Promise<{ rows: number; bytes: number }> {
  const rows = await sql<FamilyStatsRow[]>`
    SELECT count(*)::bigint AS row_count,
           coalesce(sum(pg_column_size(event)), 0)::bigint AS row_bytes
    FROM focowiki.security_audit_events AS event
  `;
  return mapStats(rows[0]);
}

async function readWebhookDeliveryStats(
  sql: DatabaseClient
): Promise<{ rows: number; bytes: number }> {
  const rows = await sql<FamilyStatsRow[]>`
    SELECT count(*)::bigint AS row_count,
           coalesce(sum(pg_column_size(delivery)), 0)::bigint AS row_bytes
    FROM focowiki.webhook_deliveries AS delivery
  `;
  return mapStats(rows[0]);
}

function retentionResult(
  deletedRows: number,
  batchSize: number,
  stats: { rows: number; bytes: number },
  limits: { maxRows: number; maxBytes: number }
): StorageVnextRetentionFamilyResult {
  return {
    deletedRows,
    remainingRows: stats.rows,
    remainingBytes: stats.bytes,
    hasMore: deletedRows === batchSize || exceedsLimit(stats, limits.maxRows, limits.maxBytes)
  };
}

function exceedsLimit(
  stats: { rows: number; bytes: number },
  maxRows: number,
  maxBytes: number
): boolean {
  return stats.rows > maxRows || stats.bytes > maxBytes;
}

function mapStats(row: FamilyStatsRow | undefined): { rows: number; bytes: number } {
  return {
    rows: safeCount(row?.row_count),
    bytes: safeCount(row?.row_bytes)
  };
}

function safeCount(value: number | string | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Storage vNext retention statistics exceed the safe integer range");
  }
  return parsed;
}

function assertRetentionInput(input: StorageVnextRetentionSliceInput): void {
  assertValidDate(input.now);
  assertBatchSize(input.batchSize);
  if (
    !Number.isSafeInteger(input.securityAuditRetentionDays)
    || input.securityAuditRetentionDays < 1
    || input.securityAuditRetentionDays > 3_650
  ) {
    throw new Error("Storage vNext security audit retention days are invalid");
  }
}

function assertBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Storage vNext retention batch size must be between 1 and 1000");
  }
  return value;
}

function assertValidDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Storage vNext retention time must be valid");
  }
}

function utcMonthStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}
