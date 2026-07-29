import { randomUUID } from "node:crypto";
import type {
  KnowledgeBaseIndexMaintenanceClaim,
  KnowledgeBaseIndexMaintenanceRepository
} from "../application/ports/knowledge-base-index-maintenance-repository.js";
import type {
  MaintenanceProgressRepository,
  MaintenanceProgressSummary
} from "../application/ports/maintenance-progress-repository.js";
import type { RuntimeSettingsService } from "../runtime-settings/service.js";

const PLANNED_SCOPES = [
  "tree",
  "navigation",
  "search",
  "graph",
  "statistics",
  "manifest",
  "compaction"
] as const;

export function createKnowledgeBaseIndexMaintenanceService(input: {
  requests: KnowledgeBaseIndexMaintenanceRepository;
  runtimeSettings: RuntimeSettingsService;
  now?: () => Date;
  requestId?: () => string;
}) {
  const now = input.now ?? (() => new Date());
  const requestId = input.requestId ?? (() => `index-maintenance-${randomUUID()}`);

  return {
    async requestManual(request: {
      knowledgeBaseId: string;
      idempotencyKey: string;
      actor: string | null;
    }) {
      const [snapshot, settingsRevision] = await Promise.all([
        input.runtimeSettings.getSnapshot(),
        input.runtimeSettings.getMaintenanceRevision()
      ]);
      return input.requests.createOrGet({
        requestId: requestId(),
        knowledgeBaseId: request.knowledgeBaseId,
        trigger: "manual",
        idempotencyKey: normalizeIdempotencyKey(request.idempotencyKey),
        actor: request.actor,
        settingsRevision,
        settingsSnapshot: schedulingSnapshot(snapshot.maintenance),
        maxAttempts: snapshot.maintenance.maxAttempts,
        now: now().toISOString()
      });
    }
  };
}

export async function runKnowledgeBaseIndexMaintenanceSlice(input: {
  requests: KnowledgeBaseIndexMaintenanceRepository;
  progress: MaintenanceProgressRepository;
  runtimeSettings: RuntimeSettingsService;
  workerId: string;
  leaseTtlSeconds: number;
  schedule: (input: {
    request: KnowledgeBaseIndexMaintenanceClaim;
    now: string;
  }) => Promise<void>;
  now?: () => Date;
}): Promise<{
  discovered: number;
  canceledAutomatic: number;
  claimed: number;
  completed: number;
  failed: number;
}> {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const [snapshot, settingsRevision] = await Promise.all([
    input.runtimeSettings.getSnapshot(),
    input.runtimeSettings.getMaintenanceRevision()
  ]);
  const maintenance = snapshot.maintenance;
  const canceledAutomatic = maintenance.knowledgeBaseMaintenanceMode === "manual"
    ? await input.requests.cancelQueuedAutomatic({ canceledAt: startedAt.toISOString() })
    : 0;
  const discovered = maintenance.knowledgeBaseMaintenanceMode === "automatic"
    ? await input.requests.discoverAutomaticDue({
        requestIdPrefix: `index-maintenance-auto-${randomUUID()}`,
        settingsRevision,
        settingsSnapshot: schedulingSnapshot(maintenance),
        maxAttempts: maintenance.maxAttempts,
        dueBefore: new Date(
          startedAt.getTime()
            - maintenance.knowledgeBaseMaintenanceScanIntervalSeconds * 1_000
        ).toISOString(),
        limit: Math.max(maintenance.knowledgeBaseMaintenanceConcurrency * 4, 20),
        now: startedAt.toISOString()
      })
    : 0;

  const claimed = await input.requests.claimBatch({
    workerId: input.workerId,
    leaseTokenPrefix: randomUUID(),
    limit: maintenance.knowledgeBaseMaintenanceConcurrency,
    now: startedAt.toISOString(),
    leaseExpiresAt: new Date(
      startedAt.getTime() + input.leaseTtlSeconds * 1_000
    ).toISOString()
  });
  const result = {
    discovered,
    canceledAutomatic,
    claimed: claimed.length,
    completed: 0,
    failed: 0
  };

  await Promise.all(claimed.map(async (request) => {
    try {
      if (request.state === "planning" || request.plannedScopes.length === 0) {
        const started = await input.requests.start({
          request,
          plannedScopes: [...PLANNED_SCOPES],
          startedAt: startedAt.toISOString()
        });
        if (!started) return;
      }
      await input.schedule({ request, now: startedAt.toISOString() });
      const progress = await input.progress.getSummary({
        knowledgeBaseId: request.knowledgeBaseId
      });
      const aggregate = aggregateProgress(progress, request.startedAt ?? request.createdAt);
      if (aggregate.failure) {
        await input.requests.retryOrFail({
          request,
          errorCode: aggregate.failure.code,
          errorMessage: aggregate.failure.message,
          retryAt: new Date(
            startedAt.getTime() + maintenance.retryDelayMs
          ).toISOString(),
          failedAt: startedAt.toISOString()
        });
        result.failed += 1;
        return;
      }
      if (!aggregate.active) {
        const completed = await input.requests.complete({
          request,
          completedScopes: [...PLANNED_SCOPES],
          completedAt: startedAt.toISOString()
        });
        if (completed) result.completed += 1;
        return;
      }
      await input.requests.heartbeat({
        request,
        stage: aggregate.stage,
        completedCount: aggregate.completed,
        expectedCount: aggregate.expected,
        heartbeatAt: startedAt.toISOString(),
        leaseExpiresAt: new Date(
          startedAt.getTime() + input.leaseTtlSeconds * 1_000
        ).toISOString()
      });
    } catch (error) {
      const failure = safeExecutionFailure(error);
      await input.requests.retryOrFail({
        request,
        errorCode: failure.code,
        errorMessage: failure.message,
        retryAt: new Date(startedAt.getTime() + maintenance.retryDelayMs).toISOString(),
        failedAt: startedAt.toISOString()
      });
      result.failed += 1;
    }
  }));
  return result;
}

