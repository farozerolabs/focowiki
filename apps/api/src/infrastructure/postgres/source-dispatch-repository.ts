import type { SourceDispatchRepository } from "../../application/ports/source-dispatch-repository.js";
import {
  assertDispatchPressureSettings,
  decideDispatchPressure,
  type DispatchPressureSnapshot
} from "../../dispatch/source-dispatch-pressure.js";
import type { DatabaseClient } from "../../db/client.js";
import { readRuntimePressureSnapshot } from "./runtime-pressure-repository.js";

export function createPostgresSourceDispatchRepository(
  sql: DatabaseClient
): SourceDispatchRepository {
  return {
    async getSummary(input) {
      const rows = await sql<Array<{
        pending_count: number;
        oldest_pending_at: Date | null;
        paused: boolean | null;
        reason: keyof DispatchPressureSnapshot | null;
      }>>`
        SELECT count(marker.id) FILTER (WHERE marker.status = 'pending')::int AS pending_count,
               min(marker.created_at) FILTER (WHERE marker.status = 'pending') AS oldest_pending_at,
               max(pressure.paused::int)::int::boolean AS paused,
               max(pressure.reason) AS reason
        FROM focowiki.source_dispatch_markers marker
        LEFT JOIN focowiki.dispatch_pressure_state pressure ON pressure.scope = 'global'
        WHERE marker.knowledge_base_id = ${input.knowledgeBaseId}
      `;
      const row = rows[0]!;
      return {
        pendingCount: row.pending_count,
        oldestPendingAt: row.oldest_pending_at?.toISOString() ?? null,
        paused: row.paused ?? false,
        pausedReason: row.reason
      };
    },

    async dispatchPending(input) {
      assertDispatchPressureSettings(input.pressure);
      if (!Number.isSafeInteger(input.batchSize) || input.batchSize <= 0) {
        throw new Error("Source dispatch batch size must be a positive integer");
      }

      return sql.begin(async (transaction) => {
        await transaction`SELECT pg_advisory_xact_lock(hashtext('focowiki:source-dispatch'))`;
        const pressure = await readRuntimePressureSnapshot(transaction, input.now);
        const snapshots = await transaction<Array<{ paused: boolean }>>`
          SELECT paused
          FROM focowiki.dispatch_pressure_state
          WHERE scope = 'global'
          FOR UPDATE
        `;
        const snapshot = pressure.snapshot;
        const decision = decideDispatchPressure({
          currentlyPaused: snapshots[0]?.paused ?? false,
          snapshot,
          settings: input.pressure
        });

        await transaction`
          INSERT INTO focowiki.dispatch_pressure_state (
            scope, paused, reason, pressure_json, updated_at
          ) VALUES (
            'global', ${decision.paused}, ${decision.reason}, ${transaction.json(snapshot)}, ${input.now}
          )
          ON CONFLICT (scope) DO UPDATE
          SET paused = EXCLUDED.paused,
              reason = EXCLUDED.reason,
              pressure_json = EXCLUDED.pressure_json,
              updated_at = EXCLUDED.updated_at
        `;

        if (decision.paused) {
          return {
            paused: true,
            reason: decision.reason,
            dispatchedCount: 0,
            pendingMarkerCount: pressure.pendingMarkerCount,
            snapshot
          };
        }

        const dispatched = await transaction<Array<{ count: number }>>`
          WITH batch AS MATERIALIZED (
            SELECT marker.id, marker.knowledge_base_id, marker.source_file_id,
                   marker.source_revision_id, marker.sequence_number
            FROM focowiki.source_dispatch_markers marker
            WHERE marker.status = 'pending'
              AND marker.run_after <= ${input.now}
              AND NOT EXISTS (
                SELECT 1
                FROM focowiki.knowledge_base_optimization_migrations migration
                WHERE migration.knowledge_base_id = marker.knowledge_base_id
                  AND migration.state <> 'optimized_active'
              )
            ORDER BY marker.sequence_number ASC, marker.id ASC
            LIMIT ${input.batchSize}
            FOR UPDATE SKIP LOCKED
          ), jobs AS (
            INSERT INTO focowiki.role_jobs (
              id, role, kind, knowledge_base_id, source_file_id, source_revision_id,
              payload_json, settings_snapshot_json, run_after, max_attempts
            )
            SELECT 'role-job-source-' || batch.source_revision_id,
                   'source', 'source_processing', batch.knowledge_base_id,
                   batch.source_file_id, batch.source_revision_id,
                   jsonb_build_object('reason', 'upload', 'dispatchSequence', batch.sequence_number),
                   ${transaction.json(input.settingsSnapshot)}, ${input.now}, ${input.maxAttempts}
            FROM batch
            ON CONFLICT (source_revision_id) WHERE role = 'source' AND source_revision_id IS NOT NULL
            DO NOTHING
            RETURNING source_revision_id
          ), marked AS (
            UPDATE focowiki.source_dispatch_markers marker
            SET status = 'dispatched', dispatched_at = ${input.now}, updated_at = ${input.now},
                claimed_by = ${input.dispatcherId}, claimed_at = ${input.now}
            FROM batch
            WHERE marker.id = batch.id
              AND EXISTS (
                SELECT 1 FROM jobs
                WHERE jobs.source_revision_id = batch.source_revision_id
              )
            RETURNING marker.id
          )
          SELECT coalesce(sum(1), 0)::int AS count FROM marked
        `;

        return {
          paused: false,
          reason: null,
          dispatchedCount: dispatched[0]?.count ?? 0,
          pendingMarkerCount: Math.max(
            0,
            pressure.pendingMarkerCount - (dispatched[0]?.count ?? 0)
          ),
          snapshot
        };
      });
    }
  };
}

export function sourceRoleJobId(sourceRevisionId: string): string {
  return `role-job-source-${sourceRevisionId}`;
}
