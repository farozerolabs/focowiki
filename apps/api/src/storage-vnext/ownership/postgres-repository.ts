import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type {
  StorageVnextObjectOwner,
  StorageVnextObjectRegistration,
  StorageVnextObjectReservation,
  StorageVnextObjectReservationResult,
  StorageVnextOwnershipRepository
} from "./ports.js";
import {
  MAX_STORAGE_VNEXT_OWNERSHIP_PAGE_SIZE,
  StorageVnextOwnershipRepositoryError,
  assertStorageVnextOwner,
  assertStorageVnextOwnerKind,
  assertStorageVnextOwnershipPageLimit,
  assertStorageVnextOwnershipTimestamp,
  assertStorageVnextPublicId,
  assertStorageVnextReservation,
  assertStorageVnextVerification,
  assertStorageVnextZeroOwnerGrace,
  decodeStorageVnextRegistrationCursor,
  decodeStorageVnextStaleReservationCursor,
  decodeStorageVnextZeroOwnerCursor,
  encodeStorageVnextOwnershipCursor,
  isStorageVnextStorageKey,
  mapStorageVnextOwner,
  mapStorageVnextOwnershipDatabaseError,
  mapStorageVnextRegistration,
  sameStorageVnextRegistrationMetadata,
  storageVnextOwnerTarget,
  type StorageVnextOwnerRow,
  type StorageVnextRegistrationRow
} from "./postgres-contract.js";

export {
  StorageVnextOwnershipRepositoryError,
  type StorageVnextOwnershipRepositoryErrorCode
} from "./postgres-contract.js";

type ReadSql = DatabaseClient | TransactionSql;

