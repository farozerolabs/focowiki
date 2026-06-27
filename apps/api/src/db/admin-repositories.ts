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
import { createSourceFileListFilterPredicate } from "./source-file-list-predicates.js";
import {
  createPostgresWorkerJobRepository,
  type WorkerJobRepository
} from "./worker-job-repository.js";
import {
  createGeneratedFileSearchDocument,
  type GeneratedFileSearchDocumentDraft,
  type GeneratedFileSearchScope
} from "../search/generated-file-search-documents.js";

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
    query?: string | null;
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
  sortKey: string;
  entryType: "directory" | "file";
  bundleFileId: string | null;
  sourceFileId: string | null;
  fileKind: BundleFileKind | null;
  childCount: number;
};

export type BundleTreeEntryDraft = Omit<
  BundleTreeEntryRecord,
  "sourceFileId" | "fileKind" | "sortKey" | "childCount"
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
  | "schema"
  | "manifest_index"
  | "manifest_index_shard"
  | "search_index"
  | "search_index_shard"
  | "link_index"
  | "link_index_shard"
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
export type PublicationJobMode = "batch" | "manual" | "per_file";
export type PublicationJobReason =
  | "bootstrap"
  | "batch_threshold"
  | "batch_interval"
  | "manual"
  | "per_file"
  | "deletion";

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
    entryType?: BundleTreeEntryRecord["entryType"] | null;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<BundleTreeEntryRecord>>;
  searchBundleTreeEntries?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    query: string;
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
  getSourceFile?: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<SourceFileRecord | null>;
  listSourceFiles: (request: {
    knowledgeBaseId: string;
    limit: number;
    cursor: string | null;
  } & SourceFileListFilters) => Promise<CursorPage<SourceFileRecord>>;
  hasActiveSourceFileNames?: (request: {
    knowledgeBaseId: string;
    normalizedFileNames: string[];
  }) => Promise<boolean>;
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
  upsertBundleFileSearchDocuments?: (
    documents: GeneratedFileSearchDocumentDraft[]
  ) => Promise<void>;
  countBundleFileSearchDocuments?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
  }) => Promise<number>;
  searchBundleFiles?: (request: {
    knowledgeBaseId: string;
    releaseId: string;
    query: string;
    scope: GeneratedFileSearchScope;
    fileKind: BundleFileKind | null;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<BundleFileSearchResultRecord>>;
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
  softDeleteSourceFile?: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    deletedAt: string;
  }) => Promise<boolean>;
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
  files?: BundleFileRepository;
  graph?: FileGraphRepository;
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
  sort_key: string;
  entry_type: "directory" | "file";
  bundle_file_id: string | null;
  source_file_id: string | null;
  file_kind: BundleFileKind | null;
  child_count: number;
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
      async listKnowledgeBases({ limit, cursor, query }) {
        const cursorValue = cursor ? parseKnowledgeBaseCursor(cursor) : null;
        const searchPredicate = query
          ? sql`AND lower(knowledge_base.id || ' ' || knowledge_base.name || ' ' || coalesce(knowledge_base.description, '')) LIKE ${containsKnowledgeBaseLikePattern(query.toLocaleLowerCase("en-US"))} ESCAPE ${"\\"}`
          : sql``;
        const rows = cursorValue
          ? await sql<KnowledgeBaseRow[]>`
              SELECT knowledge_base.id, knowledge_base.name, knowledge_base.description, knowledge_base.active_release_id, knowledge_base.created_at, knowledge_base.updated_at
              FROM focowiki.knowledge_bases knowledge_base
              WHERE knowledge_base.deleted_at IS NULL
                ${searchPredicate}
                AND (
                  knowledge_base.created_at < ${cursorValue.createdAt}
                  OR (knowledge_base.created_at = ${cursorValue.createdAt} AND knowledge_base.id > ${cursorValue.id})
                )
              ORDER BY knowledge_base.created_at DESC, knowledge_base.id ASC
              LIMIT ${limit + 1}
            `
          : await sql<KnowledgeBaseRow[]>`
              SELECT knowledge_base.id, knowledge_base.name, knowledge_base.description, knowledge_base.active_release_id, knowledge_base.created_at, knowledge_base.updated_at
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

        await upsertGeneratedFileSearchDocuments(
          sql,
          files.map(createGeneratedFileSearchDocument)
        );
      },
      async upsertBundleFileSearchDocuments(documents) {
        await upsertGeneratedFileSearchDocuments(sql, documents);
      },
      async countBundleFileSearchDocuments({ knowledgeBaseId, releaseId }) {
        const rows = await sql<Array<{ count: string }>>`
          SELECT count(*)::text AS count
          FROM focowiki.bundle_file_search_documents
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND release_id = ${releaseId}
        `;
        return Number(rows[0]?.count ?? 0);
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
              sort_key,
              entry_type,
              bundle_file_id,
              child_count
            )
            VALUES (
              ${entry.id},
              ${entry.knowledgeBaseId},
              ${entry.releaseId},
              ${entry.parentPath},
              ${entry.name},
              ${entry.logicalPath},
              ${entry.sortKey ?? createTreeSortKey(entry.entryType, entry.name)},
              ${entry.entryType},
              ${entry.bundleFileId},
              ${entry.childCount ?? 0}
            )
          `;
        }

        const releaseIds = [...new Set(entries.map((entry) => entry.releaseId))];
        for (const releaseId of releaseIds) {
          await sql`
            UPDATE focowiki.bundle_tree_entries parent
            SET child_count = COALESCE(child_counts.child_count, 0)
            FROM (
              SELECT parent_path, count(*)::integer AS child_count
              FROM focowiki.bundle_tree_entries
              WHERE release_id = ${releaseId}
              GROUP BY parent_path
            ) child_counts
            WHERE parent.release_id = ${releaseId}
              AND parent.logical_path = child_counts.parent_path
              AND parent.entry_type = 'directory'
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
            AND deleted_at IS NULL
            AND task_deleted_at IS NULL
        `;
      },
      async updateSourceFileMetadata({ knowledgeBaseId, sourceFileId, metadata }) {
        await sql`
          UPDATE focowiki.source_files
          SET metadata_json = ${sql.json(metadata as never)}
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND id = ${sourceFileId}
            AND deleted_at IS NULL
            AND task_deleted_at IS NULL
        `;
      },
      async updateSourceFileModelSuggestions({ knowledgeBaseId, sourceFileId, suggestions }) {
        await sql`
          UPDATE focowiki.source_files
          SET model_suggestions_json = ${suggestions ? sql.json(suggestions as never) : null}
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
        const entryTypeFilter = entryType ? sql`AND entry.entry_type = ${entryType}` : sql``;
        const rows = cursorValue
          ? await sql<BundleTreeEntryRow[]>`
              SELECT entry.id, entry.knowledge_base_id, entry.release_id, entry.parent_path, entry.name, entry.logical_path, entry.sort_key, entry.entry_type, entry.bundle_file_id, entry.child_count, file.source_file_id, file.file_kind
              FROM focowiki.bundle_tree_entries entry
              LEFT JOIN focowiki.bundle_files file ON file.id = entry.bundle_file_id
              WHERE entry.knowledge_base_id = ${knowledgeBaseId}
                AND entry.release_id = ${releaseId}
                AND entry.parent_path = ${parentPath}
                ${entryTypeFilter}
                AND (entry.sort_key > ${cursorValue.sortKey} OR (entry.sort_key = ${cursorValue.sortKey} AND entry.id > ${cursorValue.id}))
              ORDER BY entry.sort_key ASC, entry.id ASC
              LIMIT ${limit + 1}
            `
          : await sql<BundleTreeEntryRow[]>`
              SELECT entry.id, entry.knowledge_base_id, entry.release_id, entry.parent_path, entry.name, entry.logical_path, entry.sort_key, entry.entry_type, entry.bundle_file_id, entry.child_count, file.source_file_id, file.file_kind
              FROM focowiki.bundle_tree_entries entry
              LEFT JOIN focowiki.bundle_files file ON file.id = entry.bundle_file_id
              WHERE entry.knowledge_base_id = ${knowledgeBaseId}
                AND entry.release_id = ${releaseId}
                AND entry.parent_path = ${parentPath}
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
      async searchBundleTreeEntries({ knowledgeBaseId, releaseId, query, limit, cursor }) {
        const cursorValue = cursor ? parseTreeCursor(cursor) : null;
        const searchPattern = containsPattern(query);
        const cursorFilter = cursorValue
          ? sql`AND (entry.sort_key > ${cursorValue.sortKey} OR (entry.sort_key = ${cursorValue.sortKey} AND entry.id > ${cursorValue.id}))`
          : sql``;
        const rows = await sql<BundleTreeEntryRow[]>`
          SELECT entry.id, entry.knowledge_base_id, entry.release_id, entry.parent_path, entry.name, entry.logical_path, entry.sort_key, entry.entry_type, entry.bundle_file_id, entry.child_count, file.source_file_id, file.file_kind
          FROM focowiki.bundle_tree_entries entry
          LEFT JOIN focowiki.bundle_files file ON file.id = entry.bundle_file_id
          WHERE entry.knowledge_base_id = ${knowledgeBaseId}
            AND entry.release_id = ${releaseId}
            AND (entry.name || ' ' || entry.logical_path) ILIKE ${searchPattern} ESCAPE ${"\\"}
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
                SELECT entry.id, entry.knowledge_base_id, entry.release_id, entry.parent_path, entry.name, entry.logical_path, entry.sort_key, entry.entry_type, entry.bundle_file_id, entry.child_count, file.source_file_id, file.file_kind
                FROM focowiki.bundle_tree_entries entry
                LEFT JOIN focowiki.bundle_files file ON file.id = entry.bundle_file_id
                WHERE entry.knowledge_base_id = ${knowledgeBaseId}
                  AND entry.release_id = ${releaseId}
                  AND entry.logical_path = ANY(${ancestorPaths})
                ORDER BY entry.logical_path ASC
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
          SELECT source.id, source.knowledge_base_id, source.original_name, source.object_key, source.content_type, source.size_bytes, source.checksum_sha256, source.metadata_json, source.model_suggestions_json, source.processing_status, source.processing_stage, source.processing_started_at, source.processing_ended_at, source.processing_error_code, source.processing_error_message, source.generated_output_status, source.generated_bundle_file_id, source.generated_bundle_file_path, source.model_invocation_status, source.model_invocation_model_name, source.model_invocation_started_at, source.model_invocation_ended_at, source.model_invocation_warning_count, source.model_invocation_error_code, source.publication_dirty_at, source.publication_visible_at, source.publication_error_code, source.publication_error_message, source.retry_count, source.created_at, source.task_deleted_at, source.deleted_at
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
          ? await sql<SourceFileRow[]>`
              SELECT source.id, source.knowledge_base_id, source.original_name, source.object_key, source.content_type, source.size_bytes, source.checksum_sha256, source.metadata_json, source.model_suggestions_json, source.processing_status, source.processing_stage, source.processing_started_at, source.processing_ended_at, source.processing_error_code, source.processing_error_message, source.generated_output_status, source.generated_bundle_file_id, source.generated_bundle_file_path, source.model_invocation_status, source.model_invocation_model_name, source.model_invocation_started_at, source.model_invocation_ended_at, source.model_invocation_warning_count, source.model_invocation_error_code, source.publication_dirty_at, source.publication_visible_at, source.publication_error_code, source.publication_error_message, source.retry_count, source.created_at, source.task_deleted_at, source.deleted_at
              FROM focowiki.source_files source
              WHERE source.knowledge_base_id = ${knowledgeBaseId}
                AND source.deleted_at IS NULL
                AND source.task_deleted_at IS NULL
                ${filterPredicate}
                AND (
                  source.created_at < ${cursorValue.createdAt}
                  OR (source.created_at = ${cursorValue.createdAt} AND source.id > ${cursorValue.id})
                )
              ORDER BY source.created_at DESC, source.id ASC
              LIMIT ${limit + 1}
            `
          : await sql<SourceFileRow[]>`
              SELECT source.id, source.knowledge_base_id, source.original_name, source.object_key, source.content_type, source.size_bytes, source.checksum_sha256, source.metadata_json, source.model_suggestions_json, source.processing_status, source.processing_stage, source.processing_started_at, source.processing_ended_at, source.processing_error_code, source.processing_error_message, source.generated_output_status, source.generated_bundle_file_id, source.generated_bundle_file_path, source.model_invocation_status, source.model_invocation_model_name, source.model_invocation_started_at, source.model_invocation_ended_at, source.model_invocation_warning_count, source.model_invocation_error_code, source.publication_dirty_at, source.publication_visible_at, source.publication_error_code, source.publication_error_message, source.retry_count, source.created_at, source.task_deleted_at, source.deleted_at
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
              ? serializeTimedCursor({ createdAt: lastRow.created_at.toISOString(), id: lastRow.id })
              : null
        };
      },
      async hasActiveSourceFileNames({ knowledgeBaseId, normalizedFileNames }) {
        if (normalizedFileNames.length === 0) {
          return false;
        }

        const rows = await sql<Array<{ id: string }>>`
          SELECT id
          FROM focowiki.source_files
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND deleted_at IS NULL
            AND lower(original_name) = ANY(${normalizedFileNames})
          LIMIT 1
        `;
        return rows.length > 0;
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
        const searchPattern = containsPattern(query.toLocaleLowerCase("en-US"));
        const fileKindFilter = fileKind ? sql`AND doc.file_kind = ${fileKind}` : sql``;
        const searchPredicate =
          scope === "path"
            ? sql`AND doc.logical_path ILIKE ${searchPattern} ESCAPE ${"\\"}`
            : scope === "metadata"
              ? sql`AND (
                  coalesce(doc.title, '') ILIKE ${searchPattern} ESCAPE ${"\\"}
                  OR coalesce(doc.description, '') ILIKE ${searchPattern} ESCAPE ${"\\"}
                  OR doc.metadata_text ILIKE ${searchPattern} ESCAPE ${"\\"}
                  OR doc.tags_json::text ILIKE ${searchPattern} ESCAPE ${"\\"}
                )`
              : sql`AND doc.search_text ILIKE ${searchPattern} ESCAPE ${"\\"}`;
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
          WITH field_matches AS MATERIALIZED (
            SELECT
              doc.bundle_file_id,
              doc.logical_path,
              doc.logical_path ILIKE ${searchPattern} ESCAPE ${"\\"} AS path_match,
              coalesce(doc.title, '') ILIKE ${searchPattern} ESCAPE ${"\\"} AS title_match,
              coalesce(doc.description, '') ILIKE ${searchPattern} ESCAPE ${"\\"} AS description_match,
              doc.metadata_text ILIKE ${searchPattern} ESCAPE ${"\\"} AS metadata_text_match,
              doc.tags_json::text ILIKE ${searchPattern} ESCAPE ${"\\"} AS tags_match
            FROM focowiki.bundle_file_search_documents doc
            WHERE doc.knowledge_base_id = ${knowledgeBaseId}
              AND doc.release_id = ${releaseId}
              AND doc.removed_at IS NULL
              ${fileKindFilter}
              ${searchPredicate}
          ),
          ranked AS (
            SELECT
              bundle_file_id,
              logical_path,
              path_match,
              title_match,
              description_match,
              (metadata_text_match OR tags_match) AS metadata_match,
              (
                CASE WHEN path_match THEN 5 ELSE 0 END
                + CASE WHEN title_match THEN 4 ELSE 0 END
                + CASE WHEN description_match THEN 2 ELSE 0 END
                + CASE WHEN metadata_text_match THEN 1 ELSE 0 END
                + CASE WHEN tags_match THEN 1 ELSE 0 END
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
            doc.bundle_file_id,
            doc.knowledge_base_id,
            doc.release_id,
            doc.source_file_id,
            doc.file_kind,
            doc.logical_path,
            doc.title,
            doc.description,
            doc.tags_json,
            doc.frontmatter_json,
            limited.path_match,
            limited.title_match,
            limited.description_match,
            limited.metadata_match,
            limited.score
          FROM limited
          JOIN focowiki.bundle_file_search_documents doc
            ON doc.release_id = ${releaseId}
           AND doc.bundle_file_id = limited.bundle_file_id
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
            generated_output_status = 'pending',
            generated_bundle_file_id = NULL,
            generated_bundle_file_path = NULL,
            publication_dirty_at = ${dirtyAt},
            publication_error_code = NULL,
            publication_error_message = NULL
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND id = ANY(${sourceFileIds})
            AND deleted_at IS NULL
            AND task_deleted_at IS NULL
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
            AND processing_status = 'completed'
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
          ? await sql<SourceFileRow[]>`
              SELECT source.id, source.knowledge_base_id, source.original_name, source.object_key, source.content_type, source.size_bytes, source.checksum_sha256, source.metadata_json, source.model_suggestions_json, source.processing_status, source.processing_stage, source.processing_started_at, source.processing_ended_at, source.processing_error_code, source.processing_error_message, source.generated_output_status, source.generated_bundle_file_id, source.generated_bundle_file_path, source.model_invocation_status, source.model_invocation_model_name, source.model_invocation_started_at, source.model_invocation_ended_at, source.model_invocation_warning_count, source.model_invocation_error_code, source.publication_dirty_at, source.publication_visible_at, source.publication_error_code, source.publication_error_message, source.retry_count, source.created_at, source.task_deleted_at, source.deleted_at
              FROM focowiki.source_files source
              WHERE source.knowledge_base_id = ${knowledgeBaseId}
                AND source.deleted_at IS NULL
                AND source.task_deleted_at IS NULL
                AND source.processing_status = 'completed'
                AND source.publication_dirty_at IS NOT NULL
                AND (
                  source.publication_dirty_at > ${cursorValue.createdAt}
                  OR (source.publication_dirty_at = ${cursorValue.createdAt} AND source.id > ${cursorValue.id})
                )
              ORDER BY source.publication_dirty_at ASC, source.id ASC
              LIMIT ${limit + 1}
            `
          : await sql<SourceFileRow[]>`
              SELECT source.id, source.knowledge_base_id, source.original_name, source.object_key, source.content_type, source.size_bytes, source.checksum_sha256, source.metadata_json, source.model_suggestions_json, source.processing_status, source.processing_stage, source.processing_started_at, source.processing_ended_at, source.processing_error_code, source.processing_error_message, source.generated_output_status, source.generated_bundle_file_id, source.generated_bundle_file_path, source.model_invocation_status, source.model_invocation_model_name, source.model_invocation_started_at, source.model_invocation_ended_at, source.model_invocation_warning_count, source.model_invocation_error_code, source.publication_dirty_at, source.publication_visible_at, source.publication_error_code, source.publication_error_message, source.retry_count, source.created_at, source.task_deleted_at, source.deleted_at
              FROM focowiki.source_files source
              WHERE source.knowledge_base_id = ${knowledgeBaseId}
                AND source.deleted_at IS NULL
                AND source.task_deleted_at IS NULL
                AND source.processing_status = 'completed'
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
                  createdAt: lastRow.publication_dirty_at.toISOString(),
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
      async softDeleteSourceFile({ knowledgeBaseId, sourceFileId, deletedAt }) {
        const rows = await sql.begin(async (transaction) => {
          const updatedRows = await transaction<Array<{ id: string }>>`
            UPDATE focowiki.source_files
            SET
              deleted_at = ${deletedAt},
              generated_bundle_file_id = NULL,
              generated_bundle_file_path = NULL
            WHERE knowledge_base_id = ${knowledgeBaseId}
              AND id = ${sourceFileId}
              AND deleted_at IS NULL
            RETURNING id
          `;

          if (updatedRows.length > 0) {
            await transaction`
              UPDATE focowiki.bundle_file_search_documents
              SET
                removed_at = ${deletedAt},
                updated_at = now()
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND source_file_id = ${sourceFileId}
                AND removed_at IS NULL
            `;
          }

          return updatedRows;
        });
        return rows.length > 0;
      },
      async deleteSourceFileTasks({ knowledgeBaseId, sourceFileIds, deletedAt }) {
        const requestedIds = uniqueStrings(sourceFileIds);

        if (requestedIds.length === 0) {
          return [];
        }

        return await sql.begin(async (transaction) => {
          const sourceRows = await transaction<SourceFileRow[]>`
            SELECT source.id, source.knowledge_base_id, source.original_name, source.object_key, source.content_type, source.size_bytes, source.checksum_sha256, source.metadata_json, source.model_suggestions_json, source.processing_status, source.processing_stage, source.processing_started_at, source.processing_ended_at, source.processing_error_code, source.processing_error_message, source.generated_output_status, source.generated_bundle_file_id, source.generated_bundle_file_path, source.model_invocation_status, source.model_invocation_model_name, source.model_invocation_started_at, source.model_invocation_ended_at, source.model_invocation_warning_count, source.model_invocation_error_code, source.publication_dirty_at, source.publication_visible_at, source.publication_error_code, source.publication_error_message, source.retry_count, source.created_at, source.task_deleted_at, source.deleted_at
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
            await transaction`
              UPDATE focowiki.bundle_file_search_documents
              SET
                removed_at = ${deletedAt},
                updated_at = now()
              WHERE knowledge_base_id = ${knowledgeBaseId}
                AND source_file_id = ANY(${deletedIds})
                AND removed_at IS NULL
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
    workerJobs: createPostgresWorkerJobRepository(sql),
    modelInvocations: {
      async createModelInvocation(input) {
        const rows = await sql.begin(async (transaction) => {
          const inserted = await transaction<ModelInvocationRow[]>`
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
    fileKind: row.file_kind,
    childCount: Number(row.child_count)
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

async function upsertGeneratedFileSearchDocuments(
  sql: DatabaseClient,
  documents: GeneratedFileSearchDocumentDraft[]
): Promise<void> {
  for (const document of documents) {
    await sql`
      INSERT INTO focowiki.bundle_file_search_documents (
        knowledge_base_id,
        release_id,
        bundle_file_id,
        source_file_id,
        file_kind,
        logical_path,
        title,
        description,
        tags_json,
        frontmatter_json,
        metadata_text,
        search_text,
        removed_at,
        updated_at
      )
      VALUES (
        ${document.knowledgeBaseId},
        ${document.releaseId},
        ${document.bundleFileId},
        ${document.sourceFileId},
        ${document.fileKind},
        ${document.logicalPath},
        ${document.title},
        ${document.description},
        ${sql.json(document.tags as never)},
        ${sql.json(document.frontmatter as never)},
        ${document.metadataText},
        ${document.searchText},
        (
          SELECT source.deleted_at
          FROM focowiki.source_files source
          WHERE source.id = ${document.sourceFileId}
            AND source.knowledge_base_id = ${document.knowledgeBaseId}
        ),
        now()
      )
      ON CONFLICT (release_id, bundle_file_id) DO UPDATE SET
        source_file_id = EXCLUDED.source_file_id,
        file_kind = EXCLUDED.file_kind,
        logical_path = EXCLUDED.logical_path,
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        tags_json = EXCLUDED.tags_json,
        frontmatter_json = EXCLUDED.frontmatter_json,
        metadata_text = EXCLUDED.metadata_text,
        search_text = EXCLUDED.search_text,
        removed_at = EXCLUDED.removed_at,
        updated_at = now()
    `;
  }
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

function parseCursorRecord(cursor: string): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid cursor");
  }

  return parsed as Record<string, unknown>;
}
