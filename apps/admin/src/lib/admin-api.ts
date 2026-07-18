import {
  appendSourceFileFilterParams,
  type SourceFileListFilters
} from "@/lib/source-file-list-filters";

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string | null;
  activeGenerationId: string | null;
  resourceRevision?: number;
  catalogGeneration?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type KnowledgeBasePage = {
  items: KnowledgeBase[];
  nextCursor: string | null;
};

export type PublicOpenApiKey = {
  id: string;
  name: string;
  fingerprint: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
};

export type OneTimePublicOpenApiKey = {
  id: string;
  rawKey: string;
};

export type PublicOpenApiKeyPage = {
  items: PublicOpenApiKey[];
  nextCursor: string | null;
  oneTimeKey: OneTimePublicOpenApiKey | null;
};

export type GeneratedTreeEntry = {
  id: string;
  parentPath?: string;
  name: string;
  logicalPath: string;
  sortKey?: string;
  entryType: "directory" | "file";
  generatedFileId: string | null;
  directEntryCount?: number;
  directDirectoryCount?: number;
  sourceFileId?: string | null;
  sourceDirectoryId?: string | null;
  directFileCount?: number;
  descendantFileCount?: number;
  resourceRevision?: number | null;
  fileKind?:
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
    | "graph_node_index"
    | "graph_edge_shard"
    | "graph_file"
    | null;
  deletable?: boolean;
};

export type GeneratedTreePage = {
  items: GeneratedTreeEntry[];
  nextCursor: string | null;
};

export type GeneratedTreeSearchResult = {
  entry: GeneratedTreeEntry;
  ancestors: GeneratedTreeEntry[];
};

export type GeneratedTreeSearchPage = {
  items: GeneratedTreeSearchResult[];
  nextCursor: string | null;
};

export type GeneratedFileDetail = {
  file: {
    id: string;
    sourceFileId: string | null;
    fileKind:
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
      | "graph_node_index"
      | "graph_edge_shard"
      | "graph_file";
    logicalPath: string;
    contentType: string;
    title: string | null;
    deletable: boolean;
  };
  relationships: Array<{
    fileId: string;
    sourceFileId: string;
    generatedFileId: string | null;
    path: string;
    title: string;
    relationType: string;
    direction: "outgoing" | "incoming";
    weight: number;
    reason: string;
    source: string;
    contentAvailable: boolean;
  }>;
  content: string;
  readOnly: true;
};

export type SourceFileRecord = {
  id: string;
  name: string;
  relativePath: string;
  resourceRevision?: number;
  state: "queued" | "running" | "pending_publication" | "visible" | "failed";
  currentStage:
    | "upload_storage"
    | "metadata_resolution"
    | "llm_suggestion"
    | "graph_generation"
    | "projection_generation"
    | "generation_validation"
    | "generation_activation";
  failure: {
    stage: SourceFileRecord["currentStage"];
    code: string;
    message: string;
    occurredAt: string;
    retryKind: "source_processing" | "publication" | "none";
    correlationId: string;
  } | null;
  actions: Array<{
    kind:
      | "open_generated_file"
      | "view_failure_details"
      | "retry_source_processing"
      | "retry_publication";
    method: "GET" | "POST" | null;
    href: string | null;
    scope: "source_file" | "knowledge_base_publication";
  }>;
  processingStartedAt?: string | null;
  processingEndedAt?: string | null;
  retryCount?: number;
  modelInvocationStatus?: "running" | "completed" | "failed" | "skipped" | null;
  modelInvocationModelName?: string | null;
  modelInvocationStartedAt?: string | null;
  modelInvocationEndedAt?: string | null;
  modelInvocationWarningCount?: number | null;
  modelInvocationErrorCode?: string | null;
  generatedOutputStatus?: "pending" | "visible" | "unavailable";
  generatedFileAvailable?: boolean;
  generatedFilePath?: string | null;
  generatedFileId?: string | null;
  graphSummary?: {
    sourceFileId: string;
    relationshipCount: number;
    relationships: Array<{
      fileId: string;
      sourceFileId: string;
      generatedFileId: string | null;
      path: string;
      title: string;
      relationType: string;
      direction: "outgoing" | "incoming";
      weight: number;
      reason: string;
      source: string;
      contentAvailable: boolean;
    }>;
  } | null;
  createdAt: string;
};