export function createPostgresStorageVnextOwnershipRepository(
  sql: DatabaseClient,
  options: { zeroOwnerGraceMilliseconds: number | (() => number) } = {
    zeroOwnerGraceMilliseconds: 86_400_000
  }
): StorageVnextOwnershipRepository & {
  listRegistrationsForKnowledgeBase(input: {
    knowledgeBaseId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{
    items: readonly StorageVnextObjectRegistration[];
    nextCursor: string | null;
  }>;
} {
  resolveZeroOwnerGraceMilliseconds(options.zeroOwnerGraceMilliseconds);
  return {
    async getRegistration(objectId) {
      assertStorageVnextPublicId(objectId);
      return readRegistration(sql, objectId);
    },

    async getRegistrationsByStorageKeys(storageKeys) {
      if (storageKeys.length > MAX_STORAGE_VNEXT_OWNERSHIP_PAGE_SIZE || storageKeys.some((key) => !isStorageVnextStorageKey(key))) {
        throw new StorageVnextOwnershipRepositoryError("invalid_input");
      }
      if (storageKeys.length === 0) return [];
      const rows = await sql<StorageVnextRegistrationRow[]>`
        SELECT ${sql.unsafe(REGISTRATION_COLUMNS)}
        FROM focowiki.object_registrations registration
        WHERE registration.storage_key = ANY(${storageKeys}::text[])
        ORDER BY registration.storage_key, registration.object_id
      `;
      return rows.map(mapStorageVnextRegistration);
    },

    async listRegistrations(input) {
      const limit = assertStorageVnextOwnershipPageLimit(input.limit);
      const cursor = decodeStorageVnextRegistrationCursor(input.cursor);
      const rows = await sql<StorageVnextRegistrationRow[]>`
        SELECT ${sql.unsafe(REGISTRATION_COLUMNS)}
        FROM focowiki.object_registrations registration
        WHERE TRUE
          ${cursor
            ? sql`AND (registration.storage_key, registration.object_id)
                > (${cursor.storageKey}, ${cursor.objectId})`
            : sql``}
        ORDER BY registration.storage_key, registration.object_id
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map(mapStorageVnextRegistration);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last
          ? encodeStorageVnextOwnershipCursor({
            kind: "registration",
            storageKey: last.storageKey,
            objectId: last.objectId
          })
          : null
      };
    },

    async listRegistrationsForKnowledgeBase(input) {
      assertStorageVnextPublicId(input.knowledgeBaseId);
      const limit = assertStorageVnextOwnershipPageLimit(input.limit);
      const cursor = decodeStorageVnextRegistrationCursor(input.cursor);
      const rows = await sql<StorageVnextRegistrationRow[]>`
        SELECT ${sql.unsafe(REGISTRATION_COLUMNS)}
        FROM focowiki.object_registrations registration
        WHERE EXISTS (
          SELECT 1
          FROM focowiki.object_owners owner
          WHERE owner.object_id = registration.object_id
            AND owner.knowledge_base_id = ${input.knowledgeBaseId}
        )
          ${cursor
            ? sql`AND (registration.storage_key, registration.object_id)
                > (${cursor.storageKey}, ${cursor.objectId})`
            : sql``}
        ORDER BY registration.storage_key, registration.object_id
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map(mapStorageVnextRegistration);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last
          ? encodeStorageVnextOwnershipCursor({
            kind: "registration",
            storageKey: last.storageKey,
            objectId: last.objectId
          })
          : null
      };
    },

    async getClosure(objectId) {
      assertStorageVnextPublicId(objectId);
      const registration = await readRegistration(sql, objectId);
      const rows = await readOwners(sql, objectId);
      const owners = rows.map(mapStorageVnextOwner);
      const referenceCount = await readDurableReferenceCount(sql, objectId);
      return {
        objectId,
        owners,
        ownerCount: owners.length,
        referenceCount,
        graceExpiresAt: referenceCount === 0 && registration?.zeroOwnerSince
          ? new Date(
            new Date(registration.zeroOwnerSince).getTime()
            + resolveZeroOwnerGraceMilliseconds(options.zeroOwnerGraceMilliseconds)
          ).toISOString()
          : null
      };
    },

    async listZeroOwnerObjects(input) {
      const limit = assertStorageVnextOwnershipPageLimit(input.limit);
      const elapsedBefore = assertStorageVnextOwnershipTimestamp(input.graceElapsedBefore);
      const cursor = decodeStorageVnextZeroOwnerCursor(input.cursor);
      const rows = await sql<StorageVnextRegistrationRow[]>`
        SELECT ${sql.unsafe(REGISTRATION_COLUMNS)}
        FROM focowiki.object_registrations registration
        WHERE registration.state = 'verified'
          AND registration.zero_owner_since IS NOT NULL
          AND registration.zero_owner_since <= ${elapsedBefore}
          AND NOT EXISTS (
            SELECT 1
            FROM focowiki.object_owners owner
            WHERE owner.object_id = registration.object_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM focowiki.source_revisions revision
            WHERE revision.object_id = registration.object_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM focowiki.generated_page_candidates candidate
            WHERE candidate.object_id = registration.object_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM focowiki.upload_entries entry
            WHERE entry.object_id = registration.object_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM focowiki.embedding_artifacts artifact
            WHERE artifact.object_id = registration.object_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM focowiki.projection_scope_object_refs reference
            WHERE reference.object_id = registration.object_id
          )
          ${cursor
            ? sql`AND (registration.zero_owner_since, registration.object_id)
                > (${cursor.zeroOwnerSince}, ${cursor.objectId})`
            : sql``}
        ORDER BY registration.zero_owner_since, registration.object_id
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map(mapStorageVnextRegistration);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last?.zeroOwnerSince
          ? encodeStorageVnextOwnershipCursor({
            kind: "zero_owner",
            zeroOwnerSince: last.zeroOwnerSince,
            objectId: last.objectId
          })
          : null
      };
    },

    async listStaleReservations(input) {
      const limit = assertStorageVnextOwnershipPageLimit(input.limit);
      const staleBefore = assertStorageVnextOwnershipTimestamp(input.staleBefore);
      const cursor = decodeStorageVnextStaleReservationCursor(input.cursor);
      const rows = await sql<StorageVnextRegistrationRow[]>`
        SELECT ${sql.unsafe(REGISTRATION_COLUMNS)}
        FROM focowiki.object_registrations registration
        WHERE registration.state = 'reserved'
          AND registration.reservation_expires_at <= ${staleBefore}
          AND NOT EXISTS (
            SELECT 1 FROM focowiki.object_owners owner
            WHERE owner.object_id = registration.object_id
          )
          ${cursor
            ? sql`AND (registration.created_at, registration.object_id)
                > (${cursor.createdAt}, ${cursor.objectId})`
            : sql``}
        ORDER BY registration.created_at, registration.object_id
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map(mapStorageVnextRegistration);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last
          ? encodeStorageVnextOwnershipCursor({
            kind: "stale_reservation",
            createdAt: last.createdAt,
            objectId: last.objectId
          })
          : null
      };
    },

    async reserve(input) {
      assertStorageVnextReservation(input);
      try {
        return await sql.begin(async (transaction) =>
          reserveRegistration(transaction, input)) as StorageVnextObjectReservationResult;
      } catch (error) {
        return recoverReservationConflict(sql, input, error);
      }
    },

    async markVerified(input) {
      assertStorageVnextVerification(input);
      return sql.begin(async (transaction) => {
        const registration = await lockRegistration(transaction, input.objectId);
        if (!registration) throw new StorageVnextOwnershipRepositoryError("object_not_found");
        if (registration.write_attempt_public_id !== input.writeAttemptPublicId) {
          throw new StorageVnextOwnershipRepositoryError("write_attempt_conflict");
        }
        if (!sameStorageVnextRegistrationMetadata(registration, input)) {
          throw new StorageVnextOwnershipRepositoryError("registration_conflict");
        }
        if (registration.state === "verified") {
          if (input.holdVerifiedUntil === undefined) {
            return mapStorageVnextRegistration(registration);
          }
          const rows = await transaction<StorageVnextRegistrationRow[]>`
            UPDATE focowiki.object_registrations registration
            SET reservation_expires_at = ${input.holdVerifiedUntil}
            WHERE registration.object_id = ${input.objectId}
              AND registration.state = 'verified'
              AND registration.write_attempt_public_id
                    = ${input.writeAttemptPublicId}
            RETURNING ${transaction.unsafe(REGISTRATION_COLUMNS)}
          `;
          if (!rows[0]) {
            throw new StorageVnextOwnershipRepositoryError("write_attempt_conflict");
          }
          return mapStorageVnextRegistration(rows[0]);
        }
        if (registration.state !== "reserved") {
          throw new StorageVnextOwnershipRepositoryError("state_conflict");
        }
        const rows = await transaction<StorageVnextRegistrationRow[]>`
          UPDATE focowiki.object_registrations registration
          SET state = 'verified',
              verified_at = ${input.verifiedAt},
              reservation_expires_at = ${input.holdVerifiedUntil ?? null},
              zero_owner_since = CASE
                WHEN EXISTS (
                  SELECT 1 FROM focowiki.object_owners owner
                  WHERE owner.object_id = registration.object_id
                ) THEN NULL
                ELSE (${input.verifiedAt})::timestamp with time zone
              END
          WHERE registration.object_id = ${input.objectId}
          RETURNING ${transaction.unsafe(REGISTRATION_COLUMNS)}
        `;
        return mapStorageVnextRegistration(rows[0]!);
      }) as Promise<StorageVnextObjectRegistration>;
    },

    async releaseVerifiedReservation(input) {
      assertStorageVnextPublicId(input.objectId);
      assertStorageVnextPublicId(input.writeAttemptPublicId);
      await sql.begin(async (transaction) => {
        const registration = await lockRegistration(transaction, input.objectId);
        if (!registration) {
          throw new StorageVnextOwnershipRepositoryError("object_not_found");
        }
        if (registration.state !== "verified") {
          throw new StorageVnextOwnershipRepositoryError("state_conflict");
        }
        if (registration.write_attempt_public_id !== input.writeAttemptPublicId) {
          throw new StorageVnextOwnershipRepositoryError("write_attempt_conflict");
        }
        await transaction`
          UPDATE focowiki.object_registrations
          SET reservation_expires_at = NULL
          WHERE object_id = ${input.objectId}
            AND state = 'verified'
            AND write_attempt_public_id = ${input.writeAttemptPublicId}
        `;
      });
    },

    async attach(owner) {
      assertStorageVnextOwner(owner);
      await sql.begin(async (transaction) => {
        const registration = await lockRegistration(transaction, owner.objectId);
        if (!registration) throw new StorageVnextOwnershipRepositoryError("object_not_found");
        if (
          owner.kind === "live_reservation"
            ? !["reserved", "verified"].includes(registration.state)
            : registration.state !== "verified"
        ) {
          throw new StorageVnextOwnershipRepositoryError("object_unverified");
        }
        await assertOwnerTarget(transaction, owner);
        const columns = storageVnextOwnerTarget(owner);
        const inserted = await transaction<Array<{ public_id: string }>>`
          INSERT INTO focowiki.object_owners (
            public_id, knowledge_base_id, object_id, owner_kind,
            source_revision_public_id, source_receipt_public_id,
            generated_page_candidate_public_id, operation_public_id,
            embedding_artifact_public_id, created_at
          ) VALUES (
            ${owner.publicId}, ${owner.knowledgeBaseId}, ${owner.objectId}, ${owner.kind},
            ${columns.sourceRevisionPublicId}, ${columns.sourceReceiptPublicId},
            ${columns.generatedPageCandidatePublicId}, ${columns.operationPublicId},
            ${columns.embeddingArtifactPublicId}, ${owner.createdAt}
          )
          ON CONFLICT (object_id, owner_kind, owner_public_id) DO NOTHING
          RETURNING public_id
        `;
        if (!inserted[0]) {
          const existing = await transaction<Array<{ public_id: string }>>`
            SELECT public_id
            FROM focowiki.object_owners
            WHERE object_id = ${owner.objectId}
              AND owner_kind = ${owner.kind}
              AND owner_public_id = ${owner.ownerPublicId}
            LIMIT 1
          `;
          if (existing[0]?.public_id !== owner.publicId) {
            throw new StorageVnextOwnershipRepositoryError("owner_conflict");
          }
        }
        await transaction`
          UPDATE focowiki.object_registrations
          SET zero_owner_since = NULL
          WHERE object_id = ${owner.objectId}
        `;
      });
    },

    async release(input) {
      assertStorageVnextPublicId(input.objectId);
      assertStorageVnextPublicId(input.ownerPublicId);
      assertStorageVnextOwnerKind(input.kind);
      await sql.begin(async (transaction) => {
        await lockRegistration(transaction, input.objectId);
        await transaction`
          DELETE FROM focowiki.object_owners
          WHERE object_id = ${input.objectId}
            AND owner_kind = ${input.kind}
            AND owner_public_id = ${input.ownerPublicId}
        `;
        await transaction`
          UPDATE focowiki.object_registrations registration
          SET zero_owner_since = COALESCE(zero_owner_since, now())
          WHERE registration.object_id = ${input.objectId}
            AND registration.state = 'verified'
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.object_owners owner
              WHERE owner.object_id = registration.object_id
            )
        `;
      });
    },

    async markDeleting(objectId) {
      assertStorageVnextPublicId(objectId);
      await sql.begin(async (transaction) => {
        const registration = await lockRegistration(transaction, objectId);
        if (!registration) throw new StorageVnextOwnershipRepositoryError("object_not_found");
        const referenceCount = await readDurableReferenceCount(transaction, objectId);
        if (referenceCount > 0) {
          throw new StorageVnextOwnershipRepositoryError("owners_present");
        }
        if (registration.state === "deleting") return;
        if (registration.state !== "verified") {
          throw new StorageVnextOwnershipRepositoryError("state_conflict");
        }
        if (registration.reservation_expires_at !== null
          && Date.parse(String(registration.reservation_expires_at)) > Date.now()) {
          throw new StorageVnextOwnershipRepositoryError("write_in_progress");
        }
        await transaction`
          UPDATE focowiki.object_registrations
          SET state = 'deleting', reservation_expires_at = NULL
          WHERE object_id = ${objectId}
        `;
      });
    },

    async markDeleted(objectId) {
      assertStorageVnextPublicId(objectId);
      await sql.begin(async (transaction) => {
        const registration = await lockRegistration(transaction, objectId);
        if (!registration) throw new StorageVnextOwnershipRepositoryError("object_not_found");
        const referenceCount = await readDurableReferenceCount(transaction, objectId);
        if (referenceCount > 0) {
          throw new StorageVnextOwnershipRepositoryError("owners_present");
        }
        if (registration.state === "deleted") return;
        if (registration.state !== "deleting") {
          throw new StorageVnextOwnershipRepositoryError("state_conflict");
        }
        await transaction`
          UPDATE focowiki.object_registrations
          SET state = 'deleted'
          WHERE object_id = ${objectId}
        `;
      });
    },

    async deleteFailedReservation(input) {
      assertStorageVnextPublicId(input.objectId);
      assertStorageVnextPublicId(input.writeAttemptPublicId);
      await sql.begin(async (transaction) => {
        const registration = await lockRegistration(transaction, input.objectId);
        if (!registration) return;
        if (registration.write_attempt_public_id !== input.writeAttemptPublicId) {
          throw new StorageVnextOwnershipRepositoryError("write_attempt_conflict");
        }
        if (registration.state !== "reserved") {
          throw new StorageVnextOwnershipRepositoryError("state_conflict");
        }
        const owners = await readOwners(transaction, input.objectId);
        if (owners.length > 0) {
          throw new StorageVnextOwnershipRepositoryError("owners_present");
        }
        await transaction`
          DELETE FROM focowiki.object_registrations
          WHERE object_id = ${input.objectId}
            AND write_attempt_public_id = ${input.writeAttemptPublicId}
            AND state = 'reserved'
        `;
      });
    }
  };
}

