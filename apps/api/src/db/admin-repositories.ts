import { randomUUID } from "node:crypto";
import type {
  OkfGraphEdge,
  OkfGraphNode,
  OkfLogEntry,
  OkfLogMonthlySummary,
  SourceMetadataDefaults,
  SourceModelSuggestions
} from "@focowiki/okf";
import type {
  PublicOpenApiKeyRecord,
  PublicOpenApiKeyRepository,
  PublicOpenApiKeyStatus
} from "../public-openapi/keys.js";
import type { DatabaseClient } from "./client.js";
import { createPostgresFileGraphRepository } from "./file-graph-repository.js";

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
  | "link_index"
  | "graph_index"
  | "graph_manifest"
  | "graph_node_index"
  | "graph_edge_shard"
  | "graph_file";

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

export type GeneratedSourceFileOutputRecord = {
  sourceFileId: string;
  bundleFileId: string;
  logicalPath: string;
};

export type SourceFileProcessingStatus = "queued" | "running" | "completed" | "failed";

export type SourceFileProcessingStage =
  | "upload_storage"
  | "metadata_resolution"
  | "llm_suggestion"
  | "graph_generation"
  | "okf_validation"
  | "bundle_generation"
  | "index_publication"
  | "release_activation";

export type SourceFileRecord = {
  id: string;
  knowledgeBaseId: string;
  originalName: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  checksumSha256: string;
  metadata: SourceMetadataDefaults;
  modelSuggestions?: SourceModelSuggestions | null;
  processingStatus?: SourceFileProcessingStatus;
  processingStage?: SourceFileProcessingStage;
  processingStartedAt?: string | null;
  processingEndedAt?: string | null;
  processingErrorCode?: string | null;
  processingErrorMessage?: string | null;
  retryCount?: number;
  modelInvocationStatus?: ModelInvocationStatus | null;
  modelInvocationModelName?: string | null;
  modelInvocationStartedAt?: string | null;
  modelInvocationEndedAt?: string | null;
  modelInvocationWarningCount?: number | null;
  modelInvocationErrorCode?: string | null;
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
  bundleRootKey: string;
  generatedAt: string;
  publishedAt: string | null;
  fileCount: number;
  manifestChecksumSha256: string;
  createdAt: string;
};

export type ReleaseDraft = Omit<ReleaseRecord, "createdAt">;

export type SourceFileEventRecord = {
  id: string;
  knowledgeBaseId: string;
  sourceFileId: string;
  stageKey: SourceFileProcessingStage | "source_deletion";
  messageKey: string;
  startedAt: string | null;
  endedAt: string | null;
  severity: "info" | "warning" | "error";
  createdAt: string;
};

export type SourceFileEventDraft = Omit<SourceFileEventRecord, "id" | "createdAt">;

export type SourceFileRetryAttemptRecord = {
  id: string;
  knowledgeBaseId: string;
  sourceFileId: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  endedAt: string | null;
  errorCode: string | null;
  createdAt: string;
};

export type ModelInvocationStatus = "running" | "completed" | "failed" | "skipped";

export type ModelInvocationRecord = {
  id: string;
  knowledgeBaseId: string;
  sourceFileId: string;
  modelName: string;
  status: ModelInvocationStatus;
  startedAt: string;
  endedAt: string | null;
  warningCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
};

export type ModelInvocationDraft = Omit<ModelInvocationRecord, "id" | "createdAt"> & {
  id?: string;
};

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
    publishedAt: string;
    fileCount: number;
    manifestChecksumSha256: string;
  }) => Promise<void>;
  updateSourceFileProcessingState?: (input: {
    knowledgeBaseId: string;
    sourceFileIds: string[];
    status: SourceFileProcessingStatus;
    stage: SourceFileProcessingStage;
    startedAt?: string | null;
    endedAt?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }) => Promise<void>;
  updateSourceFileMetadata?: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    metadata: SourceMetadataDefaults;
  }) => Promise<void>;
  updateSourceFileModelSuggestions?: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    suggestions: SourceModelSuggestions | null;
  }) => Promise<void>;
  createSourceFileEvent?: (input: SourceFileEventDraft) => Promise<SourceFileEventRecord>;
  listSourceFileEvents?: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<SourceFileEventRecord>>;
  createSourceFileRetryAttempt?: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    status: SourceFileRetryAttemptRecord["status"];
    startedAt: string;
    endedAt?: string | null;
    errorCode?: string | null;
  }) => Promise<SourceFileRetryAttemptRecord>;
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
  getBundleFileById?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    fileId: string;
  }) => Promise<BundleFileRecord | null>;
  getSourceFile?: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<SourceFileRecord | null>;
  listSourceFiles: (request: {
    knowledgeBaseId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<SourceFileRecord>>;
  listGeneratedOutputsForSourceFiles?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    sourceFileIds: string[];
  }) => Promise<GeneratedSourceFileOutputRecord[]>;
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

