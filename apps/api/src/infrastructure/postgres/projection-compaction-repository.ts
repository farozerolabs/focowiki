import { createHash, randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import type {
  ProjectionCompactionJob,
  ProjectionCompactionRecord,
  ProjectionCompactionRepository
} from "../../application/ports/projection-compaction-repository.js";
import type { ProjectionSegment } from "../../application/ports/projection-segment-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import { evaluateProjectionCompaction } from "../../maintenance/projection-compaction-policy.js";

type PartitionRow = {
  knowledge_base_id: string;
  active_generation_id: string;
  projection_kind: string;
  logical_partition: string;
};

type MetricsRow = PartitionRow & {
  segment_ids: string[];
  segment_count: number;
  encoded_bytes: number;
  tombstone_entries: number;
  total_entries: number;
};

type JobRow = {
  id: string;
  knowledge_base_id: string;
  projection_kind: string;
  logical_partition: string;
  active_generation_id: string;
  expected_segment_ids: string[];
  reason_codes: string[];
  attempt_count: number;
  max_attempts: number;
  lease_token: string;
};

export function createPostgresProjectionCompactionRepository(
  sql: DatabaseClient
): ProjectionCompactionRepository {
  return {
    async discoverCandidates(input) {
      assertPositiveInteger(input.partitionLimit, "partitionLimit");
      return sql.begin(async (transaction) => {
        const cursor = await transaction<Array<{
          knowledge_base_id: string | null;
          projection_kind: string | null;
          logical_partition: string | null;
        }>>`
          SELECT knowledge_base_id, projection_kind, logical_partition
          FROM focowiki.projection_compaction_scan_cursor
          WHERE singleton = true
          FOR UPDATE
        `;
        const current = cursor[0];
        const partitions = await transaction<PartitionRow[]>`
          SELECT statistics.knowledge_base_id,
                 knowledge_base.active_generation_id,
                 statistics.projection_kind,
                 statistics.logical_partition
          FROM focowiki.active_projection_partition_stats statistics
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.id = statistics.knowledge_base_id
           AND knowledge_base.deleted_at IS NULL
           AND knowledge_base.active_generation_id IS NOT NULL
          WHERE ${current?.knowledge_base_id ?? null}::text IS NULL
             OR (statistics.knowledge_base_id, statistics.projection_kind,
                 statistics.logical_partition) > (
                  ${current?.knowledge_base_id ?? ""},
                  ${current?.projection_kind ?? ""},
                  ${current?.logical_partition ?? ""}
                )
          ORDER BY statistics.knowledge_base_id, statistics.projection_kind,
                   statistics.logical_partition
          LIMIT ${input.partitionLimit}
        `;
        if (partitions.length === 0) {
          await transaction`
            UPDATE focowiki.projection_compaction_scan_cursor
            SET knowledge_base_id = NULL, projection_kind = NULL,
                logical_partition = NULL, updated_at = ${input.discoveredAt}
            WHERE singleton = true
          `;
          return 0;
        }

        const metrics = await transaction<MetricsRow[]>`
          WITH selected AS MATERIALIZED (
            SELECT *
            FROM jsonb_to_recordset(${transaction.json(partitions as never)}) AS item(
              knowledge_base_id text,
              active_generation_id text,
              projection_kind text,
              logical_partition text
            )
          )
          SELECT selected.knowledge_base_id, selected.active_generation_id,
                 selected.projection_kind, selected.logical_partition,
                 array_agg(active.segment_id ORDER BY active.ordinal, active.segment_id)
                   AS segment_ids,
                 count(*)::int AS segment_count,
                 coalesce(sum(segment.encoded_bytes), 0)::bigint AS encoded_bytes,
                 coalesce(sum(segment.entry_count) FILTER (
                   WHERE segment.segment_kind = 'tombstone'
                 ), 0)::bigint AS tombstone_entries,
                 coalesce(sum(segment.entry_count), 0)::bigint AS total_entries
          FROM selected
          JOIN focowiki.active_projection_segments active
            ON active.knowledge_base_id = selected.knowledge_base_id
           AND active.projection_kind = selected.projection_kind
           AND active.logical_partition = selected.logical_partition
          JOIN focowiki.projection_segments segment ON segment.id = active.segment_id
          GROUP BY selected.knowledge_base_id, selected.active_generation_id,
                   selected.projection_kind, selected.logical_partition
        `;
        const candidates = metrics.flatMap((row) => {
          const result = evaluateProjectionCompaction({
            segmentCount: Number(row.segment_count),
            encodedBytes: Number(row.encoded_bytes),
            tombstoneEntries: Number(row.tombstone_entries),
            totalEntries: Number(row.total_entries),
            readAmplification: Number(row.segment_count)
          }, input.limits);
          return result.compact ? [{ row, reasons: result.reasons }] : [];
        });
        if (candidates.length > 0) {
          await transaction`
            INSERT INTO focowiki.projection_compaction_jobs (
              id, knowledge_base_id, projection_kind, logical_partition,
              active_generation_id, expected_segment_ids, reason_codes,
              state, run_after, max_attempts, created_at, updated_at
            )
            SELECT item.id, item.knowledge_base_id, item.projection_kind,
                   item.logical_partition, item.active_generation_id,
                   item.expected_segment_ids, item.reason_codes,
                   'pending', ${input.discoveredAt}, ${input.maxAttempts},
                   ${input.discoveredAt}, ${input.discoveredAt}
            FROM jsonb_to_recordset(${transaction.json(candidates.map(({ row, reasons }) => ({
              id: compactionJobId(row),
              knowledge_base_id: row.knowledge_base_id,
              projection_kind: row.projection_kind,
              logical_partition: row.logical_partition,
              active_generation_id: row.active_generation_id,
              expected_segment_ids: row.segment_ids,
              reason_codes: reasons
            })) as never)}) AS item(
              id text,
              knowledge_base_id text,
              projection_kind text,
              logical_partition text,
              active_generation_id text,
              expected_segment_ids text[],
              reason_codes text[]
            )
            ON CONFLICT (knowledge_base_id, projection_kind, logical_partition)
            DO UPDATE SET active_generation_id = EXCLUDED.active_generation_id,
                          expected_segment_ids = EXCLUDED.expected_segment_ids,
                          reason_codes = EXCLUDED.reason_codes,
                          state = 'pending', run_after = EXCLUDED.run_after,
                          attempt_count = 0, max_attempts = EXCLUDED.max_attempts,
                          locked_by = NULL, lease_token = NULL,
                          lease_expires_at = NULL, last_error_code = NULL,
                          completed_at = NULL, updated_at = EXCLUDED.updated_at
            WHERE focowiki.projection_compaction_jobs.state
                  IN ('completed', 'failed', 'superseded')
               OR focowiki.projection_compaction_jobs.active_generation_id
                  <> EXCLUDED.active_generation_id
               OR focowiki.projection_compaction_jobs.expected_segment_ids
                  <> EXCLUDED.expected_segment_ids
          `;
        }
        const last = partitions.at(-1)!;
        await transaction`
          UPDATE focowiki.projection_compaction_scan_cursor
          SET knowledge_base_id = ${last.knowledge_base_id},
              projection_kind = ${last.projection_kind},
              logical_partition = ${last.logical_partition},
              updated_at = ${input.discoveredAt}
          WHERE singleton = true
        `;
        return candidates.length;
      });
    },

    async claim(input) {
      const leaseToken = randomUUID();
      const rows = await sql<JobRow[]>`
        WITH candidates AS MATERIALIZED (
          SELECT id
          FROM focowiki.projection_compaction_jobs
          WHERE (
            (state = 'pending' AND run_after <= ${input.now})
            OR (state = 'running' AND lease_expires_at <= ${input.now})
          )
            AND attempt_count < max_attempts
          ORDER BY run_after, updated_at, id
          LIMIT ${input.limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE focowiki.projection_compaction_jobs job
        SET state = 'running', locked_by = ${input.workerId},
            lease_token = ${leaseToken}, lease_expires_at = ${input.leaseExpiresAt},
            attempt_count = least(job.max_attempts, job.attempt_count + 1),
            updated_at = ${input.now}
        FROM candidates
        WHERE job.id = candidates.id
        RETURNING job.id, job.knowledge_base_id, job.projection_kind,
                  job.logical_partition, job.active_generation_id,
                  job.expected_segment_ids, job.reason_codes,
                  job.attempt_count, job.max_attempts, job.lease_token
      `;
      return rows.map(mapJob);
    },

    async listActiveRecords(input) {
      const rows = await sql<Array<{ record_id: string; payload_json: ProjectionCompactionRecord["payload"] }>>`
        SELECT record_id, payload_json
        FROM focowiki.active_projection_records
        WHERE knowledge_base_id = ${input.job.knowledgeBaseId}
          AND projection_kind = ${input.job.projectionKind}
          AND shard_key = ${input.job.logicalPartition}
          AND (${input.afterRecordId}::text IS NULL OR record_id > ${input.afterRecordId})
        ORDER BY record_id
        LIMIT ${input.limit}
      `;
      return rows.map((row) => ({ recordId: row.record_id, payload: row.payload_json }));
    },

    async heartbeat(input) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE focowiki.projection_compaction_jobs
        SET lease_expires_at = ${input.leaseExpiresAt}, updated_at = ${input.heartbeatAt}
        WHERE id = ${input.job.id}
          AND state = 'running'
          AND lease_token = ${input.job.leaseToken}
        RETURNING id
      `;
      return rows.length === 1;
    },

    async activateCompactedSegments(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(hashtextextended(
            'focowiki:projection-partition:' || ${input.job.knowledgeBaseId}
              || ':' || ${input.job.projectionKind} || ':' || ${input.job.logicalPartition},
            0
          ))
        `;
        const knowledgeBase = await transaction<Array<{
          active_generation_id: string | null;
        }>>`
          SELECT active_generation_id
          FROM focowiki.knowledge_bases
          WHERE id = ${input.job.knowledgeBaseId} AND deleted_at IS NULL
          FOR UPDATE
        `;
        const activeSegments = await transaction<Array<{ segment_ids: string[] }>>`
          SELECT coalesce(array_agg(segment_id ORDER BY ordinal, segment_id), ARRAY[]::text[])
                   AS segment_ids
          FROM focowiki.active_projection_segments
          WHERE knowledge_base_id = ${input.job.knowledgeBaseId}
            AND projection_kind = ${input.job.projectionKind}
            AND logical_partition = ${input.job.logicalPartition}
        `;
        if (
          knowledgeBase[0]?.active_generation_id !== input.job.activeGenerationId
          || !sameStrings(activeSegments[0]?.segment_ids ?? [], input.job.expectedSegmentIds)
        ) {
          await markSuperseded(transaction, input.job, input.completedAt);
          return "superseded" as const;
        }
        if (input.segments.length > 0) {
          await transaction`
            INSERT INTO focowiki.projection_segments (
              id, knowledge_base_id, projection_kind, logical_partition,
              segment_kind, sequence_number, format_version, checksum_sha256,
              object_key, logical_path, entry_count, encoded_bytes,
              first_record_identity, last_record_identity, base_segment_id,
              lifecycle_state, created_at
            )
            SELECT item.id, item.knowledge_base_id, item.projection_kind,
                   item.logical_partition, item.segment_kind, item.sequence_number,
                   item.format_version, item.checksum_sha256, item.object_key,
                   item.logical_path, item.entry_count, item.encoded_bytes,
                   item.first_record_identity, item.last_record_identity,
                   item.base_segment_id, 'active', ${input.completedAt}
            FROM jsonb_to_recordset(${transaction.json(input.segments.map(segmentRow) as never)}) AS item(
              id text, knowledge_base_id text, projection_kind text,
              logical_partition text, segment_kind text, sequence_number integer,
              format_version integer, checksum_sha256 text, object_key text,
              logical_path text, entry_count integer, encoded_bytes bigint,
              first_record_identity text, last_record_identity text,
              base_segment_id text
            )
            ON CONFLICT (id) DO NOTHING
          `;
        }
        await transaction`
          DELETE FROM focowiki.active_projection_segments
          WHERE knowledge_base_id = ${input.job.knowledgeBaseId}
            AND projection_kind = ${input.job.projectionKind}
            AND logical_partition = ${input.job.logicalPartition}
        `;
        if (input.segments.length > 0) {
          await transaction`
            INSERT INTO focowiki.active_projection_segments (
              knowledge_base_id, projection_kind, logical_partition,
              segment_id, ordinal, updated_at
            )
            SELECT ${input.job.knowledgeBaseId}, ${input.job.projectionKind},
                   ${input.job.logicalPartition}, item.id, item.ordinal,
                   ${input.completedAt}
            FROM jsonb_to_recordset(${transaction.json(input.segments.map((segment, ordinal) => ({
              id: segment.id,
              ordinal
            })) as never)}) AS item(id text, ordinal integer)
          `;
        }
        await transaction`
          UPDATE focowiki.projection_segments
          SET lifecycle_state = CASE
                WHEN ownership_count > 0 OR EXISTS (
                  SELECT 1
                  FROM focowiki.generation_projection_segments ownership
                  WHERE ownership.segment_id = focowiki.projection_segments.id
                ) THEN 'retained'
                ELSE 'quarantined'
              END,
              compacted_at = ${input.completedAt}
          WHERE id = ANY(${input.job.expectedSegmentIds}::text[])
            AND id <> ALL(${input.segments.map((segment) => segment.id)}::text[])
        `;
        await transaction`
          UPDATE focowiki.projection_compaction_jobs
          SET state = 'completed', locked_by = NULL, lease_token = NULL,
              lease_expires_at = NULL, completed_at = ${input.completedAt},
              updated_at = ${input.completedAt}
          WHERE id = ${input.job.id} AND lease_token = ${input.job.leaseToken}
        `;
        return "completed" as const;
      });
    },

    async fail(input) {
      const rows = await sql<Array<{ state: "pending" | "failed" }>>`
        UPDATE focowiki.projection_compaction_jobs
        SET state = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'pending' END,
            run_after = ${input.retryAt}, locked_by = NULL, lease_token = NULL,
            lease_expires_at = NULL, last_error_code = ${input.code},
            updated_at = ${input.failedAt}
        WHERE id = ${input.job.id} AND lease_token = ${input.job.leaseToken}
        RETURNING state
      `;
      return rows[0]?.state ?? "failed";
    }
  };
}

