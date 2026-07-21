import type { TransactionSql } from "postgres";
import type {
  RuntimePressureRepository,
  RuntimePressureState
} from "../../application/ports/runtime-pressure-repository.js";
import type { DatabaseClient } from "../../db/client.js";

const COUNTER_KEYS = [
  "source_queue_depth",
  "dirty_file_count",
  "pending_impact_count",
  "pending_marker_count"
] as const;

export const RUNTIME_PRESSURE_RECONCILIATION_INTERVAL_SECONDS = 60;

type PressureRow = {
  source_queue_depth: number | string;
  oldest_source_queue_age_seconds: number | string;
  dirty_file_count: number | string;
  oldest_dirty_age_seconds: number | string;
  pending_impact_count: number | string;
  pending_marker_count: number | string;
};

type ReconciliationRow = {
  source_queue_depth: number | string;
  dirty_file_count: number | string;
  pending_impact_count: number | string;
  pending_marker_count: number | string;
};

export async function readRuntimePressureSnapshot(
  sql: DatabaseClient | TransactionSql,
  now: string
): Promise<RuntimePressureState> {
  const rows = await sql<PressureRow[]>`
    WITH counters AS MATERIALIZED (
      SELECT counter_key, sum(counter_value)::bigint AS counter_value
      FROM focowiki.runtime_pressure_counter_shards
      WHERE counter_key = ANY (${COUNTER_KEYS})
      GROUP BY counter_key
    ), oldest AS MATERIALIZED (
      SELECT
        (SELECT job.created_at
         FROM focowiki.role_jobs job
         WHERE job.role = 'source'
           AND job.status IN ('queued', 'running')
         ORDER BY job.created_at ASC, job.id ASC
         LIMIT 1) AS source_created_at,
        (SELECT fact.created_at
         FROM focowiki.publication_change_facts fact
         WHERE fact.assembly_state IN ('pending', 'claimed')
         ORDER BY fact.created_at ASC, fact.id ASC
         LIMIT 1) AS dirty_created_at
    )
    SELECT
      coalesce(max(counter.counter_value) FILTER (
        WHERE counter.counter_key = 'source_queue_depth'
      ), 0)::bigint AS source_queue_depth,
      coalesce(greatest(0, extract(epoch FROM (
        ${now}::timestamptz - max(oldest.source_created_at)
      ))), 0)::int AS oldest_source_queue_age_seconds,
      coalesce(max(counter.counter_value) FILTER (
        WHERE counter.counter_key = 'dirty_file_count'
      ), 0)::bigint AS dirty_file_count,
      coalesce(greatest(0, extract(epoch FROM (
        ${now}::timestamptz - max(oldest.dirty_created_at)
      ))), 0)::int AS oldest_dirty_age_seconds,
      coalesce(max(counter.counter_value) FILTER (
        WHERE counter.counter_key = 'pending_impact_count'
      ), 0)::bigint AS pending_impact_count,
      coalesce(max(counter.counter_value) FILTER (
        WHERE counter.counter_key = 'pending_marker_count'
      ), 0)::bigint AS pending_marker_count
    FROM counters counter
    CROSS JOIN oldest
  `;
  return mapPressureRow(requirePressureRow(rows[0]));
}