export type WebhookSubscriptionRecord = {
  id: string;
  name: string;
  url: string;
  signingSecret: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastDeliveryAt: string | null;
};

export type WebhookDeliveryRecord = {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: "pending" | "success" | "failed";
  attemptCount: number;
  httpStatus: number | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WebhookRepository = {
  createWebhookSubscription: (input: {
    id: string;
    name: string;
    url: string;
    signingSecret: string;
    events: string[];
    createdAt: string;
  }) => Promise<WebhookSubscriptionRecord>;
  getWebhookSubscription?: (id: string) => Promise<WebhookSubscriptionRecord | null>;
  listWebhookSubscriptions: (request: {
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<WebhookSubscriptionRecord>>;
  deleteWebhookSubscription: (input: {
    id: string;
    updatedAt: string;
  }) => Promise<boolean>;
  createWebhookDelivery?: (input: {
    id: string;
    webhookId: string;
    eventId: string;
    eventType: string;
    payload: Record<string, unknown>;
    status: WebhookDeliveryRecord["status"];
    attemptCount: number;
    httpStatus: number | null;
    errorCode: string | null;
    createdAt: string;
  }) => Promise<WebhookDeliveryRecord>;
  updateWebhookDeliveryResult?: (input: {
    id: string;
    status: WebhookDeliveryRecord["status"];
    attemptCount: number;
    httpStatus: number | null;
    errorCode: string | null;
    updatedAt: string;
  }) => Promise<WebhookDeliveryRecord | null>;
  listWebhookDeliveries: (request: {
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<WebhookDeliveryRecord>>;
  getWebhookDelivery?: (deliveryId: string) => Promise<WebhookDeliveryRecord | null>;
};

export type FileGraphNodeRecord = OkfGraphNode & {
  knowledgeBaseId: string;
  sourceFileId: string;
  updatedAt: string;
};

export type FileGraphRelatedRecord = {
  fileId: string;
  sourceFileId: string;
  bundleFileId: string | null;
  path: string;
  title: string;
  relationType: string;
  direction: "outgoing" | "incoming";
  weight: number;
  reason: string;
  source: string;
  evidence?: Record<string, unknown>;
  contentAvailable: boolean;
};

export type FileGraphSummaryRecord = {
  sourceFileId: string;
  relationshipCount: number;
  relationships: FileGraphRelatedRecord[];
};

export type FileGraphJobRecord = {
  id: string;
  knowledgeBaseId: string;
  sourceFileId: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  endedAt: string | null;
  errorCode: string | null;
  createdAt: string;
};

export type FileGraphRepository = {
  createGraphJob?: (input: {
    id?: string;
    knowledgeBaseId: string;
    sourceFileId: string;
    startedAt: string;
  }) => Promise<FileGraphJobRecord>;
  completeGraphJob?: (input: {
    id: string;
    status: FileGraphJobRecord["status"];
    endedAt: string;
    errorCode?: string | null;
  }) => Promise<FileGraphJobRecord | null>;
  upsertGraphNode: (input: {
    knowledgeBaseId: string;
    node: OkfGraphNode;
  }) => Promise<void>;
  upsertGraphEdges: (input: {
    knowledgeBaseId: string;
    edges: OkfGraphEdge[];
  }) => Promise<void>;
  upsertRejectedGraphEdges?: (input: {
    knowledgeBaseId: string;
    edges: OkfGraphEdge[];
  }) => Promise<void>;
  listGraphNodes: (request: {
    knowledgeBaseId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<OkfGraphNode>>;
  listGraphEdges: (request: {
    knowledgeBaseId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<OkfGraphEdge>>;
  listGraphNeighborhood: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
    limit: number;
    cursor?: string | null;
  }) => Promise<CursorPage<FileGraphRelatedRecord>>;
  getGraphSummary?: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
    limit: number;
  }) => Promise<FileGraphSummaryRecord>;
  deleteGraphForSourceFile: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<void>;
};

export type AdminRepositories = {
  knowledgeBases: KnowledgeBaseRepository;
  files?: BundleFileRepository;
  graph?: FileGraphRepository;
  modelInvocations?: {
    createModelInvocation: (input: ModelInvocationDraft) => Promise<ModelInvocationRecord>;
    completeModelInvocation: (input: {
      id: string;
      status: ModelInvocationStatus;
      endedAt: string;
      warningCount?: number;
      errorCode?: string | null;
      errorMessage?: string | null;
    }) => Promise<ModelInvocationRecord | null>;
  };
  securityAudit?: {
    createSecurityAuditEvent: (input: SecurityAuditEventDraft) => Promise<void>;
  };
  publicApiKeys?: PublicOpenApiKeyRepository;
  webhooks?: WebhookRepository;
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

type GeneratedSourceFileOutputRow = {
  source_file_id: string;
  bundle_file_id: string;
  logical_path: string;
};

type SourceFileRow = {
  id: string;
  knowledge_base_id: string;
  original_name: string;
  object_key: string;
  content_type: string;
  size_bytes: string | number;
  checksum_sha256: string;
  metadata_json: unknown;
  model_suggestions_json: unknown;
  processing_status: SourceFileProcessingStatus;
  processing_stage: SourceFileProcessingStage;
  processing_started_at: Date | null;
  processing_ended_at: Date | null;
  processing_error_code: string | null;
  processing_error_message: string | null;
  retry_count: string | number;
  model_invocation_status?: ModelInvocationStatus | null;
  model_invocation_model_name?: string | null;
  model_invocation_started_at?: Date | null;
  model_invocation_ended_at?: Date | null;
  model_invocation_warning_count?: string | number | null;
  model_invocation_error_code?: string | null;
  created_at: Date;
  created_at_cursor?: string;
  deleted_at: Date | null;
};

type ReleaseRow = {
  id: string;
  knowledge_base_id: string;
  bundle_root_key: string;
  generated_at: Date;
  published_at: Date | null;
  file_count: number;
  manifest_checksum_sha256: string;
  created_at: Date;
};

type PublicationLogEntryRow = {
  occurred_at: Date;
  file_count: number;
};

type PublicationLogSummaryRow = {
  month: string;
  publication_count: string | number;
  changed_file_count: string | number;
};

type ModelInvocationRow = {
  id: string;
  knowledge_base_id: string;
  source_file_id: string;
  model_name: string;
  status: ModelInvocationStatus;
  started_at: Date;
  ended_at: Date | null;
  warning_count: number;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
};

type SourceFileEventRow = {
  id: string;
  knowledge_base_id: string;
  source_file_id: string;
  stage_key: SourceFileEventRecord["stageKey"];
  message_key: string;
  started_at: Date | null;
  ended_at: Date | null;
  severity: SourceFileEventRecord["severity"];
  created_at: Date;
};

type SourceFileRetryAttemptRow = {
  id: string;
  knowledge_base_id: string;
  source_file_id: string;
  status: SourceFileRetryAttemptRecord["status"];
  started_at: Date;
  ended_at: Date | null;
  error_code: string | null;
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

type WebhookSubscriptionRow = {
  id: string;
  name: string;
  url: string;
  signing_secret: string;
  events_json: unknown;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  last_delivery_at: Date | null;
};

type WebhookDeliveryRow = {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  payload_json: unknown;
  status: "pending" | "success" | "failed";
  attempt_count: number;
  http_status: number | null;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
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
              original_name,
              object_key,
              content_type,
              size_bytes,
              checksum_sha256,
              metadata_json,
              model_suggestions_json,
              processing_status,
              processing_stage,
              processing_started_at,
              processing_ended_at,
              processing_error_code,
              processing_error_message,
              retry_count
            )
            VALUES (
              ${file.id},
              ${file.knowledgeBaseId},
              ${file.originalName},
              ${file.objectKey},
              ${file.contentType},
              ${file.sizeBytes},
              ${file.checksumSha256},
              ${sql.json(file.metadata as never)},
              ${file.modelSuggestions ? sql.json(file.modelSuggestions as never) : null},
              ${file.processingStatus ?? "queued"},
              ${file.processingStage ?? "upload_storage"},
              ${file.processingStartedAt ?? null},
              ${file.processingEndedAt ?? null},
              ${file.processingErrorCode ?? null},
              ${file.processingErrorMessage ?? null},
              ${file.retryCount ?? 0}
            )
          `;
        }
      },
      async createRelease(release) {
        await sql`
          INSERT INTO focowiki.releases (
            id,
            knowledge_base_id,
            bundle_root_key,
            generated_at,
            published_at,
            file_count,
            manifest_checksum_sha256
          )
          VALUES (
            ${release.id},
            ${release.knowledgeBaseId},
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
          `;
          await transaction`
            UPDATE focowiki.knowledge_bases
            SET
              active_release_id = ${input.releaseId},
              updated_at = now()
            WHERE id = ${input.knowledgeBaseId}
              AND deleted_at IS NULL
          `;
        });
      },
      async updateSourceFileProcessingState({
        knowledgeBaseId,
        sourceFileIds,
        status,
        stage,
        startedAt,
        endedAt,
        errorCode,
        errorMessage
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
            processing_error_code = ${errorCode ?? null},
            processing_error_message = ${errorMessage ?? null}
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND id = ANY(${sourceFileIds})
        `;
      },
      async updateSourceFileMetadata({ knowledgeBaseId, sourceFileId, metadata }) {
        await sql`
          UPDATE focowiki.source_files
          SET metadata_json = ${sql.json(metadata as never)}
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND id = ${sourceFileId}
            AND deleted_at IS NULL
        `;
      },
      async updateSourceFileModelSuggestions({ knowledgeBaseId, sourceFileId, suggestions }) {
        await sql`
          UPDATE focowiki.source_files
          SET model_suggestions_json = ${suggestions ? sql.json(suggestions as never) : null}
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND id = ${sourceFileId}
            AND deleted_at IS NULL
        `;
      },
      async createSourceFileEvent(input) {
        const rows = await sql<SourceFileEventRow[]>`
          INSERT INTO focowiki.source_file_events (
            id,
            knowledge_base_id,
            source_file_id,
            stage_key,
            message_key,
            started_at,
            ended_at,
            severity
          )
          VALUES (
            ${createSourceFileEventId()},
            ${input.knowledgeBaseId},
            ${input.sourceFileId},
            ${input.stageKey},
            ${input.messageKey},
            ${input.startedAt},
            ${input.endedAt},
            ${input.severity}
          )
          RETURNING id, knowledge_base_id, source_file_id, stage_key, message_key, started_at, ended_at, severity, created_at
        `;
        const row = rows[0];

        if (!row) {
          throw new Error("Source file event creation did not return a row");
        }

        return mapSourceFileEventRow(row);
      },
      async listSourceFileEvents({ knowledgeBaseId, sourceFileId, limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<SourceFileEventRow[]>`
              SELECT id, knowledge_base_id, source_file_id, stage_key, message_key, started_at, ended_at, severity, created_at
              FROM focowiki.source_file_events
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND source_file_id = ${sourceFileId}
                AND (created_at > ${cursorValue.createdAt} OR (created_at = ${cursorValue.createdAt} AND id > ${cursorValue.id}))
              ORDER BY created_at ASC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<SourceFileEventRow[]>`
              SELECT id, knowledge_base_id, source_file_id, stage_key, message_key, started_at, ended_at, severity, created_at
              FROM focowiki.source_file_events
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND source_file_id = ${sourceFileId}
              ORDER BY created_at ASC, id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);
        return {
          items: pageRows.map(mapSourceFileEventRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTimedCursor({ createdAt: lastRow.created_at.toISOString(), id: lastRow.id })
              : null
        };
      },
      async createSourceFileRetryAttempt(input) {
        const rows = await sql.begin(async (transaction) => {
          const inserted = await transaction<SourceFileRetryAttemptRow[]>`
            INSERT INTO focowiki.source_file_retry_attempts (
              id,
              knowledge_base_id,
              source_file_id,
              status,
              started_at,
              ended_at,
              error_code
            )
            VALUES (
              ${createSourceFileRetryAttemptId()},
              ${input.knowledgeBaseId},
              ${input.sourceFileId},
              ${input.status},
              ${input.startedAt},
              ${input.endedAt ?? null},
              ${input.errorCode ?? null}
            )
            RETURNING id, knowledge_base_id, source_file_id, status, started_at, ended_at, error_code, created_at
          `;
          await transaction`
            UPDATE focowiki.source_files
            SET retry_count = retry_count + 1
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND id = ${input.sourceFileId}
              AND deleted_at IS NULL
          `;
          return inserted;
        });
        const row = rows[0];

        if (!row) {
          throw new Error("Source file retry attempt creation did not return a row");
        }

        return mapSourceFileRetryAttemptRow(row);
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
      async getBundleFileById({ knowledgeBaseId, releaseId, fileId }) {
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
            AND id = ${fileId}
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapBundleFileRow(row) : null;
      },
      async getSourceFile({ knowledgeBaseId, sourceFileId }) {
        const rows = await sql<SourceFileRow[]>`
          SELECT source.id, source.knowledge_base_id, source.original_name, source.object_key, source.content_type, source.size_bytes, source.checksum_sha256, source.metadata_json, source.model_suggestions_json, source.processing_status, source.processing_stage, source.processing_started_at, source.processing_ended_at, source.processing_error_code, source.processing_error_message, source.retry_count, source.created_at, source.deleted_at, model.status AS model_invocation_status, model.model_name AS model_invocation_model_name, model.started_at AS model_invocation_started_at, model.ended_at AS model_invocation_ended_at, model.warning_count AS model_invocation_warning_count, model.error_code AS model_invocation_error_code
          FROM focowiki.source_files source
          LEFT JOIN LATERAL (
            SELECT status, model_name, started_at, ended_at, warning_count, error_code
            FROM focowiki.model_invocations
            WHERE source_file_id = source.id
            ORDER BY created_at DESC, id DESC
            LIMIT 1
          ) model ON true
          WHERE source.knowledge_base_id = ${knowledgeBaseId}
            AND source.id = ${sourceFileId}
            AND source.deleted_at IS NULL
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapSourceFileRow(row) : null;
      },
      async listSourceFiles({ knowledgeBaseId, limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<SourceFileRow[]>`
              SELECT source.id, source.knowledge_base_id, source.original_name, source.object_key, source.content_type, source.size_bytes, source.checksum_sha256, source.metadata_json, source.model_suggestions_json, source.processing_status, source.processing_stage, source.processing_started_at, source.processing_ended_at, source.processing_error_code, source.processing_error_message, source.retry_count, source.created_at, source.deleted_at, model.status AS model_invocation_status, model.model_name AS model_invocation_model_name, model.started_at AS model_invocation_started_at, model.ended_at AS model_invocation_ended_at, model.warning_count AS model_invocation_warning_count, model.error_code AS model_invocation_error_code
              FROM focowiki.source_files source
              LEFT JOIN LATERAL (
                SELECT status, model_name, started_at, ended_at, warning_count, error_code
                FROM focowiki.model_invocations
                WHERE source_file_id = source.id
                ORDER BY created_at DESC, id DESC
                LIMIT 1
              ) model ON true
              WHERE source.knowledge_base_id = ${knowledgeBaseId}
                AND source.deleted_at IS NULL
                AND (
                  source.created_at < ${cursorValue.createdAt}
                  OR (source.created_at = ${cursorValue.createdAt} AND source.id > ${cursorValue.id})
                )
              ORDER BY source.created_at DESC, source.id ASC
              LIMIT ${limit + 1}
            `
          : await sql<SourceFileRow[]>`
              SELECT source.id, source.knowledge_base_id, source.original_name, source.object_key, source.content_type, source.size_bytes, source.checksum_sha256, source.metadata_json, source.model_suggestions_json, source.processing_status, source.processing_stage, source.processing_started_at, source.processing_ended_at, source.processing_error_code, source.processing_error_message, source.retry_count, source.created_at, source.deleted_at, model.status AS model_invocation_status, model.model_name AS model_invocation_model_name, model.started_at AS model_invocation_started_at, model.ended_at AS model_invocation_ended_at, model.warning_count AS model_invocation_warning_count, model.error_code AS model_invocation_error_code
              FROM focowiki.source_files source
              LEFT JOIN LATERAL (
                SELECT status, model_name, started_at, ended_at, warning_count, error_code
                FROM focowiki.model_invocations
                WHERE source_file_id = source.id
                ORDER BY created_at DESC, id DESC
                LIMIT 1
              ) model ON true
              WHERE source.knowledge_base_id = ${knowledgeBaseId}
                AND source.deleted_at IS NULL
              ORDER BY source.created_at DESC, source.id ASC
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
      async listGeneratedOutputsForSourceFiles({ knowledgeBaseId, releaseId, sourceFileIds }) {
        if (sourceFileIds.length === 0) {
          return [];
        }

        const rows = await sql<GeneratedSourceFileOutputRow[]>`
          SELECT
            source_file_id,
            id AS bundle_file_id,
            logical_path
          FROM focowiki.bundle_files
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND release_id = ${releaseId}
            AND source_file_id = ANY(${sourceFileIds})
            AND file_kind = 'page'
          ORDER BY source_file_id ASC, logical_path ASC, id ASC
        `;
        const firstBySourceFile = new Map<string, GeneratedSourceFileOutputRecord>();

        for (const row of rows) {
          if (!firstBySourceFile.has(row.source_file_id)) {
            firstBySourceFile.set(row.source_file_id, mapGeneratedSourceFileOutputRow(row));
          }
        }

        return Array.from(firstBySourceFile.values());
      },
      async listReleases({ knowledgeBaseId, limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<ReleaseRow[]>`
              SELECT id, knowledge_base_id, bundle_root_key, generated_at, published_at, file_count, manifest_checksum_sha256, created_at
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
              SELECT id, knowledge_base_id, bundle_root_key, generated_at, published_at, file_count, manifest_checksum_sha256, created_at
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
            release.file_count
          FROM focowiki.releases release
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
            action: "Update",
            message: `Published ${row.file_count} generated files.`,
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
    graph: createPostgresFileGraphRepository(sql),
    modelInvocations: {
      async createModelInvocation(input) {
        const rows = await sql<ModelInvocationRow[]>`
          INSERT INTO focowiki.model_invocations (
            id,
            knowledge_base_id,
            source_file_id,
            model_name,
            status,
            started_at,
            ended_at,
            warning_count,
            error_code,
            error_message
          )
          VALUES (
            ${input.id ?? createModelInvocationId()},
            ${input.knowledgeBaseId},
            ${input.sourceFileId},
            ${input.modelName},
            ${input.status},
            ${input.startedAt},
            ${input.endedAt},
            ${input.warningCount},
            ${input.errorCode},
            ${input.errorMessage}
          )
          RETURNING
            id,
            knowledge_base_id,
            source_file_id,
            model_name,
            status,
            started_at,
            ended_at,
            warning_count,
            error_code,
            error_message,
            created_at
        `;
        const row = rows[0];

        if (!row) {
          throw new Error("Model invocation creation did not return a row");
        }

        return mapModelInvocationRow(row);
      },
      async completeModelInvocation(input) {
        const rows = await sql<ModelInvocationRow[]>`
          UPDATE focowiki.model_invocations
          SET
            status = ${input.status},
            ended_at = ${input.endedAt},
            warning_count = ${input.warningCount ?? 0},
            error_code = ${input.errorCode ?? null},
            error_message = ${input.errorMessage ?? null}
          WHERE id = ${input.id}
          RETURNING
            id,
            knowledge_base_id,
            source_file_id,
            model_name,
            status,
            started_at,
            ended_at,
            warning_count,
            error_code,
            error_message,
            created_at
        `;
        const row = rows[0];
        return row ? mapModelInvocationRow(row) : null;
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
    },
    webhooks: {
      async createWebhookSubscription(input) {
        const rows = await sql<WebhookSubscriptionRow[]>`
          INSERT INTO focowiki.webhook_subscriptions (
            id,
            name,
            url,
            signing_secret,
            events_json,
            created_at,
            updated_at
          )
          VALUES (
            ${input.id},
            ${input.name},
            ${input.url},
            ${input.signingSecret},
            ${sql.json(input.events as never)},
            ${input.createdAt},
            ${input.createdAt}
          )
          RETURNING id, name, url, signing_secret, events_json, enabled, created_at, updated_at, last_delivery_at
        `;
        const row = rows[0];

        if (!row) {
          throw new Error("Webhook subscription creation did not return a row");
        }

        return mapWebhookSubscriptionRow(row);
      },
      async getWebhookSubscription(id) {
        const rows = await sql<WebhookSubscriptionRow[]>`
          SELECT id, name, url, signing_secret, events_json, enabled, created_at, updated_at, last_delivery_at
          FROM focowiki.webhook_subscriptions
          WHERE id = ${id}
            AND enabled = true
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapWebhookSubscriptionRow(row) : null;
      },
      async listWebhookSubscriptions({ limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<WebhookSubscriptionRow[]>`
              SELECT id, name, url, signing_secret, events_json, enabled, created_at, updated_at, last_delivery_at
              FROM focowiki.webhook_subscriptions
              WHERE enabled = true
                AND (
                  created_at < ${cursorValue.createdAt}
                  OR (created_at = ${cursorValue.createdAt} AND id > ${cursorValue.id})
                )
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<WebhookSubscriptionRow[]>`
              SELECT id, name, url, signing_secret, events_json, enabled, created_at, updated_at, last_delivery_at
              FROM focowiki.webhook_subscriptions
              WHERE enabled = true
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);
        return {
          items: pageRows.map(mapWebhookSubscriptionRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTimedCursor({
                  createdAt: lastRow.created_at.toISOString(),
                  id: lastRow.id
                })
              : null
        };
      },
      async deleteWebhookSubscription({ id, updatedAt }) {
        const rows = await sql<Array<{ id: string }>>`
          UPDATE focowiki.webhook_subscriptions
          SET enabled = false, updated_at = ${updatedAt}
          WHERE id = ${id}
            AND enabled = true
          RETURNING id
        `;
        return rows.length > 0;
      },
      async createWebhookDelivery(input) {
        const rows = await sql<WebhookDeliveryRow[]>`
          INSERT INTO focowiki.webhook_deliveries (
            id,
            webhook_id,
            event_id,
            event_type,
            payload_json,
            status,
            attempt_count,
            http_status,
            error_code,
            created_at,
            updated_at
          )
          VALUES (
            ${input.id},
            ${input.webhookId},
            ${input.eventId},
            ${input.eventType},
            ${sql.json(input.payload as never)},
            ${input.status},
            ${input.attemptCount},
            ${input.httpStatus},
            ${input.errorCode},
            ${input.createdAt},
            ${input.createdAt}
          )
          RETURNING id, webhook_id, event_id, event_type, payload_json, status, attempt_count, http_status, error_code, created_at, updated_at
        `;
        const row = rows[0];

        if (!row) {
          throw new Error("Webhook delivery creation did not return a row");
        }

        return mapWebhookDeliveryRow(row);
      },
      async updateWebhookDeliveryResult(input) {
        const rows = await sql<WebhookDeliveryRow[]>`
          UPDATE focowiki.webhook_deliveries
          SET status = ${input.status},
              attempt_count = ${input.attemptCount},
              http_status = ${input.httpStatus},
              error_code = ${input.errorCode},
              updated_at = ${input.updatedAt}
          WHERE id = ${input.id}
          RETURNING id, webhook_id, event_id, event_type, payload_json, status, attempt_count, http_status, error_code, created_at, updated_at
        `;
        const row = rows[0];
        return row ? mapWebhookDeliveryRow(row) : null;
      },
      async listWebhookDeliveries({ limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<WebhookDeliveryRow[]>`
              SELECT id, webhook_id, event_id, event_type, payload_json, status, attempt_count, http_status, error_code, created_at, updated_at
              FROM focowiki.webhook_deliveries
              WHERE (
                created_at < ${cursorValue.createdAt}
                OR (created_at = ${cursorValue.createdAt} AND id > ${cursorValue.id})
              )
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<WebhookDeliveryRow[]>`
              SELECT id, webhook_id, event_id, event_type, payload_json, status, attempt_count, http_status, error_code, created_at, updated_at
              FROM focowiki.webhook_deliveries
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);
        return {
          items: pageRows.map(mapWebhookDeliveryRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTimedCursor({
                  createdAt: lastRow.created_at.toISOString(),
                  id: lastRow.id
                })
              : null
        };
      },
      async getWebhookDelivery(deliveryId) {
        const rows = await sql<WebhookDeliveryRow[]>`
          SELECT id, webhook_id, event_id, event_type, payload_json, status, attempt_count, http_status, error_code, created_at, updated_at
          FROM focowiki.webhook_deliveries
          WHERE id = ${deliveryId}
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapWebhookDeliveryRow(row) : null;
      }
    }
  };
}

export function createKnowledgeBaseId(): string {
  return `kb-${randomUUID()}`;
}

export function createSourceFileEventId(): string {
  return `source-event-${randomUUID()}`;
}

export function createSourceFileRetryAttemptId(): string {
  return `source-retry-${randomUUID()}`;
}

export function createModelInvocationId(): string {
  return `model-invocation-${randomUUID()}`;
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

function mapGeneratedSourceFileOutputRow(
  row: GeneratedSourceFileOutputRow
): GeneratedSourceFileOutputRecord {
  return {
    sourceFileId: row.source_file_id,
    bundleFileId: row.bundle_file_id,
    logicalPath: row.logical_path
  };
}

function mapSourceFileRow(row: SourceFileRow): SourceFileRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    originalName: row.original_name,
    objectKey: row.object_key,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    checksumSha256: row.checksum_sha256,
    metadata: readRecord(row.metadata_json) as SourceMetadataDefaults,
    modelSuggestions: readOptionalRecord(row.model_suggestions_json) as SourceModelSuggestions | null,
    processingStatus: row.processing_status,
    processingStage: row.processing_stage,
    processingStartedAt: row.processing_started_at?.toISOString() ?? null,
    processingEndedAt: row.processing_ended_at?.toISOString() ?? null,
    processingErrorCode: row.processing_error_code,
    processingErrorMessage: row.processing_error_message,
    retryCount: Number(row.retry_count),
    modelInvocationStatus: row.model_invocation_status ?? null,
    modelInvocationModelName: row.model_invocation_model_name ?? null,
    modelInvocationStartedAt: row.model_invocation_started_at?.toISOString() ?? null,
    modelInvocationEndedAt: row.model_invocation_ended_at?.toISOString() ?? null,
    modelInvocationWarningCount:
      row.model_invocation_warning_count === undefined ||
      row.model_invocation_warning_count === null
        ? null
        : Number(row.model_invocation_warning_count),
    modelInvocationErrorCode: row.model_invocation_error_code ?? null,
    createdAt: row.created_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null
  };
}

function mapReleaseRow(row: ReleaseRow): ReleaseRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    bundleRootKey: row.bundle_root_key,
    generatedAt: row.generated_at.toISOString(),
    publishedAt: row.published_at?.toISOString() ?? null,
    fileCount: row.file_count,
    manifestChecksumSha256: row.manifest_checksum_sha256,
    createdAt: row.created_at.toISOString()
  };
}

function mapModelInvocationRow(row: ModelInvocationRow): ModelInvocationRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceFileId: row.source_file_id,
    modelName: row.model_name,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    warningCount: row.warning_count,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString()
  };
}

function mapSourceFileEventRow(row: SourceFileEventRow): SourceFileEventRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceFileId: row.source_file_id,
    stageKey: row.stage_key,
    messageKey: row.message_key,
    startedAt: row.started_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    severity: row.severity,
    createdAt: row.created_at.toISOString()
  };
}

function mapSourceFileRetryAttemptRow(row: SourceFileRetryAttemptRow): SourceFileRetryAttemptRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceFileId: row.source_file_id,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString()
  };
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

function mapWebhookSubscriptionRow(row: WebhookSubscriptionRow): WebhookSubscriptionRecord {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    signingSecret: row.signing_secret,
    events: readStringArray(row.events_json),
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastDeliveryAt: row.last_delivery_at?.toISOString() ?? null
  };
}

function mapWebhookDeliveryRow(row: WebhookDeliveryRow): WebhookDeliveryRecord {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    eventId: row.event_id,
    eventType: row.event_type,
    payload: readRecord(row.payload_json),
    status: row.status,
    attemptCount: row.attempt_count,
    httpStatus: row.http_status,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
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

function readOptionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
