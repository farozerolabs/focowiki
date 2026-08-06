import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { resolveSecurityConfig, type RuntimeConfig } from "../../config.js";
import { getAuditSourceIp, getRequestOrigin } from "../../security/request.js";
import type { StorageVnextAuditPort } from "../audit/ports.js";

export function createStorageVnextOpenApiAuditApplication(input: {
  config: RuntimeConfig;
  audit: Pick<StorageVnextAuditPort, "append"> | null;
}) {
  return {
    async record(request: {
      context: Context;
      eventType: string;
      result: "success" | "failure" | "blocked";
      errorCode?: string | null;
    }): Promise<void> {
      if (!input.audit) return;
      const createdAt = new Date();
      const retentionDays = resolveSecurityConfig(input.config).audit.retentionDays;
      await input.audit.append({
        publicId: `audit-${randomUUID()}`,
        knowledgeBaseId: null,
        actorPublicId: null,
        eventType: request.eventType,
        targetKind: null,
        targetPublicId: null,
        result: request.result,
        reasonCode: request.errorCode ?? null,
        sourceIp: getAuditSourceIp(input.config, request.context),
        userAgent: request.context.req.header("user-agent")?.slice(0, 1_024) ?? null,
        metadata: getRequestOrigin(request.context)
          ? { origin: getRequestOrigin(request.context) }
          : {},
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(
          createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1_000
        ).toISOString()
      }).catch(() => undefined);
    }
  };
}

export type StorageVnextOpenApiAuditApplication = ReturnType<
  typeof createStorageVnextOpenApiAuditApplication
>;
