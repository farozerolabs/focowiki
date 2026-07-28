import type {
  StorageReconciliationCandidate,
  StorageReconciliationCycle,
  StorageReconciliationRepository,
  StorageReconciliationStatus
} from "../../application/ports/storage-reconciliation-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import { lockImmutableObjectKey } from "./immutable-object-lock.js";
import type { TransactionSql } from "postgres";

type CycleRow = {
  prefix: string;
  cycle_id: string | null;
  state: "idle" | "scanning" | "verifying" | "failed";
  continuation_token: string | null;
  verification_cursor: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  scan_started_at: Date | null;
  scan_completed_at: Date | null;
  next_scan_at: Date;
  listed_count: number;
  quarantined_count: number;
  deleted_count: number;
  missing_count: number;
  retry_count: number;
  last_error_code: string | null;
  safe_error_message: string | null;
  resolved_count: number;
  pending_count: number;
  database_chunk_size: number | null;
  recent_objects_per_second: number | null;
  rolling_batch_latency_ms: number | null;
  heartbeat_at: Date | null;
  last_progress_at: Date | null;
};

type CandidateRow = {
  object_key: string;
  checksum_sha256: string;
  format_version: number;
  confirmation_count: number;
  attempt_count: number;
  observed_size_bytes: number | null;
  observed_etag: string | null;
  last_seen_at: Date;
};