function resolveZeroOwnerGraceMilliseconds(
  value: number | (() => number)
): number {
  const milliseconds = typeof value === "function" ? value() : value;
  assertStorageVnextZeroOwnerGrace(milliseconds);
  return milliseconds;
}

export async function purgePostgresStorageVnextDeletedRegistrations(
  sql: DatabaseClient,
  input: { limit: number }
): Promise<number> {
  const limit = assertStorageVnextOwnershipPageLimit(input.limit);
  return sql.begin(async (transaction) => {
    const candidates = await transaction<Array<{ object_id: string }>>`
      SELECT registration.object_id
      FROM focowiki.object_registrations registration
      WHERE registration.state = 'deleted'
        AND ${hasNoDurableReferences(transaction, "registration")}
      ORDER BY registration.object_id
      FOR UPDATE OF registration SKIP LOCKED
      LIMIT ${limit}
    `;
    if (candidates.length === 0) return 0;
    const rows = await transaction<Array<{ object_id: string }>>`
      DELETE FROM focowiki.object_registrations registration
      WHERE registration.object_id = ANY(${candidates.map((item) => item.object_id)}::text[])
        AND registration.state = 'deleted'
        AND ${hasNoDurableReferences(transaction, "registration")}
      RETURNING registration.object_id
    `;
    return rows.length;
  });
}

