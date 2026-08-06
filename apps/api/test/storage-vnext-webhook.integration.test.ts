import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresStorageVnextOpenApiWebhooks } from
  "../src/storage-vnext/api/postgres-openapi-webhooks.js";
import { createStorageVnextWebhookOutbox } from
  "../src/storage-vnext/webhook/outbox.js";
import { createPostgresStorageVnextWebhookRepository } from
  "../src/storage-vnext/webhook/postgres-repository.js";
import { pruneStorageVnextWebhookDeliveries } from
  "../src/storage-vnext/retention/postgres-retention.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase("storage vNext webhook PostgreSQL lifecycle", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = "focowiki_vnext_webhook_" + ownerToken + "_"
    + randomUUID().replaceAll("-", "").slice(0, 10);
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const database = sql as unknown as DatabaseClient;
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe("CREATE DATABASE " + quoteIdentifier(databaseName));
    databaseCreated = true;
    await sql.unsafe(readFileSync(
      resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
      "utf8"
    ));
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(
        "DROP DATABASE IF EXISTS " + quoteIdentifier(databaseName) + " WITH (FORCE)"
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("fans out idempotently, exposes released statuses, and creates a new redelivery", async () => {
    const now = new Date("2026-08-03T00:00:00.000Z");
    const publicApi = createPostgresStorageVnextOpenApiWebhooks(database, {
      resultRetentionMilliseconds: 86_400_000,
      clock: () => new Date("2026-08-03T00:10:00.000Z")
    });
    const created = await publicApi.create({
      name: "Source lifecycle",
      url: "https://hooks.example.com/source",
      events: ["source_file.completed"]
    });
    expect(created.signingSecret).toMatch(/^fwwh_/u);

    const repository = createPostgresStorageVnextWebhookRepository(database);
    const outbox = createStorageVnextWebhookOutbox({
      repository,
      resultRetentionMilliseconds: 86_400_000,
      clock: () => now.toISOString()
    });
    const event = {
      eventId: "event-webhook-integration",
      eventType: "source_file.completed" as const,
      payload: {
        knowledgeBaseId: "knowledge-base-webhook",
        sourceFileId: "source-file-webhook"
      },
      createdAt: now.toISOString()
    };
    await outbox.dispatch(event);
    await outbox.dispatch(event);

    const claimed = await repository.claim({
      owner: "webhook-worker-integration",
      limit: 10,
      now: now.toISOString(),
      leaseExpiresAt: "2026-08-03T00:05:00.000Z"
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      subscriptionPublicId: created.webhook.webhookId,
      eventPublicId: event.eventId,
      eventType: event.eventType,
      signingSecret: created.signingSecret,
      attemptCount: 1
    });
    await expect(repository.settle({
      publicId: claimed[0]!.publicId,
      owner: "webhook-worker-integration",
      state: "completed",
      httpStatus: 204,
      safeErrorCode: null,
      nextAttemptAt: null,
      completedAt: "2026-08-03T00:00:01.000Z"
    })).resolves.toBe(true);

    const delivered = await publicApi.listDeliveries({ limit: 10, cursor: null });
    expect(delivered.items).toEqual([expect.objectContaining({
      deliveryId: claimed[0]!.publicId,
      eventId: event.eventId,
      status: "success",
      attemptCount: 1,
      httpStatus: 204,
      errorCode: null
    })]);
    expect(JSON.stringify(delivered)).not.toContain(created.signingSecret);
    expect(JSON.stringify(delivered)).not.toContain("event_payload");

    const redelivery = await publicApi.redeliver(claimed[0]!.publicId);
    expect(redelivery.delivery).toMatchObject({
      webhookId: created.webhook.webhookId,
      eventId: event.eventId,
      status: "pending",
      attemptCount: 0,
      httpStatus: null,
      errorCode: null
    });
    expect(redelivery.delivery.deliveryId).not.toBe(claimed[0]!.publicId);

    const redeliveryClaim = await repository.claim({
      owner: "webhook-worker-integration",
      limit: 10,
      now: "2026-08-03T00:10:00.000Z",
      leaseExpiresAt: "2026-08-03T00:15:00.000Z"
    });
    expect(redeliveryClaim.map((item) => item.publicId)).toEqual([
      redelivery.delivery.deliveryId
    ]);

    await expect(pruneStorageVnextWebhookDeliveries(database, {
      now: new Date("2026-08-05T00:00:00.000Z"),
      batchSize: 10
    })).resolves.toMatchObject({ deletedRows: 2, remainingRows: 0 });
    await expect(publicApi.remove(created.webhook.webhookId)).resolves.toEqual({
      deleted: true,
      webhookId: created.webhook.webhookId
    });
    const subscriptions = await sql.unsafe<Array<{ count: string }>>(
      "SELECT count(*)::text AS count FROM focowiki.webhook_subscriptions"
    );
    expect(subscriptions[0]?.count).toBe("0");
  });
});

function databaseConnectionUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