export function createPostgresStorageReconciliationRepository(
  sql: DatabaseClient
): StorageReconciliationRepository {
  return {
    async claimCycle(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO focowiki.storage_reconciliation_cycles (prefix, next_scan_at)
          VALUES (${input.prefix}, ${input.now})
          ON CONFLICT (prefix) DO NOTHING
        `;
        const rows = await transaction<CycleRow[]>`
          SELECT *
          FROM focowiki.storage_reconciliation_cycles
          WHERE prefix = ${input.prefix}
          FOR UPDATE
        `;
        const current = rows[0];
        if (!current) return null;
        const leaseIsLive = current.lease_expires_at
          && current.lease_expires_at.toISOString() > input.now;
        if (
          (current.state === "scanning" || current.state === "verifying")
          && leaseIsLive
          && current.lease_token !== input.leaseToken
        ) {
          return null;
        }
        if (
          (current.state === "idle" || current.state === "failed")
          && current.next_scan_at.toISOString() > input.now
        ) {
          return null;
        }

        const startsNewCycle = current.state === "idle" || current.state === "failed";
        const cycleId = startsNewCycle ? input.cycleId : current.cycle_id;
        if (!cycleId) return null;
        const updated = await transaction<CycleRow[]>`
          UPDATE focowiki.storage_reconciliation_cycles
          SET cycle_id = ${cycleId},
              state = ${startsNewCycle ? "scanning" : current.state},
              continuation_token = ${startsNewCycle ? null : current.continuation_token},
              verification_cursor = ${startsNewCycle ? null : current.verification_cursor},
              lease_token = ${input.leaseToken},
              lease_expires_at = ${input.leaseExpiresAt},
              scan_started_at = ${startsNewCycle ? input.now : current.scan_started_at?.toISOString() ?? input.now},
              scan_completed_at = ${startsNewCycle ? null : current.scan_completed_at?.toISOString() ?? null},
              listed_count = ${startsNewCycle ? 0 : current.listed_count},
              quarantined_count = ${startsNewCycle ? 0 : current.quarantined_count},
              deleted_count = ${startsNewCycle ? 0 : current.deleted_count},
              missing_count = ${startsNewCycle ? 0 : current.missing_count},
              resolved_count = ${startsNewCycle ? 0 : current.resolved_count},
              pending_count = ${startsNewCycle ? 0 : current.pending_count},
              retry_count = ${startsNewCycle ? 0 : current.retry_count},
              heartbeat_at = ${input.now},
              last_progress_at = ${startsNewCycle ? input.now : current.last_progress_at?.toISOString() ?? input.now},
              last_error_code = NULL,
              safe_error_message = NULL,
              updated_at = ${input.now}
          WHERE prefix = ${input.prefix}
          RETURNING *
        `;
        return mapClaimedCycle(updated[0]!);
      });
    },

    async renewCycleLease(input) {
      const rows = await sql<Array<{ prefix: string }>>`
        UPDATE focowiki.storage_reconciliation_cycles
        SET lease_expires_at = ${input.leaseExpiresAt},
            updated_at = ${input.renewedAt}
        WHERE prefix = ${input.cycle.prefix}
          AND cycle_id = ${input.cycle.cycleId}
          AND lease_token = ${input.leaseToken}
          AND state IN ('scanning', 'verifying')
          AND lease_expires_at > ${input.renewedAt}
        RETURNING prefix
      `;
      return rows.length === 1;
    },

    async getProtectionReadiness() {
      const rows = await sql<Array<{
        state: "pending" | "backfilling" | "verifying" | "ready" | "retrying" | "failed";
      }>>`
        SELECT state
        FROM focowiki.storage_object_protection_backfills
        WHERE schema_version = 1
      `;
      return rows[0]?.state ?? "pending";
    },

    async prepareScanPage(input) {
      return sql.begin(async (transaction) => {
        const owners = await transaction<Array<{ prefix: string }>>`
          SELECT prefix
          FROM focowiki.storage_reconciliation_cycles
          WHERE prefix = ${input.cycle.prefix}
            AND cycle_id = ${input.cycle.cycleId}
            AND lease_token = ${input.leaseToken}
            AND lease_expires_at > ${input.preparedAt}
            AND state = 'scanning'
          FOR UPDATE
        `;
        if (owners.length !== 1) return null;
        await transaction`
          INSERT INTO focowiki.storage_reconciliation_page_checkpoints (
            prefix, cycle_id, page_id, continuation_token,
            next_continuation_token, expected_chunk_count, listed_count,
            database_chunk_size, created_at, updated_at
          ) VALUES (
            ${input.cycle.prefix}, ${input.cycle.cycleId}, ${input.pageId},
            ${input.cycle.continuationToken}, ${input.nextContinuationToken},
            0, ${input.listedCount}, ${boundedLimit(input.databaseChunkSize)},
            ${input.preparedAt}, ${input.preparedAt}
          )
          ON CONFLICT (prefix, cycle_id, page_id) DO NOTHING
        `;
        const rows = await transaction<Array<{
          continuation_token: string | null;
          next_continuation_token: string | null;
          listed_count: number;
          database_chunk_size: number;
          completed_object_count: number;
          committed_at: Date | null;
        }>>`
          SELECT
            page.continuation_token,
            page.next_continuation_token,
            page.listed_count,
            page.database_chunk_size,
            coalesce(sum(chunk.object_count), 0)::int AS completed_object_count,
            page.committed_at
          FROM focowiki.storage_reconciliation_page_checkpoints page
          LEFT JOIN focowiki.storage_reconciliation_chunk_checkpoints chunk
            ON chunk.prefix = page.prefix
           AND chunk.cycle_id = page.cycle_id
           AND chunk.page_id = page.page_id
          WHERE page.prefix = ${input.cycle.prefix}
            AND page.cycle_id = ${input.cycle.cycleId}
            AND page.page_id = ${input.pageId}
          GROUP BY
            page.continuation_token,
            page.next_continuation_token,
            page.listed_count,
            page.database_chunk_size,
            page.committed_at
        `;
        const page = rows[0];
        if (
          !page
          || page.continuation_token !== input.cycle.continuationToken
          || page.next_continuation_token !== input.nextContinuationToken
          || Number(page.listed_count) !== input.listedCount
        ) {
          throw new Error("Storage reconciliation page checkpoint does not match");
        }
        return {
          completedObjectCount: Number(page.completed_object_count),
          databaseChunkSize: Number(page.database_chunk_size),
          committed: page.committed_at !== null
        };
      });
    },

    async recordScanChunk(input) {
      if (input.objects.length === 0) return true;
      return sql.begin(async (transaction) => {
        await transaction`SET LOCAL statement_timeout = '60s'`;
        const owners = await transaction<Array<{ prefix: string }>>`
          SELECT prefix
          FROM focowiki.storage_reconciliation_cycles
          WHERE prefix = ${input.cycle.prefix}
            AND cycle_id = ${input.cycle.cycleId}
            AND lease_token = ${input.leaseToken}
            AND lease_expires_at > ${input.recordedAt}
            AND state = 'scanning'
          FOR UPDATE
        `;
        if (owners.length !== 1) return false;
        const inserted = await transaction<Array<{ chunk_ordinal: number }>>`
          INSERT INTO focowiki.storage_reconciliation_chunk_checkpoints (
            prefix, cycle_id, page_id, chunk_ordinal, object_offset,
            object_count, completed_at
          ) VALUES (
            ${input.cycle.prefix}, ${input.cycle.cycleId}, ${input.pageId},
            ${input.objectOffset}, ${input.objectOffset}, ${input.objects.length},
            ${input.recordedAt}
          )
          ON CONFLICT (prefix, cycle_id, page_id, chunk_ordinal) DO NOTHING
          RETURNING chunk_ordinal
        `;
        if (inserted.length === 0) return true;

        const protectedRows = await transaction<Array<{ object_key: string }>>`
          SELECT listed.object_key
          FROM unnest(
            ${input.objects.map((object) => object.key)}::text[],
            ${input.objects.map((object) => object.checksumSha256)}::text[],
            ${input.objects.map((object) => object.formatVersion)}::int[]
          ) AS listed(object_key, checksum_sha256, format_version)
          CROSS JOIN LATERAL (
            SELECT indexed.protected, indexed.dirty
            FROM focowiki.storage_object_protection_index indexed
            WHERE indexed.object_key = listed.object_key
              AND indexed.checksum_sha256 = listed.checksum_sha256
              AND indexed.format_version = listed.format_version
            LIMIT 1
          ) protection
          WHERE protection.protected OR protection.dirty
        `;
        const protectedKeys = protectedRows.map((row) => row.object_key);
        const protectedSet = new Set(protectedKeys);
        const unknownObjects = input.objects.filter(
          (object) => !protectedSet.has(object.key)
        );
        const orphanObjects = input.allowQuarantine ? unknownObjects : [];
        const pendingCount = input.allowQuarantine ? 0 : unknownObjects.length;

        if (protectedKeys.length > 0) {
          await transaction`
            UPDATE focowiki.immutable_objects object
            SET last_storage_seen_cycle_id = ${input.cycle.cycleId},
                last_storage_seen_at = ${input.recordedAt},
                integrity_error_code = NULL,
                integrity_checked_at = ${input.recordedAt}
            WHERE object.object_key = ANY(${protectedKeys})
          `;
          await transaction`
            UPDATE focowiki.projection_segments segment
            SET last_storage_seen_cycle_id = ${input.cycle.cycleId},
                last_storage_seen_at = ${input.recordedAt},
                integrity_error_code = NULL,
                integrity_checked_at = ${input.recordedAt}
            WHERE segment.object_key = ANY(${protectedKeys})
              AND segment.lifecycle_state <> 'deleted'
          `;
        }
        const resolvedRows = protectedKeys.length === 0
          ? []
          : await transaction<Array<{ object_key: string }>>`
              UPDATE focowiki.storage_reconciliation_candidates candidate
              SET state = 'resolved',
                  deletion_lease_token = NULL,
                  resolved_at = ${input.recordedAt},
                  updated_at = ${input.recordedAt}
              WHERE candidate.prefix = ${input.cycle.prefix}
                AND candidate.object_key = ANY(${protectedKeys})
                AND candidate.state NOT IN ('resolved', 'deleted')
              RETURNING object_key
            `;
        if (orphanObjects.length > 0) {
          await upsertOrphanCandidates(
            transaction,
            input.cycle,
            orphanObjects,
            input.recordedAt
          );
        }
        await transaction`
          UPDATE focowiki.storage_reconciliation_chunk_checkpoints
          SET protected_count = ${protectedKeys.length},
              pending_count = ${pendingCount},
              quarantined_count = ${orphanObjects.length},
              resolved_count = ${resolvedRows.length},
              completed_at = ${input.recordedAt}
          WHERE prefix = ${input.cycle.prefix}
            AND cycle_id = ${input.cycle.cycleId}
            AND page_id = ${input.pageId}
            AND chunk_ordinal = ${input.objectOffset}
        `;
        await transaction`
          UPDATE focowiki.storage_reconciliation_page_checkpoints
          SET protected_count = protected_count + ${protectedKeys.length},
              pending_count = pending_count + ${pendingCount},
              quarantined_count = quarantined_count + ${orphanObjects.length},
              resolved_count = resolved_count + ${resolvedRows.length},
              updated_at = ${input.recordedAt}
          WHERE prefix = ${input.cycle.prefix}
            AND cycle_id = ${input.cycle.cycleId}
            AND page_id = ${input.pageId}
            AND committed_at IS NULL
        `;
        return true;
      });
    },

    async reduceScanPageChunkSize(input) {
      const chunkSize = boundedLimit(input.databaseChunkSize);
      const rows = await sql<Array<{ page_id: string }>>`
        UPDATE focowiki.storage_reconciliation_page_checkpoints page
        SET database_chunk_size = LEAST(database_chunk_size, ${chunkSize}),
            updated_at = ${input.reducedAt}
        FROM focowiki.storage_reconciliation_cycles cycle
        WHERE page.prefix = ${input.cycle.prefix}
          AND page.cycle_id = ${input.cycle.cycleId}
          AND page.page_id = ${input.pageId}
          AND page.committed_at IS NULL
          AND cycle.prefix = page.prefix
          AND cycle.cycle_id = page.cycle_id
          AND cycle.lease_token = ${input.leaseToken}
          AND cycle.lease_expires_at > ${input.reducedAt}
          AND cycle.state = 'scanning'
        RETURNING page.page_id
      `;
      return rows.length === 1;
    },

    async completeScanPage(input) {
      return sql.begin(async (transaction) => {
        const ownedPages = await transaction<Array<{
          next_continuation_token: string | null;
          listed_count: number;
          protected_count: number;
          pending_count: number;
          quarantined_count: number;
          resolved_count: number;
          database_chunk_size: number;
          committed_at: Date | null;
        }>>`
          SELECT
            page.next_continuation_token,
            page.listed_count,
            page.protected_count,
            page.pending_count,
            page.quarantined_count,
            page.resolved_count,
            page.database_chunk_size,
            page.committed_at
          FROM focowiki.storage_reconciliation_page_checkpoints page
          JOIN focowiki.storage_reconciliation_cycles cycle
            ON cycle.prefix = page.prefix
           AND cycle.cycle_id = page.cycle_id
          WHERE page.prefix = ${input.cycle.prefix}
            AND page.cycle_id = ${input.cycle.cycleId}
            AND page.page_id = ${input.pageId}
            AND cycle.lease_token = ${input.leaseToken}
            AND cycle.lease_expires_at > ${input.completedAt}
            AND cycle.state = 'scanning'
          FOR UPDATE OF page
        `;
        const page = ownedPages[0];
        if (!page) return false;
        if (page.committed_at !== null) return true;
        const chunkRows = await transaction<Array<{
          chunk_count: number;
          completed_object_count: number;
        }>>`
          SELECT
            count(*)::int AS chunk_count,
            coalesce(sum(object_count), 0)::int AS completed_object_count
          FROM focowiki.storage_reconciliation_chunk_checkpoints
          WHERE prefix = ${input.cycle.prefix}
            AND cycle_id = ${input.cycle.cycleId}
            AND page_id = ${input.pageId}
        `;
        const chunks = chunkRows[0]!;
        if (Number(chunks.completed_object_count) !== Number(page.listed_count)) {
          return false;
        }
        const reachedEnd = page.next_continuation_token === null;
        const absentResolvedRows = reachedEnd
          ? await transaction<Array<{ object_key: string }>>`
              UPDATE focowiki.storage_reconciliation_candidates
              SET state = 'resolved',
                  resolved_at = ${input.completedAt},
                  updated_at = ${input.completedAt}
              WHERE prefix = ${input.cycle.prefix}
                AND state IN ('quarantined', 'failed')
                AND last_seen_cycle_id <> ${input.cycle.cycleId}
              RETURNING object_key
            `
          : [];
        const cycleRows = await transaction<Array<{ prefix: string }>>`
          UPDATE focowiki.storage_reconciliation_cycles
          SET continuation_token = ${page.next_continuation_token},
              state = ${reachedEnd ? "verifying" : "scanning"},
              scan_completed_at = ${reachedEnd ? input.completedAt : null},
              listed_count = listed_count + ${page.listed_count},
              quarantined_count = quarantined_count + ${page.quarantined_count},
              resolved_count = resolved_count
                + ${page.resolved_count + absentResolvedRows.length},
              pending_count = pending_count + ${page.pending_count},
              database_chunk_size = ${page.database_chunk_size},
              rolling_batch_latency_ms = ${Math.max(0, input.batchLatencyMs)},
              recent_objects_per_second = CASE
                WHEN ${input.batchLatencyMs} > 0
                  THEN ${page.listed_count}::numeric
                    / (${input.batchLatencyMs}::numeric / 1000)
                ELSE NULL
              END,
              heartbeat_at = ${input.completedAt},
              last_progress_at = ${input.completedAt},
              updated_at = ${input.completedAt}
          WHERE prefix = ${input.cycle.prefix}
            AND cycle_id = ${input.cycle.cycleId}
            AND lease_token = ${input.leaseToken}
            AND lease_expires_at > ${input.completedAt}
            AND state = 'scanning'
          RETURNING prefix
        `;
        if (cycleRows.length !== 1) return false;
        await transaction`
          UPDATE focowiki.storage_reconciliation_page_checkpoints
          SET expected_chunk_count = ${chunks.chunk_count},
              committed_at = ${input.completedAt},
              updated_at = ${input.completedAt}
          WHERE prefix = ${input.cycle.prefix}
            AND cycle_id = ${input.cycle.cycleId}
            AND page_id = ${input.pageId}
            AND committed_at IS NULL
        `;
        return true;
      });
    },

    async claimDeletionCandidates(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          UPDATE focowiki.storage_reconciliation_candidates
          SET state = 'failed',
              deletion_lease_token = NULL,
              next_attempt_at = ${input.now},
              last_error_code = 'STALE_DELETION_LEASE_EXPIRED',
              updated_at = ${input.now}
          WHERE prefix = ${input.cycle.prefix}
            AND state = 'deleting'
            AND updated_at <= ${input.staleDeletingBefore}
        `;
        await transaction`
          UPDATE focowiki.storage_reconciliation_candidates candidate
          SET state = 'resolved', deletion_lease_token = NULL,
              resolved_at = ${input.now}, updated_at = ${input.now}
          WHERE candidate.prefix = ${input.cycle.prefix}
            AND candidate.state IN ('quarantined', 'failed')
            AND (
              EXISTS (
                SELECT 1
                FROM focowiki.storage_object_protection_index protection
                WHERE protection.checksum_sha256 = candidate.checksum_sha256
                  AND protection.format_version = candidate.format_version
                  AND protection.object_key = candidate.object_key
                  AND (protection.protected OR protection.dirty)
              )
            )
        `;
        const rows = await transaction<CandidateRow[]>`
          WITH eligible AS (
            SELECT candidate.prefix, candidate.object_key
            FROM focowiki.storage_reconciliation_candidates candidate
            WHERE candidate.prefix = ${input.cycle.prefix}
              AND candidate.state IN ('quarantined', 'failed')
              AND candidate.last_seen_cycle_id = ${input.cycle.cycleId}
              AND candidate.first_seen_at <= ${input.graceBefore}
              AND candidate.confirmation_count >= ${input.confirmationPasses}
              AND candidate.attempt_count < ${input.maxAttempts}
              AND candidate.next_attempt_at <= ${input.now}
              AND EXISTS (
                SELECT 1
                FROM focowiki.storage_object_protection_backfills backfill
                WHERE backfill.schema_version = 1
                  AND backfill.state = 'ready'
              )
              AND EXISTS (
                SELECT 1 FROM focowiki.storage_reconciliation_cycles cycle
                WHERE cycle.prefix = candidate.prefix
                  AND cycle.cycle_id = ${input.cycle.cycleId}
                  AND cycle.state = 'verifying'
                  AND cycle.lease_token = ${input.leaseToken}
                  AND cycle.lease_expires_at > ${input.now}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM focowiki.storage_object_protection_index protection
                WHERE protection.checksum_sha256 = candidate.checksum_sha256
                  AND protection.format_version = candidate.format_version
                  AND protection.object_key = candidate.object_key
                  AND (protection.protected OR protection.dirty)
              )
            ORDER BY candidate.first_seen_at, candidate.object_key
            LIMIT ${boundedLimit(input.limit)}
            FOR UPDATE SKIP LOCKED
          )
          UPDATE focowiki.storage_reconciliation_candidates candidate
          SET state = 'deleting', attempt_count = attempt_count + 1,
              deletion_lease_token = ${input.leaseToken},
              last_error_code = NULL, updated_at = ${input.now}
          FROM eligible
          WHERE candidate.prefix = eligible.prefix
            AND candidate.object_key = eligible.object_key
          RETURNING candidate.object_key, candidate.checksum_sha256,
                    candidate.format_version, candidate.confirmation_count,
                    candidate.attempt_count, candidate.observed_size_bytes,
                    candidate.observed_etag, candidate.last_seen_at
        `;
        return rows.map(mapCandidate);
      });
    },

    async authorizeCandidateDeletion(input) {
      return sql.begin(async (transaction) => {
        await lockImmutableObjectKey(transaction, input.objectKey);
        const candidates = await transaction<Array<{ object_key: string }>>`
          SELECT candidate.object_key
          FROM focowiki.storage_reconciliation_candidates candidate
          JOIN focowiki.storage_reconciliation_cycles cycle
            ON cycle.prefix = candidate.prefix
          WHERE candidate.prefix = ${input.cycle.prefix}
            AND candidate.object_key = ${input.objectKey}
            AND candidate.checksum_sha256 = ${input.checksumSha256}
            AND candidate.format_version = ${input.formatVersion}
            AND candidate.state = 'deleting'
            AND candidate.deletion_lease_token = ${input.leaseToken}
            AND cycle.cycle_id = ${input.cycle.cycleId}
            AND cycle.state = 'verifying'
            AND cycle.lease_token = ${input.leaseToken}
            AND cycle.lease_expires_at > ${input.authorizedAt}
          FOR UPDATE OF candidate, cycle
        `;
        if (candidates.length === 0) return false;

        const conflicts = await transaction<Array<{ conflict: number }>>`
          SELECT 1 AS conflict
          WHERE NOT EXISTS (
                  SELECT 1
                  FROM focowiki.storage_object_protection_backfills backfill
                  WHERE backfill.schema_version = 1
                    AND backfill.state = 'ready'
                )
             OR EXISTS (
                  SELECT 1
                  FROM focowiki.storage_object_protection_index protection
                  WHERE protection.checksum_sha256 = ${input.checksumSha256}
                    AND protection.format_version = ${input.formatVersion}
                    AND protection.object_key = ${input.objectKey}
                    AND (protection.protected OR protection.dirty)
                )
             OR EXISTS (
                  SELECT 1
                  FROM focowiki.source_files source
                  WHERE source.checksum_sha256 = ${input.checksumSha256}
                    AND ${input.formatVersion} = 1
                    AND source.object_key = ${input.objectKey}
                    AND source.deleted_at IS NULL
                )
             OR EXISTS (
                  SELECT 1
                  FROM focowiki.immutable_objects object
                  WHERE object.checksum_sha256 = ${input.checksumSha256}
                    AND object.format_version = ${input.formatVersion}
                    AND object.object_key = ${input.objectKey}
                )
             OR EXISTS (
                  SELECT 1
                  FROM focowiki.active_object_refs reference
                  JOIN focowiki.immutable_objects object
                    ON object.checksum_sha256 = reference.checksum_sha256
                   AND object.format_version = reference.format_version
                  WHERE reference.checksum_sha256 = ${input.checksumSha256}
                    AND reference.format_version = ${input.formatVersion}
                    AND object.object_key = ${input.objectKey}
                )
             OR EXISTS (
                  SELECT 1
                  FROM focowiki.generation_object_refs reference
                  JOIN focowiki.immutable_objects object
                    ON object.checksum_sha256 = reference.checksum_sha256
                   AND object.format_version = reference.format_version
                  WHERE reference.action = 'upsert'
                    AND reference.checksum_sha256 = ${input.checksumSha256}
                    AND reference.format_version = ${input.formatVersion}
                    AND object.object_key = ${input.objectKey}
                )
             OR EXISTS (
                  SELECT 1
                  FROM focowiki.publication_generations generation
                  JOIN focowiki.immutable_objects object
                    ON object.checksum_sha256 =
                      generation.root_manifest_checksum_sha256
                   AND object.format_version = generation.format_version
                  WHERE generation.root_manifest_checksum_sha256 =
                        ${input.checksumSha256}
                    AND generation.format_version = ${input.formatVersion}
                    AND object.object_key = ${input.objectKey}
                )
             OR EXISTS (
                  SELECT 1
                  FROM focowiki.projection_segments segment
                  WHERE segment.checksum_sha256 = ${input.checksumSha256}
                    AND segment.format_version = ${input.formatVersion}
                    AND segment.object_key = ${input.objectKey}
                    AND (
                      segment.ownership_count > 0
                      OR segment.lifecycle_state = ANY (
                        ARRAY['writing', 'active', 'retained']
                      )
                      OR EXISTS (
                        SELECT 1
                        FROM focowiki.active_projection_segments active
                        WHERE active.segment_id = segment.id
                      )
                      OR EXISTS (
                        SELECT 1
                        FROM focowiki.generation_projection_segments retained
                        WHERE retained.segment_id = segment.id
                      )
                    )
                )
        `;
        if (conflicts.length === 0) return true;

        await transaction`
          UPDATE focowiki.storage_reconciliation_candidates
          SET state = 'resolved', deletion_lease_token = NULL,
              resolved_at = ${input.authorizedAt},
              updated_at = ${input.authorizedAt}
          WHERE prefix = ${input.cycle.prefix} AND object_key = ${input.objectKey}
        `;
        return false;
      });
    },

    async refreshCandidateObservation(input) {
      await sql`
        UPDATE focowiki.storage_reconciliation_candidates candidate
        SET state = 'quarantined', confirmation_count = 1,
            deletion_lease_token = NULL,
            first_seen_cycle_id = last_seen_cycle_id,
            first_seen_at = ${input.observedAt}, last_seen_at = ${input.observedAt},
            observed_size_bytes = ${input.object.sizeBytes},
            observed_etag = ${input.object.etag}, next_attempt_at = ${input.observedAt},
            last_error_code = NULL, updated_at = ${input.observedAt}
        WHERE candidate.prefix = ${input.cycle.prefix}
          AND candidate.object_key = ${input.object.key}
          AND candidate.state = 'deleting'
          AND candidate.deletion_lease_token = ${input.leaseToken}
          AND EXISTS (
            SELECT 1
            FROM focowiki.storage_reconciliation_cycles cycle
            WHERE cycle.prefix = candidate.prefix
              AND cycle.cycle_id = ${input.cycle.cycleId}
              AND cycle.state = 'verifying'
              AND cycle.lease_token = ${input.leaseToken}
              AND cycle.lease_expires_at > ${input.observedAt}
          )
      `;
    },

    async completeCandidateDeletion(input) {
      await sql.begin(async (transaction) => {
        const updated = await transaction<Array<{ object_key: string }>>`
          UPDATE focowiki.storage_reconciliation_candidates candidate
          SET state = 'deleted', deletion_lease_token = NULL,
              deleted_at = ${input.completedAt},
              resolved_at = ${input.completedAt}, updated_at = ${input.completedAt}
          WHERE candidate.prefix = ${input.cycle.prefix}
            AND candidate.object_key = ${input.objectKey}
            AND candidate.state = 'deleting'
            AND candidate.deletion_lease_token = ${input.leaseToken}
            AND EXISTS (
              SELECT 1
              FROM focowiki.storage_reconciliation_cycles cycle
              WHERE cycle.prefix = candidate.prefix
                AND cycle.cycle_id = ${input.cycle.cycleId}
                AND cycle.state = 'verifying'
                AND cycle.lease_token = ${input.leaseToken}
                AND cycle.lease_expires_at > ${input.completedAt}
            )
          RETURNING candidate.object_key
        `;
        if (updated.length > 0) {
          await transaction`
            UPDATE focowiki.projection_segments
            SET lifecycle_state = 'deleted', integrity_error_code = NULL,
                integrity_checked_at = ${input.completedAt}
            WHERE object_key = ${input.objectKey}
              AND lifecycle_state = 'quarantined'
              AND ownership_count = 0
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.active_projection_segments active
                WHERE active.segment_id = focowiki.projection_segments.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.generation_projection_segments retained
                WHERE retained.segment_id = focowiki.projection_segments.id
              )
          `;
          await transaction`
            UPDATE focowiki.storage_reconciliation_cycles
            SET deleted_count = deleted_count + 1, updated_at = ${input.completedAt}
            WHERE prefix = ${input.cycle.prefix}
              AND cycle_id = ${input.cycle.cycleId}
              AND lease_token = ${input.leaseToken}
              AND lease_expires_at > ${input.completedAt}
          `;
        }
      });
    },

    async failCandidateDeletion(input) {
      await sql.begin(async (transaction) => {
        await transaction`
          UPDATE focowiki.storage_reconciliation_candidates candidate
          SET state = 'failed', deletion_lease_token = NULL,
              last_error_code = ${input.errorCode},
              next_attempt_at = ${input.retryAt}, updated_at = ${input.failedAt}
          WHERE candidate.prefix = ${input.cycle.prefix}
            AND candidate.object_key = ${input.objectKey}
            AND candidate.state = 'deleting'
            AND candidate.deletion_lease_token = ${input.leaseToken}
            AND EXISTS (
              SELECT 1
              FROM focowiki.storage_reconciliation_cycles cycle
              WHERE cycle.prefix = candidate.prefix
                AND cycle.cycle_id = ${input.cycle.cycleId}
                AND cycle.state = 'verifying'
                AND cycle.lease_token = ${input.leaseToken}
                AND cycle.lease_expires_at > ${input.failedAt}
            )
        `;
        await transaction`
          UPDATE focowiki.storage_reconciliation_cycles
          SET retry_count = retry_count + 1, updated_at = ${input.failedAt}
          WHERE prefix = ${input.cycle.prefix}
            AND cycle_id = ${input.cycle.cycleId}
            AND lease_token = ${input.leaseToken}
            AND lease_expires_at > ${input.failedAt}
        `;
      });
    },

    async listRegisteredObjectsForVerification(input) {
      const prefixUpperBound = `${input.cycle.prefix}\uffff`;
      const rows = await sql<Array<{
        checksum_sha256: string;
        format_version: number;
        object_key: string;
      }>>`
        SELECT checksum_sha256, format_version, object_key
        FROM focowiki.storage_object_protection_index protection
        WHERE (protection.protected OR protection.dirty)
          AND protection.object_key >= ${input.cycle.prefix}
          AND protection.object_key < ${prefixUpperBound}
          AND (${input.cycle.verificationCursor}::text IS NULL OR protection.object_key > ${input.cycle.verificationCursor})
          AND (
            EXISTS (
              SELECT 1 FROM focowiki.immutable_objects object
              WHERE object.checksum_sha256 = protection.checksum_sha256
                AND object.format_version = protection.format_version
                AND coalesce(object.last_storage_seen_cycle_id, '') <> ${input.cycle.cycleId}
            ) OR EXISTS (
              SELECT 1 FROM focowiki.projection_segments segment
              WHERE segment.checksum_sha256 = protection.checksum_sha256
                AND segment.format_version = protection.format_version
                AND coalesce(segment.last_storage_seen_cycle_id, '') <> ${input.cycle.cycleId}
            )
          )
        ORDER BY object_key
        LIMIT ${boundedLimit(input.limit)}
      `;
      return rows.map((row) => ({
        checksumSha256: row.checksum_sha256,
        formatVersion: Number(row.format_version),
        objectKey: row.object_key
      }));
    },

    async recordRegisteredObjectCheck(input) {
      return sql.begin(async (transaction) => {
        const owners = await transaction<Array<{ prefix: string }>>`
          SELECT prefix
          FROM focowiki.storage_reconciliation_cycles
          WHERE prefix = ${input.cycle.prefix}
            AND cycle_id = ${input.cycle.cycleId}
            AND lease_token = ${input.leaseToken}
            AND state = 'verifying'
            AND lease_expires_at > ${input.checkedAt}
          FOR UPDATE
        `;
        if (owners.length !== 1) return false;

        const objectRows = await transaction<Array<{ checksum_sha256: string }>>`
          UPDATE focowiki.immutable_objects
          SET last_storage_seen_cycle_id = ${input.exists ? input.cycle.cycleId : null},
              last_storage_seen_at = ${input.exists ? input.checkedAt : null},
              integrity_error_code = ${input.exists ? null : "STORAGE_OBJECT_MISSING"},
              integrity_checked_at = ${input.checkedAt}
          WHERE checksum_sha256 = ${input.object.checksumSha256}
            AND format_version = ${input.object.formatVersion}
            AND object_key = ${input.object.objectKey}
          RETURNING checksum_sha256
        `;
        const segmentRows = await transaction<Array<{ id: string }>>`
          UPDATE focowiki.projection_segments
          SET last_storage_seen_cycle_id = ${input.exists ? input.cycle.cycleId : null},
              last_storage_seen_at = ${input.exists ? input.checkedAt : null},
              integrity_error_code = ${input.exists ? null : "STORAGE_OBJECT_MISSING"},
              integrity_checked_at = ${input.checkedAt}
          WHERE checksum_sha256 = ${input.object.checksumSha256}
            AND format_version = ${input.object.formatVersion}
            AND object_key = ${input.object.objectKey}
            AND lifecycle_state <> 'deleted'
          RETURNING id
        `;
        const missingIncrement = !input.exists && (objectRows.length > 0 || segmentRows.length > 0)
          ? 1
          : 0;
        const cycleRows = await transaction<Array<{ prefix: string }>>`
          UPDATE focowiki.storage_reconciliation_cycles
          SET verification_cursor = ${input.object.objectKey},
              missing_count = missing_count + ${missingIncrement},
              updated_at = ${input.checkedAt}
          WHERE prefix = ${input.cycle.prefix}
            AND cycle_id = ${input.cycle.cycleId}
            AND lease_token = ${input.leaseToken}
            AND state = 'verifying'
            AND lease_expires_at > ${input.checkedAt}
          RETURNING prefix
        `;
        return cycleRows.length === 1;
      });
    },

    async finishCycle(input) {
      const rows = await sql<Array<{ prefix: string }>>`
        UPDATE focowiki.storage_reconciliation_cycles
        SET state = 'idle', continuation_token = NULL, verification_cursor = NULL,
            lease_token = NULL, lease_expires_at = NULL,
            next_scan_at = ${input.nextScanAt}, last_error_code = NULL,
            updated_at = ${input.completedAt}
        WHERE prefix = ${input.cycle.prefix}
          AND cycle_id = ${input.cycle.cycleId}
          AND lease_token = ${input.leaseToken}
          AND state = 'verifying'
          AND lease_expires_at > ${input.completedAt}
        RETURNING prefix
      `;
      return rows.length === 1;
    },

    async failCycle(input) {
      await sql.begin(async (transaction) => {
        const cycles = await transaction<Array<{ prefix: string }>>`
          UPDATE focowiki.storage_reconciliation_cycles
          SET state = 'failed', lease_token = NULL, lease_expires_at = NULL,
              next_scan_at = ${input.retryAt}, last_error_code = ${input.errorCode},
              safe_error_message = 'Storage reconciliation will retry',
              database_chunk_size = coalesce(
                ${input.databaseChunkSize ?? null},
                database_chunk_size
              ),
              heartbeat_at = ${input.failedAt},
              retry_count = retry_count + 1, updated_at = ${input.failedAt}
          WHERE prefix = ${input.cycle.prefix}
            AND cycle_id = ${input.cycle.cycleId}
            AND lease_token = ${input.leaseToken}
            AND lease_expires_at > ${input.failedAt}
          RETURNING prefix
        `;
        if (cycles.length === 0) return;
        await transaction`
          UPDATE focowiki.storage_reconciliation_candidates
          SET state = 'failed', deletion_lease_token = NULL,
              next_attempt_at = ${input.retryAt},
              last_error_code = ${input.errorCode}, updated_at = ${input.failedAt}
          WHERE prefix = ${input.cycle.prefix}
            AND last_seen_cycle_id = ${input.cycle.cycleId}
            AND state = 'deleting'
            AND deletion_lease_token = ${input.leaseToken}
        `;
      });
    },

    async getStatus(prefix) {
      const rows = await sql<CycleRow[]>`
        SELECT * FROM focowiki.storage_reconciliation_cycles
        WHERE prefix = ${prefix}
      `;
      return rows[0] ? mapStatus(rows[0]) : null;
    }
  };
}

