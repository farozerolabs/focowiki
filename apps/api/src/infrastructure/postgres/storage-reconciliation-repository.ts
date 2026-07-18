import type {
  StorageReconciliationCandidate,
  StorageReconciliationCycle,
  StorageReconciliationRepository,
  StorageReconciliationStatus
} from "../../application/ports/storage-reconciliation-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import { lockImmutableObjectKey } from "./immutable-object-lock.js";

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
              retry_count = ${startsNewCycle ? 0 : current.retry_count},
              last_error_code = NULL,
              updated_at = ${input.now}
          WHERE prefix = ${input.prefix}
          RETURNING *
        `;
        return mapClaimedCycle(updated[0]!);
      });
    },

    async recordScanPage(input) {
      return sql.begin(async (transaction) => {
        const ownedKeys: string[] = [];
        const orphanObjects = [];
        if (input.objects.length > 0) {
          const owned = await transaction<Array<{ object_key: string }>>`
            SELECT listed.object_key
            FROM unnest(
              ${input.objects.map((object) => object.key)}::text[],
              ${input.objects.map((object) => object.checksumSha256)}::text[],
              ${input.objects.map((object) => object.formatVersion)}::int[]
            ) AS listed(object_key, checksum_sha256, format_version)
            JOIN focowiki.immutable_objects object
              ON object.checksum_sha256 = listed.checksum_sha256
             AND object.format_version = listed.format_version
             AND object.object_key = listed.object_key
          `;
          ownedKeys.push(...owned.map((row) => row.object_key));
          const ownedSet = new Set(ownedKeys);
          orphanObjects.push(...input.objects.filter((object) => !ownedSet.has(object.key)));

          if (ownedKeys.length > 0) {
            await transaction`
              UPDATE focowiki.immutable_objects object
              SET last_storage_seen_cycle_id = ${input.cycle.cycleId},
                  last_storage_seen_at = ${input.recordedAt},
                  integrity_error_code = NULL,
                  integrity_checked_at = ${input.recordedAt}
              WHERE object.object_key = ANY(${ownedKeys})
            `;
            await transaction`
              UPDATE focowiki.storage_reconciliation_candidates candidate
              SET state = 'resolved', resolved_at = ${input.recordedAt}, updated_at = ${input.recordedAt}
              WHERE candidate.prefix = ${input.cycle.prefix}
                AND candidate.object_key = ANY(${ownedKeys})
                AND candidate.state <> 'deleted'
            `;
          }
        }

        if (orphanObjects.length > 0) {
          await transaction`
            INSERT INTO focowiki.storage_reconciliation_candidates (
              prefix, object_key, checksum_sha256, format_version, state,
              first_seen_cycle_id, last_seen_cycle_id, confirmation_count,
              first_seen_at, last_seen_at, observed_size_bytes, observed_etag,
              next_attempt_at, updated_at
            )
            SELECT
              ${input.cycle.prefix}, listed.object_key, listed.checksum_sha256,
              listed.format_version, 'quarantined', ${input.cycle.cycleId},
              ${input.cycle.cycleId}, 1, ${input.recordedAt}, ${input.recordedAt},
              listed.observed_size_bytes, listed.observed_etag,
              ${input.recordedAt}, ${input.recordedAt}
            FROM unnest(
              ${orphanObjects.map((object) => object.key)}::text[],
              ${orphanObjects.map((object) => object.checksumSha256)}::text[],
              ${orphanObjects.map((object) => object.formatVersion)}::int[],
              ${orphanObjects.map((object) => object.sizeBytes)}::bigint[],
              ${orphanObjects.map((object) => object.etag)}::text[]
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
                  WHEN focowiki.storage_reconciliation_candidates.last_seen_cycle_id <> EXCLUDED.last_seen_cycle_id
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

        const reachedEnd = input.nextContinuationToken === null;
        if (reachedEnd) {
          await transaction`
            UPDATE focowiki.storage_reconciliation_candidates
            SET state = 'resolved', resolved_at = ${input.recordedAt}, updated_at = ${input.recordedAt}
            WHERE prefix = ${input.cycle.prefix}
              AND state IN ('quarantined', 'failed')
              AND last_seen_cycle_id <> ${input.cycle.cycleId}
          `;
        }
        const updated = await transaction<Array<{ prefix: string }>>`
          UPDATE focowiki.storage_reconciliation_cycles
          SET continuation_token = ${input.nextContinuationToken},
              state = ${reachedEnd ? "verifying" : "scanning"},
              scan_completed_at = ${reachedEnd ? input.recordedAt : null},
              listed_count = listed_count + ${input.objects.length},
              quarantined_count = quarantined_count + ${orphanObjects.length},
              updated_at = ${input.recordedAt}
          WHERE prefix = ${input.cycle.prefix}
            AND cycle_id = ${input.cycle.cycleId}
            AND lease_token = ${input.leaseToken}
            AND state = 'scanning'
          RETURNING prefix
        `;
        return updated.length === 1;
      });
    },

    async claimDeletionCandidates(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          UPDATE focowiki.storage_reconciliation_candidates candidate
          SET state = 'resolved', resolved_at = ${input.now}, updated_at = ${input.now}
          WHERE candidate.prefix = ${input.cycle.prefix}
            AND candidate.state IN ('quarantined', 'failed')
            AND EXISTS (
              SELECT 1 FROM focowiki.immutable_objects object
              WHERE object.checksum_sha256 = candidate.checksum_sha256
                AND object.format_version = candidate.format_version
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
                SELECT 1 FROM focowiki.storage_reconciliation_cycles cycle
                WHERE cycle.prefix = candidate.prefix
                  AND cycle.cycle_id = ${input.cycle.cycleId}
                  AND cycle.state = 'verifying'
                  AND cycle.lease_token = ${input.leaseToken}
                  AND cycle.lease_expires_at > ${input.now}
              )
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.immutable_objects object
                WHERE object.checksum_sha256 = candidate.checksum_sha256
                  AND object.format_version = candidate.format_version
              )
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.generation_object_refs reference
                WHERE reference.checksum_sha256 = candidate.checksum_sha256
                  AND reference.format_version = candidate.format_version
              )
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.active_object_refs reference
                WHERE reference.checksum_sha256 = candidate.checksum_sha256
                  AND reference.format_version = candidate.format_version
              )
            ORDER BY candidate.first_seen_at, candidate.object_key
            LIMIT ${boundedLimit(input.limit)}
            FOR UPDATE SKIP LOCKED
          )
          UPDATE focowiki.storage_reconciliation_candidates candidate
          SET state = 'deleting', attempt_count = attempt_count + 1,
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
            AND cycle.cycle_id = ${input.cycle.cycleId}
            AND cycle.state = 'verifying'
            AND cycle.lease_token = ${input.leaseToken}
            AND cycle.lease_expires_at > ${input.authorizedAt}
          FOR UPDATE OF candidate, cycle
        `;
        if (candidates.length === 0) return false;

        const conflicts = await transaction<Array<{ conflict: number }>>`
          SELECT 1 AS conflict
          WHERE EXISTS (
            SELECT 1 FROM focowiki.immutable_objects object
            WHERE object.checksum_sha256 = ${input.checksumSha256}
              AND object.format_version = ${input.formatVersion}
          ) OR EXISTS (
            SELECT 1 FROM focowiki.generation_object_refs reference
            WHERE reference.checksum_sha256 = ${input.checksumSha256}
              AND reference.format_version = ${input.formatVersion}
          ) OR EXISTS (
            SELECT 1 FROM focowiki.active_object_refs reference
            WHERE reference.checksum_sha256 = ${input.checksumSha256}
              AND reference.format_version = ${input.formatVersion}
          )
        `;
        if (conflicts.length === 0) return true;

        await transaction`
          UPDATE focowiki.storage_reconciliation_candidates
          SET state = 'resolved', resolved_at = ${input.authorizedAt},
              updated_at = ${input.authorizedAt}
          WHERE prefix = ${input.cycle.prefix} AND object_key = ${input.objectKey}
        `;
        return false;
      });
    },

    async refreshCandidateObservation(input) {
      await sql`
        UPDATE focowiki.storage_reconciliation_candidates
        SET state = 'quarantined', confirmation_count = 1,
            first_seen_cycle_id = last_seen_cycle_id,
            first_seen_at = ${input.observedAt}, last_seen_at = ${input.observedAt},
            observed_size_bytes = ${input.object.sizeBytes},
            observed_etag = ${input.object.etag}, next_attempt_at = ${input.observedAt},
            last_error_code = NULL, updated_at = ${input.observedAt}
        WHERE prefix = ${input.prefix} AND object_key = ${input.object.key}
      `;
    },

    async completeCandidateDeletion(input) {
      await sql.begin(async (transaction) => {
        const updated = await transaction<Array<{ object_key: string }>>`
          UPDATE focowiki.storage_reconciliation_candidates
          SET state = 'deleted', deleted_at = ${input.completedAt},
              resolved_at = ${input.completedAt}, updated_at = ${input.completedAt}
          WHERE prefix = ${input.prefix} AND object_key = ${input.objectKey}
            AND state = 'deleting'
          RETURNING object_key
        `;
        if (updated.length > 0) {
          await transaction`
            UPDATE focowiki.storage_reconciliation_cycles
            SET deleted_count = deleted_count + 1, updated_at = ${input.completedAt}
            WHERE prefix = ${input.prefix}
          `;
        }
      });
    },

    async failCandidateDeletion(input) {
      await sql.begin(async (transaction) => {
        await transaction`
          UPDATE focowiki.storage_reconciliation_candidates
          SET state = 'failed', last_error_code = ${input.errorCode},
              next_attempt_at = ${input.retryAt}, updated_at = ${input.failedAt}
          WHERE prefix = ${input.prefix} AND object_key = ${input.objectKey}
            AND state = 'deleting'
        `;
        await transaction`
          UPDATE focowiki.storage_reconciliation_cycles
          SET retry_count = retry_count + 1, updated_at = ${input.failedAt}
          WHERE prefix = ${input.prefix}
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
        FROM focowiki.immutable_objects
        WHERE lifecycle_state IN ('writing', 'active')
          AND object_key >= ${input.cycle.prefix}
          AND object_key < ${prefixUpperBound}
          AND (${input.cycle.verificationCursor}::text IS NULL OR object_key > ${input.cycle.verificationCursor})
          AND coalesce(last_storage_seen_cycle_id, '') <> ${input.cycle.cycleId}
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
        const rows = await transaction<Array<{ checksum_sha256: string }>>`
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
        const cycleRows = await transaction<Array<{ prefix: string }>>`
          UPDATE focowiki.storage_reconciliation_cycles
          SET verification_cursor = ${input.object.objectKey},
              missing_count = missing_count + ${rows.length > 0 && !input.exists ? 1 : 0},
              updated_at = ${input.checkedAt}
          WHERE prefix = ${input.cycle.prefix}
            AND cycle_id = ${input.cycle.cycleId}
            AND lease_token = ${input.leaseToken}
            AND state = 'verifying'
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
        RETURNING prefix
      `;
      return rows.length === 1;
    },

    async failCycle(input) {
      await sql`
        UPDATE focowiki.storage_reconciliation_cycles
        SET state = 'failed', lease_token = NULL, lease_expires_at = NULL,
            next_scan_at = ${input.retryAt}, last_error_code = ${input.errorCode},
            retry_count = retry_count + 1, updated_at = ${input.failedAt}
        WHERE prefix = ${input.cycle.prefix}
          AND cycle_id = ${input.cycle.cycleId}
          AND lease_token = ${input.leaseToken}
      `;
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
    verificationCursor: row.verification_cursor
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
    lastErrorCode: row.last_error_code
  };
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Storage reconciliation limit must be between 1 and 1000");
  }
  return value;
}
