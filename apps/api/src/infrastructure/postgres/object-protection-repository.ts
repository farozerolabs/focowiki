import type {
  ObjectProtectionIdentity,
  ObjectProtectionMaintenanceClaim,
  ObjectProtectionMaintenanceStatus,
  ObjectProtectionRepository
} from "../../application/ports/object-protection-repository.js";
import type {
  ObjectProtectionClass,
  ObjectProtectionReadiness,
  ObjectProtectionRecord
} from "../../domain/storage-object-protection.js";
import type { DatabaseClient } from "../../db/client.js";
import type { TransactionSql } from "postgres";

const PROTECTION_SCHEMA_VERSION = 1;
type QueryClient = DatabaseClient | TransactionSql;

type BackfillRow = {
  schema_version: number;
  state: ObjectProtectionReadiness;
  phase: ObjectProtectionMaintenanceStatus["phase"];
  cursor_object_key: string | null;
  processed_count: number;
  expected_count: number;
  verified_count: number;
  retry_count: number;
  revision: number;
  lease_token: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  last_progress_at: Date | null;
  next_attempt_at: Date;
  recent_objects_per_second: number | null;
  rolling_batch_latency_ms: number | null;
  estimated_completion_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
};

type ProtectionRow = {
  object_key: string;
  checksum_sha256: string;
  format_version: number;
  protected: boolean;
  dirty: boolean;
  revision: number;
  protection_classes: ObjectProtectionClass[];
  refreshed_at: Date | null;
};

type BackfillIdentityRow = {
  object_key: string;
  checksum_sha256: string;
  format_version: number;
  protection_class: ObjectProtectionClass;
};

type DirtyIdentityRow = ObjectProtectionIdentity & {
  revision: number;
};