export type SourceFileDetail = {
  file: SourceFileRecord;
  events: unknown[];
  nextCursor: string | null;
};

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};

export type SourceFilePage = {
  items: SourceFileRecord[];
  nextCursor: string | null;
  refreshAfterMs?: number;
};

export type SourceFileTaskDeletionSkippedReason =
  | "missing"
  | "wrong_knowledge_base"
  | "already_removed"
  | "running"
  | "job_already_claimed"
  | "completed_pending"
  | "publication_owned";

export type SourceFileTaskDeletionResult = {
  sourceFileId: string;
  status: "deleted" | "hidden" | "skipped";
  reason?: SourceFileTaskDeletionSkippedReason;
};

export type SourceFileTaskDeletionResponse = {
  results: SourceFileTaskDeletionResult[];
  summary: {
    deleted: number;
    hidden: number;
    skipped: number;
  };
};

export type WorkerQueueSummary = {
  queuedCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  deadLetterCount: number;
  oldestQueuedAt: string | null;
  oldestQueuedAgeSeconds: number | null;
};

export type ProcessingSummary = {
  activeGenerationId: string | null;
  pendingDispatch: {
    pendingCount: number;
    oldestPendingAt: string | null;
    paused: boolean;
    pausedReason: string | null;
  };
  sourceFileJobs: WorkerQueueSummary;
  publicationJobs: WorkerQueueSummary;
  publicationProgress: {
    generationId: string | null;
    stage: string | null;
    processedImpactCount: number;
    totalImpactCount: number;
    touchedShardCount: number;
    oldestDirtyAt: string | null;
    queuedAt: string | null;
    startedAt: string | null;
    heartbeatAt: string | null;
    completedAt: string | null;
    lastSuccessAt: string | null;
    safeErrorCode: string | null;
    safeErrorMessage: string | null;
  };
  dirtySourceFiles: {
    count: number;
    oldestDirtyAt: string | null;
  };
};

export type KnowledgeBasePublicUrls = {
  index: string;
  search: string;
  links: string;
};

export type ApiFailure = {
  messageKey: string;
};

export type RateLimitSettings = {
  adminLogin: { max: number; windowSeconds: number };
  adminApi: { max: number; windowSeconds: number };
  publicOpenApi: { max: number; windowSeconds: number };
};

export type WorkerSettings = {
  sourceFileConcurrency: number;
  claimBatchSize: number;
  generationBatchSize: number;
  pollIntervalMs: number;
  lockTtlSeconds: number;
  heartbeatIntervalMs: number;
  jobMaxAttempts: number;
  jobRetryDelayMs: number;
  sourceQueueHardDepth: number;
  sourceQueueResumeDepth: number;
  sourceQueueHardAgeSeconds: number;
  sourceQueueResumeAgeSeconds: number;
  shutdownGraceMs: number;
  completedJobRetentionDays: number;
  failedJobRetentionDays: number;
  deadLetterJobRetentionDays: number;
  retentionCleanupBatchSize: number;
  hardDeleteConcurrency: number;
  hardDeleteDatabaseBatchSize: number;
  hardDeleteObjectBatchSize: number;
  hardDeleteMaxAttempts: number;
  hardDeleteRetryDelayMs: number;
  hardDeleteFailedRetentionDays: number;
  hardDeleteVersionPurgeEnabled: boolean;
};

export type PublicationSettings = {
  mode: "batch" | "manual" | "per_file";
  batchSize: number;
  intervalSeconds: number;
  roleConcurrency: number;
  claimBatchSize: number;
  impactBatchSize: number;
  impactConcurrency: number;
  dirtyFileHardCount: number;
  dirtyFileResumeCount: number;
  dirtyAgeHardSeconds: number;
  dirtyAgeResumeSeconds: number;
  pendingImpactHardCount: number;
  pendingImpactResumeCount: number;
  generationRetentionDays: number;
  indexShardSize: number;
  linkIndexShardSize: number;
  manifestShardSize: number;
  graphEdgeShardSize: number;
  graphCandidateLimit: number;
  graphMaintenanceBatchSize: number;
  rootSummaryLimit: number;
  directoryIndexMaxEntries: number;
  directoryIndexMaxBytes: number;
  okfLogMaxEntries: number;
  okfLogMaxBytes: number;
};