function mapJob(row: JobRow): ProjectionCompactionJob {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    projectionKind: row.projection_kind,
    logicalPartition: row.logical_partition,
    activeGenerationId: row.active_generation_id,
    expectedSegmentIds: row.expected_segment_ids,
    reasonCodes: row.reason_codes,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    leaseToken: row.lease_token
  };
}

function compactionJobId(row: PartitionRow): string {
  return `projection-compaction-${createHash("sha256")
    .update([
      row.knowledge_base_id,
      row.projection_kind,
      row.logical_partition
    ].join("\u0000"))
    .digest("hex")
    .slice(0, 32)}`;
}

function segmentRow(segment: ProjectionSegment) {
  return {
    id: segment.id,
    knowledge_base_id: segment.knowledgeBaseId,
    projection_kind: segment.projectionKind,
    logical_partition: segment.logicalPartition,
    segment_kind: segment.segmentKind,
    sequence_number: segment.sequenceNumber,
    format_version: segment.formatVersion,
    checksum_sha256: segment.checksumSha256,
    object_key: segment.objectKey,
    logical_path: segment.logicalPath,
    entry_count: segment.entryCount,
    encoded_bytes: segment.encodedBytes,
    first_record_identity: segment.firstRecordIdentity,
    last_record_identity: segment.lastRecordIdentity,
    base_segment_id: segment.baseSegmentId
  };
}

async function markSuperseded(
  transaction: TransactionSql<Record<string, never>>,
  job: ProjectionCompactionJob,
  completedAt: string
): Promise<void> {
  await transaction`
    UPDATE focowiki.projection_compaction_jobs
    SET state = 'superseded', locked_by = NULL, lease_token = NULL,
        lease_expires_at = NULL, completed_at = ${completedAt}, updated_at = ${completedAt}
    WHERE id = ${job.id} AND lease_token = ${job.leaseToken}
  `;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