export function createPostgresObjectProtectionRepository(
  sql: DatabaseClient
): ObjectProtectionRepository {
  return {
    async protectIdentities(input) {
      if (input.identities.length === 0) return;
      await sql`
        SELECT focowiki.protect_storage_object_identity(
          identity.object_key,
          identity.checksum_sha256,
          identity.format_version,
          identity.protection_class
        )
        FROM unnest(
          ${input.identities.map((identity) => identity.objectKey)}::text[],
          ${input.identities.map((identity) => identity.checksumSha256)}::text[],
          ${input.identities.map((identity) => identity.formatVersion)}::int[],
          ${input.identities.map((identity) => identity.protectionClass)}::text[]
        ) AS identity(
          object_key, checksum_sha256, format_version, protection_class
        )
      `;
    },

    async markIdentitiesDirty(input) {
      if (input.identities.length === 0) return;
      await sql`
        SELECT focowiki.mark_storage_object_identity_dirty(
          identity.object_key,
          identity.checksum_sha256,
          identity.format_version,
          identity.reason
        )
        FROM unnest(
          ${input.identities.map((identity) => identity.objectKey)}::text[],
          ${input.identities.map((identity) => identity.checksumSha256)}::text[],
          ${input.identities.map((identity) => identity.formatVersion)}::int[],
          ${input.identities.map((identity) => identity.reason)}::text[]
        ) AS identity(
          object_key, checksum_sha256, format_version, reason
        )
      `;
    },

    async lookupIdentities(identities) {
      if (identities.length === 0) return [];
      const rows = await sql<ProtectionRow[]>`
        SELECT
          protection.object_key,
          protection.checksum_sha256,
          protection.format_version,
          protection.protected,
          protection.dirty,
          protection.revision,
          protection.protection_classes,
          protection.refreshed_at
        FROM unnest(
          ${identities.map((identity) => identity.objectKey)}::text[],
          ${identities.map((identity) => identity.checksumSha256)}::text[],
          ${identities.map((identity) => identity.formatVersion)}::int[]
        ) AS identity(object_key, checksum_sha256, format_version)
        CROSS JOIN LATERAL (
          SELECT indexed.*
          FROM focowiki.storage_object_protection_index indexed
          WHERE indexed.object_key = identity.object_key
            AND indexed.checksum_sha256 = identity.checksum_sha256
            AND indexed.format_version = identity.format_version
          LIMIT 1
        ) protection
      `;
      return rows.map(mapProtectionRecord);
    },

    async getReadiness() {
      const rows = await sql<Array<{ state: ObjectProtectionReadiness }>>`
        SELECT state
        FROM focowiki.storage_object_protection_backfills
        WHERE schema_version = ${PROTECTION_SCHEMA_VERSION}
      `;
      return rows[0]?.state ?? "pending";
    },

    async claimMaintenance(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<BackfillRow[]>`
          SELECT *
          FROM focowiki.storage_object_protection_backfills
          WHERE schema_version = ${PROTECTION_SCHEMA_VERSION}
          FOR UPDATE
        `;
        const current = rows[0];
        if (!current) return null;

        const dirtyRows = await transaction<Array<{ exists: boolean }>>`
          SELECT EXISTS (
            SELECT 1
            FROM focowiki.storage_object_protection_dirty
            LIMIT 1
          ) AS exists
        `;
        const hasDirtyIdentities = dirtyRows[0]?.exists === true;
        if (current.state === "ready" && !hasDirtyIdentities) return null;
        if (
          current.lease_expires_at
          && current.lease_expires_at.toISOString() > input.now
          && current.lease_token !== input.leaseToken
        ) {
          return null;
        }
        if (current.next_attempt_at.toISOString() > input.now) return null;

        const restartingDirtyRefresh =
          current.state === "ready" && hasDirtyIdentities;
        let expectedCount = Number(current.expected_count);
        if (current.state === "pending") {
          const expectedRows = await transaction<Array<{ count: number }>>`
            SELECT (
              (
                SELECT count(*)
                FROM (
                  SELECT DISTINCT object_key, checksum_sha256, format_version
                  FROM focowiki.immutable_objects
                ) identity
              )
              + (
                SELECT count(*)
                FROM (
                  SELECT DISTINCT object_key, checksum_sha256
                  FROM focowiki.source_files
                  WHERE deleted_at IS NULL
                ) identity
              )
              + (
                SELECT count(*)
                FROM (
                  SELECT DISTINCT object_key, checksum_sha256, format_version
                  FROM focowiki.projection_segments
                  WHERE ownership_count > 0
                     OR lifecycle_state = ANY (
                       ARRAY['writing', 'active', 'retained']
                     )
                ) identity
              )
            )::bigint AS count
          `;
          expectedCount = Number(expectedRows[0]?.count ?? 0);
        }

        const phase = restartingDirtyRefresh ? "dirty_refresh" : current.phase;
        const state = phase.startsWith("verify_") ? "verifying" : "backfilling";
        const updated = await transaction<BackfillRow[]>`
          UPDATE focowiki.storage_object_protection_backfills
          SET state = ${state},
              phase = ${phase},
              cursor_object_key = ${restartingDirtyRefresh ? null : current.cursor_object_key},
              expected_count = ${expectedCount},
              revision = revision + 1,
              lease_token = ${input.leaseToken},
              lease_expires_at = ${input.leaseExpiresAt},
              heartbeat_at = ${input.now},
              last_error_code = NULL,
              last_error_message = NULL,
              updated_at = ${input.now}
          WHERE schema_version = ${PROTECTION_SCHEMA_VERSION}
          RETURNING *
        `;
        return mapClaim(updated[0]!);
      });
    },

    async renewMaintenanceLease(input) {
      const rows = await sql<Array<{ schema_version: number }>>`
        UPDATE focowiki.storage_object_protection_backfills
        SET lease_expires_at = ${input.leaseExpiresAt},
            heartbeat_at = ${input.now},
            updated_at = ${input.now}
        WHERE schema_version = ${input.claim.schemaVersion}
          AND lease_token = ${input.leaseToken}
          AND state IN ('backfilling', 'verifying')
          AND lease_expires_at > ${input.now}
        RETURNING schema_version
      `;
      return rows.length === 1;
    },

    async runBackfillBatch(input) {
      const limit = boundedLimit(input.limit);
      const startedAt = Date.now();
      return sql.begin(async (transaction) => {
        await assertOwnedBackfill(transaction, input.claim, input.leaseToken, input.now);
        const identities = await listBackfillIdentities(
          transaction,
          input.claim.phase,
          input.claim.cursorObjectKey,
          limit
        );
        if (isVerificationPhase(input.claim.phase)) {
          await verifyBackfillIdentities(
            transaction,
            identities,
            input.claim.phase
          );
        } else {
          await upsertBackfillIdentities(transaction, identities);
        }

        const phaseComplete = identities.length < limit;
        const nextPhase = phaseComplete
          ? nextBackfillPhase(input.claim.phase)
          : input.claim.phase;
        const completed = nextPhase === "ready";
        const elapsedMs = Math.max(1, Date.now() - startedAt);
        const rows = await transaction<BackfillRow[]>`
          UPDATE focowiki.storage_object_protection_backfills
          SET state = ${completed
            ? "ready"
            : nextPhase.startsWith("verify_") ? "verifying" : "backfilling"},
              phase = ${nextPhase},
              cursor_object_key = ${phaseComplete
                ? null
                : identities.at(-1)?.object_key ?? input.claim.cursorObjectKey},
              processed_count = processed_count
                + ${isVerificationPhase(input.claim.phase) ? 0 : identities.length},
              verified_count = verified_count
                + ${isVerificationPhase(input.claim.phase) ? identities.length : 0},
              expected_count = CASE
                WHEN ${completed}
                  THEN GREATEST(
                    processed_count
                      + ${isVerificationPhase(input.claim.phase) ? 0 : identities.length},
                    verified_count
                      + ${isVerificationPhase(input.claim.phase) ? identities.length : 0}
                  )
                ELSE GREATEST(
                  expected_count,
                  processed_count
                    + ${isVerificationPhase(input.claim.phase) ? 0 : identities.length},
                  verified_count
                    + ${isVerificationPhase(input.claim.phase) ? identities.length : 0}
                )
              END,
              recent_objects_per_second = ${identities.length * 1_000 / elapsedMs},
              rolling_batch_latency_ms = ${elapsedMs},
              last_progress_at = ${input.now},
              heartbeat_at = ${input.now},
              completed_at = ${completed ? input.now : null},
              revision = revision + 1,
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = ${input.now}
          WHERE schema_version = ${input.claim.schemaVersion}
            AND lease_token = ${input.leaseToken}
            AND revision = ${input.claim.revision}
            AND lease_expires_at > ${input.now}
          RETURNING *
        `;
        if (rows.length !== 1) throw ownershipError();
        return {
          processed: identities.length,
          completed,
          phase: nextPhase
        };
      });
    },

    async refreshDirtyBatch(input) {
      const limit = boundedLimit(input.limit);
      const startedAt = Date.now();
      return sql.begin(async (transaction) => {
        await assertOwnedBackfill(transaction, input.claim, input.leaseToken, input.now);
        const dirtyRows = await transaction<Array<{
          object_key: string;
          checksum_sha256: string;
          format_version: number;
          revision: number;
        }>>`
          SELECT object_key, checksum_sha256, format_version, revision
          FROM focowiki.storage_object_protection_dirty
          WHERE state IN ('pending', 'retry')
            AND next_attempt_at <= ${input.now}
            AND (
              lease_expires_at IS NULL
              OR lease_expires_at <= ${input.now}
              OR lease_token = ${input.leaseToken}
            )
          ORDER BY object_key, checksum_sha256, format_version
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        `;
        const identities: DirtyIdentityRow[] = dirtyRows.map((row) => ({
          objectKey: row.object_key,
          checksumSha256: row.checksum_sha256,
          formatVersion: Number(row.format_version),
          revision: Number(row.revision)
        }));
        if (identities.length > 0) {
          await refreshDirtyIdentities(transaction, identities, input.now);
        }
        const remainingRows = await transaction<Array<{ exists: boolean }>>`
          SELECT EXISTS (
            SELECT 1
            FROM focowiki.storage_object_protection_dirty
            LIMIT 1
          ) AS exists
        `;
        const completed = remainingRows[0]?.exists !== true;
        const elapsedMs = Math.max(1, Date.now() - startedAt);
        const rows = await transaction<BackfillRow[]>`
          UPDATE focowiki.storage_object_protection_backfills
          SET state = ${completed ? "ready" : "backfilling"},
              phase = ${completed ? "ready" : "dirty_refresh"},
              recent_objects_per_second = ${identities.length * 1_000 / elapsedMs},
              rolling_batch_latency_ms = ${elapsedMs},
              last_progress_at = ${input.now},
              heartbeat_at = ${input.now},
              completed_at = ${completed ? input.now : null},
              revision = revision + 1,
              lease_token = NULL,
              lease_expires_at = NULL,
              updated_at = ${input.now}
          WHERE schema_version = ${input.claim.schemaVersion}
            AND lease_token = ${input.leaseToken}
            AND revision = ${input.claim.revision}
            AND lease_expires_at > ${input.now}
          RETURNING *
        `;
        if (rows.length !== 1) throw ownershipError();
        return {
          processed: identities.length,
          completed,
          phase: completed ? "ready" : "dirty_refresh"
        };
      });
    },

    async failMaintenance(input) {
      await sql`
        UPDATE focowiki.storage_object_protection_backfills
        SET state = 'retrying',
            retry_count = retry_count + 1,
            next_attempt_at = ${input.retryAt},
            lease_token = NULL,
            lease_expires_at = NULL,
            heartbeat_at = ${input.failedAt},
            last_error_code = ${input.errorCode},
            last_error_message = ${input.errorMessage},
            revision = revision + 1,
            updated_at = ${input.failedAt}
        WHERE schema_version = ${input.claim.schemaVersion}
          AND lease_token = ${input.leaseToken}
          AND revision = ${input.claim.revision}
      `;
    },

    async getStatus() {
      const rows = await sql<BackfillRow[]>`
        SELECT *
        FROM focowiki.storage_object_protection_backfills
        WHERE schema_version = ${PROTECTION_SCHEMA_VERSION}
      `;
      const dirtyRows = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM focowiki.storage_object_protection_dirty
      `;
      return mapStatus(rows[0], Number(dirtyRows[0]?.count ?? 0));
    }
  };
}

async function listBackfillIdentities(
  sql: QueryClient,
  phase: ObjectProtectionMaintenanceClaim["phase"],
  cursor: string | null,
  limit: number
): Promise<BackfillIdentityRow[]> {
  if (phase === "immutable_objects" || phase === "verify_immutable_objects") {
    return sql<BackfillIdentityRow[]>`
      SELECT
        object_key,
        checksum_sha256,
        format_version,
        CASE
          WHEN lifecycle_state = 'writing' THEN 'write_reservation'
          ELSE 'registered'
        END::text AS protection_class
      FROM focowiki.immutable_objects
      WHERE (${cursor}::text IS NULL OR object_key > ${cursor})
      ORDER BY object_key
      LIMIT ${limit}
    `;
  }
  if (phase === "source_files" || phase === "verify_source_files") {
    return sql<BackfillIdentityRow[]>`
      SELECT
        object_key,
        checksum_sha256,
        1 AS format_version,
        'source'::text AS protection_class
      FROM focowiki.source_files
      WHERE deleted_at IS NULL
        AND (${cursor}::text IS NULL OR object_key > ${cursor})
      ORDER BY object_key
      LIMIT ${limit}
    `;
  }
  if (phase === "projection_segments" || phase === "verify_projection_segments") {
    return sql<BackfillIdentityRow[]>`
      SELECT
        object_key,
        checksum_sha256,
        format_version,
        'projection_segment'::text AS protection_class
      FROM focowiki.projection_segments
      WHERE (
          ownership_count > 0
          OR lifecycle_state = ANY (ARRAY['writing', 'active', 'retained'])
        )
        AND (${cursor}::text IS NULL OR object_key > ${cursor})
      GROUP BY object_key, checksum_sha256, format_version
      ORDER BY object_key, checksum_sha256, format_version
      LIMIT ${limit}
    `;
  }
  throw new Error("Object protection backfill phase is invalid");
}

async function upsertBackfillIdentities(
  sql: QueryClient,
  identities: BackfillIdentityRow[]
): Promise<void> {
  if (identities.length === 0) return;
  await sql`
    INSERT INTO focowiki.storage_object_protection_index (
      object_key, checksum_sha256, format_version, protected, dirty,
      revision, protection_classes, refreshed_at, updated_at
    )
    SELECT
      identity.object_key,
      identity.checksum_sha256,
      identity.format_version,
      true,
      false,
      1,
      ARRAY[identity.protection_class],
      now(),
      now()
    FROM unnest(
      ${identities.map((identity) => identity.object_key)}::text[],
      ${identities.map((identity) => identity.checksum_sha256)}::text[],
      ${identities.map((identity) => identity.format_version)}::int[],
      ${identities.map((identity) => identity.protection_class)}::text[]
    ) AS identity(
      object_key, checksum_sha256, format_version, protection_class
    )
    ON CONFLICT (object_key, checksum_sha256, format_version) DO UPDATE
    SET protected = true,
        dirty = false,
        revision = focowiki.storage_object_protection_index.revision + 1,
        protection_classes = ARRAY(
          SELECT DISTINCT value
          FROM unnest(
            CASE EXCLUDED.protection_classes[1]
              WHEN 'registered' THEN array_remove(
                focowiki.storage_object_protection_index.protection_classes,
                'write_reservation'
              )
              WHEN 'write_reservation' THEN array_remove(
                focowiki.storage_object_protection_index.protection_classes,
                'registered'
              )
              ELSE focowiki.storage_object_protection_index.protection_classes
            END
            || EXCLUDED.protection_classes
          ) AS value
          ORDER BY value
        ),
        refreshed_at = now(),
        updated_at = now()
  `;
}

async function verifyBackfillIdentities(
  sql: QueryClient,
  identities: BackfillIdentityRow[],
  phase: ObjectProtectionMaintenanceClaim["phase"]
): Promise<void> {
  if (identities.length === 0) return;
  const missing = await sql<Array<{ object_key: string }>>`
    SELECT identity.object_key
    FROM unnest(
      ${identities.map((identity) => identity.object_key)}::text[],
      ${identities.map((identity) => identity.checksum_sha256)}::text[],
      ${identities.map((identity) => identity.format_version)}::int[]
    ) AS identity(object_key, checksum_sha256, format_version)
    LEFT JOIN focowiki.storage_object_protection_index protection
      ON protection.object_key = identity.object_key
     AND protection.checksum_sha256 = identity.checksum_sha256
     AND protection.format_version = identity.format_version
    WHERE protection.object_key IS NULL
       OR NOT (protection.protected OR protection.dirty)
    LIMIT 1
  `;
  if (missing.length > 0) {
    const error = new Error(`Object protection verification failed in ${phase}`);
    Object.assign(error, { code: "OBJECT_PROTECTION_VERIFICATION_FAILED" });
    throw error;
  }
}

async function refreshDirtyIdentities(
  sql: QueryClient,
  identities: DirtyIdentityRow[],
  now: string
): Promise<void> {
  await sql`
    WITH claimed AS (
      SELECT *
      FROM unnest(
        ${identities.map((identity) => identity.objectKey)}::text[],
        ${identities.map((identity) => identity.checksumSha256)}::text[],
        ${identities.map((identity) => identity.formatVersion)}::int[],
        ${identities.map((identity) => identity.revision)}::bigint[]
      ) AS identity(object_key, checksum_sha256, format_version, revision)
    ),
    calculated AS (
      SELECT
        claimed.*,
        EXISTS (
          SELECT 1
          FROM focowiki.source_files source
          WHERE source.object_key = claimed.object_key
            AND source.checksum_sha256 = claimed.checksum_sha256
            AND claimed.format_version = 1
            AND source.deleted_at IS NULL
        ) AS source_protected,
        EXISTS (
          SELECT 1
          FROM focowiki.immutable_objects object
          WHERE object.object_key = claimed.object_key
            AND object.checksum_sha256 = claimed.checksum_sha256
            AND object.format_version = claimed.format_version
        ) AS registered_protected,
        EXISTS (
          SELECT 1
          FROM focowiki.projection_segments segment
          WHERE segment.object_key = claimed.object_key
            AND segment.checksum_sha256 = claimed.checksum_sha256
            AND segment.format_version = claimed.format_version
            AND (
              segment.ownership_count > 0
              OR segment.lifecycle_state = ANY (
                ARRAY['writing', 'active', 'retained']
              )
            )
        ) AS segment_protected
      FROM claimed
    )
    UPDATE focowiki.storage_object_protection_index protection
    SET protected = (
          calculated.source_protected
          OR calculated.registered_protected
          OR calculated.segment_protected
        ),
        dirty = false,
        revision = protection.revision + 1,
        protection_classes = array_remove(ARRAY[
          CASE WHEN calculated.source_protected THEN 'source' END,
          CASE WHEN calculated.registered_protected THEN 'registered' END,
          CASE WHEN calculated.segment_protected THEN 'projection_segment' END
        ]::text[], NULL),
        refreshed_at = ${now},
        updated_at = ${now}
    FROM calculated
    JOIN focowiki.storage_object_protection_dirty dirty
      ON dirty.object_key = calculated.object_key
     AND dirty.checksum_sha256 = calculated.checksum_sha256
     AND dirty.format_version = calculated.format_version
     AND dirty.revision = calculated.revision
    WHERE protection.object_key = calculated.object_key
      AND protection.checksum_sha256 = calculated.checksum_sha256
      AND protection.format_version = calculated.format_version
  `;
  await sql`
    DELETE FROM focowiki.storage_object_protection_dirty dirty
    USING unnest(
      ${identities.map((identity) => identity.objectKey)}::text[],
      ${identities.map((identity) => identity.checksumSha256)}::text[],
      ${identities.map((identity) => identity.formatVersion)}::int[],
      ${identities.map((identity) => identity.revision)}::bigint[]
    ) AS identity(object_key, checksum_sha256, format_version, revision)
    WHERE dirty.object_key = identity.object_key
      AND dirty.checksum_sha256 = identity.checksum_sha256
      AND dirty.format_version = identity.format_version
      AND dirty.revision = identity.revision
  `;
}

async function assertOwnedBackfill(
  sql: QueryClient,
  claim: ObjectProtectionMaintenanceClaim,
  leaseToken: string,
  now: string
): Promise<void> {
  const rows = await sql<Array<{ schema_version: number }>>`
    SELECT schema_version
    FROM focowiki.storage_object_protection_backfills
    WHERE schema_version = ${claim.schemaVersion}
      AND lease_token = ${leaseToken}
      AND revision = ${claim.revision}
      AND lease_expires_at > ${now}
      AND state IN ('backfilling', 'verifying')
    FOR UPDATE
  `;
  if (rows.length !== 1) throw ownershipError();
}

function isVerificationPhase(
  phase: ObjectProtectionMaintenanceClaim["phase"]
): boolean {
  return phase.startsWith("verify_");
}

function nextBackfillPhase(
  phase: ObjectProtectionMaintenanceClaim["phase"]
): ObjectProtectionMaintenanceStatus["phase"] {
  switch (phase) {
    case "immutable_objects":
      return "source_files";
    case "source_files":
      return "projection_segments";
    case "projection_segments":
      return "verify_immutable_objects";
    case "verify_immutable_objects":
      return "verify_source_files";
    case "verify_source_files":
      return "verify_projection_segments";
    case "verify_projection_segments":
      return "dirty_refresh";
    case "dirty_refresh":
      return "ready";
  }
}

function mapClaim(row: BackfillRow): ObjectProtectionMaintenanceClaim {
  if (row.phase === "ready") {
    throw new Error("Ready object protection maintenance cannot be claimed");
  }
  return {
    schemaVersion: Number(row.schema_version),
    revision: Number(row.revision),
    state: row.state === "ready" ? "backfilling" : row.state,
    phase: row.phase,
    cursorObjectKey: row.cursor_object_key
  };
}

function mapStatus(
  row: BackfillRow | undefined,
  dirtyCount: number
): ObjectProtectionMaintenanceStatus {
  if (!row) {
    return {
      readiness: "pending",
      phase: "immutable_objects",
      processedCount: 0,
      expectedCount: 0,
      verifiedCount: 0,
      dirtyCount,
      retryCount: 0,
      recentObjectsPerSecond: null,
      rollingBatchLatencyMs: null,
      lastProgressAt: null,
      heartbeatAt: null,
      estimatedCompletionAt: null,
      lastErrorCode: null,
      lastErrorMessage: null
    };
  }
  return {
    readiness: row.state,
    phase: row.phase,
    processedCount: Number(row.processed_count),
    expectedCount: Number(row.expected_count),
    verifiedCount: Number(row.verified_count),
    dirtyCount,
    retryCount: Number(row.retry_count),
    recentObjectsPerSecond: row.recent_objects_per_second === null
      ? null
      : Number(row.recent_objects_per_second),
    rollingBatchLatencyMs: row.rolling_batch_latency_ms === null
      ? null
      : Number(row.rolling_batch_latency_ms),
    lastProgressAt: row.last_progress_at?.toISOString() ?? null,
    heartbeatAt: row.heartbeat_at?.toISOString() ?? null,
    estimatedCompletionAt: row.estimated_completion_at?.toISOString() ?? null,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message
  };
}

function mapProtectionRecord(row: ProtectionRow): ObjectProtectionRecord {
  return {
    objectKey: row.object_key,
    checksumSha256: row.checksum_sha256,
    formatVersion: Number(row.format_version),
    protected: row.protected,
    dirty: row.dirty,
    revision: Number(row.revision),
    classes: row.protection_classes,
    refreshedAt: row.refreshed_at?.toISOString() ?? null
  };
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Object protection maintenance limit must be between 1 and 1000");
  }
  return value;
}

function ownershipError(): Error {
  const error = new Error("Object protection maintenance ownership expired");
  Object.assign(error, { code: "OBJECT_PROTECTION_OWNERSHIP_EXPIRED" });
  return error;
}