export type GraphSettings = {
  candidateLimit: number;
  acceptedEdgeLimit: number;
  searchDefaultDepth: 0 | 1 | 2;
  searchMaxDepth: 0 | 1 | 2;
  searchDefaultFanout: number;
  searchMaxFanout: number;
  modelReviewEnabled: boolean;
  publicationShardSize: number;
  cacheTtlSeconds: number;
  genericPhraseThreshold: number;
};

export type MaintenanceSettings = {
  reconciliationEnabled: boolean;
  scanIntervalSeconds: number;
  scanBatchSize: number;
  deletionBatchSize: number;
  quarantineGracePeriodSeconds: number;
  confirmationPasses: number;
  maxAttempts: number;
  retryDelayMs: number;
};

export type RuntimeModelConfig = {
  id: string;
  displayName: string;
  apiMode: "responses" | "chat_completions";
  baseUrl: string;
  apiKeyFingerprint: string;
  modelName: string;
  contextWindowTokens: number;
  requestMaxTimeoutMs: number;
  requestIdleTimeoutMs: number;
  suggestionConcurrency: number;
  transientRetryDelayMs: number;
  requestMinIntervalMs: number;
  status: "active" | "paused" | "deleted";
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type RuntimeSettingsResponse = {
  settings: {
    rateLimits: RateLimitSettings;
    worker: WorkerSettings;
    publication: PublicationSettings;
    graph: GraphSettings;
    maintenance: MaintenanceSettings;
    activeModel: RuntimeModelConfig | null;
  };
  models: RuntimeModelConfig[];
  maintenanceStatus: {
    state: "idle" | "scanning" | "verifying" | "failed";
    lastScanStartedAt: string | null;
    lastScanCompletedAt: string | null;
    listedCount: number;
    quarantinedCount: number;
    deletedCount: number;
    missingCount: number;
    retryCount: number;
    lastErrorCode: string | null;
  } | null;
};

type AuthFailureHandler = () => void;

let authFailureHandler: AuthFailureHandler | null = null;

export function setAdminAuthFailureHandler(handler: AuthFailureHandler | null) {
  authFailureHandler = handler;
}

export async function checkAdminSession(): Promise<boolean> {
  try {
    const response = await adminFetch("/admin/api/session");

    return response.ok;
  } catch {
    return false;
  }
}

export async function loginAdmin(input: { username: string; password: string }): Promise<boolean> {
  const response = await fetch(adminApiUrl("/admin/api/login"), {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });

  return response.ok;
}

export async function logoutAdmin(): Promise<void> {
  await adminFetch("/admin/api/logout", {
    method: "POST"
  });
}

export async function listKnowledgeBases(input: {
  cursor?: string | null;
  limit?: number;
  query?: string | null;
}): Promise<KnowledgeBasePage> {
  const params = new URLSearchParams();

  if (input.limit) {
    params.set("limit", String(input.limit));
  }
  if (input.cursor) {
    params.set("cursor", input.cursor);
  }
  if (input.query?.trim()) {
    params.set("query", input.query.trim());
  }

  const response = await adminFetch(`/admin/api/knowledge-bases${params.size ? `?${params}` : ""}`);

  if (!response.ok) {
    return {
      items: [],
      nextCursor: null
    };
  }

  return (await response.json()) as KnowledgeBasePage;
}

export async function fetchKnowledgeBase(knowledgeBaseId: string): Promise<KnowledgeBase | null> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
  );

  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as { knowledgeBase: KnowledgeBase };
  return body.knowledgeBase;
}

export async function createKnowledgeBase(input: {
  name: string;
  description: string;
}): Promise<{ knowledgeBase: KnowledgeBase } | ApiFailure> {
  const response = await adminFetch("/admin/api/knowledge-bases", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      name: input.name,
      ...(input.description.trim() ? { description: input.description.trim() } : {})
    })
  });
  const body = (await response.json()) as
    | { knowledgeBase: KnowledgeBase }
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.invalidKnowledgeBase");
  }

  return body as { knowledgeBase: KnowledgeBase };
}

