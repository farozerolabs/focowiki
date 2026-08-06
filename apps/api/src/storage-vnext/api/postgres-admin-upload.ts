import type { S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import { UploadSessionError } from "../../domain/upload-session.js";
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
  assertUploadPathsAvailable,
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
        }>>`
          SELECT source.public_id, source.normalized_path, source.revision,
                 revision.object_id
          FROM focowiki.source_files source
          JOIN focowiki.source_file_current_revisions current_revision
            ON current_revision.knowledge_base_id = source.knowledge_base_id
           AND current_revision.source_file_public_id = source.public_id
          JOIN focowiki.source_revisions revision
            ON revision.knowledge_base_id = current_revision.knowledge_base_id
           AND revision.source_file_public_id = current_revision.source_file_public_id
           AND revision.public_id = current_revision.source_revision_public_id
          WHERE source.knowledge_base_id = ${request.knowledgeBaseId}
            AND source.normalized_path = ANY(${normalized.map((entry) =>
              entry.normalizedPath)})
            AND source.deleted_at IS NULL
        `;
        const existingByPath = new Map(existingRows.map((row) =>
          [row.normalized_path, row]));
        const classified = normalized.map((entry) => {
          const existing = existingByPath.get(entry.normalizedPath);
          return existing
            ? {
                ...entry,
                sourceFilePublicId: existing.public_id,
                objectId: existing.object_id,
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
          await assertUploadPathsAvailable(transaction, request.knowledgeBaseId, uploadRequired.map(
            (entry) => entry.normalizedPath
          ));
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
            if (uploadRequired.length > 0) {
              await transaction`
                INSERT INTO focowiki.upload_path_reservations ${transaction(
                  uploadRequired.map((entry) => ({
                  knowledge_base_id: request.knowledgeBaseId,
                  normalized_path: entry.normalizedPath,
                  upload_session_public_id: request.sessionId,
                  upload_entry_public_id: entry.entryPublicId,
                  expires_at: session.expires_at
                })),
                "knowledge_base_id", "normalized_path", "upload_session_public_id",
                  "upload_entry_public_id", "expires_at"
                )}
              `;
            }
          } catch {
            throw new UploadSessionError("UPLOAD_MANIFEST_DUPLICATE_PATH");
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
      return requireUploadSession(input.sql, request.knowledgeBaseId, request.sessionId);
    },

    async finalizeUploadSession(request) {
      const session = await requireUploadSession(
        input.sql,
        request.knowledgeBaseId,
        request.sessionId
      );
      const completedAt = new Date().toISOString();
      const finalized = await input.uploads.finalizeSession({
        knowledgeBaseId: request.knowledgeBaseId,
        sessionPublicId: request.sessionId,
        completedAt
      });
      await input.terminal.converge({
        ...finalized.session,
        temporaryObjectIds: [],
        outcome: "completed",
        resultCode: "UPLOAD_ACCEPTED",
        completedAt,
        successorOperationPublicId: null
      });
      return {
        ...session,
        state: "completed",
        counts: {
          ...session.counts,
          finalized: finalized.acceptedRevisionCount
        },
        updatedAt: completedAt,
        completedAt
      };
    },

    async cancelUploadSession(request) {
      const session = await requireUploadSession(
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
        successorOperationPublicId: null
      });
      return { ...session, state: "cancelled", updatedAt: completedAt, completedAt };
    }
  };
}

async function requireKnowledgeBase(
  catalog: StorageVnextCatalogReadPort,
  knowledgeBaseId: string
) {
  if (!(await catalog.getKnowledgeBase({ knowledgeBaseId }))) {
    throw new StorageVnextAdminUploadApplicationError("NOT_FOUND");
  }
}
