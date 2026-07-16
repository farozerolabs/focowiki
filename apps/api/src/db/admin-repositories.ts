import { randomUUID } from "node:crypto";
import type {
  OkfGraphEdge,
  OkfGraphNode,
  OkfLogEntry,
  OkfLogMonthlySummary,
  SourceMetadataDefaults,
  SourceModelSuggestions
} from "@focowiki/okf";
import { SYMMETRIC_GRAPH_RELATION_TYPES } from "@focowiki/okf";
import type {
  PublicOpenApiKeyRecord,
  PublicOpenApiKeyRepository,
  PublicOpenApiKeyStatus
} from "../public-openapi/keys.js";
import type { DatabaseClient } from "./client.js";
import {
  cleanReleaseReadModelGinPendingLists,
  type ReleaseSearchIndexMaintenanceResult
} from "../infrastructure/postgres/release-search-index-maintenance.js";
import type { UploadSessionRepository } from "../application/ports/upload-session-repository.js";
import { createPostgresUploadSessionRepository } from "../infrastructure/postgres/upload-session-repository.js";
import type { SourceResourceRepository } from "../application/ports/source-resource-repository.js";
import { createPostgresSourceResourceRepository } from "../infrastructure/postgres/source-resource-repository.js";
import type { ReleasePublicationRepository } from "../application/ports/release-publication-repository.js";
import { createPostgresReleasePublicationRepository } from "../infrastructure/postgres/release-publication-repository.js";
import { createPostgresFileGraphRepository } from "./file-graph-repository.js";
import {
  createPostgresHardDeleteRepository,
  type HardDeleteRepository
} from "./hard-delete-repository.js";
import { createSourceFileListFilterPredicate } from "./source-file-list-predicates.js";
import {
  createPostgresWorkerJobRepository,
  type WorkerJobRepository
} from "./worker-job-repository.js";
import {
  createGeneratedFileSearchDocument,
  type GeneratedFileSearchScope
} from "../search/generated-file-search-documents.js";
import { createSearchQueryTerms } from "../search/search-query-terms.js";
import {
  graphRefForSourceFile,
  type GraphSearchContext,
  type GraphSearchDepth,
  type GraphSearchMatchType
} from "../search/graph-search-documents.js";
import {
  createRuntimeSettingsRepository,
  type RuntimeSettingsRepository
} from "../runtime-settings/repository.js";
import type { ModelApiMode } from "../runtime-settings/types.js";
import { PublicationCatalogStaleError } from "../domain/publication.js";
import type {
  PublicationJobMode,
  PublicationJobReason
} from "../domain/publication-job.js";

export type {
  PublicationJobMode,
  PublicationJobReason
} from "../domain/publication-job.js";

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type ReleaseReadSummaryRecord = {
  releaseId: string;
  knowledgeBaseId: string;
  searchableFileCount: number;
  treeNodeCount: number;
  graphDocumentCount: number;
  graphRelationshipCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
};

export type ReleaseGraphInsightsRecord = {
  releaseId: string;
  knowledgeBaseId: string;
  generatedAt: string;
  insights: Record<string, unknown>[];
};

export type KnowledgeBaseRecord = {
  id: string;
  name: string;
  description: string | null;
  activeReleaseId: string | null;
  resourceRevision?: number;
  catalogGeneration: number;
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
    query?: string | null;
  }) => Promise<CursorPage<KnowledgeBaseRecord>>;
  createKnowledgeBase: (input: CreateKnowledgeBaseInput) => Promise<KnowledgeBaseRecord>;
  getKnowledgeBase: (id: string) => Promise<KnowledgeBaseRecord | null>;
};

export type BundleTreeEntryRecord = {
  id: string;
  knowledgeBaseId: string;
  releaseId: string;
  parentPath: string;
  name: string;
  logicalPath: string;
  sortKey: string;
  entryType: "directory" | "file";
  bundleFileId: string | null;
  sourceFileId: string | null;
  sourceDirectoryId?: string | null;
  fileKind: BundleFileKind | null;
  childCount: number;
  directFileCount?: number;
  descendantFileCount?: number;
  resourceRevision?: number | null;
};

export type BundleTreeEntryDraft = Omit<
  BundleTreeEntryRecord,
  | "sourceFileId"
  | "sourceDirectoryId"
  | "fileKind"
  | "sortKey"
  | "childCount"
  | "directFileCount"
  | "descendantFileCount"
  | "resourceRevision"
> & {
  sortKey?: string;
  childCount?: number;
};

export type BundleTreeSearchResultRecord = {
  entry: BundleTreeEntryRecord;
  ancestors: BundleTreeEntryRecord[];
};

export type BundleFileKind =
  | "page"
  | "index"
  | "log"
  | "history_page"
  | "schema"
  | "directory_index"
  | "directory_index_page"
  | "directory_index_map"
  | "index_catalog"
  | "manifest_index"
  | "manifest_index_shard"
  | "search_index"
  | "search_index_shard"
  | "link_index"
  | "link_index_shard"
  | "change_index"
  | "change_index_shard"
  | "graph_index"
  | "graph_manifest"
  | "graph_node_index"
  | "graph_edge_shard"
  | "graph_file"
  | "graph_community"
  | "graph_insight";

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

export type BundleFileSearchResultRecord = {
  fileId: string;
  knowledgeBaseId: string;
  releaseId: string;
  sourceFileId: string | null;
  fileKind: BundleFileKind;
  path: string;
  title: string | null;
  description: string | null;
  tags: string[];
  frontmatter: Record<string, unknown>;
  matchedFields: Array<"path" | "title" | "description" | "metadata">;
  score: number;
  contentAvailable: boolean;
};

export type BundleGraphSearchIndexResult = {
  documentCount: number;
  relationshipCount: number;
};

export type BundleGraphSearchResultRecord = BundleFileSearchResultRecord & {
  matchType: GraphSearchMatchType;
  graphContext: GraphSearchContext;
};

export type GeneratedSourceFileOutputRecord = {
  sourceFileId: string;
  bundleFileId: string;
  logicalPath: string;
};

export type SourceFileProcessingStatus = "queued" | "running" | "completed" | "failed";
export type GeneratedOutputStatus = "pending" | "visible" | "unavailable";
export type SourceFileErrorState = "with_error" | "without_error";
export type SourceFileActionState = "openable" | "retryable" | "none";
export type PublicationJobStatus = "queued" | "running" | "completed" | "failed";
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
  name: string;
  relativePath: string;
  resourceRevision?: number;
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
  generatedOutputStatus?: GeneratedOutputStatus;
  generatedBundleFileId?: string | null;
  generatedBundleFilePath?: string | null;
  publicationDirtyAt?: string | null;
  publicationVisibleAt?: string | null;
  publicationErrorCode?: string | null;
  publicationErrorMessage?: string | null;
  retryCount?: number;
  modelInvocationStatus?: ModelInvocationStatus | null;
  modelInvocationModelName?: string | null;
  modelInvocationStartedAt?: string | null;
  modelInvocationEndedAt?: string | null;
  modelInvocationWarningCount?: number | null;
  modelInvocationErrorCode?: string | null;
  createdAt: string;
  taskDeletedAt?: string | null;
  deletedAt: string | null;
};

const SOURCE_FILE_SELECT_COLUMNS = `
  source.id,
  source.knowledge_base_id,
  source.relative_path,
  source.resource_revision,
  source.object_key,
  source.content_type,
  source.size_bytes,
  source.checksum_sha256,
  source.metadata_json,
  source.model_suggestions_json,
  source.processing_status,
  source.processing_stage,
  source.processing_started_at,
  source.processing_ended_at,
  source.processing_error_code,
  source.processing_error_message,
  source.generated_output_status,
  source.generated_bundle_file_id,
  source.generated_bundle_file_path,
  source.model_invocation_status,
  source.model_invocation_model_name,
  source.model_invocation_started_at,
  source.model_invocation_ended_at,
  source.model_invocation_warning_count,
  source.model_invocation_error_code,
  source.publication_dirty_at,
  source.publication_visible_at,
  source.publication_error_code,
  source.publication_error_message,
  source.retry_count,
  source.created_at,
  source.task_deleted_at,
  source.deleted_at
`;

const SOURCE_FILE_PROCESSING_SELECT_COLUMNS = `
  source.id,
  source.knowledge_base_id,
  COALESCE(source.candidate_relative_path, source.relative_path) AS relative_path,
  COALESCE(source.candidate_object_key, source.object_key) AS object_key,
  COALESCE(source.candidate_content_type, source.content_type) AS content_type,
  COALESCE(source.candidate_size_bytes, source.size_bytes) AS size_bytes,
  COALESCE(source.candidate_checksum_sha256, source.checksum_sha256) AS checksum_sha256,
  COALESCE(source.candidate_metadata_json, source.metadata_json) AS metadata_json,
  CASE WHEN source.candidate_operation_id IS NULL
    THEN source.model_suggestions_json ELSE source.candidate_model_suggestions_json END AS model_suggestions_json,
  source.processing_status,
  source.processing_stage,
  source.processing_started_at,
  source.processing_ended_at,
  source.processing_error_code,
  source.processing_error_message,
  source.generated_output_status,
  source.generated_bundle_file_id,
  source.generated_bundle_file_path,
  source.model_invocation_status,
  source.model_invocation_model_name,
  source.model_invocation_started_at,
  source.model_invocation_ended_at,
  source.model_invocation_warning_count,
  source.model_invocation_error_code,
  source.publication_dirty_at,
  source.publication_visible_at,
  source.publication_error_code,
  source.publication_error_message,
  source.retry_count,
  source.created_at,
  source.task_deleted_at,
  source.deleted_at
`;

export type ReleaseRecord = {
  id: string;
  knowledgeBaseId: string;
  bundleRootKey: string;
  catalogGeneration: number;
  generatedAt: string;
  publishedAt: string | null;
  fileCount: number;
  manifestChecksumSha256: string;
  createdAt: string;
};

export type ReleaseDraft = Omit<ReleaseRecord, "createdAt">;

export type PublicationJobRecord = {
  id: string;
  knowledgeBaseId: string;
  mode: PublicationJobMode;
  reason: PublicationJobReason;
  status: PublicationJobStatus;
  dirtySourceCount: number;
  releaseId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

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

export type SourceFileTaskDeletionSkippedReason =
  | "missing"
  | "wrong_knowledge_base"
  | "already_removed"
  | "running"
  | "job_already_claimed"
  | "completed_pending"
  | "publication_owned";

export type SourceFileTaskDeletionRepositoryResult =
  | {
      sourceFileId: string;
      outcome: "deleted";
      objectKey: string;
    }
  | {
      sourceFileId: string;
      outcome: "hidden";
      generatedFileId: string | null;
      generatedFilePath: string | null;
    }
  | {
      sourceFileId: string;
      outcome: "skipped";
      reason: SourceFileTaskDeletionSkippedReason;
    };

export type ModelInvocationStatus = "running" | "completed" | "failed" | "skipped";
export type SourceFileModelInvocationFilter = ModelInvocationStatus | "not_recorded";

export type SourceFileListFilters = {
  fileNameQuery?: string | null;
  fileIdQuery?: string | null;
  processingStatus?: SourceFileProcessingStatus | null;
  processingStage?: SourceFileProcessingStage | null;
  modelInvocationStatus?: SourceFileModelInvocationFilter | null;
  generatedOutputStatus?: GeneratedOutputStatus | null;
  startedFrom?: string | null;
  startedTo?: string | null;
  endedFrom?: string | null;
  endedTo?: string | null;
  errorState?: SourceFileErrorState | null;
  errorCodeQuery?: string | null;
  actionState?: SourceFileActionState | null;
};

export type ModelInvocationRecord = {
  id: string;
  knowledgeBaseId: string;
  sourceFileId: string;
  modelConfigId?: string | null;
  apiMode?: ModelApiMode | null;
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
    entryType?: BundleTreeEntryRecord["entryType"] | null;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<BundleTreeEntryRecord>>;
  searchBundleTreeEntries?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    query: string;
    entryType?: BundleTreeEntryRecord["entryType"] | null;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<BundleTreeSearchResultRecord>>;
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
  listGeneratedOutputsForSourceFiles?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    sourceFileIds: string[];
  }) => Promise<GeneratedSourceFileOutputRecord[]>;
  getSourceFile?: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<SourceFileRecord | null>;
  getSourceFileForProcessing?: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<SourceFileRecord | null>;
  listSourceFiles: (request: {
    knowledgeBaseId: string;
    limit: number;
    cursor: string | null;
  } & SourceFileListFilters) => Promise<CursorPage<SourceFileRecord>>;
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
  listReusableBundleFiles?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<BundleFileRecord>>;
  getReleaseReadSummary?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
  }) => Promise<ReleaseReadSummaryRecord | null>;
  getReleaseGraphInsights?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    limit: number;
  }) => Promise<ReleaseGraphInsightsRecord | null>;
  refreshReleaseReadSummary?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
  }) => Promise<ReleaseReadSummaryRecord>;
  finalizeReleaseSearchIndexes?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
  }) => Promise<ReleaseSearchIndexMaintenanceResult>;
  searchBundleFiles?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    query: string;
    scope: GeneratedFileSearchScope;
    fileKind: BundleFileKind | null;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<BundleFileSearchResultRecord>>;
  rebuildBundleGraphSearchDocuments?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
  }) => Promise<BundleGraphSearchIndexResult>;
  rebuildReleaseGraphProjection?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
  }) => Promise<{ nodeCount: number; edgeCount: number }>;
  searchBundleGraphFiles?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    query: string;
    scope: GeneratedFileSearchScope;
    fileKind: BundleFileKind | null;
    graphDepth: GraphSearchDepth;
    graphFanout: number;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<BundleGraphSearchResultRecord>>;
  listPublicationLogHistory?: (request: {
    knowledgeBaseId: string;
    maxEntries: number;
  }) => Promise<{
    entries: OkfLogEntry[];
    summaries: OkfLogMonthlySummary[];
  }>;
  markSourceFilesPublicationDirty?: (input: {
    knowledgeBaseId: string;
    sourceFileIds: string[];
    dirtyAt: string;
  }) => Promise<void>;
  countDirtySourceFiles?: (input: {
    knowledgeBaseId: string;
  }) => Promise<{ count: number; oldestDirtyAt: string | null }>;
  listDirtySourceFiles?: (request: {
    knowledgeBaseId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<SourceFileRecord>>;
  markSourceFilesPublicationVisible?: (input: {
    knowledgeBaseId: string;
    sourceFileIds: string[];
    generatedOutputs: GeneratedSourceFileOutputRecord[];
    visibleAt: string;
  }) => Promise<void>;
  markSourceFilesPublicationFailed?: (input: {
    knowledgeBaseId: string;
    sourceFileIds: string[];
    errorCode: string;
    errorMessage: string;
  }) => Promise<void>;
  createPublicationJob?: (input: {
    id: string;
    knowledgeBaseId: string;
    mode: PublicationJobMode;
    reason: PublicationJobReason;
    dirtySourceCount: number;
  }) => Promise<PublicationJobRecord>;
  startPublicationJob?: (input: {
    id: string;
    startedAt: string;
  }) => Promise<PublicationJobRecord | null>;
  completePublicationJob?: (input: {
    id: string;
    releaseId: string;
    endedAt: string;
  }) => Promise<PublicationJobRecord | null>;
  failPublicationJob?: (input: {
    id: string;
    endedAt: string;
    errorCode: string;
    errorMessage: string;
  }) => Promise<PublicationJobRecord | null>;
  deleteSourceFileTasks?: (input: {
    knowledgeBaseId: string;
    sourceFileIds: string[];
    deletedAt: string;
  }) => Promise<SourceFileTaskDeletionRepositoryResult[]>;
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
  replaceGraphEdgesForSourceFile?: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<string[] | void>;
  reconcileExplicitReferenceEdgesForTarget?: (input: {
    knowledgeBaseId: string;
    target: OkfGraphNode;
    limit: number;
  }) => Promise<{
    edgeCount: number;
    sourceFileIds: string[];
  }>;
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
  listActiveGraphNodes?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<OkfGraphNode>>;
  listActiveGraphEdges?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<OkfGraphEdge>>;
  getGraphEdge?: (request: {
    knowledgeBaseId: string;
    edgeId: string;
  }) => Promise<OkfGraphEdge | null>;
  getActiveGraphEdge?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    edgeId: string;
  }) => Promise<OkfGraphEdge | null>;
  listGraphNeighborhood: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
    limit: number;
    cursor?: string | null;
  }) => Promise<CursorPage<FileGraphRelatedRecord>>;
  listActiveGraphNeighborhood?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    sourceFileId: string;
    limit: number;
    cursor?: string | null;
  }) => Promise<CursorPage<FileGraphRelatedRecord>>;
  listGraphCandidates?: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
    terms: string[];
    limit: number;
  }) => Promise<OkfGraphNode[]>;
  getGraphSummary?: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
    limit: number;
  }) => Promise<FileGraphSummaryRecord>;
  refreshGraphSummariesForSourceFiles?: (request: {
    knowledgeBaseId: string;
    sourceFileIds: string[];
    limit: number;
  }) => Promise<void>;
  deleteGraphForSourceFile: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<void>;
};