export async function deleteKnowledgeBase(input: {
  knowledgeBaseId: string;
}): Promise<{ deleted: true } | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}`,
    {
      method: "DELETE"
    }
  );
  const body = (await response.json()) as
    | { deleted: true }
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.deleteFailed");
  }

  return body as { deleted: true };
}

export async function listPublicOpenApiKeys(input: {
  cursor?: string | null;
  limit?: number;
}): Promise<PublicOpenApiKeyPage> {
  const params = new URLSearchParams();

  if (input.limit) {
    params.set("limit", String(input.limit));
  }
  if (input.cursor) {
    params.set("cursor", input.cursor);
  }

  const response = await adminFetch(`/admin/api/openapi-keys${params.size ? `?${params}` : ""}`);

  if (!response.ok) {
    return {
      items: [],
      nextCursor: null,
      oneTimeKey: null
    };
  }

  return (await response.json()) as PublicOpenApiKeyPage;
}

export async function createPublicOpenApiKey(input: {
  name: string;
}): Promise<{ key: PublicOpenApiKey; oneTimeKey: OneTimePublicOpenApiKey } | ApiFailure> {
  const response = await adminFetch("/admin/api/openapi-keys", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(input.name.trim() ? { name: input.name.trim() } : {})
  });
  const body = (await response.json()) as
    | { key: PublicOpenApiKey; oneTimeKey: OneTimePublicOpenApiKey }
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.openapiKeyFailed");
  }

  return body as { key: PublicOpenApiKey; oneTimeKey: OneTimePublicOpenApiKey };
}

export async function deletePublicOpenApiKey(input: {
  keyId: string;
}): Promise<{ deleted: true } | ApiFailure> {
  const response = await adminFetch(`/admin/api/openapi-keys/${encodeURIComponent(input.keyId)}`, {
    method: "DELETE"
  });
  const body = (await response.json()) as
    | { deleted: true }
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.deleteFailed");
  }

  return body as { deleted: true };
}

export async function fetchRuntimeSettings(): Promise<RuntimeSettingsResponse | ApiFailure> {
  const response = await adminFetch("/admin/api/settings/runtime");
  const body = (await response.json()) as RuntimeSettingsResponse | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.runtimeSettingsUnavailable");
  }

  return body as RuntimeSettingsResponse;
}

export async function updateRateLimitSettings(
  input: RateLimitSettings
): Promise<{ settings: RuntimeSettingsResponse["settings"] } | ApiFailure> {
  return updateRuntimeSettings("/admin/api/settings/rate-limits", input);
}

export async function updateWorkerSettings(
  input: WorkerSettings
): Promise<{ settings: RuntimeSettingsResponse["settings"] } | ApiFailure> {
  return updateRuntimeSettings("/admin/api/settings/worker", input);
}

export async function updatePublicationSettings(
  input: PublicationSettings
): Promise<{ settings: RuntimeSettingsResponse["settings"] } | ApiFailure> {
  return updateRuntimeSettings("/admin/api/settings/publication", input);
}

export async function updateGraphSettings(
  input: GraphSettings
): Promise<{ settings: RuntimeSettingsResponse["settings"] } | ApiFailure> {
  return updateRuntimeSettings("/admin/api/settings/graph", input);
}

export async function updateMaintenanceSettings(
  input: MaintenanceSettings
): Promise<{ settings: RuntimeSettingsResponse["settings"] } | ApiFailure> {
  return updateRuntimeSettings("/admin/api/settings/maintenance", input);
}

export async function createRuntimeModel(input: {
  displayName: string;
  apiMode: RuntimeModelConfig["apiMode"];
  baseUrl: string;
  apiKey: string;
  modelName: string;
  contextWindowTokens: number;
  requestMaxTimeoutMs: number;
  requestIdleTimeoutMs: number;
  suggestionConcurrency: number;
  transientRetryDelayMs: number;
  requestMinIntervalMs: number;
  isActive: boolean;
}): Promise<{ model: RuntimeModelConfig } | ApiFailure> {
  const response = await adminFetch("/admin/api/settings/models", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });
  const body = (await response.json()) as { model: RuntimeModelConfig } | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.runtimeSettingsValidationFailed");
  }

  return body as { model: RuntimeModelConfig };
}

export async function activateRuntimeModel(
  modelId: string
): Promise<{ model: RuntimeModelConfig } | ApiFailure> {
  return postRuntimeModelAction(modelId, "activate");
}

export async function pauseRuntimeModel(
  modelId: string
): Promise<{ model: RuntimeModelConfig } | ApiFailure> {
  return postRuntimeModelAction(modelId, "pause");
}

export async function resumeRuntimeModel(
  modelId: string
): Promise<{ model: RuntimeModelConfig } | ApiFailure> {
  return postRuntimeModelAction(modelId, "resume");
}

export async function deleteRuntimeModel(
  modelId: string
): Promise<{ model: RuntimeModelConfig } | ApiFailure> {
  const response = await adminFetch(`/admin/api/settings/models/${encodeURIComponent(modelId)}`, {
    method: "DELETE"
  });
  const body = (await response.json()) as { model: RuntimeModelConfig } | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.deleteFailed");
  }

  return body as { model: RuntimeModelConfig };
}

async function updateRuntimeSettings(
  path: string,
  input: unknown
): Promise<{ settings: RuntimeSettingsResponse["settings"] } | ApiFailure> {
  const response = await adminFetch(path, {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });
  const body = (await response.json()) as
    | { settings: RuntimeSettingsResponse["settings"] }
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.runtimeSettingsValidationFailed");
  }

  return body as { settings: RuntimeSettingsResponse["settings"] };
}

async function postRuntimeModelAction(
  modelId: string,
  action: "activate" | "pause" | "resume"
): Promise<{ model: RuntimeModelConfig } | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/settings/models/${encodeURIComponent(modelId)}/${action}`,
    {
      method: "POST"
    }
  );
  const body = (await response.json()) as { model: RuntimeModelConfig } | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.runtimeSettingsValidationFailed");
  }

  return body as { model: RuntimeModelConfig };
}