function aggregateProgress(
  progress: MaintenanceProgressSummary,
  requestStartedAt: string
): {
  active: boolean;
  stage: string;
  completed: number;
  expected: number;
  failure: { code: string; message: string } | null;
} {
  const projection = progress.projectionRepair;
  const lexical = progress.lexicalRebuild;
  const search = progress.searchProjection;
  const compaction = progress.compaction.active;
  const startedAtMs = Date.parse(requestStartedAt);
  const projectionActive = Boolean(
    projection && (
      ["pending", "running", "retry"].includes(projection.state)
      || (
        projection.state === "superseded"
        && isCurrentProgress(projection.updatedAt, startedAtMs)
      )
    )
  );
  const lexicalActive = Boolean(
    lexical
      && ["pending", "running", "validating", "activating", "failed"].includes(lexical.state)
      && lexical.attemptCount < lexical.maxAttempts
  );
  const searchActive = Boolean(
    search
      && search.pendingEpoch !== null
      && search.failedCount === 0
      && search.canceledCount === 0
  );
  const failures = [
    projection?.state === "failed" && isCurrentProgress(projection.updatedAt, startedAtMs)
      ? safeFailure(projection.safeErrorCode, projection.safeErrorMessage)
      : null,
    lexical?.state === "failed"
      && lexical.attemptCount >= lexical.maxAttempts
      && isCurrentProgress(lexical.updatedAt, startedAtMs)
      ? safeFailure(lexical.safeErrorCode, lexical.safeErrorMessage)
      : null,
    search
      && search.pendingEpoch !== null
      && (search.failedCount > 0 || search.canceledCount > 0)
      && isCurrentProgress(search.updatedAt, startedAtMs)
      ? safeFailure(search.safeErrorCode, search.safeErrorMessage)
      : null,
    compaction?.state === "failed" && isCurrentProgress(compaction.updatedAt, startedAtMs)
      ? safeFailure(compaction.safeErrorCode, null)
      : null
  ].find((item) => item !== null) ?? null;

  const completed =
    (projection?.completedRecordCount ?? 0)
    + (lexical?.processedSourceCount ?? 0)
    + (search?.succeededCount ?? 0)
    + (progress.compaction.latestCompleted ? 1 : 0);
  const expected =
    (projection?.totalRecordCount ?? 0)
    + (lexical?.totalSourceCount ?? 0)
    + (search?.totalCount ?? 0)
    + (compaction ? 1 : 0);
  return {
    active: projectionActive || lexicalActive || searchActive || Boolean(compaction),
    stage: projectionActive
      ? `projection:${projection?.phase ?? "planning"}`
      : lexicalActive
        ? `search:${lexical?.phase ?? "planning"}`
        : searchActive
          ? "search:indexing"
        : compaction
          ? "compaction"
          : "validating",
    completed,
    expected: Math.max(completed, expected),
    failure: failures
  };
}

function isCurrentProgress(updatedAt: string, requestStartedAtMs: number): boolean {
  return Date.parse(updatedAt) >= requestStartedAtMs;
}

function schedulingSnapshot(
  maintenance: {
    knowledgeBaseMaintenanceMode: "manual" | "automatic";
    knowledgeBaseMaintenanceScanIntervalSeconds: number;
    knowledgeBaseMaintenanceConcurrency: number;
  }
): Record<string, string | number | boolean> {
  return {
    mode: maintenance.knowledgeBaseMaintenanceMode,
    automaticIntervalSeconds:
      maintenance.knowledgeBaseMaintenanceScanIntervalSeconds,
    knowledgeBaseConcurrency: maintenance.knowledgeBaseMaintenanceConcurrency
  };
}

function normalizeIdempotencyKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new InvalidKnowledgeBaseIndexMaintenanceRequestError();
  }
  return normalized;
}

function safeFailure(code: string | null, message: string | null) {
  return {
    code: code ?? "INDEX_MAINTENANCE_FAILED",
    message: message ?? "Knowledge-base index maintenance could not complete"
  };
}

export class InvalidKnowledgeBaseIndexMaintenanceRequestError extends Error {
  public readonly code = "INVALID_INDEX_MAINTENANCE_REQUEST";

  public constructor() {
    super("A valid index maintenance idempotency key is required");
    this.name = "InvalidKnowledgeBaseIndexMaintenanceRequestError";
  }
}

export class KnowledgeBaseIndexMaintenanceExecutionError extends Error {
  public constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "KnowledgeBaseIndexMaintenanceExecutionError";
  }
}

function safeExecutionFailure(error: unknown): { code: string; message: string } {
  if (error instanceof KnowledgeBaseIndexMaintenanceExecutionError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "INDEX_MAINTENANCE_FAILED",
    message: "Knowledge-base index maintenance could not continue"
  };
}