const REGISTRATION_COLUMNS = `
  registration.object_id, registration.storage_key, registration.checksum_sha256,
  registration.byte_count, registration.content_type, registration.object_format,
  registration.state, registration.write_attempt_public_id,
  registration.reservation_expires_at, registration.verified_at,
  registration.zero_owner_since, registration.created_at
`;

async function reserveRegistration(
  transaction: TransactionSql,
  input: StorageVnextObjectReservation
): Promise<StorageVnextObjectReservationResult> {
  const attempts = await transaction<Array<{ object_id: string }>>`
    SELECT object_id
    FROM focowiki.object_registrations
    WHERE write_attempt_public_id = ${input.writeAttemptPublicId}
    FOR UPDATE
  `;
  if (attempts[0] && attempts[0].object_id !== input.objectId) {
    throw new StorageVnextOwnershipRepositoryError("write_attempt_conflict");
  }
  const existing = await lockRegistration(transaction, input.objectId);
  if (existing) {
    if (!sameStorageVnextRegistrationMetadata(existing, input)) {
      throw new StorageVnextOwnershipRepositoryError("registration_conflict");
    }
    if (existing.state === "verified") {
      if (input.holdVerifiedUntil === undefined) {
        return { outcome: "reused", registration: mapStorageVnextRegistration(existing) };
      }
      if (existing.write_attempt_public_id !== input.writeAttemptPublicId
        && existing.reservation_expires_at !== null
        && Date.parse(String(existing.reservation_expires_at))
          > Date.parse(input.createdAt)) {
        throw new StorageVnextOwnershipRepositoryError("write_in_progress");
      }
      const rows = await transaction<StorageVnextRegistrationRow[]>`
        UPDATE focowiki.object_registrations registration
        SET write_attempt_public_id = ${input.writeAttemptPublicId},
            reservation_expires_at = ${input.holdVerifiedUntil}
        WHERE registration.object_id = ${input.objectId}
          AND registration.state = 'verified'
          AND (
            registration.write_attempt_public_id = ${input.writeAttemptPublicId}
            OR registration.reservation_expires_at IS NULL
            OR registration.reservation_expires_at <= ${input.createdAt}
          )
        RETURNING ${transaction.unsafe(REGISTRATION_COLUMNS)}
      `;
      if (!rows[0]) {
        throw new StorageVnextOwnershipRepositoryError("write_in_progress");
      }
      return { outcome: "reused", registration: mapStorageVnextRegistration(rows[0]) };
    }
    if (existing.state === "reserved") {
      if (existing.write_attempt_public_id !== input.writeAttemptPublicId) {
        if (existing.reservation_expires_at !== null
          && Date.parse(String(existing.reservation_expires_at))
            <= Date.parse(input.createdAt)) {
          const rows = await transaction<StorageVnextRegistrationRow[]>`
            UPDATE focowiki.object_registrations registration
            SET write_attempt_public_id = ${input.writeAttemptPublicId},
                created_at = ${input.createdAt},
                reservation_expires_at = ${reservationExpiresAt(input)}
            WHERE registration.object_id = ${input.objectId}
              AND registration.state = 'reserved'
              AND registration.reservation_expires_at <= ${input.createdAt}
            RETURNING ${transaction.unsafe(REGISTRATION_COLUMNS)}
          `;
          if (rows[0]) return {
            outcome: "reserved",
            registration: mapStorageVnextRegistration(rows[0])
          };
        }
        throw new StorageVnextOwnershipRepositoryError("write_in_progress");
      }
      return { outcome: "reserved", registration: mapStorageVnextRegistration(existing) };
    }
    if (existing.state === "deleted") {
      const rows = await transaction<StorageVnextRegistrationRow[]>`
        UPDATE focowiki.object_registrations registration
        SET state = 'reserved',
            write_attempt_public_id = ${input.writeAttemptPublicId},
            verified_at = NULL,
            reservation_expires_at = ${reservationExpiresAt(input)},
            zero_owner_since = NULL,
            created_at = ${input.createdAt}
        WHERE registration.object_id = ${input.objectId}
          AND registration.state = 'deleted'
          AND NOT EXISTS (
            SELECT 1 FROM focowiki.object_owners owner
            WHERE owner.object_id = registration.object_id
          )
        RETURNING ${transaction.unsafe(REGISTRATION_COLUMNS)}
      `;
      if (rows[0]) {
        return {
          outcome: "reserved",
          registration: mapStorageVnextRegistration(rows[0])
        };
      }
    }
    throw new StorageVnextOwnershipRepositoryError("state_conflict");
  }
  const rows = await transaction<StorageVnextRegistrationRow[]>`
    INSERT INTO focowiki.object_registrations AS registration (
      object_id, storage_key, checksum_sha256, byte_count, content_type,
      object_format, state, write_attempt_public_id,
      reservation_expires_at, created_at
    ) VALUES (
      ${input.objectId}, ${input.storageKey}, ${input.checksum}, ${input.byteCount},
      ${input.contentType}, ${input.format}, 'reserved',
      ${input.writeAttemptPublicId}, ${reservationExpiresAt(input)},
      ${input.createdAt}
    )
    RETURNING ${transaction.unsafe(REGISTRATION_COLUMNS)}
  `;
  return { outcome: "reserved", registration: mapStorageVnextRegistration(rows[0]!) };
}

