import { randomUUID } from "node:crypto";
import type { OkfLogEntry, OkfLogMonthlySummary, SourceMetadataDefaults } from "@focowiki/okf";
import type {
  PublicOpenApiKeyRecord,
  PublicOpenApiKeyRepository,
  PublicOpenApiKeyStatus
} from "../public-openapi/keys.js";
import type { DatabaseClient } from "./client.js";

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type KnowledgeBaseRecord = {
  id: string;
  name: string;
  description: string | null;
  activeReleaseId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateKnowledgeBaseInput = {
  name: string;
  description: string | null;
};

export type KnowledgeBaseRepository = {
  listKnowledgeBases: (request: {
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<KnowledgeBaseRecord>>;
  createKnowledgeBase: (input: CreateKnowledgeBaseInput) => Promise<KnowledgeBaseRecord>;
  getKnowledgeBase: (id: string) => Promise<KnowledgeBaseRecord | null>;
  softDeleteKnowledgeBase?: (input: {
    id: string;
    deletedAt: string;
  }) => Promise<boolean>;
};

export type BundleTreeEntryRecord = {
  id: string;
  knowledgeBaseId: string;
  releaseId: string;
  parentPath: string;
  name: string;
  logicalPath: string;
  entryType: "directory" | "file";
  bundleFileId: string | null;
  sourceFileId: string | null;
  fileKind: BundleFileKind | null;
};

export type BundleTreeEntryDraft = Omit<BundleTreeEntryRecord, "sourceFileId" | "fileKind">;

export type BundleFileKind =
  | "page"
  | "index"
  | "log"
  | "schema"
  | "manifest_index"
  | "search_index"
  | "link_index";

export type BundleFileRecord = {
  id: string;
  knowledgeBaseId: string;
  releaseId: string;
  sourceFileId: string | null;
  fileKind: BundleFileKind;
  logicalPath: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  okfType: string | null;
  title: string | null;
  description: string | null;
  tags: string[];
  frontmatter: Record<string, unknown>;
};

export type SourceFileProcessingStatus = "pending" | "running" | "completed" | "failed";

export type SourceFileProcessingStage =
  | "upload_storage"
  | "metadata_resolution"
  | "okf_validation"
  | "bundle_generation"
  | "index_publication"
  | "release_activation";

export type SourceFileRecord = {
  id: string;
  knowledgeBaseId: string;
  taskId: string;
  originalName: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  metadata: SourceMetadataDefaults;
  processingStatus?: SourceFileProcessingStatus;
  processingStage?: SourceFileProcessingStage;
  processingStartedAt?: string | null;
  processingEndedAt?: string | null;
  processingErrorCode?: string | null;
  createdAt: string;
  deletedAt: string | null;
};

type SourceFileProcessingFields =
  | "processingStatus"
  | "processingStage"
  | "processingStartedAt"
  | "processingEndedAt"
  | "processingErrorCode";

export type SourceFileDraft = Omit<
  SourceFileRecord,
  "createdAt" | "deletedAt" | SourceFileProcessingFields
> &
  Partial<Pick<SourceFileRecord, SourceFileProcessingFields>>;

export type ReleaseRecord = {
  id: string;
  knowledgeBaseId: string;
  taskId: string;
  bundleRootKey: string;
  generatedAt: string;
  publishedAt: string | null;
  fileCount: number;
  manifestChecksumSha256: string;
  createdAt: string;
};

export type ReleaseDraft = Omit<ReleaseRecord, "createdAt">;

export type UploadTaskOperation = "upload" | "delete_source" | "delete_knowledge_base";

export type UploadTaskRecord = {
  id: string;
  knowledgeBaseId: string;
  operation: UploadTaskOperation;
  startedAt: string;
  endedAt: string | null;
  sourceCount: number;
  resultReleaseId: string | null;
  internalErrorCode: string | null;
  internalErrorMessage: string | null;
  createdAt: string;
  progress?: UploadTaskProgress;
};

export type UploadTaskProgress = {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
  currentStage: SourceFileProcessingStage | null;
};

export type UploadTaskEventRecord = {
  id: string;
  taskId: string;
  phaseKey: string;
  messageKey: string;
  startedAt: string | null;
  endedAt: string | null;
  severity: "info" | "warning" | "error";
  createdAt: string;
};

export type UploadTaskEventDraft = Omit<UploadTaskEventRecord, "id" | "createdAt">;

export type SecurityAuditEventDraft = {
  eventType: string;
  result: "success" | "failure" | "blocked";
  errorCode: string | null;
  username: string | null;
  clientIp: string | null;
  userAgent: string | null;
  origin: string | null;
  createdAt?: string;
};

export type BundleFileRepository = {
  createSourceFiles?: (files: SourceFileDraft[]) => Promise<void>;
  createRelease?: (release: ReleaseDraft) => Promise<void>;
  createBundleFiles?: (files: BundleFileRecord[]) => Promise<void>;
  createBundleTreeEntries?: (entries: BundleTreeEntryDraft[]) => Promise<void>;
  activateRelease?: (input: {
    knowledgeBaseId: string;
    releaseId: string;
    taskId: string;
    publishedAt: string;
    fileCount: number;
    manifestChecksumSha256: string;
  }) => Promise<void>;
  listSourceFilesForTask?: (request: {
    knowledgeBaseId: string;
    taskId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<SourceFileRecord>>;
  updateSourceFileProcessingState?: (input: {
    knowledgeBaseId: string;
    taskId: string;
    sourceFileIds: string[];
    status: SourceFileProcessingStatus;
    stage: SourceFileProcessingStage;
    startedAt?: string | null;
    endedAt?: string | null;
    errorCode?: string | null;
  }) => Promise<void>;
  listBundleTreeEntries: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    parentPath: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<BundleTreeEntryRecord>>;
  getBundleFile: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    logicalPath: string;
  }) => Promise<BundleFileRecord | null>;
  listSourceFiles: (request: {
    knowledgeBaseId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<SourceFileRecord>>;
  listReleases: (request: {
    knowledgeBaseId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<ReleaseRecord>>;
  listBundleFiles: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<BundleFileRecord>>;
  listPublicationLogHistory?: (request: {
    knowledgeBaseId: string;
    maxEntries: number;
  }) => Promise<{
    entries: OkfLogEntry[];
    summaries: OkfLogMonthlySummary[];
  }>;
  softDeleteSourceFile?: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    deletedAt: string;
  }) => Promise<boolean>;
};

export type AdminRepositories = {
  knowledgeBases: KnowledgeBaseRepository;
  files?: BundleFileRepository;
  tasks?: {
    createUploadTask: (input: {
      knowledgeBaseId: string;
      sourceCount: number;
      operation?: UploadTaskOperation;
    }) => Promise<UploadTaskRecord>;
    completeUploadTask?: (input: {
      knowledgeBaseId: string;
      taskId: string;
      endedAt: string;
      resultReleaseId: string | null;
      internalErrorCode?: string | null;
      internalErrorMessage?: string | null;
    }) => Promise<UploadTaskRecord>;
    createUploadTaskEvent?: (input: UploadTaskEventDraft) => Promise<UploadTaskEventRecord>;
    getUploadTask?: (input: {
      knowledgeBaseId: string;
      taskId: string;
    }) => Promise<UploadTaskRecord | null>;
    getLatestUploadTask?: (knowledgeBaseId: string) => Promise<UploadTaskRecord | null>;
    listUploadTasks?: (request: {
      knowledgeBaseId: string;
      limit: number;
      cursor: string | null;
    }) => Promise<CursorPage<UploadTaskRecord>>;
    listUploadTaskEvents?: (request: {
      knowledgeBaseId: string;
      taskId: string;
      limit: number;
      cursor: string | null;
    }) => Promise<CursorPage<UploadTaskEventRecord>>;
  };
  securityAudit?: {
    createSecurityAuditEvent: (input: SecurityAuditEventDraft) => Promise<void>;
  };
  publicApiKeys?: PublicOpenApiKeyRepository;
};

type KnowledgeBaseRow = {
  id: string;
  name: string;
  description: string | null;
  active_release_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type BundleTreeEntryRow = {
  id: string;
  knowledge_base_id: string;
  release_id: string;
  parent_path: string;
  name: string;
  logical_path: string;
  entry_type: "directory" | "file";
  bundle_file_id: string | null;
  source_file_id: string | null;
  file_kind: BundleFileKind | null;
};

type BundleFileRow = {
  id: string;
  knowledge_base_id: string;
  release_id: string;
  source_file_id: string | null;
  file_kind: BundleFileKind;
  logical_path: string;
  object_key: string;
  content_type: string;
  size_bytes: string | number;
  checksum_sha256: string;
  okf_type: string | null;
  title: string | null;
  description: string | null;
  tags_json: unknown;
  frontmatter_json: unknown;
};

type SourceFileRow = {
  id: string;
  knowledge_base_id: string;
  task_id: string;
  original_name: string;
  object_key: string;
  content_type: string;
  size_bytes: string | number;
  checksum_sha256: string;
  metadata_json: unknown;
  processing_status: SourceFileProcessingStatus;
  processing_stage: SourceFileProcessingStage;
  processing_started_at: Date | null;
  processing_ended_at: Date | null;
  processing_error_code: string | null;
  created_at: Date;
  deleted_at: Date | null;
};

type ReleaseRow = {
  id: string;
  knowledge_base_id: string;
  task_id: string;
  bundle_root_key: string;
  generated_at: Date;
  published_at: Date | null;
  file_count: number;
  manifest_checksum_sha256: string;
  created_at: Date;
};

type PublicationLogEntryRow = {
  occurred_at: Date;
  operation: UploadTaskOperation;
  file_count: number;
  source_count: number;
};

type PublicationLogSummaryRow = {
  month: string;
  publication_count: string | number;
  changed_file_count: string | number;
};

type UploadTaskRow = {
  id: string;
  knowledge_base_id: string;
  operation: UploadTaskOperation;
  started_at: Date;
  ended_at: Date | null;
  source_count: number;
  result_release_id: string | null;
  internal_error_code: string | null;
  internal_error_message: string | null;
  created_at: Date;
  source_completed_count?: string | number;
  source_failed_count?: string | number;
  source_running_count?: string | number;
  source_pending_count?: string | number;
  source_current_stage?: SourceFileProcessingStage | null;
};

type UploadTaskEventRow = {
  id: string;
  task_id: string;
  phase_key: string;
  message_key: string;
  started_at: Date | null;
  ended_at: Date | null;
  severity: "info" | "warning" | "error";
  created_at: Date;
};

type PublicApiKeyRow = {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  key_suffix: string;
  status: PublicOpenApiKeyStatus;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

export function createSecurityAuditEventId(): string {
  return `audit-${randomUUID()}`;
}

export function createPostgresAdminRepositories(sql: DatabaseClient): AdminRepositories {
  return {
    knowledgeBases: {
      async listKnowledgeBases({ limit, cursor }) {
        const cursorValue = cursor ? parseKnowledgeBaseCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<KnowledgeBaseRow[]>`
              SELECT id, name, description, active_release_id, created_at, updated_at
              FROM focowiki.knowledge_bases
              WHERE deleted_at IS NULL
                AND (
                  created_at < ${cursorValue.createdAt}
                  OR (created_at = ${cursorValue.createdAt} AND id > ${cursorValue.id})
                )
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<KnowledgeBaseRow[]>`
              SELECT id, name, description, active_release_id, created_at, updated_at
              FROM focowiki.knowledge_bases
              WHERE deleted_at IS NULL
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);

        return {
          items: pageRows.map(mapKnowledgeBaseRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeKnowledgeBaseCursor({
                  createdAt: lastRow.created_at.toISOString(),
                  id: lastRow.id
                })
              : null
        };
      },
      async createKnowledgeBase(input) {
        const rows = await sql<KnowledgeBaseRow[]>`
          INSERT INTO focowiki.knowledge_bases (id, name, description)
          VALUES (${createKnowledgeBaseId()}, ${input.name}, ${input.description})
          RETURNING id, name, description, active_release_id, created_at, updated_at
        `;
        const row = rows[0];

        if (!row) {
          throw new Error("Knowledge base creation did not return a row");
        }

        return mapKnowledgeBaseRow(row);
      },
      async getKnowledgeBase(id) {
        const rows = await sql<KnowledgeBaseRow[]>`
          SELECT id, name, description, active_release_id, created_at, updated_at
          FROM focowiki.knowledge_bases
          WHERE id = ${id} AND deleted_at IS NULL
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapKnowledgeBaseRow(row) : null;
      },
      async softDeleteKnowledgeBase({ id, deletedAt }) {
        const rows = await sql<Array<{ id: string }>>`
          UPDATE focowiki.knowledge_bases
          SET deleted_at = ${deletedAt}, updated_at = now()
          WHERE id = ${id}
            AND deleted_at IS NULL
          RETURNING id
        `;
        return rows.length > 0;
      }
    },
    files: {
      async createSourceFiles(files) {
        for (const file of files) {
          await sql`
            INSERT INTO focowiki.source_files (
              id,
              knowledge_base_id,
              task_id,
              original_name,
              object_key,
              content_type,
              size_bytes,
              checksum_sha256,
              metadata_json,
              processing_status,
              processing_stage,
              processing_started_at,
              processing_ended_at,
              processing_error_code
            )
            VALUES (
              ${file.id},
              ${file.knowledgeBaseId},
              ${file.taskId},
              ${file.originalName},
              ${file.objectKey},
              ${file.contentType},
              ${file.sizeBytes},
              ${file.checksumSha256},
              ${sql.json(file.metadata as never)},
              ${file.processingStatus ?? "pending"},
              ${file.processingStage ?? "upload_storage"},
              ${file.processingStartedAt ?? null},
              ${file.processingEndedAt ?? null},
              ${file.processingErrorCode ?? null}
            )
          `;
        }
      },
      async createRelease(release) {
        await sql`
          INSERT INTO focowiki.releases (
            id,
            knowledge_base_id,
            task_id,
            bundle_root_key,
            generated_at,
            published_at,
            file_count,
            manifest_checksum_sha256
          )
          VALUES (
            ${release.id},
            ${release.knowledgeBaseId},
            ${release.taskId},
            ${release.bundleRootKey},
            ${release.generatedAt},
            ${release.publishedAt},
            ${release.fileCount},
            ${release.manifestChecksumSha256}
          )
        `;
      },
      async createBundleFiles(files) {
        for (const file of files) {
          await sql`
            INSERT INTO focowiki.bundle_files (
              id,
              knowledge_base_id,
              release_id,
              source_file_id,
              file_kind,
              logical_path,
              object_key,
              content_type,
              size_bytes,
              checksum_sha256,
              okf_type,
              title,
              description,
              tags_json,
              frontmatter_json
            )
            VALUES (
              ${file.id},
              ${file.knowledgeBaseId},
              ${file.releaseId},
              ${file.sourceFileId},
              ${file.fileKind},
              ${file.logicalPath},
              ${file.objectKey},
              ${file.contentType},
              ${file.sizeBytes},
              ${file.checksumSha256},
              ${file.okfType},
              ${file.title},
              ${file.description},
              ${sql.json(file.tags as never)},
              ${sql.json(file.frontmatter as never)}
            )
          `;
        }
      },
      async createBundleTreeEntries(entries) {
        for (const entry of entries) {
          await sql`
            INSERT INTO focowiki.bundle_tree_entries (
              id,
              knowledge_base_id,
              release_id,
              parent_path,
              name,
              logical_path,
              entry_type,
              bundle_file_id
            )
            VALUES (
              ${entry.id},
              ${entry.knowledgeBaseId},
              ${entry.releaseId},
              ${entry.parentPath},
              ${entry.name},
              ${entry.logicalPath},
              ${entry.entryType},
              ${entry.bundleFileId}
            )
          `;
        }
      },
      async activateRelease(input) {
        await sql.begin(async (transaction) => {
          await transaction`
            UPDATE focowiki.releases
            SET
              published_at = ${input.publishedAt},
              file_count = ${input.fileCount},
              manifest_checksum_sha256 = ${input.manifestChecksumSha256}
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND id = ${input.releaseId}
              AND task_id = ${input.taskId}
          `;
          await transaction`
            UPDATE focowiki.knowledge_bases
            SET
              active_release_id = ${input.releaseId},
              updated_at = now()
            WHERE id = ${input.knowledgeBaseId}
              AND deleted_at IS NULL
          `;
          await transaction`
            UPDATE focowiki.upload_tasks
            SET result_release_id = ${input.releaseId}
            WHERE id = ${input.taskId}
              AND knowledge_base_id = ${input.knowledgeBaseId}
          `;
        });
      },
      async listSourceFilesForTask({ knowledgeBaseId, taskId, limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<SourceFileRow[]>`
              SELECT id, knowledge_base_id, task_id, original_name, object_key, content_type, size_bytes, checksum_sha256, metadata_json, processing_status, processing_stage, processing_started_at, processing_ended_at, processing_error_code, created_at, deleted_at
              FROM focowiki.source_files
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND task_id = ${taskId}
                AND deleted_at IS NULL
                AND (
                  created_at < ${cursorValue.createdAt}
                  OR (created_at = ${cursorValue.createdAt} AND id > ${cursorValue.id})
                )
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<SourceFileRow[]>`
              SELECT id, knowledge_base_id, task_id, original_name, object_key, content_type, size_bytes, checksum_sha256, metadata_json, processing_status, processing_stage, processing_started_at, processing_ended_at, processing_error_code, created_at, deleted_at
              FROM focowiki.source_files
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND task_id = ${taskId}
                AND deleted_at IS NULL
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);
        return {
          items: pageRows.map(mapSourceFileRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTimedCursor({ createdAt: lastRow.created_at.toISOString(), id: lastRow.id })
              : null
        };
      },
      async updateSourceFileProcessingState({
        knowledgeBaseId,
        taskId,
        sourceFileIds,
        status,
        stage,
        startedAt,
        endedAt,
        errorCode
      }) {
        if (sourceFileIds.length === 0) {
          return;
        }

        await sql`
          UPDATE focowiki.source_files
          SET
            processing_status = ${status},
            processing_stage = ${stage},
            processing_started_at = COALESCE(${startedAt ?? null}, processing_started_at),
            processing_ended_at = ${endedAt ?? null},
            processing_error_code = ${errorCode ?? null}
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND task_id = ${taskId}
            AND id = ANY(${sourceFileIds})
        `;
      },
      async listBundleTreeEntries({ knowledgeBaseId, releaseId, parentPath, limit, cursor }) {
        const cursorValue = cursor ? parseTreeCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<BundleTreeEntryRow[]>`
              SELECT entry.id, entry.knowledge_base_id, entry.release_id, entry.parent_path, entry.name, entry.logical_path, entry.entry_type, entry.bundle_file_id, file.source_file_id, file.file_kind
              FROM focowiki.bundle_tree_entries entry
              LEFT JOIN focowiki.bundle_files file ON file.id = entry.bundle_file_id
              WHERE entry.knowledge_base_id = ${knowledgeBaseId}
                AND entry.release_id = ${releaseId}
                AND entry.parent_path = ${parentPath}
                AND (entry.name > ${cursorValue.name} OR (entry.name = ${cursorValue.name} AND entry.id > ${cursorValue.id}))
              ORDER BY entry.name ASC, entry.id ASC
              LIMIT ${limit + 1}
            `
          : await sql<BundleTreeEntryRow[]>`
              SELECT entry.id, entry.knowledge_base_id, entry.release_id, entry.parent_path, entry.name, entry.logical_path, entry.entry_type, entry.bundle_file_id, file.source_file_id, file.file_kind
              FROM focowiki.bundle_tree_entries entry
              LEFT JOIN focowiki.bundle_files file ON file.id = entry.bundle_file_id
              WHERE entry.knowledge_base_id = ${knowledgeBaseId}
                AND entry.release_id = ${releaseId}
                AND entry.parent_path = ${parentPath}
              ORDER BY entry.name ASC, entry.id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);

        return {
          items: pageRows.map(mapBundleTreeEntryRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTreeCursor({ name: lastRow.name, id: lastRow.id })
              : null
        };
      },
      async getBundleFile({ knowledgeBaseId, releaseId, logicalPath }) {
        const rows = await sql<BundleFileRow[]>`
          SELECT
            id,
            knowledge_base_id,
            release_id,
            logical_path,
            object_key,
            content_type,
            size_bytes,
            checksum_sha256,
            source_file_id,
            file_kind,
            okf_type,
            title,
            description,
            tags_json,
            frontmatter_json
          FROM focowiki.bundle_files
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND release_id = ${releaseId}
            AND logical_path = ${logicalPath}
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapBundleFileRow(row) : null;
      },
      async listSourceFiles({ knowledgeBaseId, limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<SourceFileRow[]>`
              SELECT id, knowledge_base_id, task_id, original_name, object_key, content_type, size_bytes, checksum_sha256, metadata_json, processing_status, processing_stage, processing_started_at, processing_ended_at, processing_error_code, created_at, deleted_at
              FROM focowiki.source_files
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND deleted_at IS NULL
                AND (
                  created_at < ${cursorValue.createdAt}
                  OR (created_at = ${cursorValue.createdAt} AND id > ${cursorValue.id})
                )
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<SourceFileRow[]>`
              SELECT id, knowledge_base_id, task_id, original_name, object_key, content_type, size_bytes, checksum_sha256, metadata_json, processing_status, processing_stage, processing_started_at, processing_ended_at, processing_error_code, created_at, deleted_at
              FROM focowiki.source_files
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND deleted_at IS NULL
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);
        return {
          items: pageRows.map(mapSourceFileRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTimedCursor({ createdAt: lastRow.created_at.toISOString(), id: lastRow.id })
              : null
        };
      },
      async listReleases({ knowledgeBaseId, limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<ReleaseRow[]>`
              SELECT id, knowledge_base_id, task_id, bundle_root_key, generated_at, published_at, file_count, manifest_checksum_sha256, created_at
              FROM focowiki.releases
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND (
                  published_at < ${cursorValue.createdAt}
                  OR (published_at = ${cursorValue.createdAt} AND id > ${cursorValue.id})
                )
              ORDER BY published_at DESC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<ReleaseRow[]>`
              SELECT id, knowledge_base_id, task_id, bundle_root_key, generated_at, published_at, file_count, manifest_checksum_sha256, created_at
              FROM focowiki.releases
              WHERE knowledge_base_id = ${knowledgeBaseId}
              ORDER BY published_at DESC, id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);
        return {
          items: pageRows.map(mapReleaseRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTimedCursor({
                  createdAt: (lastRow.published_at ?? lastRow.created_at).toISOString(),
                  id: lastRow.id
                })
              : null
        };
      },
      async listBundleFiles({ knowledgeBaseId, releaseId, limit, cursor }) {
        const cursorValue = cursor ? parseLogicalPathCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<BundleFileRow[]>`
              SELECT id, knowledge_base_id, release_id, source_file_id, file_kind, logical_path, object_key, content_type, size_bytes, checksum_sha256, okf_type, title, description, tags_json, frontmatter_json
              FROM focowiki.bundle_files
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND release_id = ${releaseId}
                AND (logical_path > ${cursorValue.logicalPath} OR (logical_path = ${cursorValue.logicalPath} AND id > ${cursorValue.id}))
              ORDER BY logical_path ASC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<BundleFileRow[]>`
              SELECT id, knowledge_base_id, release_id, source_file_id, file_kind, logical_path, object_key, content_type, size_bytes, checksum_sha256, okf_type, title, description, tags_json, frontmatter_json
              FROM focowiki.bundle_files
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND release_id = ${releaseId}
              ORDER BY logical_path ASC, id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);
        return {
          items: pageRows.map(mapBundleFileRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeLogicalPathCursor({ logicalPath: lastRow.logical_path, id: lastRow.id })
              : null
        };
      },
      async listPublicationLogHistory({ knowledgeBaseId, maxEntries }) {
        const boundedMaxEntries = Math.max(1, Math.min(maxEntries, 1_000));
        const entryRows = await sql<PublicationLogEntryRow[]>`
          SELECT
            COALESCE(release.published_at, release.generated_at) AS occurred_at,
            task.operation,
            release.file_count,
            task.source_count
          FROM focowiki.releases release
          JOIN focowiki.upload_tasks task ON task.id = release.task_id
          WHERE release.knowledge_base_id = ${knowledgeBaseId}
            AND release.published_at IS NOT NULL
          ORDER BY COALESCE(release.published_at, release.generated_at) DESC, release.id ASC
          LIMIT ${boundedMaxEntries}
        `;
        const summaryRows = await sql<PublicationLogSummaryRow[]>`
          WITH ranked_releases AS (
            SELECT
              COALESCE(release.published_at, release.generated_at) AS occurred_at,
              release.file_count,
              row_number() OVER (
                ORDER BY COALESCE(release.published_at, release.generated_at) DESC, release.id ASC
              ) AS row_number
            FROM focowiki.releases release
            WHERE release.knowledge_base_id = ${knowledgeBaseId}
              AND release.published_at IS NOT NULL
          )
          SELECT
            to_char(date_trunc('month', occurred_at), 'YYYY-MM') AS month,
            count(*) AS publication_count,
            COALESCE(sum(file_count), 0) AS changed_file_count
          FROM ranked_releases
          WHERE row_number > ${boundedMaxEntries}
          GROUP BY month
          ORDER BY month DESC
          LIMIT 24
        `;

        return {
          entries: entryRows.map((row) => ({
            occurredAt: row.occurred_at.toISOString(),
            action: logActionForOperation(row.operation),
            message: logMessageForOperation(row.operation, row.file_count, row.source_count),
            changedFileCount: row.file_count
          })),
          summaries: summaryRows.map((row) => ({
            month: row.month,
            publicationCount: Number(row.publication_count),
            changedFileCount: Number(row.changed_file_count)
          }))
        };
      },
      async softDeleteSourceFile({ knowledgeBaseId, sourceFileId, deletedAt }) {
        const rows = await sql<Array<{ id: string }>>`
          UPDATE focowiki.source_files
          SET deleted_at = ${deletedAt}
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND id = ${sourceFileId}
            AND deleted_at IS NULL
          RETURNING id
        `;
        return rows.length > 0;
      }
    },
    tasks: {
      async createUploadTask({ knowledgeBaseId, sourceCount, operation }) {
        const rows = await sql<UploadTaskRow[]>`
          INSERT INTO focowiki.upload_tasks (id, knowledge_base_id, operation, started_at, source_count)
          VALUES (${createUploadTaskId()}, ${knowledgeBaseId}, ${operation ?? "upload"}, now(), ${sourceCount})
          RETURNING
            id,
            knowledge_base_id,
            operation,
            started_at,
            ended_at,
            source_count,
            result_release_id,
            internal_error_code,
            internal_error_message,
            created_at
        `;
        const row = rows[0];

        if (!row) {
          throw new Error("Upload task creation did not return a row");
        }

        return mapUploadTaskRow(row);
      },
      async completeUploadTask({
        knowledgeBaseId,
        taskId,
        endedAt,
        resultReleaseId,
        internalErrorCode,
        internalErrorMessage
      }) {
        const rows = await sql<UploadTaskRow[]>`
          UPDATE focowiki.upload_tasks
          SET
            ended_at = ${endedAt},
            result_release_id = ${resultReleaseId},
            internal_error_code = ${internalErrorCode ?? null},
            internal_error_message = ${internalErrorMessage ?? null}
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND id = ${taskId}
          RETURNING
            id,
            knowledge_base_id,
            operation,
            started_at,
            ended_at,
            source_count,
            result_release_id,
            internal_error_code,
            internal_error_message,
            created_at
        `;
        const row = rows[0];

        if (!row) {
          throw new Error("Upload task completion did not return a row");
        }

        return mapUploadTaskRow(row);
      },
      async createUploadTaskEvent(input) {
        const rows = await sql<UploadTaskEventRow[]>`
          INSERT INTO focowiki.upload_task_events (
            id,
            task_id,
            phase_key,
            message_key,
            started_at,
            ended_at,
            severity
          )
          VALUES (
            ${createUploadTaskEventId()},
            ${input.taskId},
            ${input.phaseKey},
            ${input.messageKey},
            ${input.startedAt},
            ${input.endedAt},
            ${input.severity}
          )
          ON CONFLICT (task_id, phase_key)
          DO UPDATE SET
            message_key = EXCLUDED.message_key,
            started_at = COALESCE(focowiki.upload_task_events.started_at, EXCLUDED.started_at),
            ended_at = EXCLUDED.ended_at,
            severity = EXCLUDED.severity
          RETURNING
            id,
            task_id,
            phase_key,
            message_key,
            started_at,
            ended_at,
            severity,
            created_at
        `;
        const row = rows[0];

        if (!row) {
          throw new Error("Upload task event creation did not return a row");
        }

        return mapUploadTaskEventRow(row);
      },
      async getUploadTask({ knowledgeBaseId, taskId }) {
        const rows = await sql<UploadTaskRow[]>`
          SELECT
            task.id,
            task.knowledge_base_id,
            task.operation,
            task.started_at,
            task.ended_at,
            task.source_count,
            task.result_release_id,
            task.internal_error_code,
            task.internal_error_message,
            task.created_at,
            COALESCE(progress.source_completed_count, 0) AS source_completed_count,
            COALESCE(progress.source_failed_count, 0) AS source_failed_count,
            COALESCE(progress.source_running_count, 0) AS source_running_count,
            COALESCE(progress.source_pending_count, 0) AS source_pending_count,
            progress.source_current_stage AS source_current_stage
          FROM focowiki.upload_tasks task
          LEFT JOIN (
            SELECT
              task_id,
              count(*) FILTER (WHERE processing_status = 'completed') AS source_completed_count,
              count(*) FILTER (WHERE processing_status = 'failed') AS source_failed_count,
              count(*) FILTER (WHERE processing_status = 'running') AS source_running_count,
              count(*) FILTER (WHERE processing_status = 'pending') AS source_pending_count,
              (array_agg(processing_stage ORDER BY ${sql.unsafe(sourceProgressStageOrderSql())}))[1] AS source_current_stage
            FROM focowiki.source_files
            WHERE knowledge_base_id = ${knowledgeBaseId}
              AND deleted_at IS NULL
            GROUP BY task_id
          ) progress ON progress.task_id = task.id
          WHERE task.knowledge_base_id = ${knowledgeBaseId}
            AND task.id = ${taskId}
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapUploadTaskRow(row) : null;
      },
      async getLatestUploadTask(knowledgeBaseId) {
        const rows = await sql<UploadTaskRow[]>`
          SELECT
            task.id,
            task.knowledge_base_id,
            task.operation,
            task.started_at,
            task.ended_at,
            task.source_count,
            task.result_release_id,
            task.internal_error_code,
            task.internal_error_message,
            task.created_at,
            COALESCE(progress.source_completed_count, 0) AS source_completed_count,
            COALESCE(progress.source_failed_count, 0) AS source_failed_count,
            COALESCE(progress.source_running_count, 0) AS source_running_count,
            COALESCE(progress.source_pending_count, 0) AS source_pending_count,
            progress.source_current_stage AS source_current_stage
          FROM focowiki.upload_tasks task
          LEFT JOIN (
            SELECT
              task_id,
              count(*) FILTER (WHERE processing_status = 'completed') AS source_completed_count,
              count(*) FILTER (WHERE processing_status = 'failed') AS source_failed_count,
              count(*) FILTER (WHERE processing_status = 'running') AS source_running_count,
              count(*) FILTER (WHERE processing_status = 'pending') AS source_pending_count,
              (array_agg(processing_stage ORDER BY ${sql.unsafe(sourceProgressStageOrderSql())}))[1] AS source_current_stage
            FROM focowiki.source_files
            WHERE knowledge_base_id = ${knowledgeBaseId}
              AND deleted_at IS NULL
            GROUP BY task_id
          ) progress ON progress.task_id = task.id
          WHERE task.knowledge_base_id = ${knowledgeBaseId}
            AND task.operation = 'upload'
          ORDER BY task.started_at DESC, task.id ASC
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapUploadTaskRow(row) : null;
      },
      async listUploadTasks({ knowledgeBaseId, limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<UploadTaskRow[]>`
              SELECT
                task.id,
                task.knowledge_base_id,
                task.operation,
                task.started_at,
                task.ended_at,
                task.source_count,
                task.result_release_id,
                task.internal_error_code,
                task.internal_error_message,
                task.created_at,
                COALESCE(progress.source_completed_count, 0) AS source_completed_count,
                COALESCE(progress.source_failed_count, 0) AS source_failed_count,
                COALESCE(progress.source_running_count, 0) AS source_running_count,
                COALESCE(progress.source_pending_count, 0) AS source_pending_count,
                progress.source_current_stage AS source_current_stage
              FROM focowiki.upload_tasks task
              LEFT JOIN (
                SELECT
                  task_id,
                  count(*) FILTER (WHERE processing_status = 'completed') AS source_completed_count,
                  count(*) FILTER (WHERE processing_status = 'failed') AS source_failed_count,
                  count(*) FILTER (WHERE processing_status = 'running') AS source_running_count,
                  count(*) FILTER (WHERE processing_status = 'pending') AS source_pending_count,
                  (array_agg(processing_stage ORDER BY ${sql.unsafe(sourceProgressStageOrderSql())}))[1] AS source_current_stage
                FROM focowiki.source_files
                WHERE knowledge_base_id = ${knowledgeBaseId}
                  AND deleted_at IS NULL
                GROUP BY task_id
              ) progress ON progress.task_id = task.id
              WHERE task.knowledge_base_id = ${knowledgeBaseId}
                AND (task.started_at < ${cursorValue.createdAt} OR (task.started_at = ${cursorValue.createdAt} AND task.id > ${cursorValue.id}))
              ORDER BY task.started_at DESC, task.id ASC
              LIMIT ${limit + 1}
            `
          : await sql<UploadTaskRow[]>`
              SELECT
                task.id,
                task.knowledge_base_id,
                task.operation,
                task.started_at,
                task.ended_at,
                task.source_count,
                task.result_release_id,
                task.internal_error_code,
                task.internal_error_message,
                task.created_at,
                COALESCE(progress.source_completed_count, 0) AS source_completed_count,
                COALESCE(progress.source_failed_count, 0) AS source_failed_count,
                COALESCE(progress.source_running_count, 0) AS source_running_count,
                COALESCE(progress.source_pending_count, 0) AS source_pending_count,
                progress.source_current_stage AS source_current_stage
              FROM focowiki.upload_tasks task
              LEFT JOIN (
                SELECT
                  task_id,
                  count(*) FILTER (WHERE processing_status = 'completed') AS source_completed_count,
                  count(*) FILTER (WHERE processing_status = 'failed') AS source_failed_count,
                  count(*) FILTER (WHERE processing_status = 'running') AS source_running_count,
                  count(*) FILTER (WHERE processing_status = 'pending') AS source_pending_count,
                  (array_agg(processing_stage ORDER BY ${sql.unsafe(sourceProgressStageOrderSql())}))[1] AS source_current_stage
                FROM focowiki.source_files
                WHERE knowledge_base_id = ${knowledgeBaseId}
                  AND deleted_at IS NULL
                GROUP BY task_id
              ) progress ON progress.task_id = task.id
              WHERE task.knowledge_base_id = ${knowledgeBaseId}
              ORDER BY task.started_at DESC, task.id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);
        return {
          items: pageRows.map(mapUploadTaskRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTimedCursor({
                  createdAt: lastRow.started_at.toISOString(),
                  id: lastRow.id
                })
              : null
        };
      },
      async listUploadTaskEvents({ knowledgeBaseId, taskId, limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<UploadTaskEventRow[]>`
              SELECT
                event.id,
                event.task_id,
                event.phase_key,
                event.message_key,
                event.started_at,
                event.ended_at,
                event.severity,
                event.created_at
              FROM focowiki.upload_task_events event
              JOIN focowiki.upload_tasks task ON task.id = event.task_id
              WHERE task.knowledge_base_id = ${knowledgeBaseId}
                AND event.task_id = ${taskId}
                AND (event.created_at > ${cursorValue.createdAt} OR (event.created_at = ${cursorValue.createdAt} AND event.id > ${cursorValue.id}))
              ORDER BY event.created_at ASC, event.id ASC
              LIMIT ${limit + 1}
            `
          : await sql<UploadTaskEventRow[]>`
              SELECT
                event.id,
                event.task_id,
                event.phase_key,
                event.message_key,
                event.started_at,
                event.ended_at,
                event.severity,
                event.created_at
              FROM focowiki.upload_task_events event
              JOIN focowiki.upload_tasks task ON task.id = event.task_id
              WHERE task.knowledge_base_id = ${knowledgeBaseId}
                AND event.task_id = ${taskId}
              ORDER BY event.created_at ASC, event.id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);
        return {
          items: pageRows.map(mapUploadTaskEventRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTimedCursor({
                  createdAt: lastRow.created_at.toISOString(),
                  id: lastRow.id
                })
              : null
        };
      }
    },
    securityAudit: {
      async createSecurityAuditEvent(input) {
        await sql`
          INSERT INTO focowiki.admin_audit_events (
            id,
            event_type,
            result,
            error_code,
            username,
            client_ip,
            user_agent,
            origin,
            created_at
          )
          VALUES (
            ${createSecurityAuditEventId()},
            ${input.eventType},
            ${input.result},
            ${input.errorCode},
            ${input.username},
            ${input.clientIp},
            ${input.userAgent},
            ${input.origin},
            ${input.createdAt ?? new Date().toISOString()}
          )
        `;
      }
    },
    publicApiKeys: {
      async countActivePublicOpenApiKeys() {
        const rows = await sql<Array<{ count: string | number }>>`
          SELECT count(*) AS count
          FROM focowiki.public_api_keys
          WHERE status = 'active'
        `;
        return Number(rows[0]?.count ?? 0);
      },
      async listPublicOpenApiKeys({ limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<PublicApiKeyRow[]>`
              SELECT id, name, key_hash, key_prefix, key_suffix, status, created_at, last_used_at, revoked_at
              FROM focowiki.public_api_keys
              WHERE status = 'active'
                AND (
                  created_at < ${cursorValue.createdAt}
                  OR (created_at = ${cursorValue.createdAt} AND id > ${cursorValue.id})
                )
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<PublicApiKeyRow[]>`
              SELECT id, name, key_hash, key_prefix, key_suffix, status, created_at, last_used_at, revoked_at
              FROM focowiki.public_api_keys
              WHERE status = 'active'
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);

        return {
          items: pageRows.map(mapPublicApiKeyRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTimedCursor({
                  createdAt: lastRow.created_at.toISOString(),
                  id: lastRow.id
                })
              : null
        };
      },
      async createPublicOpenApiKey(input) {
        const rows = await sql<PublicApiKeyRow[]>`
          INSERT INTO focowiki.public_api_keys (
            id,
            name,
            key_hash,
            key_prefix,
            key_suffix,
            created_at
          )
          VALUES (
            ${input.id},
            ${input.name},
            ${input.keyHash},
            ${input.keyPrefix},
            ${input.keySuffix},
            ${input.createdAt}
          )
          RETURNING id, name, key_hash, key_prefix, key_suffix, status, created_at, last_used_at, revoked_at
        `;
        const row = rows[0];

        if (!row) {
          throw new Error("Public OpenAPI key creation did not return a row");
        }

        return mapPublicApiKeyRow(row);
      },
      async findActivePublicOpenApiKeyByHash(keyHash) {
        const rows = await sql<PublicApiKeyRow[]>`
          SELECT id, name, key_hash, key_prefix, key_suffix, status, created_at, last_used_at, revoked_at
          FROM focowiki.public_api_keys
          WHERE key_hash = ${keyHash}
            AND status = 'active'
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapPublicApiKeyRow(row) : null;
      },
      async revokePublicOpenApiKey({ id, revokedAt }) {
        const rows = await sql<PublicApiKeyRow[]>`
          UPDATE focowiki.public_api_keys
          SET
            status = 'revoked',
            revoked_at = ${revokedAt}
          WHERE id = ${id}
            AND status = 'active'
          RETURNING id, name, key_hash, key_prefix, key_suffix, status, created_at, last_used_at, revoked_at
        `;
        const row = rows[0];
        return row ? mapPublicApiKeyRow(row) : null;
      },
      async updatePublicOpenApiKeyLastUsed({ id, lastUsedAt }) {
        await sql`
          UPDATE focowiki.public_api_keys
          SET last_used_at = ${lastUsedAt}
          WHERE id = ${id}
            AND status = 'active'
        `;
      }
    }
  };
}

export function createKnowledgeBaseId(): string {
  return `kb-${randomUUID()}`;
}

export function createUploadTaskId(): string {
  return `task-${randomUUID()}`;
}

export function createUploadTaskEventId(): string {
  return `task-event-${randomUUID()}`;
}

function mapKnowledgeBaseRow(row: KnowledgeBaseRow): KnowledgeBaseRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    activeReleaseId: row.active_release_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function serializeKnowledgeBaseCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseKnowledgeBaseCursor(cursor: string): { createdAt: string; id: string } {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid knowledge base cursor");
  }

  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.createdAt !== "string" || typeof candidate.id !== "string") {
    throw new Error("Invalid knowledge base cursor");
  }

  return {
    createdAt: candidate.createdAt,
    id: candidate.id
  };
}

function mapBundleTreeEntryRow(row: BundleTreeEntryRow): BundleTreeEntryRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    releaseId: row.release_id,
    parentPath: row.parent_path,
    name: row.name,
    logicalPath: row.logical_path,
    entryType: row.entry_type,
    bundleFileId: row.bundle_file_id,
    sourceFileId: row.source_file_id,
    fileKind: row.file_kind
  };
}

function mapBundleFileRow(row: BundleFileRow): BundleFileRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    releaseId: row.release_id,
    sourceFileId: row.source_file_id,
    fileKind: row.file_kind,
    logicalPath: row.logical_path,
    objectKey: row.object_key,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    checksumSha256: row.checksum_sha256,
    okfType: row.okf_type,
    title: row.title,
    description: row.description,
    tags: readStringArray(row.tags_json),
    frontmatter: readRecord(row.frontmatter_json)
  };
}

function mapSourceFileRow(row: SourceFileRow): SourceFileRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    taskId: row.task_id,
    originalName: row.original_name,
    objectKey: row.object_key,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    checksumSha256: row.checksum_sha256,
    metadata: readRecord(row.metadata_json) as SourceMetadataDefaults,
    processingStatus: row.processing_status,
    processingStage: row.processing_stage,
    processingStartedAt: row.processing_started_at?.toISOString() ?? null,
    processingEndedAt: row.processing_ended_at?.toISOString() ?? null,
    processingErrorCode: row.processing_error_code,
    createdAt: row.created_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null
  };
}