export function createPostgresRuntimePressureRepository(
  sql: DatabaseClient
): RuntimePressureRepository {
  return {
    async reconcileIfDue(input) {
      if (!Number.isSafeInteger(input.intervalSeconds) || input.intervalSeconds <= 0) {
        throw new Error("Runtime pressure reconciliation interval must be positive");
      }
      return sql.begin(async (transaction) => {
        const locks = await transaction<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(
            hashtext('focowiki:runtime-pressure-reconciliation')
          ) AS locked
        `;
        if (!locks[0]?.locked) {
          return emptyReconciliationResult();
        }
        const dueRows = await transaction<Array<{ due: boolean }>>`
          SELECT
            count(*) <> ${COUNTER_KEYS.length}
            OR bool_or(reconciled_at IS NULL)
            OR min(reconciled_at) <= (
              ${input.now}::timestamptz - ${input.intervalSeconds} * interval '1 second'
            ) AS due
          FROM focowiki.runtime_pressure_counters
          WHERE counter_key = ANY (${COUNTER_KEYS})
        `;
        if (!dueRows[0]?.due) {
          return emptyReconciliationResult();
        }

        const rows = await transaction<ReconciliationRow[]>`
          WITH exact AS MATERIALIZED (
            SELECT 'source_queue_depth'::text AS counter_key,
                   (SELECT count(*) FROM focowiki.role_jobs job
                    WHERE job.role = 'source'
                      AND job.status IN ('queued', 'running'))::bigint AS counter_value
            UNION ALL
            SELECT 'dirty_file_count',
                   (SELECT count(*) FROM focowiki.publication_change_facts fact
                    WHERE fact.assembly_state IN ('pending', 'claimed'))::bigint
            UNION ALL
            SELECT 'pending_impact_count',
                   (SELECT count(*) FROM focowiki.publication_impacts impact
                    WHERE impact.status IN ('pending', 'running'))::bigint
            UNION ALL
            SELECT 'pending_marker_count',
                   (SELECT count(*) FROM focowiki.source_dispatch_markers marker
                    WHERE marker.status = 'pending')::bigint
          ), current AS MATERIALIZED (
            SELECT counter_key, sum(counter_value)::bigint AS counter_value
            FROM focowiki.runtime_pressure_counter_shards
            WHERE counter_key = ANY (${COUNTER_KEYS})
            GROUP BY counter_key
          ), corrected AS (
            INSERT INTO focowiki.runtime_pressure_counter_shards (
              counter_key, counter_shard, counter_value, updated_at
            )
            SELECT exact.counter_key, 0,
                   exact.counter_value - coalesce(current.counter_value, 0),
                   ${input.now}::timestamptz
            FROM exact
            LEFT JOIN current USING (counter_key)
            WHERE exact.counter_value <> coalesce(current.counter_value, 0)
            ON CONFLICT (counter_key, counter_shard) DO UPDATE
            SET counter_value = focowiki.runtime_pressure_counter_shards.counter_value
                  + EXCLUDED.counter_value,
                updated_at = EXCLUDED.updated_at
            RETURNING counter_key
          )
          SELECT
            max(counter_value) FILTER (
              WHERE counter_key = 'source_queue_depth'
            )::bigint AS source_queue_depth,
            max(counter_value) FILTER (
              WHERE counter_key = 'dirty_file_count'
            )::bigint AS dirty_file_count,
            max(counter_value) FILTER (
              WHERE counter_key = 'pending_impact_count'
            )::bigint AS pending_impact_count,
            max(counter_value) FILTER (
              WHERE counter_key = 'pending_marker_count'
            )::bigint AS pending_marker_count,
            (SELECT count(*) FROM corrected) AS correction_count
          FROM exact
        `;
        const counters = mapReconciliationRow(requireReconciliationRow(rows[0]));
        await transaction`
          INSERT INTO focowiki.runtime_pressure_counters (
            counter_key, counter_value, reconciled_at, updated_at
          ) VALUES
            ('source_queue_depth', ${counters.sourceQueueDepth}, ${input.now}, ${input.now}),
            ('dirty_file_count', ${counters.dirtyFileCount}, ${input.now}, ${input.now}),
            ('pending_impact_count', ${counters.pendingImpactCount}, ${input.now}, ${input.now}),
            ('pending_marker_count', ${counters.pendingMarkerCount}, ${input.now}, ${input.now})
          ON CONFLICT (counter_key) DO UPDATE
          SET counter_value = EXCLUDED.counter_value,
              reconciled_at = EXCLUDED.reconciled_at,
              updated_at = EXCLUDED.updated_at
        `;
        return { reconciled: true, counters };
      });
    }
  };
}

function mapPressureRow(row: PressureRow): RuntimePressureState {
  return {
    snapshot: {
      sourceQueueDepth: Number(row.source_queue_depth),
      oldestSourceQueueAgeSeconds: Number(row.oldest_source_queue_age_seconds),
      dirtyFileCount: Number(row.dirty_file_count),
      oldestDirtyAgeSeconds: Number(row.oldest_dirty_age_seconds),
      pendingImpactCount: Number(row.pending_impact_count)
    },
    pendingMarkerCount: Number(row.pending_marker_count)
  };
}

function mapReconciliationRow(row: ReconciliationRow) {
  return {
    sourceQueueDepth: Number(row.source_queue_depth),
    dirtyFileCount: Number(row.dirty_file_count),
    pendingImpactCount: Number(row.pending_impact_count),
    pendingMarkerCount: Number(row.pending_marker_count)
  };
}

function requirePressureRow(row: PressureRow | undefined): PressureRow {
  if (!row) throw new Error("Runtime pressure snapshot returned no row");
  return row;
}

function requireReconciliationRow(row: ReconciliationRow | undefined): ReconciliationRow {
  if (!row) throw new Error("Runtime pressure reconciliation returned no row");
  return row;
}

function emptyReconciliationResult() {
  return {
    reconciled: false,
    counters: {
      sourceQueueDepth: 0,
      dirtyFileCount: 0,
      pendingImpactCount: 0,
      pendingMarkerCount: 0
    }
  };
}