export type UploadSession = {
  id: string;
  knowledgeBaseId: string;
  state:
    | "draft"
    | "manifest_building"
    | "manifest_sealed"
    | "uploading"
    | "finalizing"
    | "completed"
    | "failed"
    | "cancelled"
    | "expired";
  declaredFileCount: number;
  declaredByteCount: number;
  counts: {
    selected: number;
    uploadRequired: number;
    skippedExisting: number;
    waitingReservation: number;
    rejectedDeleting: number;
    uploaded: number;
    failed: number;
    finalized: number;
  };
  expiresAt: string;
};

export type UploadSessionEntry = {
  id: string;
  relativePath: string;
  directoryPath: string;
  name: string;
  declaredSize: number;
  receivedSize: number | null;
  disposition:
    | "pending"
    | "upload_required"
    | "skipped_existing"
    | "waiting_reservation"
    | "rejected_deleting";
  transferState: "pending" | "missing" | "uploading" | "uploaded" | "failed" | "skipped";
  sourceDirectoryId: string | null;
  sourceFileId: string | null;
  existingResourceRevision: number | null;
  generatedPath: string;
  errorCode: string | null;
};

export type UploadSessionTransport = {
  manifestPageSize: number;
};

export async function createUploadSession(input: {
  knowledgeBaseId: string;
  idempotencyKey: string;
  declaredFileCount: number;
  declaredByteCount: number;
}): Promise<{ session: UploadSession; transport: UploadSessionTransport } | ApiFailure> {
  return uploadSessionJsonRequest(
    uploadSessionBasePath(input.knowledgeBaseId),
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
      body: JSON.stringify({
        declaredFileCount: input.declaredFileCount,
        declaredByteCount: input.declaredByteCount
      })
    }
  );
}

export async function addUploadManifestEntries(input: {
  knowledgeBaseId: string;
  sessionId: string;
  entries: Array<{ relativePath: string; declaredSize: number; checksumSha256?: string | null }>;
}): Promise<{ session: UploadSession } | ApiFailure> {
  return uploadSessionJsonRequest(uploadSessionPath(input, "entries"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries: input.entries })
  });
}

export async function sealUploadManifest(input: {
  knowledgeBaseId: string;
  sessionId: string;
}): Promise<{ session: UploadSession; sample: UploadSessionEntry[]; nextCursor: string | null } | ApiFailure> {
  return uploadSessionJsonRequest(uploadSessionPath(input, "seal"), { method: "POST" });
}

export async function getUploadSession(input: {
  knowledgeBaseId: string;
  sessionId: string;
  transferState?: "missing" | "failed" | "uploaded";
  cursor?: string | null;
  limit?: number;
}): Promise<{
  session: UploadSession;
  entries: { items: UploadSessionEntry[]; nextCursor: string | null };
} | ApiFailure> {
  const params = new URLSearchParams();
  if (input.transferState) params.set("transferState", input.transferState);
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit) params.set("limit", String(input.limit));
  return uploadSessionJsonRequest(
    `${uploadSessionPath(input)}${params.size ? `?${params.toString()}` : ""}`,
    { method: "GET" }
  );
}

