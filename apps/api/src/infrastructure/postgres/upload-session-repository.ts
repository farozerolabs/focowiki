import type postgres from "postgres";
import type { UploadSessionRepository } from "../../application/ports/upload-session-repository.js";
import {
  UploadSessionError,
  type UploadSessionCounts,
  type UploadSessionEntryRecord,
  type UploadSessionRecord
} from "../../domain/upload-session.js";
import type { DatabaseClient } from "../../db/client.js";

type UploadSessionRow = {
  id: string;
  knowledge_base_id: string;
  state: UploadSessionRecord["state"];
  idempotency_key: string;
  manifest_fingerprint: string | null;
  declared_file_count: number;
  declared_byte_count: string | number;
  selected_count: number;
  upload_required_count: number;
  skipped_existing_count: number;
  waiting_reservation_count: number;
  rejected_deleting_count: number;
  uploaded_count: number;
  failed_count: number;
  finalized_count: number;
  error_code: string | null;
  expires_at: Date;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type UploadEntryRow = {
  id: string;
  session_id: string;
  relative_path: string;
  path_key: string;
  directory_path: string;
  name: string;
  declared_size: string | number;
  received_size: string | number | null;
  checksum_sha256: string;
  received_checksum_sha256: string | null;
  disposition: UploadSessionEntryRecord["disposition"];
  transfer_state: UploadSessionEntryRecord["transferState"];
  staging_object_key: string | null;
  source_directory_id: string | null;
  source_file_id: string | null;
  existing_resource_revision: number | null;
  generated_path: string;
  error_code: string | null;
  sequence_number: string | number;
};

const SESSION_COLUMNS = `
  id, knowledge_base_id, state, idempotency_key, manifest_fingerprint,
  declared_file_count, declared_byte_count, selected_count, upload_required_count,
  skipped_existing_count, waiting_reservation_count, rejected_deleting_count,
  uploaded_count, failed_count, finalized_count, error_code, expires_at,
  completed_at, created_at, updated_at
`;

const ENTRY_COLUMNS = `
  id, session_id, relative_path, path_key, directory_path, name, declared_size,
  received_size, checksum_sha256, received_checksum_sha256, disposition,
  transfer_state, staging_object_key, source_directory_id, source_file_id,
  existing_resource_revision, generated_path, error_code, sequence_number
`;

export function createPostgresUploadSessionRepository(
  sql: DatabaseClient
): UploadSessionRepository {
  return {
    async createSession(input) {
      const rows = await sql<UploadSessionRow[]>`
        INSERT INTO focowiki.upload_sessions (
          id, knowledge_base_id, idempotency_key, declared_file_count,
          declared_byte_count, expires_at
        )
        VALUES (
          ${input.id}, ${input.knowledgeBaseId}, ${input.idempotencyKey},
          ${input.declaredFileCount}, ${input.declaredByteCount}, ${input.expiresAt}
        )
        ON CONFLICT (knowledge_base_id, idempotency_key)
        DO UPDATE SET updated_at = focowiki.upload_sessions.updated_at
        WHERE focowiki.upload_sessions.declared_file_count = EXCLUDED.declared_file_count
          AND focowiki.upload_sessions.declared_byte_count = EXCLUDED.declared_byte_count
        RETURNING ${sql.unsafe(SESSION_COLUMNS)}
      `;
      if (!rows[0]) {
        throw new UploadSessionError("UPLOAD_IDEMPOTENCY_CONFLICT");
      }
      return requireSessionRow(rows[0]);
    },

    async getSession(input) {
      const rows = await sql<UploadSessionRow[]>`
        SELECT ${sql.unsafe(SESSION_COLUMNS)}
        FROM focowiki.upload_sessions
        WHERE id = ${input.sessionId}
          AND knowledge_base_id = ${input.knowledgeBaseId}
      `;
      return rows[0] ? mapSession(rows[0]) : null;
    },

    async addManifestEntries(input) {
      return sql.begin(async (transaction) => {
        const sessions = await transaction<UploadSessionRow[]>`
          SELECT ${transaction.unsafe(SESSION_COLUMNS)}
          FROM focowiki.upload_sessions
          WHERE id = ${input.sessionId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
          FOR UPDATE
        `;
        const session = requireSessionRow(sessions[0]);
        if (session.state !== "draft" && session.state !== "manifest_building") {
          throw new UploadSessionError("UPLOAD_SESSION_STATE_CONFLICT");
        }
        if (input.entries.length === 0) {
          return session;
        }
        const pathKeys = input.entries.map((entry) => entry.path.pathKey);
        const duplicateRows = await transaction<{ path_key: string }[]>`
          SELECT path_key
          FROM focowiki.upload_session_entries
          WHERE session_id = ${input.sessionId}
            AND path_key = ANY(${pathKeys})
          LIMIT 1
        `;
        if (duplicateRows.length > 0) {
          throw new UploadSessionError("UPLOAD_MANIFEST_DUPLICATE_PATH");
        }
        const firstSequence = session.counts.selected + 1;
        const values = input.entries.map((entry, index) => ({
          id: entry.id,
          session_id: input.sessionId,
          knowledge_base_id: input.knowledgeBaseId,
          sequence_number: firstSequence + index,
          relative_path: entry.path.relativePath,
          path_key: entry.path.pathKey,
          directory_path: entry.path.directoryPath,
          name: entry.path.name,
          declared_size: entry.declaredSize,
          checksum_sha256: entry.checksumSha256,
          generated_path: entry.path.generatedPath,
          source_file_id: entry.sourceFileId
        }));
        await transaction`
          INSERT INTO focowiki.upload_session_entries ${transaction(
            values,
            "id",
            "session_id",
            "knowledge_base_id",
            "sequence_number",
            "relative_path",
            "path_key",
            "directory_path",
            "name",
            "declared_size",
            "checksum_sha256",
            "generated_path",
            "source_file_id"
          )}
        `;
        const rows = await transaction<UploadSessionRow[]>`
          UPDATE focowiki.upload_sessions
          SET state = 'manifest_building',
              selected_count = selected_count + ${input.entries.length},
              updated_at = now()
          WHERE id = ${input.sessionId}
          RETURNING ${transaction.unsafe(SESSION_COLUMNS)}
        `;
        return requireSessionRow(rows[0]);
      });
    },

    async sealManifest(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<UploadSessionRow[]>`
          SELECT ${transaction.unsafe(SESSION_COLUMNS)}
          FROM focowiki.upload_sessions
          WHERE id = ${input.sessionId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
          FOR UPDATE
        `;
        const session = requireSessionRow(rows[0]);
        if (session.state === "manifest_sealed" || session.state === "uploading") {
          return session;
        }
        if (session.state !== "draft" && session.state !== "manifest_building") {
          throw new UploadSessionError("UPLOAD_SESSION_STATE_CONFLICT");
        }
        const totals = await transaction<
          Array<{ file_count: number; byte_count: string | number }>
        >`
          SELECT count(*)::int AS file_count, coalesce(sum(declared_size), 0) AS byte_count
          FROM focowiki.upload_session_entries
          WHERE session_id = ${input.sessionId}
        `;
        const total = totals[0];
        if (
          !total ||
          total.file_count !== session.declaredFileCount ||
          Number(total.byte_count) !== session.declaredByteCount
        ) {
          throw new UploadSessionError("UPLOAD_MANIFEST_TOTAL_MISMATCH");
        }

        await transaction`
          UPDATE focowiki.upload_session_entries entry
          SET disposition = 'rejected_deleting',
              transfer_state = 'skipped',
              updated_at = now()
          WHERE entry.session_id = ${input.sessionId}
            AND entry.disposition = 'pending'
            AND EXISTS (
              SELECT 1
              FROM focowiki.deletion_intents intent
              LEFT JOIN focowiki.source_directories directory
                ON intent.target_kind = 'source_directory'
               AND directory.id = intent.target_id
              LEFT JOIN focowiki.source_files source
                ON intent.target_kind = 'source_file'
               AND source.id = intent.target_id
              WHERE intent.knowledge_base_id = ${input.knowledgeBaseId}
                AND intent.state IN ('accepted', 'running')
                AND (
                  source.path_key = entry.path_key OR
                  entry.path_key = directory.path_key OR
                  (
                    entry.path_key COLLATE "C" >= (directory.path_key || '/') COLLATE "C"
                    AND entry.path_key COLLATE "C" < (directory.path_key || '0') COLLATE "C"
                  )
                )
            )
        `;
        await transaction`
          UPDATE focowiki.upload_session_entries entry
          SET disposition = 'skipped_existing',
              transfer_state = 'skipped',
              source_file_id = source.id,
              source_directory_id = source.directory_id,
              existing_resource_revision = source.resource_revision,
              updated_at = now()
          FROM focowiki.source_files source
          WHERE entry.session_id = ${input.sessionId}
            AND entry.disposition = 'pending'
            AND source.knowledge_base_id = ${input.knowledgeBaseId}
            AND source.path_key = entry.path_key
            AND source.deleted_at IS NULL
            AND source.deletion_intent_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.deletion_intents intent
              LEFT JOIN focowiki.source_directories directory
                ON intent.target_kind = 'source_directory'
               AND directory.id = intent.target_id
              LEFT JOIN focowiki.source_files deleting_source
                ON intent.target_kind = 'source_file'
               AND deleting_source.id = intent.target_id
              WHERE intent.knowledge_base_id = ${input.knowledgeBaseId}
                AND intent.state IN ('accepted', 'running')
                AND (
                  deleting_source.path_key = entry.path_key OR
                  entry.path_key = directory.path_key OR
                  (
                    entry.path_key COLLATE "C" >= (directory.path_key || '/') COLLATE "C"
                    AND entry.path_key COLLATE "C" < (directory.path_key || '0') COLLATE "C"
                  )
                )
            )
        `;

        await transaction`
          INSERT INTO focowiki.source_path_reservations (
            knowledge_base_id, path_key, session_id, entry_id, expires_at
          )
          SELECT entry.knowledge_base_id, entry.path_key, entry.session_id, entry.id, session.expires_at
          FROM focowiki.upload_session_entries entry
          JOIN focowiki.upload_sessions session ON session.id = entry.session_id
          WHERE entry.session_id = ${input.sessionId}
            AND entry.disposition = 'pending'
          ON CONFLICT (knowledge_base_id, path_key) DO NOTHING
        `;
        await transaction`
          UPDATE focowiki.upload_session_entries entry
          SET disposition = 'upload_required',
              transfer_state = 'missing',
              updated_at = now()
          FROM focowiki.source_path_reservations reservation
          WHERE entry.session_id = ${input.sessionId}
            AND entry.disposition = 'pending'
            AND reservation.entry_id = entry.id
            AND reservation.session_id = ${input.sessionId}
        `;
        await transaction`
          UPDATE focowiki.upload_session_entries
          SET disposition = 'waiting_reservation',
              transfer_state = 'pending',
              updated_at = now()
          WHERE session_id = ${input.sessionId}
            AND disposition = 'pending'
        `;

        await assignDirectories(transaction, input.knowledgeBaseId, input.sessionId);
        await refreshSessionCounts(transaction, input.sessionId);
        const sealed = await transaction<UploadSessionRow[]>`
          UPDATE focowiki.upload_sessions
          SET state = 'manifest_sealed',
              manifest_fingerprint = ${input.manifestFingerprint},
              updated_at = now()
          WHERE id = ${input.sessionId}
          RETURNING ${transaction.unsafe(SESSION_COLUMNS)}
        `;
        return requireSessionRow(sealed[0]);
      });
    },

    async getEntry(input) {
      const rows = await sql<UploadEntryRow[]>`
        SELECT ${sql.unsafe(ENTRY_COLUMNS)}
        FROM focowiki.upload_session_entries
        WHERE id = ${input.entryId}
          AND session_id = ${input.sessionId}
          AND knowledge_base_id = ${input.knowledgeBaseId}
      `;
      return rows[0] ? mapEntry(rows[0]) : null;
    },

    async markEntryUploaded(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<UploadEntryRow[]>`
          UPDATE focowiki.upload_session_entries
          SET transfer_state = 'uploaded',
              received_size = ${input.receivedSize},
              received_checksum_sha256 = ${input.receivedChecksumSha256},
              staging_object_key = ${input.stagingObjectKey},
              error_code = NULL,
              updated_at = now()
          WHERE id = ${input.entryId}
            AND session_id = ${input.sessionId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND disposition = 'upload_required'
            AND transfer_state IN ('missing', 'failed', 'uploaded')
          RETURNING ${transaction.unsafe(ENTRY_COLUMNS)}
        `;
        const entry = rows[0];
        if (!entry) {
          throw new UploadSessionError("UPLOAD_ENTRY_NOT_REQUIRED");
        }
        await refreshSessionCounts(transaction, input.sessionId);
        await transaction`
          UPDATE focowiki.upload_sessions
          SET state = 'uploading', updated_at = now()
          WHERE id = ${input.sessionId}
            AND state = 'manifest_sealed'
        `;
        return mapEntry(entry);
      });
    },

    async markEntryFailed(input) {
      await sql.begin(async (transaction) => {
        await transaction`
          UPDATE focowiki.upload_session_entries
          SET transfer_state = 'failed', error_code = ${input.errorCode}, updated_at = now()
          WHERE id = ${input.entryId}
            AND session_id = ${input.sessionId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND disposition = 'upload_required'
        `;
        await refreshSessionCounts(transaction, input.sessionId);
      });
    },

    async listEntries(input) {
      const cursor = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
      const stateFilter = input.transferState
        ? sql`AND transfer_state = ${input.transferState}`
        : sql``;
      const rows = await sql<UploadEntryRow[]>`
        SELECT ${sql.unsafe(ENTRY_COLUMNS)}
        FROM focowiki.upload_session_entries
        WHERE session_id = ${input.sessionId}
          AND knowledge_base_id = ${input.knowledgeBaseId}
          AND sequence_number > ${Number.isSafeInteger(cursor) ? cursor : 0}
          ${stateFilter}
        ORDER BY sequence_number ASC, id ASC
        LIMIT ${input.limit + 1}
      `;
      const page = rows.slice(0, input.limit);
      return {
        items: page.map(mapEntry),
        nextCursor:
          rows.length > input.limit && page.at(-1)
            ? String(page.at(-1)?.sequence_number)
            : null
      };
    },

    async reconcileReservations(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM focowiki.source_path_reservations
          WHERE expires_at <= now()
        `;
        await transaction`
          UPDATE focowiki.upload_session_entries entry
          SET disposition = 'rejected_deleting',
              transfer_state = 'skipped',
              updated_at = now()
          WHERE entry.session_id = ${input.sessionId}
            AND entry.knowledge_base_id = ${input.knowledgeBaseId}
            AND entry.disposition = 'waiting_reservation'
            AND EXISTS (
              SELECT 1
              FROM focowiki.deletion_intents intent
              LEFT JOIN focowiki.source_directories directory
                ON intent.target_kind = 'source_directory'
               AND directory.id = intent.target_id
              LEFT JOIN focowiki.source_files deleting_source
                ON intent.target_kind = 'source_file'
               AND deleting_source.id = intent.target_id
              WHERE intent.knowledge_base_id = ${input.knowledgeBaseId}
                AND intent.state IN ('accepted', 'running')
                AND (
                  deleting_source.path_key = entry.path_key OR
                  entry.path_key = directory.path_key OR
                  (
                    entry.path_key COLLATE "C" >= (directory.path_key || '/') COLLATE "C"
                    AND entry.path_key COLLATE "C" < (directory.path_key || '0') COLLATE "C"
                  )
                )
            )
        `;
        await transaction`
          UPDATE focowiki.upload_session_entries entry
          SET disposition = 'skipped_existing',
              transfer_state = 'skipped',
              source_file_id = source.id,
              source_directory_id = source.directory_id,
              existing_resource_revision = source.resource_revision,
              updated_at = now()
          FROM focowiki.source_files source
          WHERE entry.session_id = ${input.sessionId}
            AND entry.knowledge_base_id = ${input.knowledgeBaseId}
            AND entry.disposition = 'waiting_reservation'
            AND source.knowledge_base_id = entry.knowledge_base_id
            AND source.path_key = entry.path_key
            AND source.deleted_at IS NULL
            AND source.deletion_intent_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.deletion_intents intent
              LEFT JOIN focowiki.source_directories directory
                ON intent.target_kind = 'source_directory'
               AND directory.id = intent.target_id
              LEFT JOIN focowiki.source_files deleting_source
                ON intent.target_kind = 'source_file'
               AND deleting_source.id = intent.target_id
              WHERE intent.knowledge_base_id = ${input.knowledgeBaseId}
                AND intent.state IN ('accepted', 'running')
                AND (
                  deleting_source.path_key = entry.path_key OR
                  entry.path_key = directory.path_key OR
                  (
                    entry.path_key COLLATE "C" >= (directory.path_key || '/') COLLATE "C"
                    AND entry.path_key COLLATE "C" < (directory.path_key || '0') COLLATE "C"
                  )
                )
            )
        `;
        await transaction`
          INSERT INTO focowiki.source_path_reservations (
            knowledge_base_id, path_key, session_id, entry_id, expires_at
          )
          SELECT entry.knowledge_base_id, entry.path_key, entry.session_id, entry.id, session.expires_at
          FROM focowiki.upload_session_entries entry
          JOIN focowiki.upload_sessions session ON session.id = entry.session_id
          WHERE entry.session_id = ${input.sessionId}
            AND entry.disposition = 'waiting_reservation'
          ON CONFLICT (knowledge_base_id, path_key) DO NOTHING
        `;
        await transaction`
          UPDATE focowiki.upload_session_entries entry
          SET disposition = 'upload_required',
              transfer_state = 'missing',
              updated_at = now()
          FROM focowiki.source_path_reservations reservation
          WHERE entry.session_id = ${input.sessionId}
            AND entry.disposition = 'waiting_reservation'
            AND reservation.entry_id = entry.id
            AND reservation.session_id = ${input.sessionId}
        `;
        await assignDirectories(transaction, input.knowledgeBaseId, input.sessionId);
        await refreshSessionCounts(transaction, input.sessionId);
        const rows = await transaction<UploadSessionRow[]>`
          SELECT ${transaction.unsafe(SESSION_COLUMNS)}
          FROM focowiki.upload_sessions
          WHERE id = ${input.sessionId}
        `;
        return requireSessionRow(rows[0]);
      });
    },

    async finalizeSession(input) {
      return sql.begin(async (transaction) => {
        const sessionRows = await transaction<UploadSessionRow[]>`
          SELECT ${transaction.unsafe(SESSION_COLUMNS)}
          FROM focowiki.upload_sessions
          WHERE id = ${input.sessionId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
          FOR UPDATE
        `;
        const session = requireSessionRow(sessionRows[0]);
        if (session.state === "completed" || session.state === "finalizing") {
          return session;
        }
        if (session.state !== "manifest_sealed" && session.state !== "uploading") {
          throw new UploadSessionError("UPLOAD_SESSION_STATE_CONFLICT");
        }
        const blockers = await transaction<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM focowiki.upload_session_entries
          WHERE session_id = ${input.sessionId}
            AND (
              disposition IN ('waiting_reservation', 'rejected_deleting', 'pending') OR
              (disposition = 'upload_required' AND transfer_state <> 'uploaded')
            )
        `;
        if ((blockers[0]?.count ?? 0) > 0) {
          throw new UploadSessionError("UPLOAD_SESSION_INCOMPLETE");
        }
        const updated = await transaction<UploadSessionRow[]>`
          UPDATE focowiki.upload_sessions
          SET state = 'finalizing',
              updated_at = ${input.now}
          WHERE id = ${input.sessionId}
          RETURNING ${transaction.unsafe(SESSION_COLUMNS)}
        `;
        return requireSessionRow(updated[0]);
      });
    },

    async finalizeEntryBatch(input) {
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
        throw new Error("Upload finalization batch size must be positive");
      }
      return sql.begin(async (transaction) => {
        const sessions = await transaction<UploadSessionRow[]>`
          SELECT ${transaction.unsafe(SESSION_COLUMNS)}
          FROM focowiki.upload_sessions
          WHERE id = ${input.sessionId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
          FOR UPDATE
        `;
        const session = requireSessionRow(sessions[0]);
        if (session.state === "completed") {
          return { session, processedCount: 0, completed: true, cancelled: false };
        }
        if (session.state !== "finalizing") {
          throw new UploadSessionError("UPLOAD_SESSION_STATE_CONFLICT");
        }
        const conflicts = await transaction<Array<{ blocked: boolean }>>`
          SELECT (
            knowledge_base.deleted_at IS NOT NULL
            OR EXISTS (
              SELECT 1
              FROM focowiki.upload_session_entries entry
              JOIN focowiki.source_directories directory
                ON directory.id = entry.source_directory_id
              WHERE entry.session_id = ${input.sessionId}
                AND entry.disposition = 'upload_required'
                AND entry.finalized_at IS NULL
                AND (directory.deletion_intent_id IS NOT NULL OR directory.deleted_at IS NOT NULL)
            )
          ) AS blocked
          FROM focowiki.knowledge_bases knowledge_base
          WHERE knowledge_base.id = ${input.knowledgeBaseId}
        `;
        if (conflicts[0]?.blocked ?? true) {
          const failed = await transaction<UploadSessionRow[]>`
            UPDATE focowiki.upload_sessions
            SET state = 'failed', error_code = 'UPLOAD_FINALIZATION_CONFLICT',
                updated_at = ${input.now}
            WHERE id = ${input.sessionId}
            RETURNING ${transaction.unsafe(SESSION_COLUMNS)}
          `;
          return {
            session: requireSessionRow(failed[0]),
            processedCount: 0,
            completed: false,
            cancelled: true
          };
        }
        const processed = await transaction<Array<{ count: number }>>`
          WITH batch AS (
            SELECT entry.*
            FROM focowiki.upload_session_entries entry
            WHERE entry.session_id = ${input.sessionId}
              AND entry.knowledge_base_id = ${input.knowledgeBaseId}
              AND entry.disposition = 'upload_required'
              AND entry.transfer_state = 'uploaded'
              AND entry.finalized_at IS NULL
            ORDER BY entry.sequence_number ASC, entry.id ASC
            LIMIT ${input.limit}
            FOR UPDATE SKIP LOCKED
          ), inserted_sources AS (
            INSERT INTO focowiki.source_files (
              id, knowledge_base_id, name, relative_path, path_key,
              directory_id, object_key, content_type, size_bytes, checksum_sha256,
              metadata_json, processing_status, processing_stage,
              generated_output_status, retry_count, resource_revision,
              content_revision, active_revision_id
            )
            SELECT batch.source_file_id, batch.knowledge_base_id, batch.name,
                   batch.relative_path, batch.path_key, batch.source_directory_id,
                   batch.staging_object_key, 'text/markdown; charset=utf-8',
                   batch.declared_size, batch.checksum_sha256, '{}'::jsonb,
                   'queued', 'upload_storage', 'pending', 0, 1, 1,
                   'source-revision-' || md5(batch.source_file_id || ':1')
            FROM batch
            WHERE batch.source_file_id IS NOT NULL
              AND batch.staging_object_key IS NOT NULL
            ON CONFLICT (id) DO NOTHING
            RETURNING id
          ), inserted_revisions AS (
            INSERT INTO focowiki.source_revisions (
              id, knowledge_base_id, source_file_id, revision, object_key,
              content_type, size_bytes, checksum_sha256, metadata_json,
              processing_status
            )
            SELECT 'source-revision-' || md5(batch.source_file_id || ':1'),
                   batch.knowledge_base_id, batch.source_file_id, 1,
                   batch.staging_object_key, 'text/markdown; charset=utf-8',
                   batch.declared_size, batch.checksum_sha256, '{}'::jsonb, 'queued'
            FROM batch
            JOIN inserted_sources source ON source.id = batch.source_file_id
            ON CONFLICT (id) DO NOTHING
            RETURNING source_file_id
          ), inserted_jobs AS (
            INSERT INTO focowiki.worker_jobs (
              id, kind, knowledge_base_id, source_file_id, payload_json,
              run_after, max_attempts
            )
            SELECT 'worker-job-' || md5('upload:' || ${input.sessionId} || ':' || batch.source_file_id),
                   'source_file_processing', batch.knowledge_base_id,
                   batch.source_file_id, '{"reason":"upload"}'::jsonb,
                   ${input.runAfter}, ${input.jobMaxAttempts}
            FROM batch
            JOIN inserted_revisions revision ON revision.source_file_id = batch.source_file_id
            ON CONFLICT (id) DO NOTHING
            RETURNING source_file_id
          ), marked AS (
            UPDATE focowiki.upload_session_entries entry
            SET finalized_at = ${input.now}, updated_at = ${input.now}
            FROM inserted_jobs job
            WHERE entry.session_id = ${input.sessionId}
              AND entry.source_file_id = job.source_file_id
              AND entry.finalized_at IS NULL
            RETURNING entry.id
          )
          SELECT count(*)::int AS count FROM marked
        `;
        await transaction`
          UPDATE focowiki.upload_sessions session
          SET finalized_count = counts.finalized_count,
              updated_at = ${input.now}
          FROM (
            SELECT count(*) FILTER (WHERE finalized_at IS NOT NULL)::int AS finalized_count
            FROM focowiki.upload_session_entries
            WHERE session_id = ${input.sessionId}
              AND disposition = 'upload_required'
          ) counts
          WHERE session.id = ${input.sessionId}
        `;
        const updated = await transaction<UploadSessionRow[]>`
          SELECT ${transaction.unsafe(SESSION_COLUMNS)}
          FROM focowiki.upload_sessions
          WHERE id = ${input.sessionId}
        `;
        const next = requireSessionRow(updated[0]);
        return {
          session: next,
          processedCount: processed[0]?.count ?? 0,
          completed: next.counts.finalized >= next.counts.uploadRequired,
          cancelled: false
        };
      });
    },

    async completeSession(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<UploadSessionRow[]>`
          UPDATE focowiki.upload_sessions
          SET state = 'completed', completed_at = ${input.now}, updated_at = ${input.now}
          WHERE id = ${input.sessionId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND state IN ('finalizing', 'completed')
            AND finalized_count >= upload_required_count
          RETURNING ${transaction.unsafe(SESSION_COLUMNS)}
        `;
        const session = requireSessionRow(rows[0]);
        await transaction`
          DELETE FROM focowiki.source_path_reservations
          WHERE session_id = ${input.sessionId}
        `;
        return session;
      });
    },

    async failFinalization(input) {
      const rows = await sql<UploadSessionRow[]>`
        UPDATE focowiki.upload_sessions
        SET state = 'failed', error_code = ${input.errorCode}, updated_at = ${input.now}
        WHERE id = ${input.sessionId}
          AND knowledge_base_id = ${input.knowledgeBaseId}
          AND state = 'finalizing'
        RETURNING ${sql.unsafe(SESSION_COLUMNS)}
      `;
      return requireSessionRow(rows[0]);
    },

    async cancelSession(input) {
      return sql.begin(async (transaction) => {
        const objects = await transaction<{ staging_object_key: string }[]>`
          SELECT staging_object_key
          FROM focowiki.upload_session_entries
          WHERE session_id = ${input.sessionId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND staging_object_key IS NOT NULL
        `;
        await transaction`
          DELETE FROM focowiki.source_path_reservations
          WHERE session_id = ${input.sessionId}
        `;
        const rows = await transaction<UploadSessionRow[]>`
          UPDATE focowiki.upload_sessions
          SET state = 'cancelled', updated_at = ${input.now}
          WHERE id = ${input.sessionId}
            AND knowledge_base_id = ${input.knowledgeBaseId}
            AND state IN ('draft', 'manifest_building', 'manifest_sealed', 'uploading', 'failed')
          RETURNING ${transaction.unsafe(SESSION_COLUMNS)}
        `;
        return {
          session: requireSessionRow(rows[0]),
          stagingObjectKeys: objects.map((item) => item.staging_object_key)
        };
      });
    },

    async expireSessions(input) {
      return sql.begin(async (transaction) => {
        const sessions = await transaction<{ id: string }[]>`
          SELECT id
          FROM focowiki.upload_sessions
          WHERE expires_at <= ${input.now}
            AND state IN ('draft', 'manifest_building', 'manifest_sealed', 'uploading', 'failed')
          ORDER BY expires_at ASC, id ASC
          LIMIT ${input.limit}
          FOR UPDATE SKIP LOCKED
        `;
        const results: Array<{ sessionId: string; stagingObjectKeys: string[] }> = [];
        for (const session of sessions) {
          const objects = await transaction<{ staging_object_key: string }[]>`
            SELECT staging_object_key
            FROM focowiki.upload_session_entries
            WHERE session_id = ${session.id}
              AND staging_object_key IS NOT NULL
          `;
          await transaction`
            DELETE FROM focowiki.source_path_reservations WHERE session_id = ${session.id}
          `;
          await transaction`
            UPDATE focowiki.upload_sessions
            SET state = 'expired', updated_at = ${input.now}
            WHERE id = ${session.id}
          `;
          results.push({
            sessionId: session.id,
            stagingObjectKeys: objects.map((item) => item.staging_object_key)
          });
        }
        return results;
      });
    }
  };
}