function mapReleaseRow(row: ReleaseRow): ReleaseRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    taskId: row.task_id,
    bundleRootKey: row.bundle_root_key,
    generatedAt: row.generated_at.toISOString(),
    publishedAt: row.published_at?.toISOString() ?? null,
    fileCount: row.file_count,
    manifestChecksumSha256: row.manifest_checksum_sha256,
    createdAt: row.created_at.toISOString()
  };
}

function mapUploadTaskRow(row: UploadTaskRow): UploadTaskRecord {
  const completed = Number(row.source_completed_count ?? 0);
  const failed = Number(row.source_failed_count ?? 0);
  const running = Number(row.source_running_count ?? 0);
  const pending = Math.max(0, row.source_count - completed - failed - running);

  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    operation: row.operation,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    sourceCount: row.source_count,
    resultReleaseId: row.result_release_id,
    internalErrorCode: row.internal_error_code,
    internalErrorMessage: row.internal_error_message,
    createdAt: row.created_at.toISOString(),
    progress: {
      total: row.source_count,
      completed,
      failed,
      running,
      pending,
      currentStage: row.source_current_stage ?? inferUploadTaskCurrentStage({ row, pending })
    }
  };
}

function inferUploadTaskCurrentStage(input: {
  row: UploadTaskRow;
  pending: number;
}): SourceFileProcessingStage | null {
  if (input.row.operation !== "upload") {
    return null;
  }

  if (input.pending > 0) {
    return "upload_storage";
  }

  if (input.row.source_count > 0 && input.row.ended_at && !input.row.internal_error_code) {
    return "release_activation";
  }

  return null;
}

