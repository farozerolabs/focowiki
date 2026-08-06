import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  WebhookDeliveryRecord,
  WebhookDispatcherRepositories,
  WebhookSubscriptionRecord
} from "../src/webhooks/dispatcher.js";
import { createWebhookDispatcher } from "../src/webhooks/dispatcher.js";
import { toDeveloperWebhook } from "../src/developer-openapi/serializers.js";

const now = "2026-06-16T00:00:00.000Z";

function createRepositories() {
  const webhooks = new Map<string, WebhookSubscriptionRecord>([
    [
      "webhook-001",
      {
        id: "webhook-001",
        name: "Integration",
        url: "https://example.com/webhook",
        signingSecret: "fwwh_test-secret",
        events: ["source_file.completed"],
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastDeliveryAt: null
      }
    ]
  ]);
  const deliveries = new Map<string, WebhookDeliveryRecord>();

  const repositories = {
    webhooks: {
      async getWebhookSubscription(id: string) {
        return webhooks.get(id) ?? null;
      },
      async listWebhookSubscriptions() {
        return { items: Array.from(webhooks.values()), nextCursor: null };
      },
      async createWebhookDelivery(input) {
        const delivery = { ...input, updatedAt: input.createdAt };
        deliveries.set(delivery.id, delivery);
        return delivery;
      },
      async updateWebhookDeliveryResult(input) {
        const delivery = deliveries.get(input.id);

        if (!delivery) {
          return null;
        }

        const updated = { ...delivery, ...input };
        deliveries.set(input.id, updated);
        return updated;
      }
    }
  } satisfies WebhookDispatcherRepositories;

  return { repositories, deliveries, webhooks };
}

describe("webhook dispatcher", () => {
  it("presents legacy wildcard subscriptions as the complete supported event list", () => {
    const { webhooks } = createRepositories();
    const legacy = webhooks.get("webhook-001");
    expect(legacy).toBeDefined();
    expect(toDeveloperWebhook({ ...legacy!, events: [] }).events).toEqual([
      "source_file.accepted",
      "source_file.progress",
      "source_file.completed",
      "source_file.failed",
      "generation.activated",
      "file.deleted",
      "knowledge_base.deleted"
    ]);
  });

  it("persists delivery attempts and signs webhook payloads", async () => {
    const { repositories, deliveries } = createRepositories();
    const requests: Request[] = [];
    const dispatcher = createWebhookDispatcher({
      repositories,
      redis: null,
      fetchImpl: async (url, init) => {
        requests.push(new Request(url, init));
        return new Response(null, { status: 204 });
      }
    });

    await dispatcher?.dispatch({
      eventId: "event-001",
      eventType: "source_file.completed",
      payload: { knowledgeBaseId: "kb-001", sourceFileId: "source-001" },
      createdAt: now
    });

    const request = requests[0];
    const body = request ? await request.text() : "";
    const timestamp = request?.headers.get("x-focowiki-timestamp") ?? "";
    const signature = createHmac("sha256", "fwwh_test-secret")
      .update(`${timestamp}.${body}`)
      .digest("hex");
    const delivery = Array.from(deliveries.values())[0];

    expect(request?.headers.get("x-focowiki-event")).toBe("source_file.completed");
    expect(request?.headers.get("x-focowiki-signature")).toBe(`sha256=${signature}`);
    expect(delivery).toMatchObject({
      webhookId: "webhook-001",
      eventId: "event-001",
      eventType: "source_file.completed",
      status: "success",
      attemptCount: 1,
      httpStatus: 204,
      payload: { knowledgeBaseId: "kb-001", sourceFileId: "source-001" }
    });
  });

  it("redelivers the original persisted payload", async () => {
    const { repositories, deliveries } = createRepositories();
    const dispatcher = createWebhookDispatcher({
      repositories,
      redis: null,
      fetchImpl: async () => new Response(null, { status: 500 })
    });

    deliveries.set("delivery-original", {
      id: "delivery-original",
      webhookId: "webhook-001",
      eventId: "event-001",
      eventType: "source_file.completed",
      payload: { knowledgeBaseId: "kb-001", sourceFileId: "source-001" },
      status: "failed",
      attemptCount: 1,
      httpStatus: 500,
      errorCode: "WEBHOOK_HTTP_ERROR",
      createdAt: now,
      updatedAt: now
    });

    const next = await dispatcher?.redeliver(deliveries.get("delivery-original")!);

    expect(next).toMatchObject({
      eventId: "event-001",
      eventType: "source_file.completed",
      payload: { knowledgeBaseId: "kb-001", sourceFileId: "source-001" },
      status: "failed",
      attemptCount: 1,
      httpStatus: 500,
      errorCode: "WEBHOOK_HTTP_ERROR"
    });
    expect(next?.id).not.toBe("delivery-original");
  });

  it("does not report a redelivery when the subscription no longer exists", async () => {
    const { repositories, deliveries, webhooks } = createRepositories();
    const dispatcher = createWebhookDispatcher({
      repositories,
      redis: null,
      fetchImpl: async () => new Response(null, { status: 204 })
    });
    const original = {
      id: "delivery-original",
      webhookId: "webhook-001",
      eventId: "event-001",
      eventType: "source_file.completed",
      payload: { knowledgeBaseId: "kb-001", sourceFileId: "source-001" },
      status: "failed",
      attemptCount: 1,
      httpStatus: 500,
      errorCode: "WEBHOOK_HTTP_ERROR",
      createdAt: now,
      updatedAt: now
    } satisfies WebhookDeliveryRecord;
    deliveries.set(original.id, original);
    webhooks.delete("webhook-001");

    await expect(dispatcher?.redeliver(original)).resolves.toBeNull();
    expect(deliveries.size).toBe(1);
  });
});
