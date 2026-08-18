import type { S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import {
  UploadSessionError,
  type UploadSessionRecord
} from "../../domain/upload-session.js";
import { normalizeSourceRelativePath } from "../../domain/source-path.js";
import type { RuntimeSettingsService } from "../../runtime-settings/service.js";
import type { StorageVnextVerifiedSourceBody } from "../catalog/s3-source-body-store.js";
import type { StorageVnextCatalogReadPort } from "../catalog/ports.js";
import type { StorageVnextFailedWriteCompensation } from "../ownership/failed-write-compensation.js";
import type { StorageVnextOwnershipRepository } from "../ownership/ports.js";
import type { StorageVnextUploadRepository, StorageVnextUploadTerminalPort } from "../upload/ports.js";
import { summarizeStorageVnextUploadManifest } from "../upload/manifest-summary.js";
import type { StorageVnextAdminUploadApplication } from "./admin-upload-application.js";
import { StorageVnextAdminUploadApplicationError } from "./admin-upload-application.js";
import { writeStorageVnextUploadBody } from "./admin-upload-body-writer.js";
import {
  findIdempotentUploadSession,
  listUploadEntries,
  lockUploadSession,
  mapUploadEntry,
  normalizeUploadChecksum,
  readUploadEntries,
  requireUploadEntry,
  requireUploadSession,
  uploadChecksumJson,
  uploadCount
} from "./postgres-admin-upload-session-store.js";

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

export function createPostgresStorageVnextAdminUpload(input: {
  sql: DatabaseClient;
  s3: S3Client;
  bucket: string;
  prefix: string;
  catalog: StorageVnextCatalogReadPort;
  registrations: StorageVnextOwnershipRepository;
  compensation: StorageVnextFailedWriteCompensation;
  describeSource(input: {
    checksum: string;
    byteCount: number;
    contentType: string;
  }): Omit<StorageVnextVerifiedSourceBody, "outcome">;
  uploads: StorageVnextUploadRepository;
  terminal: StorageVnextUploadTerminalPort;
  runtimeSettings: RuntimeSettingsService;
}): StorageVnextAdminUploadApplication {
  return {
    async createUploadSession(request) {
      await requireKnowledgeBase(input.catalog, request.knowledgeBaseId);
      const now = new Date();
      const settingsRevision = await input.runtimeSettings.getCurrentRevision();
      const requestHash = uploadChecksumJson({
        kind: "upload_session",
        knowledgeBaseId: request.knowledgeBaseId,
        declaredFileCount: request.declaredFileCount,
        declaredByteCount: request.declaredByteCount
      });
      const sessionId = `upload-${randomUUID()}`;
      const operationId = `upload-operation-${randomUUID()}`;
      await input.sql.begin(async (transaction) => {
        const existing = await findIdempotentUploadSession(transaction, {
          knowledgeBaseId: request.knowledgeBaseId,
          idempotencyKey: request.idempotencyKey,
          requestHash
        });
        if (existing) return;
        const expiresAt = new Date(now.getTime() + UPLOAD_SESSION_TTL_MS).toISOString();
        await transaction`
          INSERT INTO focowiki.operations (
            public_id, knowledge_base_id, operation_kind, state,
            target_kind, target_public_id
          ) VALUES (
            ${operationId}, ${request.knowledgeBaseId}, 'upload', 'processing',
            'knowledge_base', ${request.knowledgeBaseId}
          )
        `;
        await transaction`
          INSERT INTO focowiki.operation_idempotency (
            public_id, knowledge_base_id, idempotency_key, request_hash,
            operation_public_id, expires_at, created_at
          ) VALUES (
            ${`upload-idempotency-${randomUUID()}`}, ${request.knowledgeBaseId},
            ${request.idempotencyKey}, ${requestHash}, ${operationId}, ${expiresAt},
            ${now.toISOString()}
          )
        `;
        await transaction`
          INSERT INTO focowiki.operation_work_items (
            operation_public_id, knowledge_base_id, work_kind, state,
            operation_revision, settings_revision_public_id, attempt_count,
            lease_owner, lease_expires_at, checkpoint
          ) VALUES (
            ${operationId}, ${request.knowledgeBaseId}, 'upload', 'running', 1,
            ${settingsRevision.publicId}, 1, ${`upload:${sessionId}`}, ${expiresAt},
            ${transaction.json({ sessionPublicId: sessionId })}
          )
        `;
        await transaction`
          INSERT INTO focowiki.upload_sessions (
            public_id, knowledge_base_id, operation_public_id, manifest_fingerprint,
            state, expected_entry_count, expected_byte_count,
            received_entry_count, received_byte_count, expires_at, created_at, updated_at
          ) VALUES (
            ${sessionId}, ${request.knowledgeBaseId}, ${operationId}, NULL, 'draft',
            ${request.declaredFileCount}, ${request.declaredByteCount}, 0, 0,
            ${expiresAt}, ${now.toISOString()}, ${now.toISOString()}
          )
        `;
      });
      return requireUploadSession(input.sql, request.knowledgeBaseId, request.idempotencyKey);
    },

    async addUploadEntries(request) {
      await input.sql.begin(async (transaction) => {
        const session = await lockUploadSession(
          transaction,
          request.knowledgeBaseId,
          request.sessionId
        );
        if (session.state !== "draft") throw new UploadSessionError("UPLOAD_SESSION_STATE_CONFLICT");
        const normalized = request.entries.map((entry) => {
          const path = normalizeSourceRelativePath(entry.relativePath);
          return {
            entryPublicId: `upload-entry-${randomUUID()}`,
            sourceFilePublicId: `source-file-${randomUUID()}`,
            logicalPath: path.relativePath,
            normalizedPath: path.pathKey,
            checksum: normalizeUploadChecksum(entry.checksumSha256),
            byteCount: entry.declaredSize
          };
        });
        const duplicatePaths = normalized.filter((entry, index, entries) =>
          entries.findIndex((candidate) =>
            candidate.normalizedPath === entry.normalizedPath) !== index);
        if (duplicatePaths.length > 0) {
          throw new UploadSessionError("UPLOAD_MANIFEST_DUPLICATE_PATH");
        }
        const existingRows = await transaction<Array<{
          public_id: string;
          normalized_path: string;
          revision: number | string;
          object_id: string;
          checksum_sha256: string;
        }>>`
          SELECT source.public_id, source.normalized_path, source.revision,
                 revision.object_id, revision.checksum_sha256
          FROM focowiki.source_files source
          JOIN focowiki.source_file_active_revisions active_revision
            ON active_revision.knowledge_base_id = source.knowledge_base_id
           AND active_revision.source_file_public_id = source.public_id
          JOIN focowiki.source_revisions revision
            ON revision.knowledge_base_id = active_revision.knowledge_base_id
           AND revision.source_file_public_id = active_revision.source_file_public_id
           AND revision.public_id = active_revision.current_source_revision_public_id
          WHERE source.knowledge_base_id = ${request.knowledgeBaseId}
            AND source.normalized_path = ANY(${normalized.map((entry) =>
              entry.normalizedPath)})
            AND source.deleted_at IS NULL
        `;
        const existingByPath = new Map(existingRows.map((row) =>
          [row.normalized_path, row]));
        const deletingRows = await transaction<Array<{ normalized_path: string }>>`
          SELECT normalized_path
          FROM focowiki.source_files
          WHERE knowledge_base_id = ${request.knowledgeBaseId}
            AND normalized_path = ANY(${normalized.map((entry) => entry.normalizedPath)})
            AND deleted_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.source_files current_source
              WHERE current_source.knowledge_base_id = source_files.knowledge_base_id
                AND current_source.normalized_path = source_files.normalized_path
                AND current_source.deleted_at IS NULL
            )
        `;
        const deletingPaths = new Set(deletingRows.map((row) => row.normalized_path));
        const classified = normalized.map((entry) => {
          const existing = existingByPath.get(entry.normalizedPath);
          return existing
            ? {
                ...entry,
                sourceFilePublicId: existing.public_id,
                objectId: existing.object_id,
                checksum: existing.checksum_sha256,
                state: "verified" as const,
                existingResourceRevision: Number(existing.revision)
              }
            : {
                ...entry,
                objectId: null,
                state: "pending" as const,
                existingResourceRevision: null
              };
        });
        const uploadRequired = classified.filter((entry) =>
          entry.existingResourceRevision === null);
        const totals = await transaction<Array<{ count: number | string; bytes: number | string }>>`
          SELECT count(*) AS count, coalesce(sum(byte_count), 0) AS bytes
          FROM focowiki.upload_entries
          WHERE upload_session_public_id = ${request.sessionId}
        `;
        const nextCount = uploadCount(totals[0]?.count ?? 0) + normalized.length;
        const nextBytes = uploadCount(totals[0]?.bytes ?? 0)
          + normalized.reduce((sum, entry) => sum + entry.byteCount, 0);
        if (
          nextCount > uploadCount(session.expected_entry_count)
          || nextBytes > uploadCount(session.expected_byte_count)
        ) throw new UploadSessionError("UPLOAD_MANIFEST_TOTAL_MISMATCH");
        if (normalized.length > 0) {
          try {
            await transaction`
              INSERT INTO focowiki.upload_entries ${transaction(
                classified.map((entry) => ({
                  upload_session_public_id: request.sessionId,
                  entry_public_id: entry.entryPublicId,
                  knowledge_base_id: request.knowledgeBaseId,
                  source_file_public_id: entry.sourceFilePublicId,
                  logical_path: entry.logicalPath,
                  normalized_path: entry.normalizedPath,
                  checksum_sha256: entry.checksum,
                  byte_count: entry.byteCount,
                  content_type: MARKDOWN_CONTENT_TYPE,
                  object_id: entry.objectId,
                  state: entry.state
                })),
                "upload_session_public_id", "entry_public_id", "knowledge_base_id",
                "source_file_public_id", "logical_path", "normalized_path",
                "checksum_sha256", "byte_count", "content_type", "object_id", "state"
              )}
            `;
            const reservable = uploadRequired.filter((entry) =>
              !deletingPaths.has(entry.normalizedPath));
            if (reservable.length > 0) {
              await transaction`
                INSERT INTO focowiki.upload_path_reservations ${transaction(
                  reservable.map((entry) => ({
                  knowledge_base_id: request.knowledgeBaseId,
                  normalized_path: entry.normalizedPath,
                  upload_session_public_id: request.sessionId,
                  upload_entry_public_id: entry.entryPublicId,
                  expires_at: session.expires_at
                })),
                "knowledge_base_id", "normalized_path", "upload_session_public_id",
                  "upload_entry_public_id", "expires_at"
                )}
                ON CONFLICT (knowledge_base_id, normalized_path) DO NOTHING
              `;
            }
          } catch (error) {
            if (isUploadManifestDatabaseConflict(error)) {
              throw new UploadSessionError("UPLOAD_MANIFEST_DUPLICATE_PATH");
            }
            throw error;
          }
          await transaction`
            UPDATE focowiki.upload_sessions SET updated_at = now()
            WHERE public_id = ${request.sessionId}
          `;
        }
      });
      return requireUploadSession(input.sql, request.knowledgeBaseId, request.sessionId);
    },

    async sealUploadSession(request) {
      await input.sql.begin(async (transaction) => {
        const session = await lockUploadSession(
          transaction,
          request.knowledgeBaseId,
          request.sessionId
        );
        if (session.state !== "draft") throw new UploadSessionError("UPLOAD_SESSION_STATE_CONFLICT");
        const manifest = await summarizeStorageVnextUploadManifest({
          pageSize: 500,
          readPage: (cursor, limit) => readUploadEntries(
            transaction,
            request.sessionId,
            null,
            limit,
            cursor
          )
        });
        if (
          manifest.entryCount !== uploadCount(session.expected_entry_count)
          || manifest.byteCount !== uploadCount(session.expected_byte_count)
        ) throw new UploadSessionError("UPLOAD_MANIFEST_TOTAL_MISMATCH");
        const fingerprint = manifest.fingerprint;
        await transaction`
          UPDATE focowiki.upload_sessions
          SET state = 'uploading', manifest_fingerprint = ${fingerprint}, updated_at = now()
          WHERE public_id = ${request.sessionId}
        `;
        await transaction`
          UPDATE focowiki.operation_work_items
          SET checkpoint = ${transaction.json({
            sessionPublicId: request.sessionId,
            manifestFingerprint: fingerprint
          })}, updated_at = now()
          WHERE operation_public_id = ${session.operation_public_id}
        `;
      });
      return {
        session: await requireUploadSession(input.sql, request.knowledgeBaseId, request.sessionId),
        entries: await listUploadEntries(input.sql, {
          knowledgeBaseId: request.knowledgeBaseId,
          sessionId: request.sessionId,
          limit: 100,
          cursor: null
        })
      };
    },

    async writeUploadContent(request) {
      const row = await requireUploadEntry(input.sql, request);
      if (row.object_id) return mapUploadEntry(row);
      const stored = await writeStorageVnextUploadBody({
        s3: input.s3,
        bucket: input.bucket,
        prefix: input.prefix,
        registrations: input.registrations,
        compensation: input.compensation,
        describeSource: input.describeSource,
        request,
        entry: row
      });
      const marked = await input.uploads.markEntryUploaded({
        knowledgeBaseId: request.knowledgeBaseId,
        sessionPublicId: request.sessionId,
        entryPublicId: request.entryId,
        objectId: stored.objectId,
        checksumSha256: stored.checksum,
        byteCount: stored.byteCount,
        contentType: stored.contentType
      }).catch((error: unknown) => {
        throw mapUploadContentCommitError(error);
      });
      return mapUploadEntry({
        ...row,
        checksum_sha256: marked.checksumSha256,
        object_id: marked.objectId,
        state: "verified"
      });
    },

    async getUploadSession(request) {
      return {
        session: await requireUploadSession(input.sql, request.knowledgeBaseId, request.sessionId),
        entries: await listUploadEntries(input.sql, request)
      };
    },

    async reconcileUploadSession(request) {
      await input.sql.begin(async (transaction) => {
        const session = await lockUploadSession(
          transaction,
          request.knowledgeBaseId,
          request.sessionId
        );
        if (session.state !== "uploading") {
          throw new UploadSessionError("UPLOAD_SESSION_STATE_CONFLICT");
        }
        await transaction`
          UPDATE focowiki.upload_entries entry
          SET source_file_public_id = source.public_id,
              object_id = revision.object_id,
              checksum_sha256 = revision.checksum_sha256,
              state = 'verified', updated_at = now()
          FROM focowiki.source_files source
          JOIN focowiki.source_file_active_revisions current_revision
            ON current_revision.knowledge_base_id = source.knowledge_base_id
           AND current_revision.source_file_public_id = source.public_id
          JOIN focowiki.source_revisions revision
            ON revision.knowledge_base_id = current_revision.knowledge_base_id
           AND revision.source_file_public_id = current_revision.source_file_public_id
           AND revision.public_id = current_revision.current_source_revision_public_id
          WHERE entry.knowledge_base_id = ${request.knowledgeBaseId}
            AND entry.upload_session_public_id = ${request.sessionId}
            AND entry.state = 'pending'
            AND source.knowledge_base_id = entry.knowledge_base_id
            AND source.normalized_path = entry.normalized_path
            AND source.deleted_at IS NULL
        `;
        await transaction`
          INSERT INTO focowiki.upload_path_reservations (
            knowledge_base_id, normalized_path, upload_session_public_id,
            upload_entry_public_id, expires_at
          )
          SELECT entry.knowledge_base_id, entry.normalized_path,
                 entry.upload_session_public_id, entry.entry_public_id,
                 current_session.expires_at
          FROM focowiki.upload_entries entry
          JOIN focowiki.upload_sessions current_session
            ON current_session.knowledge_base_id = entry.knowledge_base_id
           AND current_session.public_id = entry.upload_session_public_id
          WHERE entry.knowledge_base_id = ${request.knowledgeBaseId}
            AND entry.upload_session_public_id = ${request.sessionId}
            AND entry.state = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.source_files deleting
              WHERE deleting.knowledge_base_id = entry.knowledge_base_id
                AND deleting.normalized_path = entry.normalized_path
                AND deleting.deleted_at IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM focowiki.source_files current_source
                  WHERE current_source.knowledge_base_id = deleting.knowledge_base_id
                    AND current_source.normalized_path = deleting.normalized_path
                    AND current_source.deleted_at IS NULL
                )
            )
          ON CONFLICT (knowledge_base_id, normalized_path) DO NOTHING
        `;
      });
      return requireUploadSession(input.sql, request.knowledgeBaseId, request.sessionId);
    },

    async finalizeUploadSession(request) {
      const session = await requireUploadSession(
        input.sql,
        request.knowledgeBaseId,
        request.sessionId
      );
      const finalization = assertUploadSessionFinalizable(session);
      if (finalization === "replayed") return session;
      const completedAt = new Date().toISOString();
      const finalized = await input.uploads.finalizeSession({
        knowledgeBaseId: request.knowledgeBaseId,
        sessionPublicId: request.sessionId,
        completedAt
      });
      await input.terminal.converge({
        ...finalized.session,
        temporaryObjectIds: [],
        outcome: "accepted",
        resultCode: "UPLOAD_ACCEPTED",
        completedAt,
        relatedOperationPublicId: null
      });
      return requireUploadSession(
        input.sql,
        request.knowledgeBaseId,
        request.sessionId
      );
    },

    async cancelUploadSession(request) {
      await requireUploadSession(
        input.sql,
        request.knowledgeBaseId,
        request.sessionId
      );
      const completedAt = new Date().toISOString();
      const reference = await input.uploads.terminateSession({
        knowledgeBaseId: request.knowledgeBaseId,
        sessionPublicId: request.sessionId,
        reasonCode: "UPLOAD_CANCELLED",
        terminatedAt: completedAt
      });
      await input.terminal.converge({
        ...reference,
        outcome: "cancelled",
        resultCode: "UPLOAD_CANCELLED",
        completedAt,
        relatedOperationPublicId: null
      });
      return requireUploadSession(
        input.sql,
        request.knowledgeBaseId,
        request.sessionId
      );
    }
  };
}

export function assertUploadSessionFinalizable(
  session: Pick<UploadSessionRecord, "state" | "counts">
): "proceed" | "replayed" {
  if (session.state === "completed" || session.state === "finalizing") {
    return "replayed";
  }
  if (session.state !== "uploading") {
    throw new UploadSessionError("UPLOAD_SESSION_STATE_CONFLICT");
  }
  if (
    session.state === "uploading"
    && (
      session.counts.uploaded !== session.counts.uploadRequired
      || session.counts.waitingReservation > 0
      || session.counts.rejectedDeleting > 0
    )
  ) {
    throw new UploadSessionError("UPLOAD_SESSION_INCOMPLETE");
  }
  return "proceed";
}

export function mapUploadContentCommitError(error: unknown): Error {
  if (hasErrorCode(error, "entry_missing")) {
    return new UploadSessionError("UPLOAD_ENTRY_NOT_FOUND");
  }
  if (hasErrorCode(error, "entry_conflict") || hasErrorCode(error, "session_missing")) {
    return new UploadSessionError("UPLOAD_SESSION_STATE_CONFLICT");
  }
  return error instanceof Error ? error : new Error("Upload content commit failed");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isUploadManifestDatabaseConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const constraintName = "constraint_name" in error
    ? error.constraint_name
    : null;
  return constraintName === "upload_entries_path_key"
    || constraintName === "upload_entries_source_file_key";
}

async function requireKnowledgeBase(
  catalog: StorageVnextCatalogReadPort,
  knowledgeBaseId: string
) {
  if (!(await catalog.getKnowledgeBase({ knowledgeBaseId }))) {
    throw new StorageVnextAdminUploadApplicationError("NOT_FOUND");
  }
}