type TransactionSql = postgres.TransactionSql;

async function assignDirectories(
  transaction: TransactionSql,
  knowledgeBaseId: string,
  sessionId: string
): Promise<void> {
  await transaction`
    WITH source_paths AS (
      SELECT DISTINCT string_to_array(entry.directory_path, '/') AS segments
      FROM focowiki.upload_session_entries entry
      WHERE entry.session_id = ${sessionId}
        AND entry.disposition = 'upload_required'
        AND entry.directory_path <> ''
    ), directory_paths AS MATERIALIZED (
      SELECT DISTINCT
             array_to_string(source.segments[1:depth.value], '/') AS relative_path,
             lower(array_to_string(source.segments[1:depth.value], '/')) AS path_key,
             source.segments[depth.value] AS name,
             depth.value AS depth,
             CASE WHEN depth.value = 1 THEN NULL
               ELSE lower(array_to_string(source.segments[1:depth.value - 1], '/'))
             END AS parent_path_key
      FROM source_paths source
      CROSS JOIN LATERAL generate_series(1, array_length(source.segments, 1)) depth(value)
    ), assigned_paths AS MATERIALIZED (
      SELECT 'source-directory-' || gen_random_uuid()::text AS id,
             path.relative_path, path.path_key, path.name, path.depth,
             path.parent_path_key
      FROM directory_paths path
    )
    INSERT INTO focowiki.source_directories (
      id, knowledge_base_id, parent_id, name, relative_path, path_key, depth
    )
    SELECT path.id,
           ${knowledgeBaseId},
           COALESCE(active_parent.id, batch_parent.id),
           path.name, path.relative_path, path.path_key, path.depth
    FROM assigned_paths path
    LEFT JOIN focowiki.source_directories active_parent
      ON active_parent.knowledge_base_id = ${knowledgeBaseId}
     AND active_parent.path_key = path.parent_path_key
     AND active_parent.deleted_at IS NULL
    LEFT JOIN assigned_paths batch_parent
      ON batch_parent.path_key = path.parent_path_key
    ORDER BY path.depth ASC, path.path_key ASC
    ON CONFLICT (knowledge_base_id, path_key) WHERE deleted_at IS NULL
    DO UPDATE SET updated_at = focowiki.source_directories.updated_at
  `;
  await transaction`
    UPDATE focowiki.source_directories child
    SET parent_id = parent.id, updated_at = now()
    FROM focowiki.source_directories parent
    WHERE child.knowledge_base_id = ${knowledgeBaseId}
      AND child.deleted_at IS NULL
      AND child.depth > 1
      AND parent.knowledge_base_id = child.knowledge_base_id
      AND parent.deleted_at IS NULL
      AND parent.path_key = left(
        child.path_key,
        length(child.path_key) - length(split_part(reverse(child.path_key), '/', 1)) - 1
      )
      AND child.parent_id IS DISTINCT FROM parent.id
  `;
  await transaction`
    UPDATE focowiki.upload_session_entries entry
    SET source_directory_id = directory.id, updated_at = now()
    FROM focowiki.source_directories directory
    WHERE entry.session_id = ${sessionId}
      AND entry.knowledge_base_id = ${knowledgeBaseId}
      AND entry.disposition = 'upload_required'
      AND entry.directory_path <> ''
      AND directory.knowledge_base_id = entry.knowledge_base_id
      AND directory.path_key = lower(entry.directory_path)
      AND directory.deleted_at IS NULL
  `;
}

