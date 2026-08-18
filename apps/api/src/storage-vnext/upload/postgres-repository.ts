import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type {
  StorageVnextUploadEntry,
  StorageVnextUploadRepository,
  StorageVnextUploadSessionReference
} from "./ports.js";
import { createStorageVnextUploadIdentity } from "./identity.js";
import { finalizePostgresStorageVnextUploadSession } from "./postgres-finalization.js";
import type { SemanticMaintenanceTarget } from
  "../../semantic/domain/contracts.js";

type UploadEntryRow = {
  knowledge_base_id: string;
  upload_session_public_id: string;
  entry_public_id: string;
  source_file_public_id: string;
  logical_path: string;
  normalized_path: string;
  checksum_sha256: string;
  byte_count: number | string;
  content_type: string;
  object_id: string | null;
  state: "pending" | "uploaded" | "verified";
};

type ExistingRequestRow = {
  request_hash: string;
  operation_public_id: string;
  session_public_id: string | null;
  result_session_public_id: string | null;
};

type SessionRow = {
  public_id: string;
  knowledge_base_id: string;
  operation_public_id: string;
};

type RegistrationRow = {
  object_id: string;
  checksum_sha256: string;
  byte_count: number | string;
  content_type: string;
  state: string;
};

export function createPostgresStorageVnextUploadRepository(
  sql: DatabaseClient,
  options: {
    sourceWorkRetentionMilliseconds: number;
    resolveSemanticTarget?: (
      knowledgeBaseId: string
    ) => Promise<SemanticMaintenanceTarget | null>;
  }
): StorageVnextUploadRepository {
  assertRetention(options.sourceWorkRetentionMilliseconds);
  return {
    async openSession(input) {
      assertSessionTimes(input.createdAt, input.expiresAt);
      return sql.begin(async (transaction) => {
        const existing = await transaction<ExistingRequestRow[]>`
          SELECT idempotency.request_hash, idempotency.operation_public_id,
                 session.public_id AS session_public_id,
                 result.correlation_public_id AS result_session_public_id
          FROM focowiki.operation_idempotency idempotency
          LEFT JOIN focowiki.upload_sessions session
            ON session.operation_public_id = idempotency.operation_public_id
          LEFT JOIN focowiki.operation_results result
            ON result.public_id = idempotency.operation_public_id
          WHERE idempotency.knowledge_base_id = ${input.knowledgeBaseId}
            AND idempotency.idempotency_key = ${input.idempotencyKey}
          FOR UPDATE OF idempotency
        `;
        if (existing[0]) {
          if (existing[0].request_hash !== input.requestHash) {
            throw repositoryError("idempotency_conflict");
          }
          const sessionPublicId = existing[0].session_public_id
            ?? existing[0].result_session_public_id;
          if (!sessionPublicId) throw repositoryError("session_missing");
          return { outcome: "replayed" as const, sessionPublicId };
        }
        await assertOpenScope(transaction, input.knowledgeBaseId, input.entries);
        try {
          await insertOpenSession(transaction, input);
        } catch (error) {
          throw mapDatabaseError(error);
        }
        return { outcome: "opened" as const, sessionPublicId: input.sessionPublicId };
      });
    },

    async getEntry(input) {
      const rows = await sql<UploadEntryRow[]>`
        SELECT entry.knowledge_base_id, entry.upload_session_public_id,
               entry.entry_public_id, entry.source_file_public_id,
               entry.logical_path, entry.normalized_path, entry.checksum_sha256,
               entry.byte_count, entry.content_type, entry.object_id, entry.state
        FROM focowiki.upload_entries entry
        JOIN focowiki.upload_sessions session
          ON session.knowledge_base_id = entry.knowledge_base_id
         AND session.public_id = entry.upload_session_public_id
        WHERE entry.knowledge_base_id = ${input.knowledgeBaseId}
          AND entry.upload_session_public_id = ${input.sessionPublicId}
          AND entry.entry_public_id = ${input.entryPublicId}
          AND session.state = 'uploading'
      `;
      return rows[0] ? mapEntry(rows[0]) : null;
    },

    async markEntryUploaded(input) {
      return sql.begin(async (transaction) => {
        const entries = await transaction<UploadEntryRow[]>`
          SELECT entry.knowledge_base_id, entry.upload_session_public_id,
                 entry.entry_public_id, entry.source_file_public_id,
                 entry.logical_path, entry.normalized_path, entry.checksum_sha256,
                 entry.byte_count, entry.content_type, entry.object_id, entry.state
          FROM focowiki.upload_entries entry
          JOIN focowiki.upload_sessions session
            ON session.knowledge_base_id = entry.knowledge_base_id
           AND session.public_id = entry.upload_session_public_id
          WHERE entry.knowledge_base_id = ${input.knowledgeBaseId}
            AND entry.upload_session_public_id = ${input.sessionPublicId}
            AND entry.entry_public_id = ${input.entryPublicId}
            AND session.state = 'uploading'
          FOR UPDATE OF entry, session
        `;
        const entry = entries[0];
        if (!entry) throw repositoryError("entry_missing");
        if (entry.object_id) {
          assertEntryObject(entry, input);
          return mapEntry(entry);
        }
        assertEntryObject(entry, input);
        const registrations = await transaction<RegistrationRow[]>`
          SELECT object_id, checksum_sha256, byte_count, content_type, state
          FROM focowiki.object_registrations
          WHERE object_id = ${input.objectId}
        `;
        assertVerifiedRegistration(registrations[0], input);
        const operations = await transaction<Array<{ operation_public_id: string }>>`
          SELECT operation_public_id
          FROM focowiki.upload_sessions
          WHERE public_id = ${input.sessionPublicId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
        `;
        const operationPublicId = operations[0]?.operation_public_id;
        if (!operationPublicId) throw repositoryError("session_missing");
        await transaction`
          INSERT INTO focowiki.object_owners (
            public_id, knowledge_base_id, object_id, owner_kind, operation_public_id
          ) VALUES (
            ${createStorageVnextUploadIdentity(
              "live-owner",
              "upload",
              operationPublicId,
              input.objectId
            )},
            ${input.knowledgeBaseId}, ${input.objectId}, 'live_reservation',
            ${operationPublicId}
          )
          ON CONFLICT (object_id, owner_kind, owner_public_id) DO NOTHING
        `;
        await transaction`
          UPDATE focowiki.object_registrations
          SET zero_owner_since = NULL
          WHERE object_id = ${input.objectId}
        `;
        const updated = await transaction<UploadEntryRow[]>`
          UPDATE focowiki.upload_entries
          SET object_id = ${input.objectId}, checksum_sha256 = ${input.checksumSha256},
              state = 'verified', updated_at = now()
          WHERE upload_session_public_id = ${input.sessionPublicId}
            AND entry_public_id = ${input.entryPublicId}
            AND state = 'pending'
          RETURNING knowledge_base_id, upload_session_public_id, entry_public_id,
                    source_file_public_id, logical_path, normalized_path,
                    checksum_sha256, byte_count, content_type, object_id, state
        `;
        if (!updated[0]) throw repositoryError("entry_conflict");
        await transaction`
          UPDATE focowiki.upload_sessions
          SET received_entry_count = received_entry_count + 1,
              received_byte_count = received_byte_count + ${input.byteCount},
              updated_at = now()
          WHERE public_id = ${input.sessionPublicId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND state = 'uploading'
        `;
        return mapEntry(updated[0]);
      });
    },

    async finalizeSession(input) {
      try {
        const semanticTarget = options.resolveSemanticTarget
          ? await options.resolveSemanticTarget(input.knowledgeBaseId)
          : null;
        return await sql.begin((transaction) =>
          finalizePostgresStorageVnextUploadSession(transaction, {
            ...input,
            semanticTarget,
            sourceWorkRetentionMilliseconds: options.sourceWorkRetentionMilliseconds
          }));
      } catch (error) {
        throw mapDatabaseError(error);
      }
    },

    async terminateSession(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          UPDATE focowiki.upload_sessions
          SET state = 'finalizing', updated_at = ${input.terminatedAt}
          WHERE public_id = ${input.sessionPublicId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          UPDATE focowiki.operation_work_items work
          SET safe_error_code = ${input.reasonCode}, updated_at = ${input.terminatedAt}
          FROM focowiki.upload_sessions session
          WHERE session.public_id = ${input.sessionPublicId}
            AND session.knowledge_base_id = ${input.knowledgeBaseId}
            AND work.operation_public_id = session.operation_public_id
        `;
        const references = await readSessionReferences(transaction, [input.sessionPublicId]);
        if (references[0]) return references[0];
        const terminal = await readTerminalReference(transaction, input);
        if (!terminal) throw repositoryError("session_missing");
        return terminal;
      });
    },

    async listExpiredSessions(input) {
      assertLimit(input.limit);
      return sql.begin(async (transaction) => {
        const sessions = await transaction<SessionRow[]>`
          SELECT public_id, knowledge_base_id, operation_public_id
          FROM focowiki.upload_sessions
          WHERE expires_at <= ${input.expiredBefore}
          ORDER BY expires_at, public_id
          LIMIT ${input.limit}
          FOR UPDATE SKIP LOCKED
        `;
        if (sessions.length === 0) return [];
        await transaction`
          UPDATE focowiki.upload_sessions
          SET state = 'finalizing', updated_at = ${input.expiredBefore}
          WHERE public_id = ANY(${sessions.map((session) => session.public_id)})
        `;
        return readSessionReferences(
          transaction,
          sessions.map((session) => session.public_id)
        );
      });
    },

    async listKnowledgeBaseSessions(input) {
      assertLimit(input.limit);
      return sql.begin(async (transaction) => {
        const sessions = await transaction<SessionRow[]>`
          SELECT public_id, knowledge_base_id, operation_public_id
          FROM focowiki.upload_sessions
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
          ORDER BY public_id
          LIMIT ${input.limit}
          FOR UPDATE SKIP LOCKED
        `;
        if (sessions.length === 0) return [];
        await transaction`
          UPDATE focowiki.upload_sessions
          SET state = 'finalizing', updated_at = now()
          WHERE public_id = ANY(${sessions.map((session) => session.public_id)})
        `;
        return readSessionReferences(
          transaction,
          sessions.map((session) => session.public_id)
        );
      });
    }
  };
}

async function insertOpenSession(
  transaction: TransactionSql,
  input: Parameters<StorageVnextUploadRepository["openSession"]>[0]
): Promise<void> {
  const expectedByteCount = input.entries.reduce((sum, entry) => sum + entry.byteCount, 0);
  await transaction`
    INSERT INTO focowiki.operations (
      public_id, knowledge_base_id, operation_kind, state,
      target_kind, target_public_id
    ) VALUES (
      ${input.operationPublicId}, ${input.knowledgeBaseId}, 'upload', 'processing',
      'knowledge_base', ${input.knowledgeBaseId}
    )
  `;
  await transaction`
    INSERT INTO focowiki.operation_idempotency (
      public_id, knowledge_base_id, idempotency_key, request_hash,
      operation_public_id, expires_at, created_at
    ) VALUES (
      ${createStorageVnextUploadIdentity(
        "idempotency",
        input.knowledgeBaseId,
        input.idempotencyKey
      )},
      ${input.knowledgeBaseId}, ${input.idempotencyKey}, ${input.requestHash},
      ${input.operationPublicId}, ${input.expiresAt}, ${input.createdAt}
    )
  `;
  await transaction`
    INSERT INTO focowiki.operation_work_items (
      operation_public_id, knowledge_base_id, work_kind, state,
      operation_revision, settings_revision_public_id, attempt_count,
      lease_owner, lease_expires_at, checkpoint
    ) VALUES (
      ${input.operationPublicId}, ${input.knowledgeBaseId}, 'upload', 'running',
      1, ${input.settingsRevisionPublicId}, 1,
      ${`upload:${input.sessionPublicId}`}, ${input.expiresAt},
      ${transaction.json({
        sessionPublicId: input.sessionPublicId,
        manifestFingerprint: input.manifestFingerprint
      })}
    )
  `;
  await transaction`
    INSERT INTO focowiki.upload_sessions (
      public_id, knowledge_base_id, operation_public_id, manifest_fingerprint,
      state, expected_entry_count, expected_byte_count,
      received_entry_count, received_byte_count, expires_at, created_at, updated_at
    ) VALUES (
      ${input.sessionPublicId}, ${input.knowledgeBaseId}, ${input.operationPublicId},
      ${input.manifestFingerprint}, 'uploading', ${input.entries.length},
      ${expectedByteCount}, 0, 0, ${input.expiresAt}, ${input.createdAt}, ${input.createdAt}
    )
  `;
  if (input.entries.length === 0) return;
  await transaction`
    INSERT INTO focowiki.upload_entries ${transaction(
      input.entries.map((entry) => ({
        upload_session_public_id: input.sessionPublicId,
        entry_public_id: entry.entryPublicId,
        knowledge_base_id: input.knowledgeBaseId,
        source_file_public_id: entry.sourceFilePublicId,
        logical_path: entry.logicalPath,
        normalized_path: entry.normalizedPath,
        checksum_sha256: entry.checksumSha256,
        byte_count: entry.byteCount,
        content_type: entry.contentType,
        object_id: null,
        state: "pending",
        updated_at: input.createdAt
      })),
      "upload_session_public_id", "entry_public_id", "knowledge_base_id",
      "source_file_public_id", "logical_path", "normalized_path",
      "checksum_sha256", "byte_count", "content_type", "object_id", "state", "updated_at"
    )}
  `;
  await transaction`
    INSERT INTO focowiki.upload_path_reservations ${transaction(
      input.entries.map((entry) => ({
        knowledge_base_id: input.knowledgeBaseId,
        normalized_path: entry.normalizedPath,
        upload_session_public_id: input.sessionPublicId,
        upload_entry_public_id: entry.entryPublicId,
        expires_at: input.expiresAt,
        created_at: input.createdAt
      })),
      "knowledge_base_id", "normalized_path", "upload_session_public_id",
      "upload_entry_public_id", "expires_at", "created_at"
    )}
  `;
}

async function assertOpenScope(
  transaction: TransactionSql,
  knowledgeBaseId: string,
  entries: Parameters<StorageVnextUploadRepository["openSession"]>[0]["entries"]
): Promise<void> {
  const scope = await transaction<Array<{ accepted: boolean }>>`
    SELECT knowledge_base.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.source_files source
        WHERE source.knowledge_base_id = knowledge_base.public_id
          AND source.normalized_path = ANY(${entries.map((entry) => entry.normalizedPath)})
      ) AS accepted
    FROM focowiki.knowledge_bases knowledge_base
    WHERE knowledge_base.public_id = ${knowledgeBaseId}
  `;
  if (!scope[0]?.accepted) throw repositoryError("path_conflict");
}

async function readSessionReferences(
  transaction: TransactionSql,
  sessionPublicIds: readonly string[]
): Promise<StorageVnextUploadSessionReference[]> {
  if (sessionPublicIds.length === 0) return [];
  const rows = await transaction<Array<SessionRow & { object_ids: string[] | null }>>`
    SELECT session.public_id, session.knowledge_base_id, session.operation_public_id,
           array_remove(array_agg(entry.object_id ORDER BY entry.entry_public_id), NULL)
             AS object_ids
    FROM focowiki.upload_sessions session
    LEFT JOIN focowiki.upload_entries entry
      ON entry.upload_session_public_id = session.public_id
    WHERE session.public_id = ANY(${sessionPublicIds})
    GROUP BY session.public_id, session.knowledge_base_id, session.operation_public_id
    ORDER BY session.public_id
  `;
  return rows.map((row) => ({
    knowledgeBaseId: row.knowledge_base_id,
    operationPublicId: row.operation_public_id,
    sessionPublicId: row.public_id,
    temporaryObjectIds: row.object_ids ?? []
  }));
}

async function readTerminalReference(
  transaction: TransactionSql,
  input: { knowledgeBaseId: string; sessionPublicId: string }
): Promise<StorageVnextUploadSessionReference | null> {
  const rows = await transaction<Array<{ public_id: string }>>`
    SELECT public_id FROM focowiki.operation_results
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND correlation_public_id = ${input.sessionPublicId}
      AND operation_kind = 'upload'
    LIMIT 1
  `;
  return rows[0] ? {
    knowledgeBaseId: input.knowledgeBaseId,
    operationPublicId: rows[0].public_id,
    sessionPublicId: input.sessionPublicId,
    temporaryObjectIds: []
  } : null;
}

function mapEntry(row: UploadEntryRow): StorageVnextUploadEntry {
  return {
    knowledgeBaseId: row.knowledge_base_id,
    sessionPublicId: row.upload_session_public_id,
    entryPublicId: row.entry_public_id,
    sourceFilePublicId: row.source_file_public_id,
    logicalPath: row.logical_path,
    normalizedPath: row.normalized_path,
    checksumSha256: row.checksum_sha256,
    byteCount: Number(row.byte_count),
    contentType: "text/markdown; charset=utf-8",
    objectId: row.object_id
  };
}

function assertEntryObject(
  entry: UploadEntryRow,
  input: { objectId: string; checksumSha256: string; byteCount: number; contentType: string }
): void {
  if (
    (entry.checksum_sha256 !== null && entry.checksum_sha256 !== input.checksumSha256)
    || Number(entry.byte_count) !== input.byteCount
    || entry.content_type !== input.contentType
    || (entry.object_id !== null && entry.object_id !== input.objectId)
  ) throw repositoryError("object_conflict");
}

function assertVerifiedRegistration(
  registration: RegistrationRow | undefined,
  input: { objectId: string; checksumSha256: string; byteCount: number; contentType: string }
): void {
  if (
    !registration
    || registration.object_id !== input.objectId
    || registration.checksum_sha256 !== input.checksumSha256
    || Number(registration.byte_count) !== input.byteCount
    || registration.content_type !== input.contentType
    || registration.state !== "verified"
  ) throw repositoryError("object_unverified");
}

function assertSessionTimes(createdAt: string, expiresAt: string): void {
  const created = Date.parse(createdAt);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created) {
    throw repositoryError("invalid_input");
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw repositoryError("invalid_input");
  }
}

function assertRetention(milliseconds: number): void {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw repositoryError("invalid_input");
  }
}

function mapDatabaseError(error: unknown): Error {
  if (isDatabaseError(error, "23505")) {
    if (error.constraint_name === "operation_idempotency_key") {
      return repositoryError("idempotency_conflict");
    }
    if (
      error.constraint_name === "upload_path_reservations_pkey"
      || error.constraint_name === "source_files_path_key"
    ) return repositoryError("path_conflict");
  }
  return error instanceof Error ? error : repositoryError("database_error");
}

function isDatabaseError(
  error: unknown,
  code: string
): error is Error & { code: string; constraint_name?: string } {
  return error instanceof Error && "code" in error && error.code === code;
}

function repositoryError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Storage vNext upload repository error: ${code}`), { code });
}