function mapClaimedCycle(row: CycleRow): StorageReconciliationCycle {
  if (!row.cycle_id || (row.state !== "scanning" && row.state !== "verifying")) {
    throw new Error("Storage reconciliation cycle is not claimed");
  }
  return {
    prefix: row.prefix,
    cycleId: row.cycle_id,
    state: row.state,
    continuationToken: row.continuation_token,
    verificationCursor: row.verification_cursor,
    databaseChunkSize: row.database_chunk_size === null
      ? null
      : Number(row.database_chunk_size)
  };
}

function mapCandidate(row: CandidateRow): StorageReconciliationCandidate {
  return {
    key: row.object_key,
    checksumSha256: row.checksum_sha256,
    formatVersion: Number(row.format_version),
    confirmationCount: Number(row.confirmation_count),
    attemptCount: Number(row.attempt_count),
    sizeBytes: Number(row.observed_size_bytes ?? 0),
    etag: row.observed_etag,
    lastModified: row.last_seen_at.toISOString()
  };
}

function mapStatus(row: CycleRow): StorageReconciliationStatus {
  return {
    state: row.state,
    lastScanStartedAt: row.scan_started_at?.toISOString() ?? null,
    lastScanCompletedAt: row.scan_completed_at?.toISOString() ?? null,
    listedCount: Number(row.listed_count),
    quarantinedCount: Number(row.quarantined_count),
    deletedCount: Number(row.deleted_count),
    missingCount: Number(row.missing_count),
    retryCount: Number(row.retry_count),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.safe_error_message,
    resolvedCount: Number(row.resolved_count),
    pendingCount: Number(row.pending_count),
    databaseChunkSize: row.database_chunk_size === null
      ? null
      : Number(row.database_chunk_size),
    recentObjectsPerSecond: row.recent_objects_per_second === null
      ? null
      : Number(row.recent_objects_per_second),
    rollingBatchLatencyMs: row.rolling_batch_latency_ms === null
      ? null
      : Number(row.rolling_batch_latency_ms),
    heartbeatAt: row.heartbeat_at?.toISOString() ?? null,
    lastProgressAt: row.last_progress_at?.toISOString() ?? null
  };
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Storage reconciliation limit must be between 1 and 1000");
  }
  return value;
}