function sourceProgressStageOrderSql(): string {
  return [
    "CASE processing_status",
    "WHEN 'running' THEN 0",
    "WHEN 'pending' THEN 1",
    "WHEN 'failed' THEN 2",
    "WHEN 'completed' THEN 3",
    "ELSE 4",
    "END ASC,",
    "CASE processing_stage",
    "WHEN 'upload_storage' THEN 1",
    "WHEN 'metadata_resolution' THEN 2",
    "WHEN 'bundle_generation' THEN 3",
    "WHEN 'okf_validation' THEN 4",
    "WHEN 'index_publication' THEN 5",
    "WHEN 'release_activation' THEN 6",
    "ELSE 0",
    "END DESC"
  ].join(" ");
}

function mapUploadTaskEventRow(row: UploadTaskEventRow): UploadTaskEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    phaseKey: row.phase_key,
    messageKey: row.message_key,
    startedAt: row.started_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    severity: row.severity,
    createdAt: row.created_at.toISOString()
  };
}

function logActionForOperation(operation: UploadTaskOperation): string {
  if (operation === "delete_source" || operation === "delete_knowledge_base") {
    return "Deletion";
  }

  return "Update";
}

function logMessageForOperation(
  operation: UploadTaskOperation,
  fileCount: number,
  sourceCount: number
): string {
  if (operation === "delete_source") {
    return `Republished the knowledge base after deleting one source document; ${fileCount} generated files are active.`;
  }

  if (operation === "delete_knowledge_base") {
    return "Deleted the knowledge base.";
  }

  return `Published ${sourceCount} source documents and ${fileCount} generated files.`;
}

