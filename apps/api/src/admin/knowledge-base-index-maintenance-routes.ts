import { Hono, type MiddlewareHandler } from "hono";
import type { StorageVnextAdminAuditApplication } from "../storage-vnext/api/admin-audit-application.js";
import type { StorageVnextAdminMaintenanceApplication } from "../storage-vnext/api/admin-maintenance-application.js";

export function registerAdminKnowledgeBaseIndexMaintenanceRoutes(
  app: Hono,
  services: {
    application: StorageVnextAdminMaintenanceApplication;
    audit: StorageVnextAdminAuditApplication;
  },
  middlewares: {
    requireAuth: MiddlewareHandler;
    requireWriteProtection: MiddlewareHandler;
  }
): void {
  app.post(
    "/admin/api/knowledge-bases/:knowledgeBaseId/index-maintenance",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      try {
        const body = await readJsonBody(context.req.raw);
        const idempotencyKey = readIdempotencyKey(
          context.req.header("idempotency-key"),
          body.idempotencyKey
        );
        if (!idempotencyKey || idempotencyKey.length > 200) {
          return context.json({
            error: {
              code: "INVALID_INDEX_MAINTENANCE_REQUEST",
              messageKey: "errors.invalidIndexMaintenanceRequest"
            }
          }, 400);
        }
        const request = await services.application.requestMaintenance({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          idempotencyKey
        });
        if (!request.available) {
          return context.json({
            error: {
              code: "INDEX_MAINTENANCE_UNAVAILABLE",
              messageKey: "errors.indexMaintenanceUnavailable"
            }
          }, 503);
        }
        const result = request.result;

        if (result.outcome === "not_found") {
          return context.json({
            error: {
              code: "NOT_FOUND",
              messageKey: "errors.knowledgeBaseNotFound"
            }
          }, 404);
        }
        if (result.outcome === "deleted") {
          return context.json({
            error: {
              code: "KNOWLEDGE_BASE_UNAVAILABLE",
              messageKey: "errors.knowledgeBaseUnavailable"
            }
          }, 409);
        }
        if (result.outcome === "configuration_required") {
          return context.json({
            error: {
              code: "SEMANTIC_CONFIGURATION_REQUIRED",
              messageKey: "errors.semanticConfigurationRequired",
              safeCode: result.safeCode ?? "semantic_configuration_required"
            }
          }, 409);
        }
        if (!("request" in result)) {
          return context.json({
            error: {
              code: "INDEX_MAINTENANCE_REQUEST_FAILED",
              messageKey: "errors.indexMaintenanceRequestFailed"
            }
          }, 500);
        }

        await services.audit.record({
          context,
          eventType: result.outcome === "accepted"
            ? "knowledge_base_index_maintenance_requested"
            : "knowledge_base_index_maintenance_already_active",
          result: "success"
        });
        return context.json({
          result: result.outcome,
          maintenance: {
            requestId: result.request.id,
            state: result.request.state,
            trigger: result.request.trigger,
            active: isActive(result.request.state),
            stage: result.request.stage,
            completedCount: result.request.completedCount,
            expectedCount: result.request.expectedCount,
            retryCount: result.request.retryCount,
            lastProgressAt: result.request.lastProgressAt,
            lastCompletedAt: result.request.completedAt,
            maintenanceRequired: result.request.state !== "completed",
            safeErrorCode: result.request.lastErrorCode,
            safeErrorMessage: result.request.lastErrorMessage
          }
        }, 202);
      } catch {
        return context.json({
          error: {
            code: "INDEX_MAINTENANCE_REQUEST_FAILED",
            messageKey: "errors.indexMaintenanceRequestFailed"
          }
        }, 500);
      }
    }
  );
  app.post(
    "/admin/api/knowledge-bases/:knowledgeBaseId/index-maintenance/cancel",
    middlewares.requireAuth,
    middlewares.requireWriteProtection,
    async (context) => {
      try {
        const result = await services.application.cancelMaintenance({
          knowledgeBaseId: context.req.param("knowledgeBaseId")
        });
        if (!result.available) {
          return context.json({
            error: {
              code: "INDEX_MAINTENANCE_UNAVAILABLE",
              messageKey: "errors.indexMaintenanceUnavailable"
            }
          }, 503);
        }
        await services.audit.record({
          context,
          eventType: "knowledge_base_index_maintenance_cancelled",
          result: "success"
        });
        return context.json({ result: result.outcome }, 200);
      } catch {
        return context.json({
          error: {
            code: "INDEX_MAINTENANCE_CANCEL_FAILED",
            messageKey: "errors.indexMaintenanceCancelFailed"
          }
        }, 500);
      }
    }
  );
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readIdempotencyKey(header: string | undefined, body: unknown): string {
  if (header?.trim()) return header.trim();
  return typeof body === "string" ? body.trim() : "";
}

function isActive(state: string): boolean {
  return ["queued", "planning", "running", "validating"].includes(state);
}
