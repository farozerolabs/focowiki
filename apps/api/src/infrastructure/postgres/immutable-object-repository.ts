import type {
  ActiveImmutableObjectRecord,
  ImmutableObjectRecord,
  ImmutableObjectRecoveryRepository,
  ImmutableObjectRepository
} from "../../application/ports/immutable-object-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import { lockImmutableObjectKey } from "./immutable-object-lock.js";

type ImmutableObjectRow = {
  checksum_sha256: string;
  format_version: number;
  object_key: string;
  content_type: string;
  size_bytes: number;
  lifecycle_state: "writing" | "active" | "deleting";
  write_token: string | null;
  write_started_at: Date | null;
  write_attempt_count: number;
  created_at: Date;
  verified_at: Date | null;
};

export function createPostgresImmutableObjectRepository(
  sql: DatabaseClient
): ImmutableObjectRepository & ImmutableObjectRecoveryRepository {
  async function findActive(input: {
    checksumSha256: string;
    formatVersion: number;
  }): Promise<ActiveImmutableObjectRecord | null> {
    const rows = await sql<ImmutableObjectRow[]>`
      SELECT checksum_sha256, format_version, object_key, content_type,
             size_bytes, lifecycle_state, write_token, write_started_at,
             write_attempt_count, created_at, verified_at
      FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${input.checksumSha256}
        AND format_version = ${input.formatVersion}
        AND lifecycle_state = 'active'
    `;
    return rows[0] ? mapActiveRow(rows[0]) : null;
  }

  return {
    find: findActive,

    async findAny(input) {
      const rows = await sql<ImmutableObjectRow[]>`
        SELECT checksum_sha256, format_version, object_key, content_type,
               size_bytes, lifecycle_state, write_token, write_started_at,
               write_attempt_count, created_at, verified_at
        FROM focowiki.immutable_objects
        WHERE checksum_sha256 = ${input.checksumSha256}
          AND format_version = ${input.formatVersion}
      `;
      return rows[0] ? mapRow(rows[0]) : null;
    },

    async reserve(input) {
      return sql.begin(async (transaction) => {
        await lockImmutableObjectKey(transaction, input.objectKey);
        const deletionCandidates = await transaction<Array<{ state: string }>>`
          SELECT state
          FROM focowiki.storage_reconciliation_candidates
          WHERE object_key = ${input.objectKey}
            AND state <> 'deleted'
          FOR UPDATE
        `;
        if (deletionCandidates.some((candidate) => candidate.state === "deleting")) {
          throw new Error("Immutable object is pending storage reconciliation deletion");
        }
        const existingRows = await transaction<ImmutableObjectRow[]>`
          SELECT checksum_sha256, format_version, object_key, content_type,
                 size_bytes, lifecycle_state, write_token, write_started_at,
                 write_attempt_count, created_at, verified_at
          FROM focowiki.immutable_objects
          WHERE checksum_sha256 = ${input.checksumSha256}
            AND format_version = ${input.formatVersion}
          FOR UPDATE
        `;
        const existing = existingRows[0];
        if (!existing) {
          const inserted = await transaction<ImmutableObjectRow[]>`
            INSERT INTO focowiki.immutable_objects (
              checksum_sha256, format_version, object_key, content_type, size_bytes,
              lifecycle_state, write_token, write_started_at, write_attempt_count, verified_at
            ) VALUES (
              ${input.checksumSha256}, ${input.formatVersion}, ${input.objectKey},
              ${input.contentType}, ${input.sizeBytes}, 'writing', ${input.writeToken},
              ${input.writeStartedAt}, 1, NULL
            )
            RETURNING checksum_sha256, format_version, object_key, content_type,
                      size_bytes, lifecycle_state, write_token, write_started_at,
                      write_attempt_count, created_at, verified_at
          `;
          return { status: "reserved" as const, record: mapRow(inserted[0]!) };
        }

        assertMetadata(existing, input);
        if (existing.lifecycle_state === "active") {
          return { status: "active" as const, record: mapRow(existing) };
        }
        if (existing.lifecycle_state === "deleting") {
          throw new Error("Immutable object is pending deletion");
        }
        if (
          existing.write_token !== input.writeToken
          && existing.write_started_at
          && existing.write_started_at.toISOString() > input.staleBefore
        ) {
          return { status: "pending" as const, record: mapRow(existing) };
        }

        const reserved = await transaction<ImmutableObjectRow[]>`
          UPDATE focowiki.immutable_objects
          SET write_token = ${input.writeToken}, write_started_at = ${input.writeStartedAt},
              write_attempt_count = write_attempt_count + 1, last_write_error_code = NULL
          WHERE checksum_sha256 = ${input.checksumSha256}
            AND format_version = ${input.formatVersion}
            AND lifecycle_state = 'writing'
          RETURNING checksum_sha256, format_version, object_key, content_type,
                    size_bytes, lifecycle_state, write_token, write_started_at,
                    write_attempt_count, created_at, verified_at
        `;
        return { status: "reserved" as const, record: mapRow(reserved[0]!) };
      });
    },

    async activate(input) {
      const rows = await sql<ImmutableObjectRow[]>`
        UPDATE focowiki.immutable_objects
        SET lifecycle_state = 'active', verified_at = ${input.verifiedAt},
            write_token = NULL, write_started_at = NULL, last_write_error_code = NULL
        WHERE checksum_sha256 = ${input.checksumSha256}
          AND format_version = ${input.formatVersion}
          AND lifecycle_state = 'writing'
          AND write_token = ${input.writeToken}
          AND object_key = ${input.objectKey}
          AND content_type = ${input.contentType}
          AND size_bytes = ${input.sizeBytes}
        RETURNING checksum_sha256, format_version, object_key, content_type,
                  size_bytes, lifecycle_state, write_token, write_started_at,
                  write_attempt_count, created_at, verified_at
      `;
      if (rows[0]) return mapActiveRow(rows[0]);
      const active = await findActive(input);
      if (active) {
        assertActiveMetadata(active, input);
        return active;
      }
      throw new Error("Immutable object reservation is unavailable for activation");
    },

    async markWriteFailure(input) {
      await sql`
        UPDATE focowiki.immutable_objects
        SET last_write_error_code = ${input.errorCode}
        WHERE checksum_sha256 = ${input.checksumSha256}
          AND format_version = ${input.formatVersion}
          AND lifecycle_state = 'writing'
          AND write_token = ${input.writeToken}
      `;
    },

    async claimStaleWriting(input) {
      const rows = await sql<ImmutableObjectRow[]>`
        WITH stale AS (
          SELECT checksum_sha256, format_version
          FROM focowiki.immutable_objects object
          WHERE lifecycle_state = 'writing'
            AND write_started_at <= ${input.staleBefore}
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.generation_object_refs reference
              WHERE reference.checksum_sha256 = object.checksum_sha256
                AND reference.format_version = object.format_version
            )
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.active_object_refs reference
              WHERE reference.checksum_sha256 = object.checksum_sha256
                AND reference.format_version = object.format_version
            )
          ORDER BY write_started_at, checksum_sha256, format_version
          LIMIT ${boundedRecoveryLimit(input.limit)}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE focowiki.immutable_objects object
        SET write_token = ${input.recoveryToken},
            write_started_at = ${input.claimedAt},
            write_attempt_count = write_attempt_count + 1,
            last_write_error_code = NULL
        FROM stale
        WHERE object.checksum_sha256 = stale.checksum_sha256
          AND object.format_version = stale.format_version
          AND object.lifecycle_state = 'writing'
        RETURNING object.checksum_sha256, object.format_version, object.object_key,
                  object.content_type, object.size_bytes, object.lifecycle_state,
                  object.write_token, object.write_started_at,
                  object.write_attempt_count, object.created_at, object.verified_at
      `;
      return rows.map((row) => ({
        checksumSha256: row.checksum_sha256,
        formatVersion: Number(row.format_version),
        objectKey: row.object_key,
        contentType: row.content_type,
        sizeBytes: Number(row.size_bytes)
      }));
    },

    async activateRecovered(input) {
      const rows = await sql<Array<{ checksum_sha256: string }>>`
        UPDATE focowiki.immutable_objects
        SET lifecycle_state = 'active', verified_at = ${input.verifiedAt},
            write_token = NULL, write_started_at = NULL, last_write_error_code = NULL
        WHERE checksum_sha256 = ${input.checksumSha256}
          AND format_version = ${input.formatVersion}
          AND object_key = ${input.objectKey}
          AND content_type = ${input.contentType}
          AND size_bytes = ${input.sizeBytes}
          AND lifecycle_state = 'writing'
          AND write_token = ${input.recoveryToken}
        RETURNING checksum_sha256
      `;
      return rows.length === 1;
    },

    async expireMissing(input) {
      const rows = await sql<Array<{ checksum_sha256: string }>>`
        DELETE FROM focowiki.immutable_objects object
        WHERE checksum_sha256 = ${input.checksumSha256}
          AND format_version = ${input.formatVersion}
          AND lifecycle_state = 'writing'
          AND write_token = ${input.recoveryToken}
          AND NOT EXISTS (
            SELECT 1 FROM focowiki.generation_object_refs reference
            WHERE reference.checksum_sha256 = object.checksum_sha256
              AND reference.format_version = object.format_version
          )
          AND NOT EXISTS (
            SELECT 1 FROM focowiki.active_object_refs reference
            WHERE reference.checksum_sha256 = object.checksum_sha256
              AND reference.format_version = object.format_version
          )
        RETURNING checksum_sha256
      `;
      return rows.length === 1;
    },

    async markRecoveryFailure(input) {
      await sql`
        UPDATE focowiki.immutable_objects
        SET write_token = NULL, write_started_at = ${input.failedAt},
            last_write_error_code = ${input.errorCode}
        WHERE checksum_sha256 = ${input.checksumSha256}
          AND format_version = ${input.formatVersion}
          AND lifecycle_state = 'writing'
          AND write_token = ${input.recoveryToken}
      `;
    }
  };
}

function boundedRecoveryLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Immutable object recovery limit must be between 1 and 1000");
  }
  return value;
}

function mapRow(row: ImmutableObjectRow): ImmutableObjectRecord {
  return {
    checksumSha256: row.checksum_sha256,
    formatVersion: row.format_version,
    objectKey: row.object_key,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    lifecycleState: row.lifecycle_state,
    writeToken: row.write_token,
    writeStartedAt: row.write_started_at?.toISOString() ?? null,
    writeAttemptCount: Number(row.write_attempt_count),
    createdAt: row.created_at.toISOString(),
    verifiedAt: row.verified_at?.toISOString() ?? null
  };
}

function mapActiveRow(row: ImmutableObjectRow): ActiveImmutableObjectRecord {
  const record = mapRow(row);
  if (record.lifecycleState !== "active" || !record.verifiedAt) {
    throw new Error("Immutable object catalog returned a non-active object");
  }
  return { ...record, lifecycleState: "active", verifiedAt: record.verifiedAt };
}

function assertMetadata(
  row: ImmutableObjectRow,
  expected: { objectKey: string; contentType: string; sizeBytes: number }
): void {
  if (
    row.object_key !== expected.objectKey
    || row.content_type !== expected.contentType
    || Number(row.size_bytes) !== expected.sizeBytes
  ) {
    throw new Error("Immutable object identity conflicts with registered metadata");
  }
}

function assertActiveMetadata(
  row: ActiveImmutableObjectRecord,
  expected: { objectKey: string; contentType: string; sizeBytes: number }
): void {
  if (
    row.objectKey !== expected.objectKey
    || row.contentType !== expected.contentType
    || row.sizeBytes !== expected.sizeBytes
  ) {
    throw new Error("Immutable object identity conflicts with registered metadata");
  }
}
