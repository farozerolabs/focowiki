import type { DatabaseClient } from "../../db/client.js";
import type { StorageVnextCatalogReadPort } from "../catalog/ports.js";
import type { StorageVnextMaintenanceRepository } from "../maintenance/ports.js";
import type { StorageVnextReleaseReadPort } from "../release/ports.js";
import type {
  StorageVnextAdminProcessingApplication,
  StorageVnextAdminProcessingSummary
} from "./admin-processing-application.js";

type QueueRow = {
  work_kind: string;
  queued_count: number | string;
  running_count: number | string;
  retry_count: number | string;
  oldest_queued_at: Date | null;
};

type PendingRow = {
  pending_count: number | string;
  oldest_pending_at: Date | null;
};

type DirtyRow = {
  dirty_count: number | string;
  oldest_dirty_at: Date | null;
};

type PublicationRow = {
  operation_public_id: string;
  state: string;
  checkpoint: unknown;
  updated_at: Date;
};

export function createPostgresStorageVnextAdminProcessing(input: {
  sql: DatabaseClient;
  catalog: StorageVnextCatalogReadPort;
  releases: StorageVnextReleaseReadPort;
  maintenance: Pick<StorageVnextMaintenanceRepository, "getStatus">;
}): StorageVnextAdminProcessingApplication {
  return {
    async getProcessingSummary(request) {
      const knowledgeBase = await input.catalog.getKnowledgeBase(request);
      if (!knowledgeBase) return { ok: false, code: "NOT_FOUND" };
      const now = new Date();
      const [root, queues, pendingRows, dirtyRows, publicationRows, maintenance] =
        await Promise.all([
          input.releases.getActiveRoot(request.knowledgeBaseId),
          input.sql<QueueRow[]>`
            SELECT work_kind,
                   count(*) FILTER (WHERE state = 'queued') AS queued_count,
                   count(*) FILTER (WHERE state = 'running') AS running_count,
                   count(*) FILTER (WHERE state = 'retry') AS retry_count,
                   min(updated_at) FILTER (WHERE state IN ('queued', 'retry')) AS oldest_queued_at
            FROM focowiki.operation_work_items
            WHERE knowledge_base_id = ${request.knowledgeBaseId}
            GROUP BY work_kind
          `,
          input.sql<PendingRow[]>`
            SELECT count(*) AS pending_count, min(created_at) AS oldest_pending_at
            FROM focowiki.operations
            WHERE knowledge_base_id = ${request.knowledgeBaseId}
              AND state IN ('accepted', 'validating')
          `,
          input.sql<DirtyRow[]>`
            SELECT count(*) AS dirty_count, min(updated_at) AS oldest_dirty_at
            FROM focowiki.source_files
            WHERE knowledge_base_id = ${request.knowledgeBaseId}
              AND deleted_at IS NULL
              AND status IN ('pending', 'processing')
          `,
          input.sql<PublicationRow[]>`
            SELECT operation_public_id, state, checkpoint, updated_at
            FROM focowiki.operation_work_items
            WHERE knowledge_base_id = ${request.knowledgeBaseId}
              AND work_kind = 'publication'
            ORDER BY updated_at DESC
            LIMIT 1
          `,
          input.maintenance.getStatus(request)
        ]);
      const sourceQueue = queueSummary(queues, ["source", "graph"], now);
      const publicationQueue = queueSummary(
        queues,
        ["publication", "search", "mutation"],
        now
      );
      const pending = pendingRows[0];
      const dirty = dirtyRows[0];
      const publication = publicationRows[0];
      const checkpoint = readRecord(publication?.checkpoint);
      const summary: StorageVnextAdminProcessingSummary = {
        activeVersionId: root?.publicId ?? null,
        pendingDispatch: {
          pendingCount: toCount(pending?.pending_count ?? 0),
          oldestPendingAt: pending?.oldest_pending_at?.toISOString() ?? null,
          paused: false,
          pausedReason: null
        },
        sourceFileJobs: sourceQueue,
        publicationJobs: publicationQueue,
        publicationProgress: {
          generationId: root?.publicId ?? null,
          stage: publication?.state ?? null,
          processedImpactCount: readCount(checkpoint, "completedCount"),
          totalImpactCount: readCount(checkpoint, "expectedCount"),
          touchedShardCount: readCount(checkpoint, "batchOrdinal"),
          throughputPerMinute: readOptionalNumber(checkpoint, "throughputPerSecond") === null
            ? null
            : readOptionalNumber(checkpoint, "throughputPerSecond")! * 60,
          oldestDirtyAt: dirty?.oldest_dirty_at?.toISOString() ?? null,
          queuedAt: null,
          startedAt: readOptionalString(checkpoint, "startedAt"),
          heartbeatAt: publication?.updated_at.toISOString() ?? null,
          completedAt: null,
          lastSuccessAt: root?.createdAt ?? null,
          safeErrorCode: null,
          safeErrorMessage: null
        },
        maintenanceProgress: {
          migration: null,
          lexicalRebuild: null,
          projectionRepair: null,
          compaction: { active: null, latestCompleted: null }
        },
        indexMaintenance: maintenance,
        dirtySourceFiles: {
          count: toCount(dirty?.dirty_count ?? 0),
          oldestDirtyAt: dirty?.oldest_dirty_at?.toISOString() ?? null
        }
      };
      return { ok: true, value: summary };
    }
  };
}

function queueSummary(rows: QueueRow[], kinds: string[], now: Date) {
  const selected = rows.filter((row) => kinds.includes(row.work_kind));
  const oldest = selected
    .map((row) => row.oldest_queued_at)
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => left.getTime() - right.getTime())[0] ?? null;
  return {
    queuedCount: sum(selected, "queued_count") + sum(selected, "retry_count"),
    runningCount: sum(selected, "running_count"),
    completedCount: 0,
    failedCount: 0,
    deadLetterCount: 0,
    oldestQueuedAt: oldest?.toISOString() ?? null,
    oldestQueuedAgeSeconds: oldest
      ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1_000))
      : null
  };
}

function sum(rows: QueueRow[], key: "queued_count" | "running_count" | "retry_count") {
  return rows.reduce((total, row) => total + toCount(row[key]), 0);
}

function toCount(value: number | string): number {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === "string" ? record[key] : null;
}