async function upsertOrphanCandidates(
  transaction: TransactionSql,
  cycle: StorageReconciliationCycle,
  objects: Array<{
    key: string;
    checksumSha256: string;
    formatVersion: number;
    sizeBytes: number;
    etag: string | null;
  }>,
  recordedAt: string
): Promise<void> {
  await transaction`
    INSERT INTO focowiki.storage_reconciliation_candidates (
      prefix, object_key, checksum_sha256, format_version, state,
      first_seen_cycle_id, last_seen_cycle_id, confirmation_count,
      first_seen_at, last_seen_at, observed_size_bytes, observed_etag,
      next_attempt_at, updated_at
    )
    SELECT
      ${cycle.prefix}, listed.object_key, listed.checksum_sha256,
      listed.format_version, 'quarantined', ${cycle.cycleId},
      ${cycle.cycleId}, 1, ${recordedAt}, ${recordedAt},
      listed.observed_size_bytes, listed.observed_etag,
      ${recordedAt}, ${recordedAt}
    FROM unnest(
      ${objects.map((object) => object.key)}::text[],
      ${objects.map((object) => object.checksumSha256)}::text[],
      ${objects.map((object) => object.formatVersion)}::int[],
      ${objects.map((object) => object.sizeBytes)}::bigint[],
      ${objects.map((object) => object.etag)}::text[]
    ) AS listed(
      object_key, checksum_sha256, format_version,
      observed_size_bytes, observed_etag
    )
    ON CONFLICT (prefix, object_key) DO UPDATE
    SET checksum_sha256 = EXCLUDED.checksum_sha256,
        format_version = EXCLUDED.format_version,
        state = CASE
          WHEN focowiki.storage_reconciliation_candidates.state = 'deleted'
            THEN 'quarantined'
          ELSE focowiki.storage_reconciliation_candidates.state
        END,
        confirmation_count = CASE
          WHEN focowiki.storage_reconciliation_candidates.last_seen_cycle_id
            <> EXCLUDED.last_seen_cycle_id
            THEN focowiki.storage_reconciliation_candidates.confirmation_count + 1
          ELSE focowiki.storage_reconciliation_candidates.confirmation_count
        END,
        last_seen_cycle_id = EXCLUDED.last_seen_cycle_id,
        last_seen_at = EXCLUDED.last_seen_at,
        observed_size_bytes = EXCLUDED.observed_size_bytes,
        observed_etag = EXCLUDED.observed_etag,
        resolved_at = NULL,
        deleted_at = NULL,
        updated_at = EXCLUDED.updated_at
  `;
}