async function refreshSessionCounts(
  transaction: TransactionSql,
  sessionId: string
): Promise<void> {
  await transaction`
    UPDATE focowiki.upload_sessions session
    SET upload_required_count = counts.upload_required,
        skipped_existing_count = counts.skipped_existing,
        waiting_reservation_count = counts.waiting_reservation,
        rejected_deleting_count = counts.rejected_deleting,
        uploaded_count = counts.uploaded,
        failed_count = counts.failed,
        updated_at = now()
    FROM (
      SELECT
        count(*) FILTER (WHERE disposition = 'upload_required')::int AS upload_required,
        count(*) FILTER (WHERE disposition = 'skipped_existing')::int AS skipped_existing,
        count(*) FILTER (WHERE disposition = 'waiting_reservation')::int AS waiting_reservation,
        count(*) FILTER (WHERE disposition = 'rejected_deleting')::int AS rejected_deleting,
        count(*) FILTER (WHERE transfer_state = 'uploaded')::int AS uploaded,
        count(*) FILTER (WHERE transfer_state = 'failed')::int AS failed
      FROM focowiki.upload_session_entries
      WHERE session_id = ${sessionId}
    ) counts
    WHERE session.id = ${sessionId}
  `;
}

function requireSessionRow(row: UploadSessionRow | undefined): UploadSessionRecord {
  if (!row) {
    throw new UploadSessionError("UPLOAD_SESSION_NOT_FOUND");
  }
  return mapSession(row);
}