async function recoverReservationConflict(
  sql: DatabaseClient,
  input: StorageVnextObjectReservation,
  error: unknown
): Promise<StorageVnextObjectReservationResult> {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "23505") {
    throw mapStorageVnextOwnershipDatabaseError(error);
  }
  return sql.begin((transaction) => reserveRegistration(transaction, input)) as
    Promise<StorageVnextObjectReservationResult>;
}

function reservationExpiresAt(input: StorageVnextObjectReservation): string {
  return input.reservationExpiresAt
    ?? new Date(Date.parse(input.createdAt) + 30_000).toISOString();
}

async function readRegistration(
  sql: ReadSql,
  objectId: string
): Promise<StorageVnextObjectRegistration | null> {
  const rows = await sql<StorageVnextRegistrationRow[]>`
    SELECT ${sql.unsafe(REGISTRATION_COLUMNS)}
    FROM focowiki.object_registrations registration
    WHERE registration.object_id = ${objectId}
    LIMIT 1
  `;
  return rows[0] ? mapStorageVnextRegistration(rows[0]) : null;
}

async function lockRegistration(
  sql: TransactionSql,
  objectId: string
): Promise<StorageVnextRegistrationRow | null> {
  const rows = await sql<StorageVnextRegistrationRow[]>`
    SELECT ${sql.unsafe(REGISTRATION_COLUMNS)}
    FROM focowiki.object_registrations registration
    WHERE registration.object_id = ${objectId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function readOwners(sql: ReadSql, objectId: string): Promise<StorageVnextOwnerRow[]> {
  return sql<StorageVnextOwnerRow[]>`
    SELECT public_id, knowledge_base_id, object_id, owner_kind,
      owner_public_id, created_at
    FROM focowiki.object_owners
    WHERE object_id = ${objectId}
    ORDER BY created_at, public_id
  `;
}

async function readDurableReferenceCount(
  sql: ReadSql,
  objectId: string
): Promise<number> {
  const rows = await sql<Array<{ reference_count: number | string }>>`
    SELECT (
      (SELECT count(*) FROM focowiki.object_owners owner
       WHERE owner.object_id = ${objectId})
      + (SELECT count(*) FROM focowiki.source_revisions revision
         WHERE revision.object_id = ${objectId})
      + (SELECT count(*) FROM focowiki.generated_page_candidates candidate
         WHERE candidate.object_id = ${objectId})
      + (SELECT count(*) FROM focowiki.upload_entries entry
         WHERE entry.object_id = ${objectId})
      + (SELECT count(*) FROM focowiki.embedding_artifacts artifact
         WHERE artifact.object_id = ${objectId})
      + (SELECT count(*) FROM focowiki.projection_scope_object_refs reference
         WHERE reference.object_id = ${objectId})
    ) AS reference_count
  `;
  return Number(rows[0]?.reference_count ?? 0);
}

function hasNoDurableReferences(sql: ReadSql, alias: string) {
  const registration = sql.unsafe(alias);
  return sql`
    NOT EXISTS (
      SELECT 1 FROM focowiki.object_owners owner
      WHERE owner.object_id = ${registration}.object_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM focowiki.source_revisions revision
      WHERE revision.object_id = ${registration}.object_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM focowiki.generated_page_candidates candidate
      WHERE candidate.object_id = ${registration}.object_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM focowiki.upload_entries entry
      WHERE entry.object_id = ${registration}.object_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM focowiki.embedding_artifacts artifact
      WHERE artifact.object_id = ${registration}.object_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM focowiki.projection_scope_object_refs reference
      WHERE reference.object_id = ${registration}.object_id
    )
  `;
}

async function assertOwnerTarget(
  sql: TransactionSql,
  owner: StorageVnextObjectOwner
): Promise<void> {
  let rows: readonly unknown[];
  if (owner.kind === "source_revision") {
    rows = await sql`
      SELECT 1 FROM focowiki.source_revisions
      WHERE knowledge_base_id = ${owner.knowledgeBaseId}
        AND public_id = ${owner.ownerPublicId}
      FOR UPDATE
    `;
  } else if (owner.kind === "source_receipt") {
    rows = await sql`
      SELECT 1 FROM focowiki.document_artifact_receipts receipt
      WHERE receipt.knowledge_base_id = ${owner.knowledgeBaseId}
        AND receipt.public_id = ${owner.ownerPublicId}
      FOR UPDATE
    `;
  } else if (owner.kind === "generated_page_candidate") {
    rows = await sql`
      SELECT 1 FROM focowiki.generated_page_candidates candidate
      WHERE knowledge_base_id = ${owner.knowledgeBaseId}
        AND candidate.public_id = ${owner.ownerPublicId}
        AND candidate.object_id = ${owner.objectId}
      FOR UPDATE
    `;
  } else if (owner.kind === "live_reservation") {
    rows = await sql`
      SELECT 1 FROM focowiki.operations
      WHERE knowledge_base_id = ${owner.knowledgeBaseId}
        AND public_id = ${owner.ownerPublicId}
        AND state IN ('accepted', 'running')
      FOR UPDATE
    `;
  } else {
    rows = await sql`
      SELECT 1 FROM focowiki.embedding_artifacts
      WHERE knowledge_base_id = ${owner.knowledgeBaseId}
        AND public_id = ${owner.ownerPublicId}
        AND object_id = ${owner.objectId}
      FOR UPDATE
    `;
  }
  if (!rows[0]) throw new StorageVnextOwnershipRepositoryError("owner_target_conflict");
}
