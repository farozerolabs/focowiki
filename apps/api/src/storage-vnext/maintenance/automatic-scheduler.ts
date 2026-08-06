import { createHash } from "node:crypto";
import type { KnowledgeBaseMaintenanceMode } from
  "../../runtime-settings/types.js";
import type { createStorageVnextMaintenanceRequestService } from
  "./maintenance-coordinator.js";

export type StorageVnextAutomaticMaintenanceDuePort = {
  list(input: {
    dueBefore: string;
    limit: number;
  }): Promise<readonly {
    knowledgeBaseId: string;
    revision: number;
  }[]>;
  cancelQueuedAutomatic(input: {
    canceledAt: string;
    expiresAt: string;
    limit: number;
  }): Promise<number>;
};

export function createStorageVnextAutomaticMaintenanceScheduler(input: {
  due: StorageVnextAutomaticMaintenanceDuePort;
  requests: Pick<
    ReturnType<typeof createStorageVnextMaintenanceRequestService>,
    "requestMaintenance"
  >;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  return {
    async run(settings: {
      mode: KnowledgeBaseMaintenanceMode;
      settingsRevisionPublicId: string;
      scanIntervalSeconds: number;
      maxAttempts: number;
      resultRetentionMilliseconds: number;
      limit: number;
    }): Promise<{ canceled: number; discovered: number; scheduled: number }> {
      validateSettings(settings);
      const current = now();
      assertDate(current);
      const requestedAt = current.toISOString();
      const expiresAt = new Date(
        current.getTime() + settings.resultRetentionMilliseconds
      ).toISOString();
      if (settings.mode === "manual") {
        const canceled = await input.due.cancelQueuedAutomatic({
          canceledAt: requestedAt,
          expiresAt,
          limit: settings.limit
        });
        return { canceled, discovered: 0, scheduled: 0 };
      }
      const due = await input.due.list({
        dueBefore: new Date(
          current.getTime() - settings.scanIntervalSeconds * 1_000
        ).toISOString(),
        limit: settings.limit
      });
      if (due.length > settings.limit) throw schedulerError("due_page_overflow");
      let scheduled = 0;
      const bucket = Math.floor(
        current.getTime() / (settings.scanIntervalSeconds * 1_000)
      );
      for (const knowledgeBase of due) {
        assertDue(knowledgeBase);
        const identity = automaticIdentity(knowledgeBase.knowledgeBaseId, bucket);
        const result = await input.requests.requestMaintenance({
          knowledgeBaseId: knowledgeBase.knowledgeBaseId,
          operationPublicId: identity.operationPublicId,
          trigger: "automatic",
          idempotencyKey: identity.idempotencyKey,
          expectedResourceRevision: knowledgeBase.revision,
          settingsRevisionPublicId: settings.settingsRevisionPublicId,
          requestedAt,
          expiresAt,
          maxAttempts: settings.maxAttempts
        });
        if (result.outcome === "queued") scheduled += 1;
      }
      return { canceled: 0, discovered: due.length, scheduled };
    }
  };
}

function automaticIdentity(knowledgeBaseId: string, bucket: number): {
  operationPublicId: string;
  idempotencyKey: string;
} {
  const digest = createHash("sha256")
    .update(`storage-vnext-automatic-maintenance-v1\0${knowledgeBaseId}\0${bucket}`)
    .digest("hex");
  return {
    operationPublicId: `maintenance-auto-${digest}`,
    idempotencyKey: `maintenance-auto-${digest}`
  };
}

function validateSettings(input: {
  mode: KnowledgeBaseMaintenanceMode;
  settingsRevisionPublicId: string;
  scanIntervalSeconds: number;
  maxAttempts: number;
  resultRetentionMilliseconds: number;
  limit: number;
}): void {
  if (
    !["manual", "automatic"].includes(input.mode)
    || !input.settingsRevisionPublicId
    || Buffer.byteLength(input.settingsRevisionPublicId) > 255
    || !Number.isSafeInteger(input.scanIntervalSeconds)
    || input.scanIntervalSeconds < 1
    || !Number.isSafeInteger(input.maxAttempts)
    || input.maxAttempts < 1
    || !Number.isSafeInteger(input.resultRetentionMilliseconds)
    || input.resultRetentionMilliseconds < 1
    || !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > 1_000
  ) throw schedulerError("invalid_settings");
}

function assertDue(input: { knowledgeBaseId: string; revision: number }): void {
  if (
    !input.knowledgeBaseId
    || Buffer.byteLength(input.knowledgeBaseId) > 255
    || !Number.isSafeInteger(input.revision)
    || input.revision < 0
  ) throw schedulerError("invalid_due_item");
}

function assertDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) throw schedulerError("invalid_clock");
}

function schedulerError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext automatic maintenance scheduler error: ${code}`),
    { code }
  );
}