function mapSession(row: UploadSessionRow): UploadSessionRecord {
  const counts: UploadSessionCounts = {
    selected: row.selected_count,
    uploadRequired: row.upload_required_count,
    skippedExisting: row.skipped_existing_count,
    waitingReservation: row.waiting_reservation_count,
    rejectedDeleting: row.rejected_deleting_count,
    uploaded: row.uploaded_count,
    failed: row.failed_count,
    finalized: row.finalized_count
  };
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    manifestFingerprint: row.manifest_fingerprint,
    declaredFileCount: row.declared_file_count,
    declaredByteCount: Number(row.declared_byte_count),
    counts,
    errorCode: row.error_code,
    expiresAt: row.expires_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapEntry(row: UploadEntryRow): UploadSessionEntryRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    relativePath: row.relative_path,
    pathKey: row.path_key,
    directoryPath: row.directory_path,
    name: row.name,
    declaredSize: Number(row.declared_size),
    receivedSize: row.received_size === null ? null : Number(row.received_size),
    checksumSha256: row.checksum_sha256,
    receivedChecksumSha256: row.received_checksum_sha256,
    disposition: row.disposition,
    transferState: row.transfer_state,
    stagingObjectKey: row.staging_object_key,
    sourceDirectoryId: row.source_directory_id,
    sourceFileId: row.source_file_id,
    existingResourceRevision: row.existing_resource_revision,
    generatedPath: row.generated_path,
    errorCode: row.error_code
  };
}
