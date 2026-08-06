import type { Hono } from "hono";
import type { AdminSessionManager } from "../../auth/session.js";
import type { RuntimeConfig } from "../../config.js";
import type { RedisCoordinator } from "../../redis/coordination.js";
import type { RuntimeSettingsService } from "../../runtime-settings/service.js";
import {
  createAdminAuthMiddleware,
  createAdminWriteProtectionMiddleware,
  limitAdminLoginRequest,
  registerAdminSecurityMiddlewares
} from "../../admin/security.js";
import type { StorageVnextAdminAuditApplication } from "./admin-audit-application.js";

export function createStorageVnextAdminSecurityApplication(input: {
  config: RuntimeConfig;
  sessionManager: AdminSessionManager | null;
  redis: RedisCoordinator | null;
  audit: StorageVnextAdminAuditApplication;
  runtimeSettings: RuntimeSettingsService | null;
}) {
  const requireAuth = createAdminAuthMiddleware(input);
  const requireWriteProtection = createAdminWriteProtectionMiddleware(input);
  return {
    requireAuth,
    requireWriteProtection,
    register(app: Hono): void {
      registerAdminSecurityMiddlewares(app, input);
    },
    limitLogin(request: {
      context: Parameters<typeof limitAdminLoginRequest>[0]["context"];
      username: string;
    }) {
      return limitAdminLoginRequest({
        ...input,
        context: request.context,
        username: request.username
      });
    }
  };
}

export type StorageVnextAdminSecurityApplication = ReturnType<
  typeof createStorageVnextAdminSecurityApplication
>;
