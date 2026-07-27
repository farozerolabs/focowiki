import { Hono, type MiddlewareHandler } from "hono";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RuntimeConfig } from "../config.js";
import type {
  KnowledgeBaseIndexMaintenanceRepository,
  KnowledgeBaseIndexMaintenanceState
} from "../application/ports/knowledge-base-index-maintenance-repository.js";
import {
  createKnowledgeBaseIndexMaintenanceService,
  InvalidKnowledgeBaseIndexMaintenanceRequestError
} from "../maintenance/knowledge-base-index-maintenance.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";
import { recordAdminAudit } from "./security.js";

export function registerAdminKnowledgeBaseIndexMaintenanceRoutes(
  app: Hono,
  services: {
    config: RuntimeConfig;
    repositories: AdminRepositories | null;
    requests: KnowledgeBaseIndexMaintenanceRepository | null;
    runtimeSettings: RuntimeSettingsService | null;
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
      if (!services.requests || !services.runtimeSettings) {
        return context.json({
          error: {
            code: "INDEX_MAINTENANCE_UNAVAILABLE",
            messageKey: "errors.indexMaintenanceUnavailable"
          }
        }, 503);
      }

      try {
        const body = await readJsonBody(context.req.raw);
        const idempotencyKey = readIdempotencyKey(
          context.req.header("idempotency-key"),
          body.idempotencyKey
        );
        const result = await createKnowledgeBaseIndexMaintenanceService({
          requests: services.requests,
          runtimeSettings: services.runtimeSettings
        }).requestManual({
          knowledgeBaseId: context.req.param("knowledgeBaseId"),
          idempotencyKey,
          actor: "admin"
        });

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
        if (!("request" in result)) {
          return context.json({
            error: {
              code: "INDEX_MAINTENANCE_REQUEST_FAILED",
              messageKey: "errors.indexMaintenanceRequestFailed"
            }
          }, 500);
        }

        await recordAdminAudit({
          repositories: services.repositories,
          config: services.config,
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
      } catch (error) {
        if (error instanceof InvalidKnowledgeBaseIndexMaintenanceRequestError) {
          return context.json({
            error: {
              code: error.code,
              messageKey: "errors.invalidIndexMaintenanceRequest"
            }
          }, 400);
        }
        return context.json({
          error: {
            code: "INDEX_MAINTENANCE_REQUEST_FAILED",
            messageKey: "errors.indexMaintenanceRequestFailed"
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

function isActive(state: KnowledgeBaseIndexMaintenanceState): boolean {
  return ["queued", "planning", "running", "validating"].includes(state);
}