export type AdminRepositories = {
  knowledgeBases: KnowledgeBaseRepository;
  uploadSessions?: UploadSessionRepository;
  sourceResources?: SourceResourceRepository;
  releasePublication?: ReleasePublicationRepository;
  files?: BundleFileRepository;
  graph?: FileGraphRepository;
  hardDelete?: HardDeleteRepository;
  workerJobs?: WorkerJobRepository;
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
  runtimeSettings?: RuntimeSettingsRepository;
};

type KnowledgeBaseRow = {
  id: string;
  name: string;
  description: string | null;
  active_release_id: string | null;
  resource_revision: number;
  catalog_generation: number | string;
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
  sort_key: string;
  entry_type: "directory" | "file";
  bundle_file_id: string | null;
  source_file_id: string | null;
  source_directory_id: string | null;
  file_kind: BundleFileKind | null;
  child_count: number;
  direct_file_count: number;
  descendant_file_count: number;
  directory_resource_revision: number | null;
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

type BundleFileSearchDocumentRow = {
  bundle_file_id: string;
  knowledge_base_id: string;
  release_id: string;
  source_file_id: string | null;
  file_kind: BundleFileKind;
  logical_path: string;
  title: string | null;
  description: string | null;
  tags_json: unknown;
  frontmatter_json: unknown;
  path_match: boolean;
  title_match: boolean;
  description_match: boolean;
  metadata_match: boolean;
  score: string | number;
};

type BundleGraphSearchDocumentRow = BundleFileSearchDocumentRow & {
  graph_ref: string;
  relationship_count: string | number;
  top_relationships_json: unknown;
  node_match: boolean;
  relationship_match: boolean;
  neighbor_match: boolean;
  edge_match: boolean;
  depth: string | number;
  match_type: GraphSearchMatchType;
};

type ReleaseReadSummaryRow = {
  release_id: string;
  knowledge_base_id: string;
  searchable_file_count: number | string;
  tree_node_count: number | string;
  graph_document_count: number | string;
  graph_relationship_count: number | string;
  graph_node_count: number | string;
  graph_edge_count: number | string;
};

type ReleaseGraphInsightsRow = {
  release_id: string;
  knowledge_base_id: string;
  generated_at: Date;
  insights_json: unknown;
};

type SourceFileRow = {
  id: string;
  knowledge_base_id: string;
  relative_path: string;
  resource_revision: number;
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
  generated_output_status: GeneratedOutputStatus;
  generated_bundle_file_id: string | null;
  generated_bundle_file_path: string | null;
  publication_dirty_at: Date | null;
  publication_visible_at: Date | null;
  publication_error_code: string | null;
  publication_error_message: string | null;
  retry_count: string | number;
  model_invocation_status?: ModelInvocationStatus | null;
  model_invocation_model_name?: string | null;
  model_invocation_started_at?: Date | null;
  model_invocation_ended_at?: Date | null;
  model_invocation_warning_count?: string | number | null;
  model_invocation_error_code?: string | null;
  created_at: Date;
  created_at_cursor?: string;
  task_deleted_at?: Date | null;
  deleted_at: Date | null;
};

type SourceFileTaskWorkerJobRow = {
  id: string;
  source_file_id: string | null;
  status: "queued" | "running";
};

type ReleaseRow = {
  id: string;
  knowledge_base_id: string;
  bundle_root_key: string;
  catalog_generation: number | string;
  generated_at: Date;
  published_at: Date | null;
  file_count: number;
  manifest_checksum_sha256: string;
  created_at: Date;
};

type PublicationJobRow = {
  id: string;
  knowledge_base_id: string;
  mode: PublicationJobMode;
  reason: PublicationJobReason;
  status: PublicationJobStatus;
  dirty_source_count: string | number;
  release_id: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
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
  model_config_id: string | null;
  api_mode: ModelApiMode | null;
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
    runtimeSettings: createRuntimeSettingsRepository(sql),
    uploadSessions: createPostgresUploadSessionRepository(sql),
    sourceResources: createPostgresSourceResourceRepository(sql),
    releasePublication: createPostgresReleasePublicationRepository(sql),
    knowledgeBases: {
      async listKnowledgeBases({ limit, cursor, query }) {
        const cursorValue = cursor ? parseKnowledgeBaseCursor(cursor) : null;
        const searchPredicate = query
          ? sql`AND lower(knowledge_base.id || ' ' || knowledge_base.name || ' ' || coalesce(knowledge_base.description, '')) LIKE ${containsKnowledgeBaseLikePattern(query.toLocaleLowerCase("en-US"))} ESCAPE ${"\\"}`
          : sql``;
        const rows = cursorValue
          ? await sql<Array<KnowledgeBaseRow & { cursor_timestamp: string }>>`
              SELECT knowledge_base.id, knowledge_base.name, knowledge_base.description, knowledge_base.active_release_id, knowledge_base.resource_revision, knowledge_base.catalog_generation, knowledge_base.created_at, knowledge_base.updated_at,
                     floor(extract(epoch FROM knowledge_base.created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.knowledge_bases knowledge_base
              WHERE knowledge_base.deleted_at IS NULL
                ${searchPredicate}
                AND (
                  knowledge_base.created_at < to_timestamp(${cursorValue.createdAt}::double precision / 1000000)
                  OR (knowledge_base.created_at = to_timestamp(${cursorValue.createdAt}::double precision / 1000000) AND knowledge_base.id > ${cursorValue.id})
                )
              ORDER BY knowledge_base.created_at DESC, knowledge_base.id ASC
              LIMIT ${limit + 1}
            `
          : await sql<Array<KnowledgeBaseRow & { cursor_timestamp: string }>>`
              SELECT knowledge_base.id, knowledge_base.name, knowledge_base.description, knowledge_base.active_release_id, knowledge_base.resource_revision, knowledge_base.catalog_generation, knowledge_base.created_at, knowledge_base.updated_at,
                     floor(extract(epoch FROM knowledge_base.created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.knowledge_bases knowledge_base
              WHERE knowledge_base.deleted_at IS NULL
                ${searchPredicate}
              ORDER BY knowledge_base.created_at DESC, knowledge_base.id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);

        return {
          items: pageRows.map(mapKnowledgeBaseRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeKnowledgeBaseCursor({
                  createdAt: lastRow.cursor_timestamp,
                  id: lastRow.id
                })
              : null
        };
      },
      async createKnowledgeBase(input) {
        const rows = await sql<KnowledgeBaseRow[]>`
          INSERT INTO focowiki.knowledge_bases (id, name, description)
          VALUES (${createKnowledgeBaseId()}, ${input.name}, ${input.description})
          RETURNING id, name, description, active_release_id, resource_revision, catalog_generation, created_at, updated_at
        `;
        const row = rows[0];

        if (!row) {
          throw new Error("Knowledge base creation did not return a row");
        }

        return mapKnowledgeBaseRow(row);
      },
      async getKnowledgeBase(id) {
        const rows = await sql<KnowledgeBaseRow[]>`
          SELECT id, name, description, active_release_id, resource_revision, catalog_generation, created_at, updated_at
          FROM focowiki.knowledge_bases
          WHERE id = ${id} AND deleted_at IS NULL
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapKnowledgeBaseRow(row) : null;
      },
    },
    files: {
      async createRelease(release) {
        await sql`
          INSERT INTO focowiki.releases (
            id,
            knowledge_base_id,
            bundle_root_key,
            generated_at,
            published_at,
            file_count,
            manifest_checksum_sha256,
            catalog_generation
          )
          VALUES (
            ${release.id},
            ${release.knowledgeBaseId},
            ${release.bundleRootKey},
            ${release.generatedAt},
            ${release.publishedAt},
            ${release.fileCount},
            ${release.manifestChecksumSha256},
            ${release.catalogGeneration}
          )
        `;
      },
      async createBundleFiles(files) {
        for (const file of files) {
          const searchDocument = createGeneratedFileSearchDocument(file);
          const sourceDirectoryPath = sourceDirectoryPathForGeneratedFile(file.logicalPath);
          const sourceDirectoryId = sourceDirectoryPath
            ? sql`(
                SELECT directory.source_directory_id
                FROM focowiki.release_source_directories directory
                WHERE directory.knowledge_base_id = ${file.knowledgeBaseId}
                  AND directory.release_id = ${file.releaseId}
                  AND directory.relative_path = ${sourceDirectoryPath}
                LIMIT 1
              )`
            : sql`NULL`;
          await sql`
            INSERT INTO focowiki.bundle_files (
              id,
              knowledge_base_id,
              release_id,
              source_file_id,
              file_kind,
              logical_path,
              title,
              description,
              tags_json,
              frontmatter_json,
              object_key,
              checksum_sha256,
              size_bytes,
              content_type,
              okf_type,
              navigation_only,
              source_directory_id
            )
            VALUES (
              ${file.id},
              ${file.knowledgeBaseId},
              ${file.releaseId},
              ${file.sourceFileId},
              ${file.fileKind},
              ${file.logicalPath},
              ${file.title},
              ${file.description},
              ${sql.json(file.tags as never)},
              ${sql.json(file.frontmatter as never)},
              ${file.objectKey},
              ${file.checksumSha256},
              ${file.sizeBytes},
              ${file.contentType},
              ${file.okfType},
              ${isNavigationOnlyFileKind(file.fileKind)},
              ${sourceDirectoryId}
            )
            ON CONFLICT (release_id, logical_path) DO NOTHING
          `;

          if (!isNavigationOnlyFileKind(file.fileKind)) {
            await sql`
              INSERT INTO focowiki.bundle_file_search_documents (
                bundle_file_id,
                knowledge_base_id,
                release_id,
                source_file_id,
                file_kind,
                logical_path,
                path_text,
                title_text,
                description_text,
                metadata_text,
                search_text
              )
              SELECT
                stored.id,
                stored.knowledge_base_id,
                stored.release_id,
                stored.source_file_id,
                stored.file_kind,
                stored.logical_path,
                ${searchDocument.logicalPath.toLocaleLowerCase("en-US")},
                ${searchDocument.title?.toLocaleLowerCase("en-US") ?? ""},
                ${searchDocument.description?.toLocaleLowerCase("en-US") ?? ""},
                ${searchDocument.metadataText},
                ${searchDocument.searchText}
              FROM focowiki.bundle_files stored
              WHERE stored.knowledge_base_id = ${file.knowledgeBaseId}
                AND stored.release_id = ${file.releaseId}
                AND stored.logical_path = ${file.logicalPath}
                AND stored.navigation_only = false
              ON CONFLICT (bundle_file_id) DO UPDATE SET
                source_file_id = EXCLUDED.source_file_id,
                file_kind = EXCLUDED.file_kind,
                logical_path = EXCLUDED.logical_path,
                path_text = EXCLUDED.path_text,
                title_text = EXCLUDED.title_text,
                description_text = EXCLUDED.description_text,
                metadata_text = EXCLUDED.metadata_text,
                search_text = EXCLUDED.search_text,
                updated_at = now()
            `;
          }
        }
      },
      async getReleaseReadSummary({ knowledgeBaseId, releaseId }) {
        const rows = await sql<ReleaseReadSummaryRow[]>`
          SELECT release_id, knowledge_base_id, searchable_file_count, tree_node_count,
                 graph_document_count, graph_relationship_count, graph_node_count,
                 graph_edge_count
          FROM focowiki.release_read_summaries
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND release_id = ${releaseId}
          LIMIT 1
        `;
        return rows[0] ? mapReleaseReadSummaryRow(rows[0]) : null;
      },
      async getReleaseGraphInsights({ knowledgeBaseId, releaseId, limit }) {
        const rows = await sql<ReleaseGraphInsightsRow[]>`
          WITH selected_insights AS (
            SELECT insight.id, insight.insight_type, insight.title, insight.description,
                   insight.payload_json, insight.severity, insight.created_at
            FROM focowiki.knowledge_graph_insights insight
            WHERE insight.knowledge_base_id = ${knowledgeBaseId}
              AND insight.release_id = ${releaseId}
            ORDER BY insight.created_at DESC, insight.id ASC
            LIMIT ${limit}
          )
          SELECT
            release.id AS release_id,
            release.knowledge_base_id,
            release.generated_at,
            COALESCE(
              jsonb_agg(
                insight.payload_json || jsonb_build_object(
                  'insightId', insight.id,
                  'type', insight.insight_type,
                  'title', insight.title,
                  'description', insight.description,
                  'severity', insight.severity,
                  'createdAt', insight.created_at
                )
                ORDER BY insight.created_at DESC, insight.id ASC
              ) FILTER (WHERE insight.id IS NOT NULL),
              '[]'::jsonb
            ) AS insights_json
          FROM focowiki.releases release
          LEFT JOIN selected_insights insight ON true
          WHERE release.knowledge_base_id = ${knowledgeBaseId}
            AND release.id = ${releaseId}
          GROUP BY release.id, release.knowledge_base_id, release.generated_at
          LIMIT 1
        `;
        const row = rows[0];
        if (!row) return null;

        return {
          releaseId: row.release_id,
          knowledgeBaseId: row.knowledge_base_id,
          generatedAt: row.generated_at.toISOString(),
          insights: Array.isArray(row.insights_json)
            ? row.insights_json.filter(
                (value): value is Record<string, unknown> =>
                  Boolean(value) && typeof value === "object" && !Array.isArray(value)
              )
            : []
        };
      },
      async refreshReleaseReadSummary({ knowledgeBaseId, releaseId }) {
        const rows = await sql<ReleaseReadSummaryRow[]>`
          INSERT INTO focowiki.release_read_summaries (
            release_id,
            knowledge_base_id,
            searchable_file_count,
            tree_node_count,
            graph_document_count,
            graph_relationship_count,
            graph_node_count,
            graph_edge_count,
            updated_at
          )
          SELECT
            ${releaseId},
            ${knowledgeBaseId},
            (SELECT count(*)::integer FROM focowiki.bundle_file_search_documents
              WHERE knowledge_base_id = ${knowledgeBaseId} AND release_id = ${releaseId}),
            (SELECT count(*)::integer FROM focowiki.knowledge_file_tree_nodes
              WHERE knowledge_base_id = ${knowledgeBaseId} AND release_id = ${releaseId}),
            (SELECT count(*)::integer FROM focowiki.knowledge_graph_search_documents
              WHERE knowledge_base_id = ${knowledgeBaseId} AND release_id = ${releaseId}),
            (SELECT count(DISTINCT edge_id)::integer FROM focowiki.knowledge_graph_search_documents
              WHERE knowledge_base_id = ${knowledgeBaseId} AND release_id = ${releaseId}
                AND anchor_type = 'edge'),
            (SELECT count(*)::integer FROM focowiki.knowledge_graph_nodes
              WHERE knowledge_base_id = ${knowledgeBaseId} AND release_id = ${releaseId}),
            (SELECT count(*)::integer FROM focowiki.knowledge_graph_edges
              WHERE knowledge_base_id = ${knowledgeBaseId} AND release_id = ${releaseId}
                AND quality_status = 'accepted'),
            now()
          ON CONFLICT (release_id) DO UPDATE SET
            searchable_file_count = EXCLUDED.searchable_file_count,
            tree_node_count = EXCLUDED.tree_node_count,
            graph_document_count = EXCLUDED.graph_document_count,
            graph_relationship_count = EXCLUDED.graph_relationship_count,
            graph_node_count = EXCLUDED.graph_node_count,
            graph_edge_count = EXCLUDED.graph_edge_count,
            updated_at = now()
          RETURNING release_id, knowledge_base_id, searchable_file_count, tree_node_count,
                    graph_document_count, graph_relationship_count, graph_node_count,
                    graph_edge_count
        `;
        const row = rows[0];
        if (!row) {
          throw new Error("Release read summary refresh did not return a row");
        }
        return mapReleaseReadSummaryRow(row);
      },
      async finalizeReleaseSearchIndexes() {
        return cleanReleaseReadModelGinPendingLists(sql);
      },
      async createBundleTreeEntries(entries) {
        for (const entry of entries) {
          const fileIdExpression =
            entry.entryType === "file"
              ? sql`
                  COALESCE(
                    (
                      SELECT file.id
                      FROM focowiki.bundle_files file
                      WHERE file.knowledge_base_id = ${entry.knowledgeBaseId}
                        AND file.release_id = ${entry.releaseId}
                        AND file.logical_path = ${entry.logicalPath}
                      LIMIT 1
                    ),
                    ${entry.bundleFileId}
                  )
                `
              : sql`NULL`;

          await sql`
            INSERT INTO focowiki.knowledge_file_tree_nodes (
              id,
              knowledge_base_id,
              release_id,
              parent_id,
              path,
              name,
              node_type,
              file_id,
              source_directory_id,
              depth,
              sort_key,
              child_count
              ,direct_file_count
              ,descendant_file_count
            )
            VALUES (
              ${entry.id},
              ${entry.knowledgeBaseId},
              ${entry.releaseId},
              (
                SELECT parent.id
                FROM focowiki.knowledge_file_tree_nodes parent
                WHERE parent.knowledge_base_id = ${entry.knowledgeBaseId}
                  AND parent.release_id = ${entry.releaseId}
                  AND parent.path = ${entry.parentPath}
                LIMIT 1
              ),
              ${entry.logicalPath},
              ${entry.name},
              ${entry.entryType},
              ${fileIdExpression},
              CASE
                WHEN ${entry.entryType} = 'directory' AND ${entry.logicalPath} LIKE 'pages/%'
                THEN (
                  SELECT directory.id FROM focowiki.source_directories directory
                  WHERE directory.knowledge_base_id = ${entry.knowledgeBaseId}
                    AND directory.relative_path = substring(${entry.logicalPath} from 7)
                    AND directory.deleted_at IS NULL
                  LIMIT 1
                )
                ELSE NULL
              END,
              ${treePathDepth(entry.logicalPath)},
              ${entry.sortKey ?? createTreeSortKey(entry.entryType, entry.name)},
              ${entry.childCount ?? 0},
              0,
              0
            )
            ON CONFLICT (release_id, path) DO UPDATE
            SET
              parent_id = EXCLUDED.parent_id,
              name = EXCLUDED.name,
              node_type = EXCLUDED.node_type,
              file_id = EXCLUDED.file_id,
              source_directory_id = EXCLUDED.source_directory_id,
              depth = EXCLUDED.depth,
              sort_key = EXCLUDED.sort_key,
              child_count = EXCLUDED.child_count,
              updated_at = now()
          `;
        }

        const releaseScopes = [...new Map(entries.map((entry) => [
          `${entry.knowledgeBaseId}:${entry.releaseId}`,
          { knowledgeBaseId: entry.knowledgeBaseId, releaseId: entry.releaseId }
        ])).values()];
        for (const { knowledgeBaseId, releaseId } of releaseScopes) {
          await sql`
            UPDATE focowiki.knowledge_file_tree_nodes parent
            SET child_count = COALESCE(child_counts.child_count, 0)
            FROM (
              SELECT parent_id, count(*)::integer AS child_count
              FROM focowiki.knowledge_file_tree_nodes
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND release_id = ${releaseId}
              GROUP BY parent_id
            ) child_counts
            WHERE parent.knowledge_base_id = ${knowledgeBaseId}
              AND parent.release_id = ${releaseId}
              AND parent.id = child_counts.parent_id
              AND parent.node_type = 'directory'
          `;
          await sql`
            UPDATE focowiki.knowledge_file_tree_nodes entry
            SET direct_file_count = counts.direct_file_count,
                descendant_file_count = counts.descendant_file_count
            FROM (
              SELECT directory.id,
                (SELECT count(*)::int FROM focowiki.source_files source
                 WHERE source.directory_id = directory.id
                   AND source.deleted_at IS NULL) AS direct_file_count,
                (SELECT count(*)::int FROM focowiki.source_files source
                 WHERE source.knowledge_base_id = directory.knowledge_base_id
                   AND source.deleted_at IS NULL
                   AND (source.relative_path LIKE directory.relative_path || '/%')) AS descendant_file_count
              FROM focowiki.source_directories directory
              WHERE directory.knowledge_base_id = ${knowledgeBaseId}
                AND directory.deleted_at IS NULL
            ) counts
            WHERE entry.knowledge_base_id = ${knowledgeBaseId}
              AND entry.release_id = ${releaseId}
              AND entry.source_directory_id = counts.id
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
          const activated = await transaction<Array<{ id: string }>>`
            UPDATE focowiki.knowledge_bases
            SET
              active_release_id = ${input.releaseId},
              updated_at = now()
            WHERE id = ${input.knowledgeBaseId}
              AND deleted_at IS NULL
              AND catalog_generation >= (
                SELECT release.catalog_generation
                FROM focowiki.releases release
                WHERE release.id = ${input.releaseId}
                  AND release.knowledge_base_id = ${input.knowledgeBaseId}
              )
            RETURNING id
          `;
          if (!activated[0]) {
            throw new PublicationCatalogStaleError();
          }
          await transaction`
            UPDATE focowiki.source_directories directory
            SET parent_id = directory.candidate_parent_id,
                name = directory.candidate_name,
                relative_path = directory.candidate_relative_path,
                path_key = directory.candidate_path_key,
                depth = directory.candidate_depth,
                resource_revision = directory.resource_revision + 1,
                candidate_operation_id = NULL,
                candidate_parent_id = NULL,
                candidate_name = NULL,
                candidate_relative_path = NULL,
                candidate_path_key = NULL,
                candidate_depth = NULL,
                updated_at = ${input.publishedAt}
            FROM focowiki.resource_operations operation,
                 focowiki.release_resource_operations captured
            WHERE directory.candidate_operation_id = operation.id
              AND operation.knowledge_base_id = ${input.knowledgeBaseId}
              AND operation.state = 'publishing'
              AND captured.release_id = ${input.releaseId}
              AND captured.knowledge_base_id = ${input.knowledgeBaseId}
              AND captured.operation_id = operation.id
          `;
          await transaction`
            UPDATE focowiki.source_files source
            SET name = source.candidate_name,
                relative_path = source.candidate_relative_path,
                path_key = source.candidate_path_key,
                directory_id = source.candidate_directory_id,
                object_key = COALESCE(source.candidate_object_key, source.object_key),
                content_type = COALESCE(source.candidate_content_type, source.content_type),
                size_bytes = COALESCE(source.candidate_size_bytes, source.size_bytes),
                checksum_sha256 = COALESCE(source.candidate_checksum_sha256, source.checksum_sha256),
                metadata_json = COALESCE(source.candidate_metadata_json, source.metadata_json),
                model_suggestions_json = source.candidate_model_suggestions_json,
                active_revision_id = COALESCE(source.candidate_revision_id, source.active_revision_id),
                content_revision = CASE
                  WHEN source.candidate_revision_id IS NULL THEN source.content_revision
                  ELSE source.content_revision + 1
                END,
                resource_revision = source.resource_revision + 1,
                candidate_operation_id = NULL,
                candidate_revision_id = NULL,
                candidate_name = NULL,
                candidate_relative_path = NULL,
                candidate_path_key = NULL,
                candidate_directory_id = NULL,
                candidate_object_key = NULL,
                candidate_content_type = NULL,
                candidate_size_bytes = NULL,
                candidate_checksum_sha256 = NULL,
                candidate_metadata_json = NULL,
                candidate_model_suggestions_json = NULL
            FROM focowiki.resource_operations operation,
                 focowiki.release_resource_operations captured
            WHERE source.candidate_operation_id = operation.id
              AND operation.knowledge_base_id = ${input.knowledgeBaseId}
              AND operation.state = 'publishing'
              AND captured.release_id = ${input.releaseId}
              AND captured.knowledge_base_id = ${input.knowledgeBaseId}
              AND captured.operation_id = operation.id
          `;
          await transaction`
            UPDATE focowiki.source_files source
            SET processing_stage = 'release_activation',
                processing_ended_at = ${input.publishedAt},
                generated_output_status = 'visible',
                generated_bundle_file_id = file.id,
                generated_bundle_file_path = file.logical_path,
                publication_dirty_at = NULL,
                publication_visible_at = ${input.publishedAt},
                publication_error_code = NULL,
                publication_error_message = NULL
            FROM focowiki.bundle_files file,
                 focowiki.release_source_files release_source
            WHERE file.knowledge_base_id = ${input.knowledgeBaseId}
              AND file.release_id = ${input.releaseId}
              AND file.file_kind = 'page'
              AND file.source_file_id = source.id
              AND release_source.knowledge_base_id = ${input.knowledgeBaseId}
              AND release_source.release_id = ${input.releaseId}
              AND release_source.source_file_id = source.id
              AND release_source.publication_required = TRUE
              AND source.knowledge_base_id = ${input.knowledgeBaseId}
              AND source.deleted_at IS NULL
              AND source.task_deleted_at IS NULL
              AND (
                source.candidate_operation_id IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM focowiki.release_resource_operations captured
                  WHERE captured.release_id = ${input.releaseId}
                    AND captured.knowledge_base_id = ${input.knowledgeBaseId}
                    AND captured.operation_id = source.candidate_operation_id
                )
              )
          `;
          await transaction`
            UPDATE focowiki.resource_operations operation
            SET state = 'completed', completed_at = ${input.publishedAt}, updated_at = ${input.publishedAt},
                result_json = COALESCE(operation.result_json, '{}'::jsonb)
                  || jsonb_build_object(
                    'releaseId', ${input.releaseId}::text,
                    'visibility', 'active'::text
                  )
            WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
              AND operation.state = 'publishing'
              AND EXISTS (
                SELECT 1
                FROM focowiki.release_resource_operations captured
                WHERE captured.release_id = ${input.releaseId}
                  AND captured.knowledge_base_id = ${input.knowledgeBaseId}
                  AND captured.operation_id = operation.id
              )
          `;
          await transaction`
            DELETE FROM focowiki.resource_path_reservations reservation
            USING focowiki.resource_operations operation
            WHERE reservation.operation_id = operation.id
              AND operation.knowledge_base_id = ${input.knowledgeBaseId}
              AND operation.state = 'completed'
              AND EXISTS (
                SELECT 1
                FROM focowiki.release_resource_operations captured
                WHERE captured.release_id = ${input.releaseId}
                  AND captured.knowledge_base_id = ${input.knowledgeBaseId}
                  AND captured.operation_id = operation.id
              )
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
            AND deleted_at IS NULL
            AND task_deleted_at IS NULL
        `;
        await sql`
          UPDATE focowiki.source_revisions revision
          SET processing_status = CASE
                WHEN ${status} = 'queued' THEN 'queued'
                WHEN ${status} = 'running' THEN 'running'
                WHEN ${status} = 'completed' THEN 'completed'
                ELSE 'failed'
              END
          FROM focowiki.source_files source
          WHERE source.knowledge_base_id = ${knowledgeBaseId}
            AND source.id = ANY(${sourceFileIds})
            AND source.candidate_revision_id = revision.id
        `;
      },
      async updateSourceFileMetadata({ knowledgeBaseId, sourceFileId, metadata }) {
        await sql`
          UPDATE focowiki.source_files
          SET metadata_json = CASE
                WHEN candidate_operation_id IS NULL THEN ${sql.json(metadata as never)}
                ELSE metadata_json
              END,
              candidate_metadata_json = CASE
                WHEN candidate_operation_id IS NULL THEN candidate_metadata_json
                ELSE ${sql.json(metadata as never)}
              END
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND id = ${sourceFileId}
            AND deleted_at IS NULL
            AND task_deleted_at IS NULL
        `;
        await sql`
          UPDATE focowiki.source_revisions revision
          SET metadata_json = ${sql.json(metadata as never)}
          FROM focowiki.source_files source
          WHERE source.knowledge_base_id = ${knowledgeBaseId}
            AND source.id = ${sourceFileId}
            AND source.candidate_revision_id = revision.id
        `;
      },
      async updateSourceFileModelSuggestions({ knowledgeBaseId, sourceFileId, suggestions }) {
        await sql`
          UPDATE focowiki.source_files
          SET model_suggestions_json = CASE
                WHEN candidate_operation_id IS NULL
                THEN ${suggestions ? sql.json(suggestions as never) : null}
                ELSE model_suggestions_json
              END,
              candidate_model_suggestions_json = CASE
                WHEN candidate_operation_id IS NULL THEN candidate_model_suggestions_json
                ELSE ${suggestions ? sql.json(suggestions as never) : null}
              END
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND id = ${sourceFileId}
            AND deleted_at IS NULL
            AND task_deleted_at IS NULL
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
          SELECT
            ${createSourceFileEventId()},
            ${input.knowledgeBaseId},
            ${input.sourceFileId},
            ${input.stageKey},
            ${input.messageKey},
            ${input.startedAt},
            ${input.endedAt},
            ${input.severity}
          FROM focowiki.source_files source
          WHERE source.id = ${input.sourceFileId}
            AND source.knowledge_base_id = ${input.knowledgeBaseId}
            AND source.deleted_at IS NULL
            AND source.deletion_intent_id IS NULL
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
          ? await sql<Array<SourceFileEventRow & { cursor_timestamp: string }>>`
              SELECT id, knowledge_base_id, source_file_id, stage_key, message_key, started_at, ended_at, severity, created_at,
                     floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.source_file_events
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND source_file_id = ${sourceFileId}
                AND (
                  created_at > to_timestamp(${cursorValue.createdAt}::double precision / 1000000)
                  OR (created_at = to_timestamp(${cursorValue.createdAt}::double precision / 1000000) AND id > ${cursorValue.id})
                )
              ORDER BY created_at ASC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<Array<SourceFileEventRow & { cursor_timestamp: string }>>`
              SELECT id, knowledge_base_id, source_file_id, stage_key, message_key, started_at, ended_at, severity, created_at,
                     floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
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
              ? serializeTimedCursor({ createdAt: lastRow.cursor_timestamp, id: lastRow.id })
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
              AND task_deleted_at IS NULL
          `;
          return inserted;
        });
        const row = rows[0];

        if (!row) {
          throw new Error("Source file retry attempt creation did not return a row");
        }

        return mapSourceFileRetryAttemptRow(row);
      },
      async listBundleTreeEntries({
        knowledgeBaseId,
        releaseId,
        parentPath,
        entryType = null,
        limit,
        cursor
      }) {
        const cursorValue = cursor ? parseTreeCursor(cursor) : null;
        const entryTypeFilter = entryType ? sql`AND entry.node_type = ${entryType}` : sql``;
        const parentFilter =
          parentPath === ""
            ? sql`AND entry.parent_id IS NULL`
            : sql`AND parent.path = ${parentPath}`;
        const rows = cursorValue
          ? await sql<BundleTreeEntryRow[]>`
              SELECT entry.id, entry.knowledge_base_id, ${releaseId} AS release_id, COALESCE(parent.path, '') AS parent_path, entry.name, entry.path AS logical_path, entry.sort_key, entry.node_type AS entry_type, entry.file_id AS bundle_file_id, entry.child_count, entry.direct_file_count, entry.descendant_file_count, entry.source_directory_id, directory.resource_revision AS directory_resource_revision, file.source_file_id, file.file_kind
              FROM focowiki.knowledge_file_tree_nodes entry
              LEFT JOIN focowiki.knowledge_file_tree_nodes parent ON parent.id = entry.parent_id
              LEFT JOIN focowiki.bundle_files file ON file.id = entry.file_id
              LEFT JOIN focowiki.source_directories directory ON directory.id = entry.source_directory_id
              WHERE entry.knowledge_base_id = ${knowledgeBaseId}
                AND entry.release_id = ${releaseId}
                ${parentFilter}
                ${entryTypeFilter}
                AND (entry.sort_key > ${cursorValue.sortKey} OR (entry.sort_key = ${cursorValue.sortKey} AND entry.id > ${cursorValue.id}))
              ORDER BY entry.sort_key ASC, entry.id ASC
              LIMIT ${limit + 1}
            `
          : await sql<BundleTreeEntryRow[]>`
              SELECT entry.id, entry.knowledge_base_id, ${releaseId} AS release_id, COALESCE(parent.path, '') AS parent_path, entry.name, entry.path AS logical_path, entry.sort_key, entry.node_type AS entry_type, entry.file_id AS bundle_file_id, entry.child_count, entry.direct_file_count, entry.descendant_file_count, entry.source_directory_id, directory.resource_revision AS directory_resource_revision, file.source_file_id, file.file_kind
              FROM focowiki.knowledge_file_tree_nodes entry
              LEFT JOIN focowiki.knowledge_file_tree_nodes parent ON parent.id = entry.parent_id
              LEFT JOIN focowiki.bundle_files file ON file.id = entry.file_id
              LEFT JOIN focowiki.source_directories directory ON directory.id = entry.source_directory_id
              WHERE entry.knowledge_base_id = ${knowledgeBaseId}
                AND entry.release_id = ${releaseId}
                ${parentFilter}
                ${entryTypeFilter}
              ORDER BY entry.sort_key ASC, entry.id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);

        return {
          items: pageRows.map(mapBundleTreeEntryRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTreeCursor({ sortKey: lastRow.sort_key, id: lastRow.id })
              : null
        };
      },
      async searchBundleTreeEntries({ knowledgeBaseId, releaseId, query, entryType = null, limit, cursor }) {
        const cursorValue = cursor ? parseTreeCursor(cursor) : null;
        const searchPattern = containsPattern(query.toLocaleLowerCase("en-US"));
        const entryTypeFilter = entryType ? sql`AND entry.node_type = ${entryType}` : sql``;
        const cursorFilter = cursorValue
          ? sql`AND (entry.sort_key > ${cursorValue.sortKey} OR (entry.sort_key = ${cursorValue.sortKey} AND entry.id > ${cursorValue.id}))`
          : sql``;
        const rows = await sql<BundleTreeEntryRow[]>`
          SELECT entry.id, entry.knowledge_base_id, ${releaseId} AS release_id, COALESCE(parent.path, '') AS parent_path, entry.name, entry.path AS logical_path, entry.sort_key, entry.node_type AS entry_type, entry.file_id AS bundle_file_id, entry.child_count, entry.direct_file_count, entry.descendant_file_count, entry.source_directory_id, directory.resource_revision AS directory_resource_revision, file.source_file_id, file.file_kind
          FROM focowiki.knowledge_file_tree_nodes entry
          LEFT JOIN focowiki.knowledge_file_tree_nodes parent ON parent.id = entry.parent_id
          LEFT JOIN focowiki.bundle_files file ON file.id = entry.file_id
          LEFT JOIN focowiki.source_directories directory ON directory.id = entry.source_directory_id
          WHERE entry.knowledge_base_id = ${knowledgeBaseId}
            AND entry.release_id = ${releaseId}
            ${entryTypeFilter}
            AND lower(entry.name || ' ' || entry.path) LIKE ${searchPattern} ESCAPE ${"\\"}
            ${cursorFilter}
          ORDER BY entry.sort_key ASC, entry.id ASC
          LIMIT ${limit + 1}
        `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);
        const ancestorPaths = collectAncestorPaths(pageRows.map((row) => row.logical_path));
        const ancestorRows =
          ancestorPaths.length > 0
            ? await sql<BundleTreeEntryRow[]>`
                SELECT entry.id, entry.knowledge_base_id, ${releaseId} AS release_id, COALESCE(parent.path, '') AS parent_path, entry.name, entry.path AS logical_path, entry.sort_key, entry.node_type AS entry_type, entry.file_id AS bundle_file_id, entry.child_count, entry.direct_file_count, entry.descendant_file_count, entry.source_directory_id, directory.resource_revision AS directory_resource_revision, file.source_file_id, file.file_kind
                FROM focowiki.knowledge_file_tree_nodes entry
                LEFT JOIN focowiki.knowledge_file_tree_nodes parent ON parent.id = entry.parent_id
                LEFT JOIN focowiki.bundle_files file ON file.id = entry.file_id
                LEFT JOIN focowiki.source_directories directory ON directory.id = entry.source_directory_id
                WHERE entry.knowledge_base_id = ${knowledgeBaseId}
                  AND entry.release_id = ${releaseId}
                  AND entry.path = ANY(${ancestorPaths})
                ORDER BY entry.path ASC
              `
            : [];
        const ancestorByPath = new Map(
          ancestorRows.map((row) => [row.logical_path, mapBundleTreeEntryRow(row)])
        );

        return {
          items: pageRows.map((row) => {
            const entry = mapBundleTreeEntryRow(row);
            return {
              entry,
              ancestors: createAncestorPaths(entry.logicalPath)
                .map((path) => ancestorByPath.get(path))
                .filter((ancestor): ancestor is BundleTreeEntryRecord => Boolean(ancestor))
            };
          }),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTreeCursor({ sortKey: lastRow.sort_key, id: lastRow.id })
              : null
        };
      },
      async getBundleFile({ knowledgeBaseId, releaseId, logicalPath }) {
        const rows = await sql<BundleFileRow[]>`
          SELECT
            file.id, file.knowledge_base_id, file.release_id, file.logical_path,
            file.object_key, file.content_type, file.size_bytes, file.checksum_sha256,
            file.source_file_id, file.file_kind, file.okf_type, file.title,
            file.description, file.tags_json, file.frontmatter_json
          FROM focowiki.bundle_files file
          WHERE file.knowledge_base_id = ${knowledgeBaseId}
            AND file.release_id = ${releaseId}
            AND file.logical_path = ${logicalPath}
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapBundleFileRow(row) : null;
      },
      async getBundleFileById({ knowledgeBaseId, releaseId, fileId }) {
        const rows = await sql<BundleFileRow[]>`
          SELECT
            file.id, file.knowledge_base_id, file.release_id, file.logical_path,
            file.object_key, file.content_type, file.size_bytes, file.checksum_sha256,
            file.source_file_id, file.file_kind, file.okf_type, file.title,
            file.description, file.tags_json, file.frontmatter_json
          FROM focowiki.bundle_files file
          WHERE file.knowledge_base_id = ${knowledgeBaseId}
            AND file.release_id = ${releaseId}
            AND file.id = ${fileId}
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapBundleFileRow(row) : null;
      },
      async listGeneratedOutputsForSourceFiles({ knowledgeBaseId, releaseId, sourceFileIds }) {
        if (sourceFileIds.length === 0) {
          return [];
        }

        const rows = await sql<
          Array<{ source_file_id: string; bundle_file_id: string; logical_path: string }>
        >`
          SELECT DISTINCT ON (source_file_id)
            source_file_id,
            id AS bundle_file_id,
            logical_path
          FROM focowiki.bundle_files
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND release_id = ${releaseId}
            AND source_file_id = ANY(${sourceFileIds})
            AND file_kind = 'page'
          ORDER BY source_file_id ASC, logical_path ASC
        `;

        return rows.map((row) => ({
          sourceFileId: row.source_file_id,
          bundleFileId: row.bundle_file_id,
          logicalPath: row.logical_path
        }));
      },
      async getSourceFile({ knowledgeBaseId, sourceFileId }) {
        const rows = await sql<SourceFileRow[]>`
          SELECT ${sql.unsafe(SOURCE_FILE_SELECT_COLUMNS)}
          FROM focowiki.source_files source
          WHERE source.knowledge_base_id = ${knowledgeBaseId}
            AND source.id = ${sourceFileId}
            AND source.deleted_at IS NULL
            AND source.task_deleted_at IS NULL
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapSourceFileRow(row) : null;
      },
      async getSourceFileForProcessing({ knowledgeBaseId, sourceFileId }) {
        const rows = await sql<SourceFileRow[]>`
          SELECT ${sql.unsafe(SOURCE_FILE_PROCESSING_SELECT_COLUMNS)}
          FROM focowiki.source_files source
          WHERE source.knowledge_base_id = ${knowledgeBaseId}
            AND source.id = ${sourceFileId}
            AND source.deleted_at IS NULL
            AND source.task_deleted_at IS NULL
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapSourceFileRow(row) : null;
      },
      async listSourceFiles({
        knowledgeBaseId,
        limit,
        cursor,
        ...filters
      }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const filterPredicate = createSourceFileListFilterPredicate(sql, filters);
        const rows = cursorValue
          ? await sql<Array<SourceFileRow & { cursor_timestamp: string }>>`
              SELECT ${sql.unsafe(SOURCE_FILE_SELECT_COLUMNS)},
                     floor(extract(epoch FROM source.created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.source_files source
              WHERE source.knowledge_base_id = ${knowledgeBaseId}
                AND source.deleted_at IS NULL
                AND source.task_deleted_at IS NULL
                ${filterPredicate}
                AND (
                  source.created_at < to_timestamp(${cursorValue.createdAt}::double precision / 1000000)
                  OR (source.created_at = to_timestamp(${cursorValue.createdAt}::double precision / 1000000) AND source.id > ${cursorValue.id})
                )
              ORDER BY source.created_at DESC, source.id ASC
              LIMIT ${limit + 1}
            `
          : await sql<Array<SourceFileRow & { cursor_timestamp: string }>>`
              SELECT ${sql.unsafe(SOURCE_FILE_SELECT_COLUMNS)},
                     floor(extract(epoch FROM source.created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.source_files source
              WHERE source.knowledge_base_id = ${knowledgeBaseId}
                AND source.deleted_at IS NULL
                AND source.task_deleted_at IS NULL
                ${filterPredicate}
              ORDER BY source.created_at DESC, source.id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);
        return {
          items: pageRows.map(mapSourceFileRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTimedCursor({ createdAt: lastRow.cursor_timestamp, id: lastRow.id })
              : null
        };
      },
      async listReleases({ knowledgeBaseId, limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<Array<ReleaseRow & { cursor_timestamp: string }>>`
              SELECT id, knowledge_base_id, bundle_root_key, catalog_generation, generated_at, published_at, file_count, manifest_checksum_sha256, created_at,
                     floor(extract(epoch FROM COALESCE(published_at, created_at)) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.releases
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND (
                  COALESCE(published_at, created_at) < to_timestamp(${cursorValue.createdAt}::double precision / 1000000)
                  OR (COALESCE(published_at, created_at) = to_timestamp(${cursorValue.createdAt}::double precision / 1000000) AND id > ${cursorValue.id})
                )
              ORDER BY COALESCE(published_at, created_at) DESC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<Array<ReleaseRow & { cursor_timestamp: string }>>`
              SELECT id, knowledge_base_id, bundle_root_key, catalog_generation, generated_at, published_at, file_count, manifest_checksum_sha256, created_at,
                     floor(extract(epoch FROM COALESCE(published_at, created_at)) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.releases
              WHERE knowledge_base_id = ${knowledgeBaseId}
              ORDER BY COALESCE(published_at, created_at) DESC, id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);
        return {
          items: pageRows.map(mapReleaseRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTimedCursor({
                  createdAt: lastRow.cursor_timestamp,
                  id: lastRow.id
                })
              : null
        };
      },
      async listBundleFiles({ knowledgeBaseId, releaseId, limit, cursor }) {
        const cursorValue = cursor ? parseLogicalPathCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<BundleFileRow[]>`
              SELECT file.id, file.knowledge_base_id, file.release_id, file.source_file_id,
                     file.file_kind, file.logical_path, file.object_key, file.content_type,
                     file.size_bytes, file.checksum_sha256, file.okf_type, file.title,
                     file.description, file.tags_json, file.frontmatter_json
              FROM focowiki.bundle_files file
              WHERE file.knowledge_base_id = ${knowledgeBaseId}
                AND file.release_id = ${releaseId}
                AND (file.logical_path > ${cursorValue.logicalPath}
                  OR (file.logical_path = ${cursorValue.logicalPath} AND file.id > ${cursorValue.id}))
              ORDER BY file.logical_path ASC, file.id ASC
              LIMIT ${limit + 1}
            `
          : await sql<BundleFileRow[]>`
              SELECT file.id, file.knowledge_base_id, file.release_id, file.source_file_id,
                     file.file_kind, file.logical_path, file.object_key, file.content_type,
                     file.size_bytes, file.checksum_sha256, file.okf_type, file.title,
                     file.description, file.tags_json, file.frontmatter_json
              FROM focowiki.bundle_files file
              WHERE file.knowledge_base_id = ${knowledgeBaseId}
                AND file.release_id = ${releaseId}
              ORDER BY file.logical_path ASC, file.id ASC
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
      async listReusableBundleFiles({ knowledgeBaseId, releaseId, limit, cursor }) {
        const cursorValue = cursor ? parseLogicalPathCursor(cursor) : null;
        const rows = await sql<BundleFileRow[]>`
          SELECT file.id, file.knowledge_base_id, file.release_id, file.source_file_id,
                 file.file_kind, file.logical_path, file.object_key, file.content_type,
                 file.size_bytes, file.checksum_sha256, file.okf_type, file.title,
                 file.description, file.tags_json, file.frontmatter_json
          FROM focowiki.bundle_files file
          LEFT JOIN focowiki.source_files source ON source.id = file.source_file_id
          WHERE file.knowledge_base_id = ${knowledgeBaseId}
            AND file.release_id = ${releaseId}
            AND (file.source_file_id IS NULL OR (
              source.id IS NOT NULL AND source.deleted_at IS NULL
                AND source.deletion_intent_id IS NULL
            ))
            ${cursorValue ? sql`AND (file.logical_path > ${cursorValue.logicalPath}
              OR (file.logical_path = ${cursorValue.logicalPath} AND file.id > ${cursorValue.id}))` : sql``}
          ORDER BY file.logical_path ASC, file.id ASC
          LIMIT ${limit + 1}
        `;
        const pageRows = rows.slice(0, limit);
        const last = pageRows.at(-1);
        return {
          items: pageRows.map(mapBundleFileRow),
          nextCursor: rows.length > limit && last
            ? serializeLogicalPathCursor({ logicalPath: last.logical_path, id: last.id })
            : null
        };
      },
      async searchBundleFiles({
        knowledgeBaseId,
        releaseId,
        query,
        scope,
        fileKind,
        limit,
        cursor
      }) {
        const cursorValue = cursor ? parseBundleFileSearchCursor(cursor) : null;
        const normalizedQuery = query.toLocaleLowerCase("en-US");
        const searchPatterns = createSearchQueryTerms(normalizedQuery).map(containsPattern);
        const candidateLimit = Math.min(4_000, Math.max(200, (limit + 1) * 20));
        const fileKindFilter = fileKind ? sql`AND document.file_kind = ${fileKind}` : sql``;
        const searchPredicate =
          scope === "path"
            ? sql`AND ${conjunctivePredicate(sql, searchPatterns, (pattern) =>
                sql`document.path_text ILIKE ${pattern} ESCAPE ${"\\"}`
              )}`
            : scope === "metadata"
              ? sql`AND ${conjunctivePredicate(sql, searchPatterns, (pattern) =>
                  sql`document.metadata_text ILIKE ${pattern} ESCAPE ${"\\"}`
                )}`
              : sql`AND ${conjunctivePredicate(sql, searchPatterns, (pattern) =>
                  sql`document.search_text ILIKE ${pattern} ESCAPE ${"\\"}`
                )}`;
        const pathMatch = conjunctivePredicate(sql, searchPatterns, (pattern) =>
          sql`path_text ILIKE ${pattern} ESCAPE ${"\\"}`
        );
        const titleMatch = conjunctivePredicate(sql, searchPatterns, (pattern) =>
          sql`title_text ILIKE ${pattern} ESCAPE ${"\\"}`
        );
        const descriptionMatch = conjunctivePredicate(sql, searchPatterns, (pattern) =>
          sql`description_text ILIKE ${pattern} ESCAPE ${"\\"}`
        );
        const metadataMatch = conjunctivePredicate(sql, searchPatterns, (pattern) =>
          sql`metadata_text ILIKE ${pattern} ESCAPE ${"\\"}`
        );
        const searchableTextMatch = conjunctivePredicate(sql, searchPatterns, (pattern) =>
          sql`search_text ILIKE ${pattern} ESCAPE ${"\\"}`
        );
        const cursorFilter = cursorValue
          ? sql`AND (
              score < ${cursorValue.score}
              OR (
                score = ${cursorValue.score}
                AND (
                  logical_path > ${cursorValue.logicalPath}
                  OR (logical_path = ${cursorValue.logicalPath} AND bundle_file_id > ${cursorValue.fileId})
                )
              )
            )`
          : sql``;
        const rows = await sql<BundleFileSearchDocumentRow[]>`
          WITH candidates AS MATERIALIZED (
            SELECT
              document.bundle_file_id,
              document.logical_path,
              document.path_text,
              document.title_text,
              document.description_text,
              document.metadata_text,
              document.search_text
            FROM focowiki.bundle_file_search_documents document
            WHERE document.knowledge_base_id = ${knowledgeBaseId}
              AND document.release_id = ${releaseId}
              ${fileKindFilter}
              ${searchPredicate}
            ORDER BY document.logical_path ASC, document.bundle_file_id ASC
            LIMIT ${candidateLimit}
          ),
          field_matches AS MATERIALIZED (
            SELECT
              bundle_file_id,
              logical_path,
              ${pathMatch} AS path_match,
              ${titleMatch} AS title_match,
              ${descriptionMatch} AS description_match,
              ${metadataMatch} AS metadata_text_match,
              ${searchableTextMatch} AS searchable_text_match,
              (
                path_text = ${normalizedQuery}
                OR title_text = ${normalizedQuery}
              ) AS exact_match,
              (
                path_text LIKE ${`${escapeLikePattern(normalizedQuery)}%`} ESCAPE ${"\\"}
                OR title_text LIKE ${`${escapeLikePattern(normalizedQuery)}%`} ESCAPE ${"\\"}
              ) AS prefix_match
            FROM candidates
          ),
          ranked AS (
            SELECT
              bundle_file_id,
              logical_path,
              path_match,
              title_match,
              description_match,
              metadata_text_match AS metadata_match,
              (
                CASE WHEN exact_match THEN 12 ELSE 0 END
                + CASE WHEN prefix_match THEN 6 ELSE 0 END
                + CASE WHEN path_match THEN 5 ELSE 0 END
                + CASE WHEN title_match THEN 4 ELSE 0 END
                + CASE WHEN description_match THEN 2 ELSE 0 END
                + CASE WHEN metadata_text_match THEN 1 ELSE 0 END
                + CASE WHEN searchable_text_match THEN 1 ELSE 0 END
              )::integer AS score
            FROM field_matches
          ),
          limited AS (
            SELECT
              bundle_file_id,
              logical_path,
              path_match,
              title_match,
              description_match,
              metadata_match,
              score
            FROM ranked
            WHERE score > 0
              ${cursorFilter}
            ORDER BY score DESC, logical_path ASC, bundle_file_id ASC
            LIMIT ${limit + 1}
          )
          SELECT
            file.id AS bundle_file_id,
            file.knowledge_base_id,
            file.release_id,
            file.source_file_id,
            file.file_kind,
            file.logical_path,
            file.title,
            file.description,
            file.tags_json,
            file.frontmatter_json,
            limited.path_match,
            limited.title_match,
            limited.description_match,
            limited.metadata_match,
            limited.score
          FROM limited
          JOIN focowiki.bundle_files file
            ON file.knowledge_base_id = ${knowledgeBaseId}
           AND file.release_id = ${releaseId}
           AND file.id = limited.bundle_file_id
          ORDER BY limited.score DESC, limited.logical_path ASC, limited.bundle_file_id ASC
        `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);

        return {
          items: pageRows.map(mapBundleFileSearchDocumentRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeBundleFileSearchCursor({
                  score: Number(lastRow.score),
                  logicalPath: lastRow.logical_path,
                  fileId: lastRow.bundle_file_id
                })
              : null
        };
      },
      async rebuildReleaseGraphProjection(input) {
        return sql.begin(async (transaction) => {
          await transaction`
            DELETE FROM focowiki.knowledge_graph_edges
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND release_id = ${input.releaseId}
          `;
          await transaction`
            DELETE FROM focowiki.knowledge_graph_nodes
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND release_id = ${input.releaseId}
          `;
          const nodeRows = await transaction<Array<{ count: number | string }>>`
            WITH inserted AS (
              INSERT INTO focowiki.knowledge_graph_nodes (
                id, knowledge_base_id, release_id, file_id, source_file_id, path,
                title, summary, subjects_json, entities_json, keywords_json,
                headings_json, explicit_references_json, metadata_json, profile_text,
                quality_status, updated_at
              )
              SELECT 'knowledge-graph-node-' || md5(${input.releaseId} || ':' || source_node.source_file_id),
                     ${input.knowledgeBaseId}, ${input.releaseId}, file.id,
                     source_node.source_file_id, file.logical_path,
                     source_node.title, COALESCE(source_node.summary, source_node.description),
                     source_node.subjects_json, source_node.entities_json,
                     source_node.keywords_json, source_node.headings_json,
                     source_node.explicit_references_json, source_node.metadata_json,
                     left(source_node.profile_json::text, 12000), 'ready', now()
              FROM focowiki.source_file_graph_nodes source_node
              JOIN focowiki.bundle_files file
                ON file.knowledge_base_id = source_node.knowledge_base_id
               AND file.release_id = ${input.releaseId}
               AND file.source_file_id = source_node.source_file_id
               AND file.file_kind = 'page'
              WHERE source_node.knowledge_base_id = ${input.knowledgeBaseId}
              ON CONFLICT (release_id, file_id) DO NOTHING
              RETURNING id
            )
            SELECT count(*)::int AS count FROM inserted
          `;
          const edgeRows = await transaction<Array<{ count: number | string }>>`
            WITH ranked_source_edges AS (
              SELECT source_edge.*,
                     row_number() OVER (
                       PARTITION BY
                         CASE
                           WHEN source_edge.relation_type = ANY(${SYMMETRIC_GRAPH_RELATION_TYPES}::text[])
                             THEN LEAST(source_edge.from_source_file_id, source_edge.to_source_file_id)
                           ELSE source_edge.from_source_file_id
                         END,
                         CASE
                           WHEN source_edge.relation_type = ANY(${SYMMETRIC_GRAPH_RELATION_TYPES}::text[])
                             THEN GREATEST(source_edge.from_source_file_id, source_edge.to_source_file_id)
                           ELSE source_edge.to_source_file_id
                         END,
                         source_edge.relation_type
                       ORDER BY source_edge.weight DESC, source_edge.updated_at DESC, source_edge.id ASC
                     ) AS edge_rank
              FROM focowiki.source_file_graph_edges source_edge
              WHERE source_edge.knowledge_base_id = ${input.knowledgeBaseId}
                AND source_edge.status = 'accepted'
            ), projection_edges AS (
              SELECT source_edge.*,
                     CASE
                       WHEN source_edge.relation_type = ANY(${SYMMETRIC_GRAPH_RELATION_TYPES}::text[])
                         THEN LEAST(source_edge.from_source_file_id, source_edge.to_source_file_id)
                       ELSE source_edge.from_source_file_id
                     END AS projection_from_source_file_id,
                     CASE
                       WHEN source_edge.relation_type = ANY(${SYMMETRIC_GRAPH_RELATION_TYPES}::text[])
                         THEN GREATEST(source_edge.from_source_file_id, source_edge.to_source_file_id)
                       ELSE source_edge.to_source_file_id
                     END AS projection_to_source_file_id,
                     CASE
                       WHEN source_edge.relation_type = ANY(${SYMMETRIC_GRAPH_RELATION_TYPES}::text[])
                         THEN 'bidirectional'::text
                       ELSE 'directed'::text
                     END AS projection_direction
              FROM ranked_source_edges source_edge
              WHERE source_edge.edge_rank = 1
            ), inserted AS (
              INSERT INTO focowiki.knowledge_graph_edges (
                id, knowledge_base_id, release_id, from_node_id, to_node_id,
                from_file_id, to_file_id, relation_type, direction, confidence,
                weight, quality_status, reason, evidence_json, signals_json,
                created_by, updated_at
              )
              SELECT 'knowledge-graph-edge-' || md5(
                       ${input.releaseId} || ':' || source_edge.projection_from_source_file_id || ':' ||
                       source_edge.projection_to_source_file_id || ':' || source_edge.relation_type
                     ),
                     ${input.knowledgeBaseId}, ${input.releaseId}, from_node.id, to_node.id,
                     from_node.file_id, to_node.file_id, source_edge.relation_type,
                     source_edge.projection_direction, source_edge.weight, source_edge.weight, 'accepted',
                     source_edge.reason,
                     CASE
                       WHEN jsonb_typeof(source_edge.evidence_json->'items') = 'array'
                         THEN source_edge.evidence_json->'items'
                       ELSE jsonb_build_array(source_edge.evidence_json)
                     END,
                     '{}'::jsonb, source_edge.source, now()
              FROM projection_edges source_edge
              JOIN focowiki.knowledge_graph_nodes from_node
                ON from_node.release_id = ${input.releaseId}
               AND from_node.source_file_id = source_edge.projection_from_source_file_id
              JOIN focowiki.knowledge_graph_nodes to_node
                ON to_node.release_id = ${input.releaseId}
               AND to_node.source_file_id = source_edge.projection_to_source_file_id
              ON CONFLICT (release_id, from_node_id, to_node_id, relation_type) DO NOTHING
              RETURNING id
            )
            SELECT count(*)::int AS count FROM inserted
          `;
          return {
            nodeCount: Number(nodeRows[0]?.count ?? 0),
            edgeCount: Number(edgeRows[0]?.count ?? 0)
          };
        });
      },
      async rebuildBundleGraphSearchDocuments(input) {
        return rebuildBundleGraphSearchDocuments(sql, input);
      },
      async searchBundleGraphFiles({
        knowledgeBaseId,
        releaseId,
        query,
        scope,
        fileKind,
        graphDepth,
        graphFanout,
        limit,
        cursor
      }) {
        if (fileKind && fileKind !== "page") {
          return { items: [], nextCursor: null };
        }

        const cursorValue = cursor ? parseBundleFileSearchCursor(cursor) : null;
        const normalizedQuery = query.toLocaleLowerCase("en-US");
        const searchPatterns = createSearchQueryTerms(normalizedQuery).map(containsPattern);
        const candidateLimit = Math.min(4_000, Math.max(200, (limit + 1) * 20));
        const pathMatch = conjunctivePredicate(sql, searchPatterns, (pattern) =>
          sql`document.path ILIKE ${pattern} ESCAPE ${"\\"}`
        );
        const titleMatch = conjunctivePredicate(sql, searchPatterns, (pattern) =>
          sql`coalesce(document.title, '') ILIKE ${pattern} ESCAPE ${"\\"}`
        );
        const descriptionMatch = conjunctivePredicate(sql, searchPatterns, (pattern) =>
          sql`coalesce(document.summary, '') ILIKE ${pattern} ESCAPE ${"\\"}`
        );
        const metadataMatch = conjunctivePredicate(sql, searchPatterns, (pattern) =>
          sql`coalesce(document.matched_field_text, '') ILIKE ${pattern} ESCAPE ${"\\"}`
        );
        const graphTextMatch = conjunctivePredicate(sql, searchPatterns, (pattern) =>
          sql`document.search_text ILIKE ${pattern} ESCAPE ${"\\"}`
        );
        const neighborMatch = conjunctivePredicate(sql, searchPatterns, (pattern) =>
          sql`document.neighbor_text ILIKE ${pattern} ESCAPE ${"\\"}`
        );
        const graphContextMatch = conjunctivePredicate(sql, searchPatterns, (pattern) =>
          sql`(
            document.search_text ILIKE ${pattern} ESCAPE ${"\\"}
            OR document.neighbor_text ILIKE ${pattern} ESCAPE ${"\\"}
          )`
        );
        const searchPredicate =
          scope === "path"
            ? sql`AND ${pathMatch}`
            : scope === "metadata"
              ? sql`AND ${metadataMatch}`
              : sql`AND ${graphContextMatch}`;
        const cursorFilter = cursorValue
          ? sql`AND (
              score < ${cursorValue.score}
              OR (
                score = ${cursorValue.score}
                AND (
                  logical_path > ${cursorValue.logicalPath}
                  OR (logical_path = ${cursorValue.logicalPath} AND bundle_file_id > ${cursorValue.fileId})
                )
              )
            )`
          : sql``;
        const depthFactor = graphDepth === 0 ? 0 : graphDepth === 1 ? 1 : 2;
        const rows = await sql<BundleGraphSearchDocumentRow[]>`
          WITH candidates AS MATERIALIZED (
            SELECT
              document.id,
              document.file_id,
              document.path,
              document.anchor_type,
              document.title,
              document.summary,
              document.search_text,
              document.matched_field_text,
              document.neighbor_text
            FROM focowiki.knowledge_graph_search_documents document
            WHERE document.knowledge_base_id = ${knowledgeBaseId}
              AND document.release_id = ${releaseId}
              AND document.file_id IS NOT NULL
              AND document.path IS NOT NULL
              ${searchPredicate}
            ORDER BY document.path ASC NULLS LAST, document.file_id ASC, document.id ASC
            LIMIT ${candidateLimit}
          ),
          scored_documents AS MATERIALIZED (
            SELECT
              document.id AS document_id,
              file.source_file_id,
              file.id AS bundle_file_id,
              file.logical_path,
              ${pathMatch} AS path_match,
              ${titleMatch} AS title_match,
              ${descriptionMatch} AS description_match,
              ${metadataMatch} AS metadata_match,
              document.anchor_type = 'node'
                AND ${graphContextMatch} AS node_match,
              document.anchor_type = 'edge'
                AND ${graphContextMatch} AS relationship_match,
              ${neighborMatch} AS neighbor_match,
              document.anchor_type = 'edge'
                AND ${graphTextMatch} AS edge_match,
              (
                CASE WHEN document.path = ${normalizedQuery} OR coalesce(document.title, '') = ${normalizedQuery} THEN 12 ELSE 0 END
                + CASE WHEN ${pathMatch} THEN 6 ELSE 0 END
                + CASE WHEN ${titleMatch} THEN 6 ELSE 0 END
                + CASE WHEN ${descriptionMatch} THEN 3 ELSE 0 END
                + CASE WHEN document.anchor_type = 'node' AND ${graphContextMatch} THEN 4 ELSE 0 END
                + CASE WHEN document.anchor_type = 'edge' AND ${graphContextMatch} THEN 5 ELSE 0 END
                + CASE WHEN ${neighborMatch} THEN ${depthFactor} ELSE 0 END
                + CASE WHEN ${metadataMatch} THEN 1 ELSE 0 END
              )::integer AS score
            FROM candidates document
            JOIN focowiki.bundle_files file
              ON file.id = document.file_id
            WHERE file.knowledge_base_id = ${knowledgeBaseId}
              AND file.release_id = ${releaseId}
              AND file.file_kind = 'page'
          ),
          ranked AS (
            SELECT DISTINCT ON (bundle_file_id)
              *
            FROM scored_documents
            WHERE score > 0
            ORDER BY bundle_file_id ASC, score DESC, logical_path ASC, document_id ASC
          ),
          limited AS (
            SELECT
              document_id,
              source_file_id,
              bundle_file_id,
              logical_path,
              path_match,
              title_match,
              description_match,
              metadata_match,
              node_match,
              relationship_match,
              neighbor_match,
              edge_match,
              score,
              CASE
                WHEN edge_match OR relationship_match THEN 'graph_edge'
                WHEN neighbor_match THEN 'graph_neighbor'
                WHEN node_match THEN 'graph_node'
                WHEN path_match OR title_match OR description_match OR metadata_match THEN 'file_direct'
                ELSE 'graph_node'
              END AS match_type
            FROM ranked
            WHERE score > 0
              ${cursorFilter}
            ORDER BY score DESC, logical_path ASC, bundle_file_id ASC
            LIMIT ${limit + 1}
          )
          SELECT
            file.id AS bundle_file_id,
            file.knowledge_base_id,
            ${releaseId} AS release_id,
            file.source_file_id,
            file.file_kind,
            file.logical_path,
            file.title,
            file.description,
            file.tags_json,
            file.frontmatter_json,
            limited.path_match,
            limited.title_match,
            limited.description_match,
            limited.metadata_match,
            limited.node_match,
            limited.relationship_match,
            limited.neighbor_match,
            limited.edge_match,
            limited.match_type::text AS match_type,
            limited.score,
            '_graph/by-file/' || COALESCE(file.source_file_id, file.id) || '.json' AS graph_ref,
            document.relationship_count,
            document.top_neighbors_json AS top_relationships_json,
            ${graphDepth}::integer AS depth
          FROM limited
          JOIN focowiki.knowledge_graph_search_documents document
            ON document.id = limited.document_id
           AND document.knowledge_base_id = ${knowledgeBaseId}
           AND document.release_id = ${releaseId}
          JOIN focowiki.bundle_files file
            ON file.id = limited.bundle_file_id
           AND file.knowledge_base_id = ${knowledgeBaseId}
           AND file.release_id = ${releaseId}
          ORDER BY limited.score DESC, limited.logical_path ASC, limited.bundle_file_id ASC
        `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);

        return {
          items: pageRows.map((row) => mapBundleGraphSearchDocumentRow(row, graphFanout)),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeBundleFileSearchCursor({
                  score: Number(lastRow.score),
                  logicalPath: lastRow.logical_path,
                  fileId: lastRow.bundle_file_id
                })
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
      async markSourceFilesPublicationDirty({ knowledgeBaseId, sourceFileIds, dirtyAt }) {
        if (sourceFileIds.length === 0) {
          return;
        }

        await sql`
          UPDATE focowiki.source_files
          SET
            generated_output_status = CASE
              WHEN generated_output_status = 'visible' AND generated_bundle_file_path IS NOT NULL
                THEN 'visible'
              ELSE 'pending'
            END,
            generated_bundle_file_id = CASE
              WHEN generated_output_status = 'visible' AND generated_bundle_file_path IS NOT NULL
                THEN generated_bundle_file_id
              ELSE NULL
            END,
            generated_bundle_file_path = CASE
              WHEN generated_output_status = 'visible' AND generated_bundle_file_path IS NOT NULL
                THEN generated_bundle_file_path
              ELSE NULL
            END,
            publication_dirty_at = ${dirtyAt},
            publication_error_code = NULL,
            publication_error_message = NULL
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND id = ANY(${sourceFileIds})
            AND deleted_at IS NULL
            AND task_deleted_at IS NULL
        `;
        await sql`
          UPDATE focowiki.resource_operations operation
          SET state = 'publishing', updated_at = ${dirtyAt}
          WHERE operation.knowledge_base_id = ${knowledgeBaseId}
            AND operation.operation_kind = 'source_file_replace'
            AND operation.state = 'processing'
            AND EXISTS (
              SELECT 1 FROM focowiki.source_files source
              WHERE source.id = ANY(${sourceFileIds})
                AND source.candidate_operation_id = operation.id
            )
        `;
      },
      async countDirtySourceFiles({ knowledgeBaseId }) {
        const rows = await sql<Array<{ count: string | number; oldest_dirty_at: Date | null }>>`
          SELECT
            count(*) AS count,
            min(publication_dirty_at) AS oldest_dirty_at
          FROM focowiki.source_files
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND deleted_at IS NULL
            AND task_deleted_at IS NULL
            AND (processing_status = 'completed' OR candidate_operation_id IS NOT NULL)
            AND publication_dirty_at IS NOT NULL
        `;
        const row = rows[0];

        return {
          count: Number(row?.count ?? 0),
          oldestDirtyAt: row?.oldest_dirty_at?.toISOString() ?? null
        };
      },
      async listDirtySourceFiles({ knowledgeBaseId, limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<Array<SourceFileRow & { cursor_timestamp: string }>>`
              SELECT ${sql.unsafe(SOURCE_FILE_SELECT_COLUMNS)},
                     floor(extract(epoch FROM source.publication_dirty_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.source_files source
              WHERE source.knowledge_base_id = ${knowledgeBaseId}
                AND source.deleted_at IS NULL
                AND source.task_deleted_at IS NULL
                AND (source.processing_status = 'completed' OR source.candidate_operation_id IS NOT NULL)
                AND source.publication_dirty_at IS NOT NULL
                AND (
                  source.publication_dirty_at > to_timestamp(${cursorValue.createdAt}::double precision / 1000000)
                  OR (source.publication_dirty_at = to_timestamp(${cursorValue.createdAt}::double precision / 1000000) AND source.id > ${cursorValue.id})
                )
              ORDER BY source.publication_dirty_at ASC, source.id ASC
              LIMIT ${limit + 1}
            `
          : await sql<Array<SourceFileRow & { cursor_timestamp: string }>>`
              SELECT ${sql.unsafe(SOURCE_FILE_SELECT_COLUMNS)},
                     floor(extract(epoch FROM source.publication_dirty_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.source_files source
              WHERE source.knowledge_base_id = ${knowledgeBaseId}
                AND source.deleted_at IS NULL
                AND source.task_deleted_at IS NULL
                AND (source.processing_status = 'completed' OR source.candidate_operation_id IS NOT NULL)
                AND source.publication_dirty_at IS NOT NULL
              ORDER BY source.publication_dirty_at ASC, source.id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);

        return {
          items: pageRows.map(mapSourceFileRow),
          nextCursor:
            rows.length > limit && lastRow?.publication_dirty_at
              ? serializeTimedCursor({
                  createdAt: lastRow.cursor_timestamp,
                  id: lastRow.id
                })
              : null
        };
      },
      async markSourceFilesPublicationVisible({
        knowledgeBaseId,
        sourceFileIds,
        generatedOutputs,
        visibleAt
      }) {
        if (sourceFileIds.length === 0) {
          return;
        }

        await sql.begin(async (transaction) => {
          await transaction`
            UPDATE focowiki.source_files
            SET
              processing_stage = 'release_activation',
              processing_ended_at = ${visibleAt},
              generated_output_status = 'visible',
              generated_bundle_file_id = NULL,
              generated_bundle_file_path = NULL,
              publication_dirty_at = NULL,
              publication_visible_at = ${visibleAt},
              publication_error_code = NULL,
              publication_error_message = NULL
            WHERE knowledge_base_id = ${knowledgeBaseId}
              AND id = ANY(${sourceFileIds})
              AND deleted_at IS NULL
              AND task_deleted_at IS NULL
          `;

          for (const output of generatedOutputs) {
            await transaction`
              UPDATE focowiki.source_files
              SET
                generated_bundle_file_id = ${output.bundleFileId},
                generated_bundle_file_path = ${output.logicalPath}
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND id = ${output.sourceFileId}
                AND id = ANY(${sourceFileIds})
                AND deleted_at IS NULL
                AND task_deleted_at IS NULL
            `;
          }
        });
      },
      async markSourceFilesPublicationFailed({
        knowledgeBaseId,
        sourceFileIds,
        errorCode,
        errorMessage
      }) {
        if (sourceFileIds.length === 0) {
          return;
        }

        await sql`
          UPDATE focowiki.source_files
          SET
            generated_output_status = 'unavailable',
            generated_bundle_file_id = NULL,
            generated_bundle_file_path = NULL,
            publication_error_code = ${errorCode},
            publication_error_message = ${errorMessage}
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND id = ANY(${sourceFileIds})
            AND deleted_at IS NULL
            AND task_deleted_at IS NULL
        `;
      },
      async createPublicationJob(input) {
        const rows = await sql<PublicationJobRow[]>`
          INSERT INTO focowiki.publication_jobs (
            id,
            knowledge_base_id,
            mode,
            reason,
            dirty_source_count
          )
          VALUES (
            ${input.id},
            ${input.knowledgeBaseId},
            ${input.mode},
            ${input.reason},
            ${input.dirtySourceCount}
          )
          RETURNING id, knowledge_base_id, mode, reason, status, dirty_source_count, release_id, started_at, ended_at, error_code, error_message, created_at, updated_at
        `;
        const row = rows[0];

        if (!row) {
          throw new Error("Publication job creation did not return a row");
        }

        return mapPublicationJobRow(row);
      },
      async startPublicationJob({ id, startedAt }) {
        const rows = await sql<PublicationJobRow[]>`
          UPDATE focowiki.publication_jobs
          SET
            status = 'running',
            started_at = ${startedAt},
            updated_at = now()
          WHERE id = ${id}
            AND status = 'queued'
          RETURNING id, knowledge_base_id, mode, reason, status, dirty_source_count, release_id, started_at, ended_at, error_code, error_message, created_at, updated_at
        `;
        const row = rows[0];
        return row ? mapPublicationJobRow(row) : null;
      },
      async completePublicationJob({ id, releaseId, endedAt }) {
        const rows = await sql<PublicationJobRow[]>`
          UPDATE focowiki.publication_jobs
          SET
            status = 'completed',
            release_id = ${releaseId},
            ended_at = ${endedAt},
            updated_at = now()
          WHERE id = ${id}
          RETURNING id, knowledge_base_id, mode, reason, status, dirty_source_count, release_id, started_at, ended_at, error_code, error_message, created_at, updated_at
        `;
        const row = rows[0];
        return row ? mapPublicationJobRow(row) : null;
      },
      async failPublicationJob({ id, endedAt, errorCode, errorMessage }) {
        const rows = await sql<PublicationJobRow[]>`
          UPDATE focowiki.publication_jobs
          SET
            status = 'failed',
            ended_at = ${endedAt},
            error_code = ${errorCode},
            error_message = ${errorMessage},
            updated_at = now()
          WHERE id = ${id}
          RETURNING id, knowledge_base_id, mode, reason, status, dirty_source_count, release_id, started_at, ended_at, error_code, error_message, created_at, updated_at
        `;
        const row = rows[0];
        return row ? mapPublicationJobRow(row) : null;
      },
      async deleteSourceFileTasks({ knowledgeBaseId, sourceFileIds, deletedAt }) {
        const requestedIds = uniqueStrings(sourceFileIds);

        if (requestedIds.length === 0) {
          return [];
        }

        return await sql.begin(async (transaction) => {
          const sourceRows = await transaction<SourceFileRow[]>`
            SELECT ${transaction.unsafe(SOURCE_FILE_SELECT_COLUMNS)}
            FROM focowiki.source_files source
            WHERE source.id = ANY(${requestedIds})
              AND source.knowledge_base_id = ${knowledgeBaseId}
            FOR UPDATE
          `;
          const wrongKnowledgeBaseRows = await transaction<Array<{ id: string }>>`
            SELECT id
            FROM focowiki.source_files
            WHERE id = ANY(${requestedIds})
              AND knowledge_base_id <> ${knowledgeBaseId}
          `;
          const workerRows = await transaction<SourceFileTaskWorkerJobRow[]>`
            SELECT id, source_file_id, status
            FROM focowiki.worker_jobs
            WHERE knowledge_base_id = ${knowledgeBaseId}
              AND kind = 'source_file_processing'
              AND source_file_id = ANY(${requestedIds})
              AND status IN ('queued', 'running')
            FOR UPDATE
          `;

          const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
          const wrongKnowledgeBaseIds = new Set(wrongKnowledgeBaseRows.map((row) => row.id));
          const workerRowsBySourceFileId = groupWorkerRowsBySourceFileId(workerRows);
          const deletedRows: SourceFileRow[] = [];
          const hiddenRows: SourceFileRow[] = [];
          const results: SourceFileTaskDeletionRepositoryResult[] = [];

          for (const sourceFileId of requestedIds) {
            const source = sourceById.get(sourceFileId);

            if (!source) {
              results.push({
                sourceFileId,
                outcome: "skipped",
                reason: wrongKnowledgeBaseIds.has(sourceFileId) ? "wrong_knowledge_base" : "missing"
              });
              continue;
            }

            if (source.deleted_at || source.task_deleted_at) {
              results.push({ sourceFileId, outcome: "skipped", reason: "already_removed" });
              continue;
            }

            const workerRowsForSource = workerRowsBySourceFileId.get(sourceFileId) ?? [];
            const hasRunningWorker = workerRowsForSource.some((worker) => worker.status === "running");

            if (source.processing_status === "running") {
              results.push({ sourceFileId, outcome: "skipped", reason: "running" });
              continue;
            }

            if (hasRunningWorker) {
              results.push({ sourceFileId, outcome: "skipped", reason: "job_already_claimed" });
              continue;
            }

            if (isPublicationOwnedSourceFileRow(source)) {
              results.push({
                sourceFileId,
                outcome: "skipped",
                reason: source.generated_output_status === "pending" ? "completed_pending" : "publication_owned"
              });
              continue;
            }

            if (isVisibleGeneratedOutputSourceFileRow(source)) {
              hiddenRows.push(source);
              results.push({
                sourceFileId,
                outcome: "hidden",
                generatedFileId: source.generated_bundle_file_id,
                generatedFilePath: source.generated_bundle_file_path
              });
              continue;
            }

            deletedRows.push(source);
            results.push({ sourceFileId, outcome: "deleted", objectKey: source.object_key });
          }

          const deletedIds = deletedRows.map((source) => source.id);
          const hiddenIds = hiddenRows.map((source) => source.id);

          if (deletedIds.length > 0) {
            await transaction`
              UPDATE focowiki.worker_jobs
              SET
                status = 'cancelled',
                locked_by = NULL,
                locked_at = NULL,
                heartbeat_at = NULL,
                completed_at = ${deletedAt},
                failed_at = NULL,
                last_error_code = 'SOURCE_FILE_TASK_DELETED',
                last_error_message = 'Source file task was deleted before processing.',
                updated_at = now()
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND kind = 'source_file_processing'
                AND source_file_id = ANY(${deletedIds})
                AND status = 'queued'
            `;
            await transaction`
              UPDATE focowiki.source_files
              SET
                deleted_at = ${deletedAt},
                generated_output_status = 'unavailable',
                generated_bundle_file_id = NULL,
                generated_bundle_file_path = NULL,
                publication_dirty_at = NULL,
                publication_error_code = NULL,
                publication_error_message = NULL,
                graph_relationship_count = 0,
                graph_top_relationships_json = '[]'::jsonb
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND id = ANY(${deletedIds})
                AND deleted_at IS NULL
            `;
          }

          if (hiddenIds.length > 0) {
            await transaction`
              UPDATE focowiki.source_files
              SET task_deleted_at = ${deletedAt}
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND id = ANY(${hiddenIds})
                AND deleted_at IS NULL
                AND task_deleted_at IS NULL
            `;
          }

          for (const source of [...deletedRows, ...hiddenRows]) {
            await transaction`
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
                ${knowledgeBaseId},
                ${source.id},
                'source_deletion',
                'sourceFiles.stage.taskDeletion',
                ${deletedAt},
                ${deletedAt},
                'info'
              )
            `;
          }

          return results;
        });
      }
    },
    graph: createPostgresFileGraphRepository(sql),
    hardDelete: createPostgresHardDeleteRepository(sql),
    workerJobs: createPostgresWorkerJobRepository(sql),
    modelInvocations: {
      async createModelInvocation(input) {
        const rows = await sql.begin(async (transaction) => {
          const inserted = await transaction<ModelInvocationRow[]>`
            INSERT INTO focowiki.model_invocations (
              id,
              knowledge_base_id,
              source_file_id,
              model_config_id,
              api_mode,
              model_name,
              status,
              started_at,
              ended_at,
              warning_count,
              error_code,
              error_message
            )
            SELECT
              ${input.id ?? createModelInvocationId()},
              ${input.knowledgeBaseId},
              ${input.sourceFileId},
              ${input.modelConfigId ?? null},
              ${input.apiMode ?? null},
              ${input.modelName},
              ${input.status},
              ${input.startedAt},
              ${input.endedAt},
              ${input.warningCount},
              ${input.errorCode},
              ${input.errorMessage}
            FROM focowiki.source_files source
            WHERE source.id = ${input.sourceFileId}
              AND source.knowledge_base_id = ${input.knowledgeBaseId}
              AND source.deleted_at IS NULL
              AND source.deletion_intent_id IS NULL
            RETURNING
              id,
              knowledge_base_id,
              source_file_id,
              model_config_id,
              api_mode,
              model_name,
              status,
              started_at,
              ended_at,
              warning_count,
              error_code,
              error_message,
              created_at
          `;
          const row = inserted[0];

          if (row) {
            await transaction`
              UPDATE focowiki.source_files
              SET
                model_invocation_status = ${row.status},
                model_invocation_model_name = ${row.model_name},
                model_invocation_started_at = ${row.started_at},
                model_invocation_ended_at = ${row.ended_at},
                model_invocation_warning_count = ${row.warning_count},
                model_invocation_error_code = ${row.error_code}
              WHERE knowledge_base_id = ${row.knowledge_base_id}
                AND id = ${row.source_file_id}
                AND deleted_at IS NULL
                AND deletion_intent_id IS NULL
            `;
          }

          return inserted;
        });
        const row = rows[0];

        if (!row) {
          throw new Error("Model invocation creation did not return a row");
        }

        return mapModelInvocationRow(row);
      },
      async completeModelInvocation(input) {
        const rows = await sql.begin(async (transaction) => {
          const updated = await transaction<ModelInvocationRow[]>`
            UPDATE focowiki.model_invocations
            SET
              status = ${input.status},
              ended_at = ${input.endedAt},
              warning_count = ${input.warningCount ?? 0},
              error_code = ${input.errorCode ?? null},
              error_message = ${input.errorMessage ?? null}
            WHERE id = ${input.id}
              AND EXISTS (
                SELECT 1 FROM focowiki.source_files source
                WHERE source.id = focowiki.model_invocations.source_file_id
                  AND source.knowledge_base_id = focowiki.model_invocations.knowledge_base_id
                  AND source.deleted_at IS NULL
                  AND source.deletion_intent_id IS NULL
              )
            RETURNING
              id,
              knowledge_base_id,
              source_file_id,
              model_config_id,
              api_mode,
              model_name,
              status,
              started_at,
              ended_at,
              warning_count,
              error_code,
              error_message,
              created_at
          `;
          const row = updated[0];

          if (row) {
            await transaction`
              UPDATE focowiki.source_files
              SET
                model_invocation_status = ${row.status},
                model_invocation_model_name = ${row.model_name},
                model_invocation_started_at = ${row.started_at},
                model_invocation_ended_at = ${row.ended_at},
                model_invocation_warning_count = ${row.warning_count},
                model_invocation_error_code = ${row.error_code}
              WHERE knowledge_base_id = ${row.knowledge_base_id}
                AND id = ${row.source_file_id}
            `;
          }

          return updated;
        });
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
          ? await sql<Array<PublicApiKeyRow & { cursor_timestamp: string }>>`
              SELECT id, name, key_hash, key_prefix, key_suffix, status, created_at, last_used_at, revoked_at,
                     floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.public_api_keys
              WHERE status = 'active'
                AND (
                  created_at < to_timestamp(${cursorValue.createdAt}::double precision / 1000000)
                  OR (created_at = to_timestamp(${cursorValue.createdAt}::double precision / 1000000) AND id > ${cursorValue.id})
                )
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<Array<PublicApiKeyRow & { cursor_timestamp: string }>>`
              SELECT id, name, key_hash, key_prefix, key_suffix, status, created_at, last_used_at, revoked_at,
                     floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
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
                  createdAt: lastRow.cursor_timestamp,
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
          ? await sql<Array<WebhookSubscriptionRow & { cursor_timestamp: string }>>`
              SELECT id, name, url, signing_secret, events_json, enabled, created_at, updated_at, last_delivery_at,
                     floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.webhook_subscriptions
              WHERE enabled = true
                AND (
                  created_at < to_timestamp(${cursorValue.createdAt}::double precision / 1000000)
                  OR (created_at = to_timestamp(${cursorValue.createdAt}::double precision / 1000000) AND id > ${cursorValue.id})
                )
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<Array<WebhookSubscriptionRow & { cursor_timestamp: string }>>`
              SELECT id, name, url, signing_secret, events_json, enabled, created_at, updated_at, last_delivery_at,
                     floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
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
                  createdAt: lastRow.cursor_timestamp,
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
          ? await sql<Array<WebhookDeliveryRow & { cursor_timestamp: string }>>`
              SELECT id, webhook_id, event_id, event_type, payload_json, status, attempt_count, http_status, error_code, created_at, updated_at,
                     floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.webhook_deliveries
              WHERE (
                created_at < to_timestamp(${cursorValue.createdAt}::double precision / 1000000)
                OR (created_at = to_timestamp(${cursorValue.createdAt}::double precision / 1000000) AND id > ${cursorValue.id})
              )
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<Array<WebhookDeliveryRow & { cursor_timestamp: string }>>`
              SELECT id, webhook_id, event_id, event_type, payload_json, status, attempt_count, http_status, error_code, created_at, updated_at,
                     floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
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
                  createdAt: lastRow.cursor_timestamp,
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
    resourceRevision: row.resource_revision,
    catalogGeneration: Number(row.catalog_generation),
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

function containsKnowledgeBaseLikePattern(value: string): string {
  return `%${escapeKnowledgeBaseLikePattern(value)}%`;
}

function escapeKnowledgeBaseLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function mapBundleTreeEntryRow(row: BundleTreeEntryRow): BundleTreeEntryRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    releaseId: row.release_id,
    parentPath: row.parent_path,
    name: row.name,
    logicalPath: row.logical_path,
    sortKey: row.sort_key,
    entryType: row.entry_type,
    bundleFileId: row.bundle_file_id,
    sourceFileId: row.source_file_id,
    sourceDirectoryId: row.source_directory_id ?? null,
    fileKind: row.file_kind,
    childCount: Number(row.child_count),
    directFileCount: Number(row.direct_file_count ?? 0),
    descendantFileCount: Number(row.descendant_file_count ?? 0),
    resourceRevision: row.directory_resource_revision ?? null
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

function mapReleaseReadSummaryRow(row: ReleaseReadSummaryRow): ReleaseReadSummaryRecord {
  return {
    releaseId: row.release_id,
    knowledgeBaseId: row.knowledge_base_id,
    searchableFileCount: Number(row.searchable_file_count),
    treeNodeCount: Number(row.tree_node_count),
    graphDocumentCount: Number(row.graph_document_count),
    graphRelationshipCount: Number(row.graph_relationship_count),
    graphNodeCount: Number(row.graph_node_count),
    graphEdgeCount: Number(row.graph_edge_count)
  };
}

function mapBundleFileSearchDocumentRow(
  row: BundleFileSearchDocumentRow
): BundleFileSearchResultRecord {
  const matchedFields: BundleFileSearchResultRecord["matchedFields"] = [];

  if (row.path_match) {
    matchedFields.push("path");
  }

  if (row.title_match) {
    matchedFields.push("title");
  }

  if (row.description_match) {
    matchedFields.push("description");
  }

  if (row.metadata_match) {
    matchedFields.push("metadata");
  }

  return {
    fileId: row.bundle_file_id,
    knowledgeBaseId: row.knowledge_base_id,
    releaseId: row.release_id,
    sourceFileId: row.source_file_id,
    fileKind: row.file_kind,
    path: row.logical_path,
    title: row.title,
    description: row.description,
    tags: readStringArray(row.tags_json),
    frontmatter: readRecord(row.frontmatter_json),
    matchedFields,
    score: Number(row.score),
    contentAvailable: true
  };
}

function mapBundleGraphSearchDocumentRow(
  row: BundleGraphSearchDocumentRow,
  graphFanout: number
): BundleGraphSearchResultRecord {
  const base = mapBundleFileSearchDocumentRow(row);
  const matchedNodeFields = [
    row.path_match ? "path" : null,
    row.title_match ? "title" : null,
    row.description_match ? "description" : null,
    row.metadata_match ? "metadata" : null,
    row.node_match ? "node" : null
  ].filter((field): field is string => Boolean(field));
  const matchedRelationshipFields = [
    row.relationship_match ? "relationship" : null,
    row.neighbor_match ? "neighbor" : null,
    row.edge_match ? "edge" : null
  ].filter((field): field is string => Boolean(field));
  const depth = Number(row.depth) as GraphSearchDepth;
  const relationships = readFileGraphRelatedRecords(row.top_relationships_json)
    .slice(0, depth === 0 ? 0 : graphFanout);

  return {
    ...base,
    matchType: row.match_type,
    graphContext: {
      graphRef: row.graph_ref,
      depth,
      seedSourceFileId: row.source_file_id ?? "",
      matchedNodeFields,
      matchedRelationshipFields,
      relationships,
      graphPaths: uniqueStrings([
        row.graph_ref,
        ...relationships.map((relationship) => graphRefForSourceFile(relationship.sourceFileId))
      ])
    }
  };
}

function mapSourceFileRow(row: SourceFileRow): SourceFileRecord {
  const relativePath = row.relative_path;
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    name: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    resourceRevision: row.resource_revision,
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
    generatedOutputStatus: row.generated_output_status,
    generatedBundleFileId: row.generated_bundle_file_id,
    generatedBundleFilePath: row.generated_bundle_file_path,
    publicationDirtyAt: row.publication_dirty_at?.toISOString() ?? null,
    publicationVisibleAt: row.publication_visible_at?.toISOString() ?? null,
    publicationErrorCode: row.publication_error_code,
    publicationErrorMessage: row.publication_error_message,
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
    taskDeletedAt: row.task_deleted_at?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null
  };
}

function groupWorkerRowsBySourceFileId(
  rows: SourceFileTaskWorkerJobRow[]
): Map<string, SourceFileTaskWorkerJobRow[]> {
  const grouped = new Map<string, SourceFileTaskWorkerJobRow[]>();

  for (const row of rows) {
    if (!row.source_file_id) {
      continue;
    }

    const current = grouped.get(row.source_file_id) ?? [];
    current.push(row);
    grouped.set(row.source_file_id, current);
  }

  return grouped;
}

function isVisibleGeneratedOutputSourceFileRow(row: SourceFileRow): boolean {
  return row.generated_output_status === "visible" && Boolean(row.generated_bundle_file_path);
}

function isPublicationOwnedSourceFileRow(row: SourceFileRow): boolean {
  return (
    row.processing_status === "completed" &&
    (!isVisibleGeneratedOutputSourceFileRow(row) || row.publication_dirty_at !== null)
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function mapPublicationJobRow(row: PublicationJobRow): PublicationJobRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    mode: row.mode,
    reason: row.reason,
    status: row.status,
    dirtySourceCount: Number(row.dirty_source_count),
    releaseId: row.release_id,
    startedAt: row.started_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function mapReleaseRow(row: ReleaseRow): ReleaseRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    bundleRootKey: row.bundle_root_key,
    catalogGeneration: Number(row.catalog_generation),
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
    modelConfigId: row.model_config_id,
    apiMode: row.api_mode,
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

function readFileGraphRelatedRecords(value: unknown): FileGraphRelatedRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item): FileGraphRelatedRecord | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }

      const record = item as Record<string, unknown>;
      const fileId = typeof record.fileId === "string" ? record.fileId : null;
      const sourceFileId = typeof record.sourceFileId === "string" ? record.sourceFileId : null;
      const path = typeof record.path === "string" ? record.path : null;
      const title = typeof record.title === "string" ? record.title : null;
      const relationType = typeof record.relationType === "string" ? record.relationType : null;
      const direction = record.direction === "incoming" || record.direction === "outgoing"
        ? record.direction
        : null;
      const weight = typeof record.weight === "number" ? record.weight : Number(record.weight ?? 0);
      const reason = typeof record.reason === "string" ? record.reason : "";
      const source = typeof record.source === "string" ? record.source : "";

      if (!fileId || !sourceFileId || !path || !title || !relationType || !direction) {
        return null;
      }

      return {
        fileId,
        sourceFileId,
        bundleFileId: typeof record.bundleFileId === "string" ? record.bundleFileId : null,
        path,
        title,
        relationType,
        direction,
        weight: Number.isFinite(weight) ? weight : 0,
        reason,
        source,
        evidence: readRecord(record.evidence),
        contentAvailable: record.contentAvailable === true
      };
    })
    .filter((item): item is FileGraphRelatedRecord => Boolean(item));
}

async function rebuildBundleGraphSearchDocuments(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    releaseId: string;
  }
): Promise<BundleGraphSearchIndexResult> {
  return await sql.begin(async (transaction) => {
    await transaction`
      DELETE FROM focowiki.knowledge_graph_search_documents
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND release_id = ${input.releaseId}
    `;

    const fileRows = await transaction<Array<{ count: string | number }>>`
      WITH inserted AS (
        INSERT INTO focowiki.knowledge_graph_search_documents (
          id,
          knowledge_base_id,
          release_id,
          file_id,
          path,
          anchor_type,
          title,
          summary,
          search_text,
          matched_field_text,
          neighbor_text,
          relationship_count,
          top_neighbors_json
        )
        SELECT
          'knowledge-graph-search-file-' || md5(${input.releaseId} || ':' || file.id),
          file.knowledge_base_id,
          ${input.releaseId},
          file.id,
          file.logical_path,
          'file',
          file.title,
          file.description,
          left(lower(concat_ws(
            ' ',
            file.logical_path,
            file.title,
            file.description,
            file.tags_json::text,
            file.frontmatter_json::text
          )), 12000),
          left(lower(concat_ws(' ', file.title, file.description, file.tags_json::text)), 4000),
          ''::text,
          0,
          '[]'::jsonb
        FROM focowiki.bundle_files file
        WHERE file.knowledge_base_id = ${input.knowledgeBaseId}
          AND file.release_id = ${input.releaseId}
          AND file.navigation_only = false
        ON CONFLICT (id) DO UPDATE SET
          file_id = EXCLUDED.file_id,
          path = EXCLUDED.path,
          anchor_type = EXCLUDED.anchor_type,
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          search_text = EXCLUDED.search_text,
          matched_field_text = EXCLUDED.matched_field_text,
          neighbor_text = EXCLUDED.neighbor_text,
          relationship_count = EXCLUDED.relationship_count,
          top_neighbors_json = EXCLUDED.top_neighbors_json,
          updated_at = now()
        RETURNING id
      )
      SELECT count(*) AS count
      FROM inserted
    `;

    const nodeRows = await transaction<Array<{ count: string | number }>>`
      WITH edge_counts AS MATERIALIZED (
        SELECT
          file_id,
          count(*)::integer AS relationship_count
        FROM (
          SELECT from_file_id AS file_id
          FROM focowiki.knowledge_graph_edges
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_id = ${input.releaseId}
            AND quality_status = 'accepted'
          UNION ALL
          SELECT to_file_id AS file_id
          FROM focowiki.knowledge_graph_edges
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_id = ${input.releaseId}
            AND quality_status = 'accepted'
        ) edges
        GROUP BY file_id
      ),
      inserted AS (
        INSERT INTO focowiki.knowledge_graph_search_documents (
          id,
          knowledge_base_id,
          release_id,
          node_id,
          file_id,
          path,
          anchor_type,
          title,
          summary,
          search_text,
          matched_field_text,
          neighbor_text,
          relationship_count,
          top_neighbors_json
        )
        SELECT
          'knowledge-graph-search-node-' || md5(${input.releaseId} || ':' || node.id),
          node.knowledge_base_id,
          ${input.releaseId},
          node.id,
          node.file_id,
          node.path,
          'node',
          node.title,
          node.summary,
          left(lower(concat_ws(
            ' ',
            node.title,
            node.summary,
            node.subjects_json::text,
            node.entities_json::text,
            node.explicit_references_json::text,
            node.headings_json::text,
            node.keywords_json::text,
            node.path,
            node.metadata_json::text,
            node.profile_text
          )), 12000),
          left(lower(concat_ws(' ', node.title, node.summary, node.subjects_json::text)), 4000),
          ''::text,
          COALESCE(edge_counts.relationship_count, 0),
          '[]'::jsonb
        FROM focowiki.knowledge_graph_nodes node
        JOIN focowiki.bundle_files file
          ON file.id = node.file_id
         AND file.knowledge_base_id = node.knowledge_base_id
        LEFT JOIN edge_counts
          ON edge_counts.file_id = node.file_id
        WHERE node.knowledge_base_id = ${input.knowledgeBaseId}
          AND node.release_id = ${input.releaseId}
          AND file.release_id = ${input.releaseId}
        ON CONFLICT (id) DO UPDATE SET
          node_id = EXCLUDED.node_id,
          file_id = EXCLUDED.file_id,
          path = EXCLUDED.path,
          anchor_type = EXCLUDED.anchor_type,
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          search_text = EXCLUDED.search_text,
          matched_field_text = EXCLUDED.matched_field_text,
          neighbor_text = EXCLUDED.neighbor_text,
          relationship_count = EXCLUDED.relationship_count,
          top_neighbors_json = EXCLUDED.top_neighbors_json,
          updated_at = now()
        RETURNING id
      )
      SELECT count(*) AS count
      FROM inserted
    `;

    const relationshipRows = await transaction<Array<{ count: string | number }>>`
      WITH edge_endpoints AS MATERIALIZED (
        SELECT
          edge.id AS edge_id,
          edge.knowledge_base_id,
          edge.relation_type,
          edge.reason,
          edge.evidence_json,
          edge.signals_json,
          edge.created_by,
          edge.weight,
          from_file.id AS current_file_id,
          from_file.source_file_id AS current_source_file_id,
          from_file.logical_path AS current_path,
          COALESCE(from_file.title, from_node.title, from_file.logical_path) AS current_title,
          from_node.profile_text AS current_profile_text,
          to_file.id AS related_file_id,
          to_file.source_file_id AS related_source_file_id,
          to_file.logical_path AS related_path,
          COALESCE(to_file.title, to_node.title, to_file.logical_path) AS related_title,
          to_node.summary AS related_summary,
          to_node.profile_text AS related_profile_text,
          'outgoing'::text AS presentation_direction
        FROM focowiki.knowledge_graph_edges edge
        JOIN focowiki.bundle_files from_file
          ON from_file.id = edge.from_file_id
         AND from_file.knowledge_base_id = edge.knowledge_base_id
        JOIN focowiki.bundle_files to_file
          ON to_file.id = edge.to_file_id
         AND to_file.knowledge_base_id = edge.knowledge_base_id
        JOIN focowiki.knowledge_graph_nodes from_node
          ON from_node.id = edge.from_node_id
         AND from_node.knowledge_base_id = edge.knowledge_base_id
        JOIN focowiki.knowledge_graph_nodes to_node
          ON to_node.id = edge.to_node_id
         AND to_node.knowledge_base_id = edge.knowledge_base_id
        WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
          AND edge.release_id = ${input.releaseId}
          AND from_file.release_id = ${input.releaseId}
          AND to_file.release_id = ${input.releaseId}
          AND edge.quality_status = 'accepted'
        UNION ALL
        SELECT
          edge.id,
          edge.knowledge_base_id,
          edge.relation_type,
          edge.reason,
          edge.evidence_json,
          edge.signals_json,
          edge.created_by,
          edge.weight,
          to_file.id,
          to_file.source_file_id,
          to_file.logical_path,
          COALESCE(to_file.title, to_node.title, to_file.logical_path),
          to_node.profile_text,
          from_file.id,
          from_file.source_file_id,
          from_file.logical_path,
          COALESCE(from_file.title, from_node.title, from_file.logical_path),
          from_node.summary,
          from_node.profile_text,
          'incoming'::text
        FROM focowiki.knowledge_graph_edges edge
        JOIN focowiki.bundle_files from_file
          ON from_file.id = edge.from_file_id
         AND from_file.knowledge_base_id = edge.knowledge_base_id
        JOIN focowiki.bundle_files to_file
          ON to_file.id = edge.to_file_id
         AND to_file.knowledge_base_id = edge.knowledge_base_id
        JOIN focowiki.knowledge_graph_nodes from_node
          ON from_node.id = edge.from_node_id
         AND from_node.knowledge_base_id = edge.knowledge_base_id
        JOIN focowiki.knowledge_graph_nodes to_node
          ON to_node.id = edge.to_node_id
         AND to_node.knowledge_base_id = edge.knowledge_base_id
        WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
          AND edge.release_id = ${input.releaseId}
          AND from_file.release_id = ${input.releaseId}
          AND to_file.release_id = ${input.releaseId}
          AND edge.quality_status = 'accepted'
      ),
      inserted AS (
        INSERT INTO focowiki.knowledge_graph_search_documents (
          id,
          knowledge_base_id,
          release_id,
          edge_id,
          file_id,
          path,
          anchor_type,
          title,
          summary,
          search_text,
          matched_field_text,
          neighbor_text,
          relationship_count,
          top_neighbors_json
        )
        SELECT
          'knowledge-graph-search-edge-' || md5(${input.releaseId} || ':' || endpoint.edge_id || ':' || endpoint.presentation_direction),
          endpoint.knowledge_base_id,
          ${input.releaseId},
          endpoint.edge_id,
          endpoint.current_file_id,
          endpoint.current_path,
          'edge',
          endpoint.current_title || CASE WHEN endpoint.presentation_direction = 'outgoing' THEN ' -> ' ELSE ' <- ' END || endpoint.related_title,
          endpoint.reason,
          left(lower(concat_ws(
            ' ',
            endpoint.relation_type,
            endpoint.reason,
            endpoint.evidence_json::text,
            endpoint.signals_json::text,
            endpoint.current_path,
            endpoint.current_title,
            endpoint.current_profile_text,
            endpoint.related_path,
            endpoint.related_title,
            endpoint.related_profile_text
          )), 12000),
          left(lower(concat_ws(' ', endpoint.relation_type, endpoint.reason)), 4000),
          left(lower(concat_ws(' ', endpoint.related_path, endpoint.related_title, endpoint.related_summary, endpoint.relation_type, endpoint.reason)), 4000),
          1,
          jsonb_build_array(
            jsonb_build_object(
              'fileId', COALESCE(endpoint.related_source_file_id, endpoint.related_file_id),
              'sourceFileId', COALESCE(endpoint.related_source_file_id, endpoint.related_file_id),
              'bundleFileId', endpoint.related_file_id,
              'path', endpoint.related_path,
              'title', endpoint.related_title,
              'relationType', endpoint.relation_type,
              'direction', endpoint.presentation_direction,
              'weight', endpoint.weight,
              'reason', endpoint.reason,
              'source', endpoint.created_by,
              'evidence', endpoint.evidence_json,
              'contentAvailable', true
            )
          )
        FROM edge_endpoints endpoint
        ON CONFLICT (id) DO UPDATE SET
          edge_id = EXCLUDED.edge_id,
          file_id = EXCLUDED.file_id,
          path = EXCLUDED.path,
          anchor_type = EXCLUDED.anchor_type,
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          search_text = EXCLUDED.search_text,
          matched_field_text = EXCLUDED.matched_field_text,
          neighbor_text = EXCLUDED.neighbor_text,
          relationship_count = EXCLUDED.relationship_count,
          top_neighbors_json = EXCLUDED.top_neighbors_json,
          updated_at = now()
        RETURNING edge_id
      )
      SELECT count(DISTINCT edge_id) AS count
      FROM inserted
    `;

    return {
      documentCount: Number(fileRows[0]?.count ?? 0) + Number(nodeRows[0]?.count ?? 0),
      relationshipCount: Number(relationshipRows[0]?.count ?? 0)
    };
  });
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

function serializeBundleFileSearchCursor(cursor: {
  score: number;
  logicalPath: string;
  fileId: string;
}): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseBundleFileSearchCursor(cursor: string): {
  score: number;
  logicalPath: string;
  fileId: string;
} {
  const candidate = parseCursorRecord(cursor);

  if (
    typeof candidate.score !== "number" ||
    typeof candidate.logicalPath !== "string" ||
    typeof candidate.fileId !== "string"
  ) {
    throw new Error("Invalid bundle file search cursor");
  }

  return {
    score: candidate.score,
    logicalPath: candidate.logicalPath,
    fileId: candidate.fileId
  };
}

function conjunctivePredicate(
  sql: DatabaseClient,
  patterns: string[],
  createPredicate: (pattern: string) => ReturnType<DatabaseClient>
): ReturnType<DatabaseClient> {
  const [first, ...rest] = patterns.map(createPredicate);

  if (!first) {
    throw new Error("Search query must contain at least one term");
  }

  return rest.reduce(
    (combined, predicate) => sql`${combined} AND ${predicate}`,
    first
  );
}

function containsPattern(value: string): string {
  return `%${escapeLikePattern(value)}%`;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function collectAncestorPaths(logicalPaths: string[]): string[] {
  return [...new Set(logicalPaths.flatMap(createAncestorPaths))];
}

function createAncestorPaths(logicalPath: string): string[] {
  const segments = logicalPath.split("/").filter(Boolean);
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
}

function serializeTreeCursor(cursor: { sortKey: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseTreeCursor(cursor: string): { sortKey: string; id: string } {
  const candidate = parseCursorRecord(cursor);

  if (typeof candidate.sortKey !== "string" || typeof candidate.id !== "string") {
    throw new Error("Invalid tree cursor");
  }

  return {
    sortKey: candidate.sortKey,
    id: candidate.id
  };
}

function createTreeSortKey(
  entryType: BundleTreeEntryRecord["entryType"],
  name: string
): string {
  return `${entryType === "directory" ? "0" : "1"}:${name.toLocaleLowerCase("en-US")}`;
}

function treePathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

function isNavigationOnlyFileKind(fileKind: BundleFileKind): boolean {
  return fileKind !== "page";
}

function sourceDirectoryPathForGeneratedFile(logicalPath: string): string | null {
  if (!logicalPath.startsWith("pages/")) {
    return null;
  }

  const segments = logicalPath.slice("pages/".length).split("/");
  if (segments.length < 2) {
    return null;
  }

  return segments.slice(0, -1).join("/");
}

function parseCursorRecord(cursor: string): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid cursor");
  }

  return parsed as Record<string, unknown>;
}