function mapPublicApiKeyRow(row: PublicApiKeyRow): PublicOpenApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    keyHash: row.key_hash,
    keyPrefix: row.key_prefix,
    keySuffix: row.key_suffix,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function serializeTimedCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseTimedCursor(cursor: string): { createdAt: string; id: string } {
  const candidate = parseCursorRecord(cursor);

  if (typeof candidate.createdAt !== "string" || typeof candidate.id !== "string") {
    throw new Error("Invalid timed cursor");
  }

  return {
    createdAt: candidate.createdAt,
    id: candidate.id
  };
}

function serializeLogicalPathCursor(cursor: { logicalPath: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseLogicalPathCursor(cursor: string): { logicalPath: string; id: string } {
  const candidate = parseCursorRecord(cursor);

  if (typeof candidate.logicalPath !== "string" || typeof candidate.id !== "string") {
    throw new Error("Invalid logical path cursor");
  }

  return {
    logicalPath: candidate.logicalPath,
    id: candidate.id
  };
}

function serializeTreeCursor(cursor: { name: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseTreeCursor(cursor: string): { name: string; id: string } {
  const candidate = parseCursorRecord(cursor);

  if (typeof candidate.name !== "string" || typeof candidate.id !== "string") {
    throw new Error("Invalid tree cursor");
  }

  return {
    name: candidate.name,
    id: candidate.id
  };
}

function parseCursorRecord(cursor: string): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid cursor");
  }

  return parsed as Record<string, unknown>;
}
