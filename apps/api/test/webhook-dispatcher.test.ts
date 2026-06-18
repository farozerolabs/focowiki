import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  AdminRepositories,
  WebhookDeliveryRecord,
  WebhookSubscriptionRecord
} from "../src/db/admin-repositories.js";
import { createWebhookDispatcher } from "../src/webhooks/dispatcher.js";

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
    knowledgeBases: {
      async listKnowledgeBases() {
        return { items: [], nextCursor: null };
      },
      async createKnowledgeBase() {
        throw new Error("Not used by webhook dispatcher tests");
      },
      async getKnowledgeBase() {
        return null;
      }
    },
    webhooks: {
      async createWebhookSubscription() {
        throw new Error("Not used by webhook dispatcher tests");
      },
      async getWebhookSubscription(id: string) {
        return webhooks.get(id) ?? null;
      },
      async listWebhookSubscriptions() {
        return { items: Array.from(webhooks.values()), nextCursor: null };
      },
      async deleteWebhookSubscription() {
        return false;
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
      },
      async listWebhookDeliveries() {
        return { items: Array.from(deliveries.values()), nextCursor: null };
      },
      async getWebhookDelivery(deliveryId: string) {
        return deliveries.get(deliveryId) ?? null;
      }
    }
  } satisfies AdminRepositories;

  return { repositories, deliveries };
}

describe("webhook dispatcher", () => {
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
});