export async function uploadSessionContent(input: {
  knowledgeBaseId: string;
  sessionId: string;
  entryId: string;
  file: File;
}): Promise<{ entry: UploadSessionEntry } | ApiFailure> {
  return uploadSessionJsonRequest(
    uploadSessionPath(input, `entries/${encodeURIComponent(input.entryId)}/content`),
    {
      method: "PUT",
      headers: { "content-type": "text/markdown; charset=utf-8" },
      body: input.file
    }
  );
}

export async function reconcileUploadSession(input: {
  knowledgeBaseId: string;
  sessionId: string;
}): Promise<{ session: UploadSession } | ApiFailure> {
  return uploadSessionJsonRequest(uploadSessionPath(input, "reconcile"), { method: "POST" });
}

export async function finalizeUploadSession(input: {
  knowledgeBaseId: string;
  sessionId: string;
}): Promise<{ session: UploadSession } | ApiFailure> {
  return uploadSessionJsonRequest(uploadSessionPath(input, "finalize"), { method: "POST" });
}

export async function cancelUploadSession(input: {
  knowledgeBaseId: string;
  sessionId: string;
}): Promise<{ session: UploadSession } | ApiFailure> {
  return uploadSessionJsonRequest(uploadSessionPath(input), { method: "DELETE" });
}

async function uploadSessionJsonRequest<T>(path: string, init: RequestInit): Promise<T | ApiFailure> {
  const response = await adminFetch(path, init);
  const body = (await response.json()) as T | { error?: { messageKey?: string } };
  return response.ok ? (body as T) : readFailure(body, "errors.uploadFailed");
}

function uploadSessionBasePath(knowledgeBaseId: string): string {
  return `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/upload-sessions`;
}

function uploadSessionPath(
  input: { knowledgeBaseId: string; sessionId: string },
  action?: string
): string {
  const base = `${uploadSessionBasePath(input.knowledgeBaseId)}/${encodeURIComponent(input.sessionId)}`;
  return action ? `${base}/${action}` : base;
}

export async function retryKnowledgeBaseSourceFile(input: {
  knowledgeBaseId: string;
  sourceFileId: string;
}): Promise<{
  file: SourceFileRecord;
  retry: {
    kind: "source_processing" | "publication";
    scope: "source_file" | "knowledge_base_publication";
    coalesced: boolean;
  };
} | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(
      input.knowledgeBaseId
    )}/source-files/${encodeURIComponent(input.sourceFileId)}/retry`,
    {
      method: "POST"
    }
  );
  const body = (await response.json()) as
    | {
        file: SourceFileRecord;
        retry: {
          kind: "source_processing" | "publication";
          scope: "source_file" | "knowledge_base_publication";
          coalesced: boolean;
        };
      }
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.uploadFailed");
  }

  return body as {
    file: SourceFileRecord;
    retry: {
      kind: "source_processing" | "publication";
      scope: "source_file" | "knowledge_base_publication";
      coalesced: boolean;
    };
  };
}

export async function deleteKnowledgeBaseSourceFileTasks(input: {
  knowledgeBaseId: string;
  sourceFileIds: string[];
}): Promise<SourceFileTaskDeletionResponse | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(
      input.knowledgeBaseId
    )}/source-files/task-deletions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sourceFileIds: input.sourceFileIds
      })
    }
  );
  const body = (await response.json()) as
    | SourceFileTaskDeletionResponse
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.sourceFileTaskDeletionFailed");
  }

  return body as SourceFileTaskDeletionResponse;
}

export async function fetchKnowledgeBaseFileTree(input: {
  knowledgeBaseId: string;
  parentPath?: string;
  cursor?: string | null;
}): Promise<GeneratedTreePage> {
  const params = new URLSearchParams();

  if (input.parentPath) {
    params.set("parentPath", input.parentPath);
  }
  if (input.cursor) {
    params.set("cursor", input.cursor);
  }

  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/files/tree${
      params.size ? `?${params}` : ""
    }`
  );

  if (!response.ok) {
    return {
      items: [],
      nextCursor: null
    };
  }

  return (await response.json()) as GeneratedTreePage;
}

