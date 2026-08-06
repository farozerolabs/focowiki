import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import { conflict, notFound, validationError } from "../../developer-openapi/errors.js";
import { isWebhookEventType } from "../../webhooks/events.js";

type SubscriptionRow = {
  public_id: string;
  label: string;
  endpoint_url: string;
  event_types: unknown;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  last_delivery_at: Date | null;
};

type DeliveryRow = {
  public_id: string;
  subscription_public_id: string;
  operation_public_id: string | null;
  event_public_id: string;
  event_type: string;
  state: "queued" | "running" | "retry" | "completed" | "failed";
  attempt_count: number;
  http_status: number | null;
  safe_error_code: string | null;
  created_at: Date;
  updated_at: Date;
};

type Cursor = { version: 1; createdAt: string; publicId: string };

export function createPostgresStorageVnextOpenApiWebhooks(
  sql: DatabaseClient,
  options: { resultRetentionMilliseconds: number; clock?: () => Date }
) {
  if (
    !Number.isSafeInteger(options.resultRetentionMilliseconds)
    || options.resultRetentionMilliseconds < 1
  ) throw new Error("Invalid storage vNext webhook retention");
  const clock = options.clock ?? (() => new Date());
  return {
    async create(input: { name: string | null; url: string; events: string[] }) {
      const url = normalizeWebhookUrl(input.url);
      const events = normalizeEvents(input.events);
      const rawSecret = `fwwh_${randomBytes(32).toString("base64url")}`;
      const createdAt = clock();
      const rows = await sql<SubscriptionRow[]>`
        INSERT INTO focowiki.webhook_subscriptions (
          public_id, knowledge_base_id, label, endpoint_url, secret_reference,
          event_types, enabled, revision, created_at, updated_at
        ) VALUES (
          ${`webhook-${randomUUID()}`}, NULL, ${input.name?.trim() || "Webhook"},
          ${url}, ${`inline-v1:${rawSecret}`}, ${sql.json(events)}, true, 1,
          ${createdAt}, ${createdAt}
        )
        RETURNING public_id, label, endpoint_url, event_types, enabled,
                  created_at, updated_at,
                  NULL::timestamptz AS last_delivery_at
      `;
      return { webhook: mapSubscription(requireRow(rows[0])), signingSecret: rawSecret };
    },

    async list(input: { limit: number; cursor: string | null }) {
      const limit = assertLimit(input.limit);
      const cursor = decodeCursor(input.cursor);
      const rows = await sql<SubscriptionRow[]>`
        SELECT subscription.public_id, subscription.label,
               subscription.endpoint_url, subscription.event_types,
               subscription.enabled, subscription.created_at,
               subscription.updated_at, max(delivery.updated_at) AS last_delivery_at
        FROM focowiki.webhook_subscriptions subscription
        LEFT JOIN focowiki.webhook_deliveries delivery
          ON delivery.subscription_public_id = subscription.public_id
         AND delivery.knowledge_base_id IS NULL
        WHERE subscription.knowledge_base_id IS NULL
          AND subscription.enabled = true
          AND (
            ${cursor?.createdAt ?? null}::timestamptz IS NULL
            OR (subscription.created_at, subscription.public_id) <
               (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.publicId ?? null}::text)
          )
        GROUP BY subscription.public_id, subscription.label,
                 subscription.endpoint_url, subscription.event_types,
                 subscription.enabled, subscription.created_at, subscription.updated_at
        ORDER BY subscription.created_at DESC, subscription.public_id DESC
        LIMIT ${limit + 1}
      `;
      return page(rows, limit, mapSubscription);
    },

    async remove(webhookId: string) {
      const rows = await sql<Array<{ public_id: string }>>`
        DELETE FROM focowiki.webhook_subscriptions
        WHERE public_id = ${webhookId} AND knowledge_base_id IS NULL AND enabled = true
        RETURNING public_id
      `;
      if (!rows[0]) throw notFound();
      return { deleted: true, webhookId };
    },

    async listDeliveries(input: { limit: number; cursor: string | null }) {
      const limit = assertLimit(input.limit);
      const cursor = decodeCursor(input.cursor);
      const rows = await sql<DeliveryRow[]>`
        SELECT delivery.public_id, delivery.subscription_public_id,
               delivery.operation_public_id, delivery.event_public_id,
               delivery.event_type, delivery.state,
               delivery.attempt_count, delivery.http_status,
               delivery.safe_error_code,
               delivery.created_at, delivery.updated_at
        FROM focowiki.webhook_deliveries delivery
        JOIN focowiki.webhook_subscriptions subscription
          ON subscription.public_id = delivery.subscription_public_id
         AND subscription.knowledge_base_id IS NULL
        WHERE delivery.knowledge_base_id IS NULL
          AND (
            ${cursor?.createdAt ?? null}::timestamptz IS NULL
            OR (delivery.created_at, delivery.public_id) <
               (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.publicId ?? null}::text)
          )
        ORDER BY delivery.created_at DESC, delivery.public_id DESC
        LIMIT ${limit + 1}
      `;
      return page(rows, limit, mapDelivery);
    },

    async redeliver(deliveryId: string) {
      const createdAt = clock();
      const expiresAt = new Date(
        createdAt.getTime() + options.resultRetentionMilliseconds
      );
      const rows = await sql<DeliveryRow[]>`
        INSERT INTO focowiki.webhook_deliveries (
          public_id, knowledge_base_id, subscription_public_id,
          operation_public_id, event_public_id, event_type, event_payload,
          state, attempt_count, next_attempt_at, provider_correlation_id,
          http_status, safe_error_code, completed_at, expires_at,
          redelivery_of_public_id, created_at, updated_at
        )
        SELECT ${`delivery-${randomUUID()}`}, NULL,
               delivery.subscription_public_id, delivery.operation_public_id,
               delivery.event_public_id, delivery.event_type,
               delivery.event_payload, 'queued', 0, ${createdAt},
               delivery.provider_correlation_id, NULL, NULL, NULL,
               ${expiresAt}, delivery.public_id, ${createdAt}, ${createdAt}
        FROM focowiki.webhook_deliveries delivery
        JOIN focowiki.webhook_subscriptions subscription
          ON subscription.public_id = delivery.subscription_public_id
        WHERE delivery.public_id = ${deliveryId}
          AND delivery.knowledge_base_id IS NULL
          AND subscription.knowledge_base_id IS NULL
          AND subscription.enabled = true
        RETURNING public_id, subscription_public_id, operation_public_id,
                  event_public_id, event_type, state, attempt_count,
                  http_status, safe_error_code, created_at, updated_at
      `;
      if (!rows[0]) {
        const exists = await sql<Array<{ present: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM focowiki.webhook_deliveries
            WHERE public_id = ${deliveryId} AND knowledge_base_id IS NULL
          ) AS present
        `;
        if (exists[0]?.present) throw conflict("The webhook subscription no longer exists.");
        throw notFound();
      }
      return { delivery: mapDelivery(rows[0]) };
    }
  };
}

function mapSubscription(row: SubscriptionRow) {
  return {
    webhookId: row.public_id,
    name: row.label,
    endpointHost: safeUrlHost(row.endpoint_url),
    events: readEvents(row.event_types),
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastDeliveryAt: row.last_delivery_at?.toISOString() ?? null
  };
}

function mapDelivery(row: DeliveryRow) {
  return {
    deliveryId: row.public_id,
    webhookId: row.subscription_public_id,
    eventId: row.event_public_id,
    eventType: row.event_type,
    status: publicDeliveryStatus(row.state),
    attemptCount: row.attempt_count,
    httpStatus: row.http_status,
    errorCode: row.safe_error_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function publicDeliveryStatus(state: DeliveryRow["state"]): "pending" | "success" | "failed" {
  if (state === "completed") return "success";
  if (state === "failed") return "failed";
  return "pending";
}

function normalizeWebhookUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("protocol");
    return url.toString();
  } catch {
    throw validationError("Webhook URL must be a valid HTTPS URL.", { field: "url" });
  }
}

function normalizeEvents(values: string[]) {
  const events = values.map((value) => value.trim());
  if (
    events.length === 0 || new Set(events).size !== events.length
    || events.some((value) => !isWebhookEventType(value))
  ) throw validationError("Webhook events are invalid.", { field: "events" });
  return events;
}

function readEvents(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Invalid storage vNext webhook events");
  }
  return value;
}

function page<TRow extends { public_id: string; created_at: Date }, T>(
  rows: TRow[],
  limit: number,
  map: (row: TRow) => T
) {
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(map),
    nextCursor: rows.length > limit && last
      ? encodeCursor({ version: 1, createdAt: last.created_at.toISOString(), publicId: last.public_id })
      : null
  };
}

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string | null): Cursor | null {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      cursor.version !== 1 || typeof cursor.createdAt !== "string"
      || !Number.isFinite(Date.parse(cursor.createdAt))
      || typeof cursor.publicId !== "string" || !cursor.publicId
    ) throw new Error("invalid");
    return cursor as Cursor;
  } catch {
    throw validationError("Pagination cursor is invalid.", { field: "cursor" });
  }
}

function assertLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw validationError("Pagination limit is invalid.", { field: "limit" });
  }
  return limit;
}

function requireRow<T>(row: T | undefined): T {
  if (!row) throw new Error("Storage vNext webhook write returned no row");
  return row;
}

function safeUrlHost(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}
