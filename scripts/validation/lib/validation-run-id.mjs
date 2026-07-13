import { randomUUID } from "node:crypto";

export function createValidationRunId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
  return `validation-${timestamp}-${randomUUID().slice(0, 8)}`;
}
