import type { MiddlewareHandler } from "hono";
import type { RuntimeConfig } from "../config.js";
import type { AdminRepositories, SecurityAuditEventDraft } from "../db/admin-repositories.js";
import { getClientIp, getRequestOrigin } from "./request.js";

type RequestContext = Parameters<MiddlewareHandler>[0];

export async function recordSecurityAudit(input: {
  repositories: AdminRepositories | null;
  config: RuntimeConfig;
  context: RequestContext;
  eventType: string;
  result: SecurityAuditEventDraft["result"];
  errorCode?: string | null;
  username?: string | null;
}): Promise<void> {
  const createEvent = input.repositories?.securityAudit?.createSecurityAuditEvent;

  if (!createEvent) {
    return;
  }

  await createEvent({
    eventType: input.eventType,
    result: input.result,
    errorCode: input.errorCode ?? null,
    username: input.username ?? null,
    clientIp: getClientIp(input.config, input.context),
    userAgent: input.context.req.header("user-agent")?.slice(0, 300) ?? null,
    origin: getRequestOrigin(input.context)
  }).catch(() => undefined);
}
