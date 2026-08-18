import type { Hono } from "hono";
import type { StorageVnextOpenApiRouteContext } from
  "../storage-vnext/api/openapi-route-context.js";
import { repositoryUnavailable, validationError } from "./errors.js";
import { readIdempotencyKey } from "./idempotency-key.js";
import {
  readDeveloperJsonObjectBody,
  readLimit,
  safe
} from "./route-helpers.js";

export function registerDeveloperOpenApiWebhookRoutes(
  app: Hono,
  services: StorageVnextOpenApiRouteContext
): void {
  const { api } = services;

  app.post("/openapi/v2/webhooks", async (context) =>
    safe(context, async () => {
      const body = await readDeveloperJsonObjectBody(
        context.req.raw,
        ["name", "url", "events"]
      );
      if (
        body.name !== undefined
        && body.name !== null
        && typeof body.name !== "string"
      ) {
        throw validationError("Webhook name must be a string or null.", {
          field: "name"
        });
      }
      if (!Array.isArray(body.events) || !body.events.every((event) => typeof event === "string")) {
        throw validationError("Webhook events must be an array of strings.", {
          field: "events"
        });
      }
      const created = await api.createWebhook({
        idempotencyKey: readIdempotencyKey(context.req.header("idempotency-key")),
        name: typeof body.name === "string" ? body.name : null,
        url: typeof body.url === "string" ? body.url : "",
        events: body.events
      });
      const webhookId = readNestedResponseId(created, "webhook", "webhookId");
      await services.auditApplication.record({
        context,
        eventType: "webhook_create",
        result: "success",
        targetKind: "webhook",
        targetPublicId: webhookId
      });
      return created;
    }, 201)
  );

  app.get("/openapi/v2/webhooks", async (context) =>
    safe(context, () =>
      api.listWebhooks({
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      })
    )
  );

  app.delete("/openapi/v2/webhooks/:webhookId", async (context) =>
    safe(context, async () => {
      const webhookId = context.req.param("webhookId");
      const deleted = await api.deleteWebhook(webhookId);
      await services.auditApplication.record({
        context,
        eventType: "webhook_delete",
        result: "success",
        targetKind: "webhook",
        targetPublicId: webhookId
      });
      return deleted;
    })
  );

  app.get("/openapi/v2/webhook-deliveries", async (context) =>
    safe(context, () =>
      api.listWebhookDeliveries({
        webhookId: context.req.query("webhookId") ?? null,
        limit: readLimit(context.req.query("limit"), services.config),
        cursor: context.req.query("cursor") ?? null
      })
    )
  );

  app.post("/openapi/v2/webhook-deliveries/:deliveryId/redeliver", async (context) =>
    safe(context, async () => {
      const deliveryId = context.req.param("deliveryId");
      const redelivery = await api.redeliverWebhook(deliveryId);
      await services.auditApplication.record({
        context,
        eventType: "webhook_redelivery_accepted",
        result: "success",
        targetKind: "webhook_delivery",
        targetPublicId: deliveryId
      });
      return redelivery;
    }, 202)
  );
}

function readNestedResponseId(
  response: Record<string, unknown>,
  objectField: string,
  idField: string
): string {
  const nested = response[objectField];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    throw repositoryUnavailable();
  }
  const id = (nested as Record<string, unknown>)[idField];
  if (typeof id !== "string" || id.trim() === "") throw repositoryUnavailable();
  return id;
}