export async function searchKnowledgeBaseFileTree(input: {
  knowledgeBaseId: string;
  query: string;
  cursor?: string | null;
}): Promise<GeneratedTreeSearchPage> {
  const params = new URLSearchParams({
    query: input.query
  });

  if (input.cursor) {
    params.set("cursor", input.cursor);
  }

  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/files/tree/search?${params}`
  );

  if (!response.ok) {
    return {
      items: [],
      nextCursor: null
    };
  }

  return (await response.json()) as GeneratedTreeSearchPage;
}

export async function fetchKnowledgeBaseFileDetail(input: {
  knowledgeBaseId: string;
  path: string;
}): Promise<GeneratedFileDetail | null> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(
      input.knowledgeBaseId
    )}/files/detail?path=${encodeURIComponent(input.path)}&includeRelationships=1`
  );

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as GeneratedFileDetail;
}

export async function deleteKnowledgeBaseFile(input: {
  knowledgeBaseId: string;
  path: string;
}): Promise<{ deleted: true; publicationQueued: true } | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(
      input.knowledgeBaseId
    )}/files/detail?path=${encodeURIComponent(input.path)}`,
    {
      method: "DELETE"
    }
  );
  const body = (await response.json()) as
    | { deleted: true; publicationQueued: true }
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.deleteFailed");
  }

  return body as { deleted: true; publicationQueued: true };
}

export async function deleteKnowledgeBaseSourceDirectory(input: {
  knowledgeBaseId: string;
  sourceDirectoryId: string;
  expectedResourceRevision: number;
}): Promise<
  | {
      accepted: true;
      operationId: string;
      directoryId: string;
      affectedDirectoryCount: number;
      affectedFileCount: number;
    }
  | ApiFailure
> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/source-directories/${encodeURIComponent(input.sourceDirectoryId)}`,
    {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID()
      },
      body: JSON.stringify({ expectedResourceRevision: input.expectedResourceRevision })
    }
  );
  const body = await response.json() as
    | {
        accepted: true;
        operationId: string;
        directoryId: string;
        affectedDirectoryCount: number;
        affectedFileCount: number;
      }
    | { error?: { messageKey?: string } };
  return response.ok
    ? body as Extract<typeof body, { accepted: true }>
    : readFailure(body, "errors.deleteDirectoryFailed");
}

export async function listSourceFiles(input: {
  knowledgeBaseId: string;
  cursor?: string | null;
  filters?: SourceFileListFilters;
}): Promise<SourceFilePage> {
  const params = new URLSearchParams();

  if (input.cursor) {
    params.set("cursor", input.cursor);
  }
  if (input.filters) {
    appendSourceFileFilterParams(params, input.filters);
  }

  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/source-files${
      params.size ? `?${params}` : ""
    }`
  );

  if (!response.ok) {
    throw new Error("pagination.expired");
  }

  return (await response.json()) as SourceFilePage;
}

export async function fetchSourceFile(input: {
  knowledgeBaseId: string;
  sourceFileId: string;
}): Promise<SourceFileRecord | null> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/source-files/${encodeURIComponent(input.sourceFileId)}`
  );
  if (!response.ok) return null;
  return ((await response.json()) as SourceFileDetail).file;
}

export async function fetchKnowledgeBaseProcessingSummary(input: {
  knowledgeBaseId: string;
}): Promise<ProcessingSummary | null> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/processing-summary`
  );

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as ProcessingSummary;
}

export async function fetchKnowledgeBasePublicUrls(input: {
  knowledgeBaseId: string;
}): Promise<KnowledgeBasePublicUrls | null> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/public-urls`
  );

  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as { publicUrls: KnowledgeBasePublicUrls };
  return body.publicUrls;
}

function readFailure(
  body: unknown,
  fallbackMessageKey: string
): ApiFailure {
  const candidate =
    body && typeof body === "object"
      ? (body as { error?: { messageKey?: string } })
      : {};
  return {
    messageKey: candidate.error?.messageKey ?? fallbackMessageKey
  };
}

export async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(adminApiUrl(path), {
    ...init,
    credentials: "include"
  });

  if (response.status === 401) {
    authFailureHandler?.();
  }

  return response;
}

function adminApiUrl(path: string): string {
  const baseUrl = readAdminApiBaseUrl();
  return baseUrl ? `${baseUrl}${path}` : path;
}

function readAdminApiBaseUrl(): string {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  const value = meta.env?.VITE_ADMIN_API_BASE_URL?.trim() ?? "";
  return value.replace(/\/+$/, "");
}
