import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { isWebhookEventType } from "../../webhooks/events.js";
import type {
  StorageVnextClaimedWebhookDelivery,
  StorageVnextWebhookEnqueue,
  StorageVnextWebhookRepository
} from "./ports.js";

type ClaimedRow = {
  public_id: string;
  subscription_public_id: string;
  event_public_id: string;
  event_type: string;
  event_payload: unknown;
  endpoint_url: string;
  secret_reference: string;
  attempt_count: number | string;
  created_at: Date | string;
};

export function createPostgresStorageVnextWebhookRepository(
  sql: DatabaseClient
): StorageVnextWebhookRepository {
  return {
    async enqueue(input: StorageVnextWebhookEnqueue): Promise<number> {
      return enqueuePostgresStorageVnextWebhookEvents(sql, [input]);
    },

    async claim(input) {
      const rows = await sql<ClaimedRow[]>`
        WITH candidates AS (
          SELECT delivery.public_id
          FROM focowiki.webhook_deliveries delivery
          JOIN focowiki.webhook_subscriptions subscription
            ON subscription.public_id = delivery.subscription_public_id
          WHERE subscription.enabled = true
            AND delivery.expires_at > ${input.now}
            AND (
              (delivery.state IN ('queued', 'retry')
                AND delivery.next_attempt_at <= ${input.now})
              OR (delivery.state = 'running'
                AND delivery.lease_expires_at <= ${input.now})
            )
          ORDER BY delivery.next_attempt_at, delivery.updated_at,
                   delivery.public_id
          FOR UPDATE OF delivery SKIP LOCKED
          LIMIT ${input.limit}
        ), claimed AS (
          UPDATE focowiki.webhook_deliveries delivery
          SET state = 'running', attempt_count = attempt_count + 1,
              lease_owner = ${input.owner},
              lease_expires_at = ${input.leaseExpiresAt},
              updated_at = ${input.now}
          FROM candidates
          WHERE delivery.public_id = candidates.public_id
          RETURNING delivery.*
        )
        SELECT claimed.public_id, claimed.subscription_public_id,
               claimed.event_public_id, claimed.event_type,
               claimed.event_payload, subscription.endpoint_url,
               subscription.secret_reference, claimed.attempt_count,
               claimed.created_at
        FROM claimed
        JOIN focowiki.webhook_subscriptions subscription
          ON subscription.public_id = claimed.subscription_public_id
        ORDER BY claimed.next_attempt_at, claimed.updated_at, claimed.public_id
      `;
      return rows.map(mapClaimed);
    },

    async settle(input): Promise<boolean> {
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.webhook_deliveries
        SET state = ${input.state}, http_status = ${input.httpStatus},
            safe_error_code = ${input.safeErrorCode},
            next_attempt_at = ${input.nextAttemptAt},
            completed_at = ${input.completedAt},
            lease_owner = NULL, lease_expires_at = NULL,
            updated_at = COALESCE(${input.completedAt}, ${input.nextAttemptAt}, now())
        WHERE public_id = ${input.publicId}
          AND state = 'running'
          AND lease_owner = ${input.owner}
        RETURNING public_id
      `;
      return rows.length === 1;
    }
  };
}

const MAXIMUM_WEBHOOK_EVENT_BATCH = 1_000;

export async function enqueuePostgresStorageVnextWebhookEvents(
  sql: DatabaseClient | TransactionSql,
  events: readonly StorageVnextWebhookEnqueue[]
): Promise<number> {
  if (events.length === 0) return 0;
  if (events.length > MAXIMUM_WEBHOOK_EVENT_BATCH) {
    throw new Error("Storage vNext webhook event batch exceeds the supported limit");
  }
  const rows = await sql<Array<{ public_id: string }>>`
    INSERT INTO focowiki.webhook_deliveries (
      public_id, knowledge_base_id, subscription_public_id,
      operation_public_id, event_public_id, event_type, event_payload,
      state, attempt_count, next_attempt_at, created_at, updated_at,
      expires_at
    )
    SELECT 'delivery-' || md5(
             subscription.public_id || chr(31) || event."eventPublicId"
           ),
           NULL, subscription.public_id, NULL, event."eventPublicId",
           event."eventType", event.payload, 'queued', 0,
           event."createdAt", event."createdAt", event."createdAt",
           event."expiresAt"
    FROM jsonb_to_recordset(${sql.json(events as never)}) AS event(
      "eventPublicId" text, "eventType" text, payload jsonb,
      "createdAt" timestamptz, "expiresAt" timestamptz
    )
    JOIN focowiki.webhook_subscriptions subscription
      ON subscription.knowledge_base_id IS NULL
     AND subscription.enabled = true
     AND subscription.event_types ? event."eventType"
     AND subscription.created_at <= event."createdAt"
    ON CONFLICT (subscription_public_id, event_public_id)
      WHERE redelivery_of_public_id IS NULL
    DO NOTHING
    RETURNING public_id
  `;
  return rows.length;
}

function mapClaimed(row: ClaimedRow): StorageVnextClaimedWebhookDelivery {
  if (!isWebhookEventType(row.event_type)) {
    throw new Error("Invalid storage vNext webhook event type");
  }
  const signingSecret = row.secret_reference.startsWith("inline-v1:")
    ? row.secret_reference.slice("inline-v1:".length)
    : "";
  return {
    publicId: row.public_id,
    subscriptionPublicId: row.subscription_public_id,
    eventPublicId: row.event_public_id,
    eventType: row.event_type,
    payload: record(row.event_payload),
    endpointUrl: row.endpoint_url,
    signingSecret,
    attemptCount: integer(row.attempt_count),
    createdAt: timestamp(row.created_at)
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid storage vNext webhook payload");
  }
  return value as Record<string, unknown>;
}

function integer(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Invalid storage vNext webhook attempt count");
  }
  return parsed;
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Invalid storage vNext webhook timestamp");
  }
  return parsed.toISOString();
}
