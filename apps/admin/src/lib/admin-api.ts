import {
  appendSourceFileFilterParams,
  type SourceFileListFilters
} from "@/lib/source-file-list-filters";

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string | null;
  activeContentRevision: number;
  resourceRevision?: number;
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
    portableScopePath?: string | null;
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
  state: "waiting" | "processing" | "available" | "error" | "deleting";
  requiredWorkCount: number;
  completedWorkCount: number;
  activeWorkKinds: SourceFileWorkKind[];
  blockingWorkKind: SourceFileWorkKind | null;
  retryingWorkKind: SourceFileWorkKind | null;
  failure: {
    workKind: SourceFileWorkKind;
    code: string;
    message: string;
    occurredAt: string;
    retryKind: "document_processing" | "none";
    correlationId: string;
  } | null;
  actions: Array<{
    kind:
      | "open_generated_file"
      | "view_failure_details"
      | "replace_source_content"
      | "retry_document_processing";
    method: "GET" | "POST" | "PUT" | null;
    href: string | null;
    scope: "source_file";
  }>;
  processingStartedAt?: string | null;
  processingEndedAt?: string | null;
  retryCount?: number;
  modelInvocationStatus?: "not_required" | "running" | "completed" | "failed" | null;
  modelInvocationModelName?: string | null;
  modelInvocationStartedAt?: string | null;
  modelInvocationEndedAt?: string | null;
  modelInvocationWarningCount?: number | null;
  modelInvocationErrorCode?: string | null;
  modelLayerExecutions?: Array<{
    layer: "first_layer" | "candidate_delta" | "graphrag";
    status: "running" | "completed" | "failed";
    modelName: string;
    selected: boolean | null;
    reused: boolean;
    providerRequestCount: number;
    waitTimeMs: number;
    serviceTimeMs: number;
    providerObservations: Array<{
      apiMode: "responses" | "chat_completions";
      structuredOutputCapability: "native_json_schema" | "json_object_compatibility" | "unknown";
      attempt: number;
      repair: boolean;
      requestId: string | null;
      finishState: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      cachedInputTokens: number | null;
      serviceTimeMs: number;
      errorClass: "none" | "refusal" | "incomplete" | "schema_validation" | "transient" | "provider";
    }>;
    warningCount: number;
    errorCode: string | null;
    startedAt: string;
    endedAt: string | null;
  }>;
  generatedOutputStatus?: "unavailable" | "previous_available" | "current_available";
  generatedFileAvailable?: boolean;
  generatedFilePath?: string | null;
  generatedFileId?: string | null;
  createdAt: string;
};

export type SourceFileWorkKind =
  | "prepare"
  | "first_layer"
  | "content_projection"
  | "graphrag"
  | "relation_reconcile"
  | "knowledge_projection"
  | "activate"
  | "cleanup";

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
  | "job_already_claimed";

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

export type ProcessingSummary = {
  waitingCount: number;
  processingCount: number;
  availableCount: number;
  errorCount: number;
  oldestWaitingAt: string | null;
};

export type IndexMaintenanceStatus = {
  requestId: string | null;
  state: "idle" | "queued" | "planning" | "running" | "validating"
    | "completed" | "failed" | "superseded" | "canceled";
  trigger: "manual" | "automatic" | null;
  stage: string | null;
  active: boolean;
  completedCount: number;
  expectedCount: number;
  retryCount: number;
  lastProgressAt: string | null;
  lastCompletedAt: string | null;
  maintenanceRequired: boolean;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
};

export type KnowledgeBasePublicUrls = {
  index: string;
  search: string;
  links: string;
};

export type ApiFailure = {
  messageKey: string;
  code?: string;
  issues?: Array<{ field: string }>;
};

export type RateLimitSettings = {
  adminLogin: { max: number; windowSeconds: number };
  adminApi: { max: number; windowSeconds: number };
  publicOpenApi: { max: number; windowSeconds: number };
};

export type WorkerSettings = {
  sourceFileConcurrency: number;
  s3Concurrency: number;
  jobMaxAttempts: number;
  jobRetryDelayMs: number;
  completedJobRetentionDays: number;
};

export type GeneratedSettings = {
  directoryIndexMaxEntries: number;
  directoryIndexMaxBytes: number;
  rootSummaryLimit: number;
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
  shardSize: number;
  genericPhraseThreshold: number;
};

export type MaintenanceSettings = {
  reconciliationEnabled: boolean;
  scanBatchSize: number;
  maxAttempts: number;
  retryDelayMs: number;
  hardDeleteConcurrency: number;
  hardDeleteDatabaseBatchSize: number;
  hardDeleteObjectBatchSize: number;
  hardDeleteMaxAttempts: number;
  hardDeleteRetryDelayMs: number;
  hardDeleteFailedRetentionDays: number;
};

export type SearchSettings = {
  requestTimeoutMs: number;
  engineSearchCutoffMs: number;
  overfetchFactor: number;
  indexBatchDocumentCount: number;
  indexBatchCompressedBytes: number;
  maxInFlightTasks: number;
  taskPollIntervalMs: number;
  taskTimeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  cleanupBatchSize: number;
  cropLength: number;
};

export type SemanticSettings = {
  maximumChunkCharacters: number;
  maximumChunks: number;
  maximumEvidenceTargets: number;
  graphRagAdapterTimeoutMs: number;
  searchLaneCutoffMs: number;
  queryEmbeddingConcurrency: number;
  queryEmbeddingCacheEntries: number;
};

export type EmbeddingConfiguration = {
  publicId: string;
  revisionPublicId: string;
  revision: number;
  displayName: string;
  authenticationMode: "api_key" | "none";
  baseUrl: string;
  apiKeyConfigured: boolean;
  modelName: string;
  requestedDimension: number | null;
  resolvedDimension: number | null;
  normalization: "none" | "l2";
  maximumInputTokens: number;
  batchSize: number;
  timeoutMs: number;
  retryCount: number;
  minimumIntervalMs: number;
  concurrency: number;
  maximumResponseBytes: number;
  minimumVectorRelevance: number;
  vectorProducingRevisionPublicId: string;
  queryPolicyRevisionPublicId: string;
  validationStatus: "not_tested" | "valid" | "invalid";
  validationFingerprintSha256: string | null;
  safeValidationErrorCode: string | null;
  lifecycleStatus: "draft" | "active" | "paused";
  createdAt: string;
};

export type EmbeddingConfigurationDraft = Pick<
  EmbeddingConfiguration,
  | "displayName"
  | "authenticationMode"
  | "baseUrl"
  | "modelName"
  | "requestedDimension"
  | "normalization"
  | "maximumInputTokens"
  | "batchSize"
  | "timeoutMs"
  | "retryCount"
  | "minimumIntervalMs"
  | "concurrency"
  | "maximumResponseBytes"
  | "minimumVectorRelevance"
> & { apiKey: string | null };

export type RerankerConfiguration = {
  publicId: string;
  revisionPublicId: string;
  revision: number;
  displayName: string;
  authenticationMode: "api_key" | "none";
  baseUrl: string;
  apiKeyConfigured: boolean;
  modelName: string;
  timeoutMs: number;
  retryCount: number;
  minimumIntervalMs: number;
  concurrency: number;
  validationStatus: "not_tested" | "valid" | "invalid";
  validationFingerprintSha256: string | null;
  safeValidationErrorCode: string | null;
  lifecycleStatus: "draft" | "active" | "paused";
  createdAt: string;
};

export type RerankerConfigurationDraft = Pick<
  RerankerConfiguration,
  | "displayName"
  | "authenticationMode"
  | "baseUrl"
  | "modelName"
  | "timeoutMs"
  | "retryCount"
  | "minimumIntervalMs"
  | "concurrency"
> & { apiKey: string | null };

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

export type RuntimeModelDraft = {
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
};

export type RuntimeSettingsResponse = {
  settings: {
    rateLimits: RateLimitSettings;
    worker: WorkerSettings;
    generated: GeneratedSettings;
    graph: GraphSettings;
    maintenance: MaintenanceSettings;
    semantic: SemanticSettings;
    search: SearchSettings;
    activeModel: RuntimeModelConfig | null;
  };
  models: RuntimeModelConfig[];
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

export type AdminLoginResult =
  | { authenticated: true; error: null; retryAfterSeconds: null }
  | {
      authenticated: false;
      error: "invalid_credentials" | "rate_limited" | "request_failed";
      retryAfterSeconds: number | null;
    };

export async function loginAdmin(input: { username: string; password: string }): Promise<AdminLoginResult> {
  let response: Response;
  try {
    response = await fetch(adminApiUrl("/admin/api/login"), {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    });
  } catch {
    return { authenticated: false, error: "request_failed", retryAfterSeconds: null };
  }

  if (response.ok) {
    return { authenticated: true, error: null, retryAfterSeconds: null };
  }
  if (response.status === 401) {
    return { authenticated: false, error: "invalid_credentials", retryAfterSeconds: null };
  }
  if (response.status === 429) {
    return {
      authenticated: false,
      error: "rate_limited",
      retryAfterSeconds: readRetryAfterSeconds(response.headers.get("retry-after"))
    };
  }

  return { authenticated: false, error: "request_failed", retryAfterSeconds: null };
}

function readRetryAfterSeconds(value: string | null): number | null {
  const seconds = Number.parseInt(value ?? "", 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
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
    const body = await response.json().catch(() => null);
    throw new Error(readFailure(body, "errors.runtimeSettingsUnavailable").messageKey);
  }

  return (await response.json()) as KnowledgeBasePage;
}

export async function fetchKnowledgeBase(knowledgeBaseId: string): Promise<KnowledgeBase | null> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
  );

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(readFailure(body, "errors.runtimeSettingsUnavailable").messageKey);
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
}): Promise<{
  accepted: true;
  operationId: string;
  affectedDirectoryCount: number;
  affectedFileCount: number;
} | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}`,
    {
      method: "DELETE"
    }
  );
  const body = (await response.json()) as
    | {
        accepted: true;
        operationId: string;
        affectedDirectoryCount: number;
        affectedFileCount: number;
      }
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.deleteFailed");
  }

  return body as {
    accepted: true;
    operationId: string;
    affectedDirectoryCount: number;
    affectedFileCount: number;
  };
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
    const body = await response.json().catch(() => null);
    throw new Error(readFailure(body, "errors.openapiKeyFailed").messageKey);
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

export async function updateGeneratedSettings(
  input: GeneratedSettings
): Promise<{ settings: RuntimeSettingsResponse["settings"] } | ApiFailure> {
  return updateRuntimeSettings("/admin/api/settings/generated", input);
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

export async function updateSearchSettings(
  input: SearchSettings
): Promise<{ settings: RuntimeSettingsResponse["settings"] } | ApiFailure> {
  return updateRuntimeSettings("/admin/api/settings/search", input);
}

export async function updateSemanticSettings(
  input: SemanticSettings
): Promise<{ settings: RuntimeSettingsResponse["settings"] } | ApiFailure> {
  return updateRuntimeSettings("/admin/api/settings/semantic", input);
}

export async function fetchEmbeddingConfigurations(): Promise<
  { configurations: EmbeddingConfiguration[] } | ApiFailure
> {
  const response = await adminFetch("/admin/api/settings/embeddings");
  const body = (await response.json()) as
    | { configurations: EmbeddingConfiguration[] }
    | { error?: { messageKey?: string } };
  return response.ok
    ? body as { configurations: EmbeddingConfiguration[] }
    : readFailure(body, "errors.embeddingConfigurationUnavailable");
}

export async function createEmbeddingConfiguration(
  input: EmbeddingConfigurationDraft
): Promise<{ configuration: EmbeddingConfiguration } | ApiFailure> {
  return writeEmbeddingConfiguration("/admin/api/settings/embeddings", "POST", input);
}

export async function updateEmbeddingConfiguration(input: {
  configurationId: string;
  expectedRevision: number;
  configuration: EmbeddingConfigurationDraft;
}): Promise<{ configuration: EmbeddingConfiguration } | ApiFailure> {
  return writeEmbeddingConfiguration(
    `/admin/api/settings/embeddings/${encodeURIComponent(input.configurationId)}`,
    "PUT",
    { expectedRevision: input.expectedRevision, configuration: input.configuration }
  );
}

export async function testEmbeddingConfiguration(configurationId: string) {
  return writeEmbeddingConfiguration(
    `/admin/api/settings/embeddings/${encodeURIComponent(configurationId)}/test`,
    "POST"
  );
}

export async function activateEmbeddingConfiguration(
  configurationId: string,
  expectedRevision: number
) {
  return embeddingLifecycleAction(configurationId, "activate", expectedRevision);
}

export async function pauseEmbeddingConfiguration(
  configurationId: string,
  expectedRevision: number
) {
  return embeddingLifecycleAction(configurationId, "pause", expectedRevision);
}

export async function resumeEmbeddingConfiguration(
  configurationId: string,
  expectedRevision: number
) {
  return embeddingLifecycleAction(configurationId, "resume", expectedRevision);
}

export async function deleteEmbeddingConfiguration(
  configurationId: string,
  expectedRevision: number
): Promise<{ deleted: true } | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/settings/embeddings/${encodeURIComponent(configurationId)}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision })
    }
  );
  const body = (await response.json()) as
    | { deleted: true }
    | { error?: { messageKey?: string } };
  return response.ok
    ? body as { deleted: true }
    : readFailure(body, "errors.embeddingConfigurationActionFailed");
}

function embeddingLifecycleAction(
  configurationId: string,
  action: "activate" | "pause" | "resume",
  expectedRevision: number
) {
  return writeEmbeddingConfiguration(
    `/admin/api/settings/embeddings/${encodeURIComponent(configurationId)}/${action}`,
    "POST",
    { expectedRevision }
  );
}

async function writeEmbeddingConfiguration(
  path: string,
  method: "POST" | "PUT",
  input?: unknown
): Promise<{ configuration: EmbeddingConfiguration } | ApiFailure> {
  const response = await adminFetch(path, {
    method,
    ...(input === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    })
  });
  const body = (await response.json()) as
    | { configuration: EmbeddingConfiguration }
    | { error?: { messageKey?: string } };
  return response.ok
    ? body as { configuration: EmbeddingConfiguration }
    : readFailure(body, "errors.embeddingConfigurationActionFailed");
}

export async function fetchRerankerConfigurations(): Promise<
  { configurations: RerankerConfiguration[] } | ApiFailure
> {
  const response = await adminFetch("/admin/api/settings/rerankers");
  const body = (await response.json()) as
    | { configurations: RerankerConfiguration[] }
    | { error?: { messageKey?: string } };
  return response.ok
    ? body as { configurations: RerankerConfiguration[] }
    : readFailure(body, "errors.rerankerConfigurationUnavailable");
}

export async function createRerankerConfiguration(
  input: RerankerConfigurationDraft
): Promise<{ configuration: RerankerConfiguration } | ApiFailure> {
  return writeRerankerConfiguration("/admin/api/settings/rerankers", "POST", input);
}

export async function updateRerankerConfiguration(input: {
  configurationId: string;
  expectedRevision: number;
  configuration: RerankerConfigurationDraft;
}): Promise<{ configuration: RerankerConfiguration } | ApiFailure> {
  return writeRerankerConfiguration(
    `/admin/api/settings/rerankers/${encodeURIComponent(input.configurationId)}`,
    "PUT",
    { expectedRevision: input.expectedRevision, configuration: input.configuration }
  );
}

export async function testRerankerConfiguration(configurationId: string) {
  return writeRerankerConfiguration(
    `/admin/api/settings/rerankers/${encodeURIComponent(configurationId)}/test`,
    "POST"
  );
}

export async function activateRerankerConfiguration(
  configurationId: string,
  expectedRevision: number
) {
  return rerankerLifecycleAction(configurationId, "activate", expectedRevision);
}

export async function pauseRerankerConfiguration(
  configurationId: string,
  expectedRevision: number
) {
  return rerankerLifecycleAction(configurationId, "pause", expectedRevision);
}

export async function resumeRerankerConfiguration(
  configurationId: string,
  expectedRevision: number
) {
  return rerankerLifecycleAction(configurationId, "resume", expectedRevision);
}

export async function deleteRerankerConfiguration(
  configurationId: string,
  expectedRevision: number
): Promise<{ deleted: true } | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/settings/rerankers/${encodeURIComponent(configurationId)}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision })
    }
  );
  const body = (await response.json()) as
    | { deleted: true }
    | { error?: { messageKey?: string } };
  return response.ok
    ? body as { deleted: true }
    : readFailure(body, "errors.rerankerConfigurationActionFailed");
}

function rerankerLifecycleAction(
  configurationId: string,
  action: "activate" | "pause" | "resume",
  expectedRevision: number
) {
  return writeRerankerConfiguration(
    `/admin/api/settings/rerankers/${encodeURIComponent(configurationId)}/${action}`,
    "POST",
    { expectedRevision }
  );
}

async function writeRerankerConfiguration(
  path: string,
  method: "POST" | "PUT",
  input?: unknown
): Promise<{ configuration: RerankerConfiguration } | ApiFailure> {
  const response = await adminFetch(path, {
    method,
    ...(input === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    })
  });
  const body = (await response.json()) as
    | { configuration: RerankerConfiguration }
    | { error?: { messageKey?: string } };
  return response.ok
    ? body as { configuration: RerankerConfiguration }
    : readFailure(body, "errors.rerankerConfigurationActionFailed");
}

export async function createRuntimeModel(
  input: RuntimeModelDraft
): Promise<{ model: RuntimeModelConfig } | ApiFailure> {
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

export async function updateRuntimeModel(
  modelId: string,
  input: Omit<RuntimeModelDraft, "isActive">
): Promise<{ model: RuntimeModelConfig } | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/settings/models/${encodeURIComponent(modelId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }
  );
  const body = (await response.json()) as
    | { model: RuntimeModelConfig }
    | { error?: { messageKey?: string } };
  return response.ok
    ? body as { model: RuntimeModelConfig }
    : readFailure(body, "errors.runtimeSettingsValidationFailed");
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
  operationId: string;
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
  contentUploadConcurrency?: number;
};

export async function createUploadSession(input: {
  knowledgeBaseId: string;
  idempotencyKey: string;
  declaredFileCount: number;
  declaredByteCount: number;
  signal?: AbortSignal | undefined;
}): Promise<{ session: UploadSession; transport: UploadSessionTransport } | ApiFailure> {
  return uploadSessionJsonRequest(
    uploadSessionBasePath(input.knowledgeBaseId),
    {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
      body: JSON.stringify({
        declaredFileCount: input.declaredFileCount,
        declaredByteCount: input.declaredByteCount
      }),
      ...(input.signal ? { signal: input.signal } : {})
    }
  );
}

export async function addUploadManifestEntries(input: {
  knowledgeBaseId: string;
  sessionId: string;
  entries: Array<{ relativePath: string; declaredSize: number; checksumSha256?: string | null }>;
  signal?: AbortSignal | undefined;
}): Promise<{ session: UploadSession } | ApiFailure> {
  return uploadSessionJsonRequest(uploadSessionPath(input, "entries"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries: input.entries }),
    ...(input.signal ? { signal: input.signal } : {})
  });
}

export async function sealUploadManifest(input: {
  knowledgeBaseId: string;
  sessionId: string;
  signal?: AbortSignal | undefined;
}): Promise<{ session: UploadSession; sample: UploadSessionEntry[]; nextCursor: string | null } | ApiFailure> {
  return uploadSessionJsonRequest(uploadSessionPath(input, "seal"), {
    method: "POST",
    ...(input.signal ? { signal: input.signal } : {})
  });
}

export async function getUploadSession(input: {
  knowledgeBaseId: string;
  sessionId: string;
  transferState?: "missing" | "failed" | "uploaded";
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal | undefined;
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
    { method: "GET", ...(input.signal ? { signal: input.signal } : {}) }
  );
}

export async function uploadSessionContent(input: {
  knowledgeBaseId: string;
  sessionId: string;
  entryId: string;
  file: File;
  signal?: AbortSignal | undefined;
}): Promise<{ entry: UploadSessionEntry } | ApiFailure> {
  return uploadSessionJsonRequest(
    uploadSessionPath(input, `entries/${encodeURIComponent(input.entryId)}/content`),
    {
      method: "PUT",
      headers: { "content-type": "text/markdown; charset=utf-8" },
      body: input.file,
      ...(input.signal ? { signal: input.signal } : {})
    }
  );
}

export async function reconcileUploadSession(input: {
  knowledgeBaseId: string;
  sessionId: string;
  signal?: AbortSignal | undefined;
}): Promise<{ session: UploadSession } | ApiFailure> {
  return uploadSessionJsonRequest(uploadSessionPath(input, "reconcile"), {
    method: "POST",
    ...(input.signal ? { signal: input.signal } : {})
  });
}

export async function finalizeUploadSession(input: {
  knowledgeBaseId: string;
  sessionId: string;
  signal?: AbortSignal | undefined;
}): Promise<{ session: UploadSession } | ApiFailure> {
  return uploadSessionJsonRequest(uploadSessionPath(input, "finalize"), {
    method: "POST",
    ...(input.signal ? { signal: input.signal } : {})
  });
}

export async function cancelUploadSession(input: {
  knowledgeBaseId: string;
  sessionId: string;
}): Promise<{ session: UploadSession } | ApiFailure> {
  return uploadSessionJsonRequest(uploadSessionPath(input), { method: "DELETE" });
}

async function uploadSessionJsonRequest<T>(path: string, init: RequestInit): Promise<T | ApiFailure> {
  const response = await adminFetch(path, init);
  const body = (await response.json()) as T | {
    error?: { code?: string; messageKey?: string };
  };
  return response.ok ? (body as T) : readUploadFailure(body);
}

function readUploadFailure(body: unknown): ApiFailure {
  const error = body && typeof body === "object"
    ? (body as { error?: { code?: unknown; messageKey?: unknown } }).error
    : undefined;
  if (typeof error?.messageKey === "string" && error.messageKey.length > 0) {
    return { messageKey: error.messageKey };
  }
  const messageKeyByCode: Record<string, string> = {
    UPLOAD_MANIFEST_DUPLICATE_PATH: "errors.uploadPathReserved",
    UPLOAD_SESSION_NOT_FOUND: "errors.uploadSessionUnavailable",
    UPLOAD_SESSION_STATE_CONFLICT: "errors.uploadSessionUnavailable",
    UPLOAD_SESSION_EXPIRED: "errors.uploadSessionUnavailable",
    UPLOAD_IDEMPOTENCY_CONFLICT: "errors.uploadSessionConflict",
    UPLOAD_MANIFEST_TOTAL_MISMATCH: "errors.uploadSelectionChanged",
    UPLOAD_ENTRY_NOT_FOUND: "errors.uploadSessionUnavailable",
    UPLOAD_ENTRY_NOT_REQUIRED: "errors.uploadSessionUnavailable",
    UPLOAD_ENTRY_SIZE_MISMATCH: "errors.uploadContentChanged",
    UPLOAD_ENTRY_CHECKSUM_MISMATCH: "errors.uploadContentChanged",
    UPLOAD_ENTRY_STORAGE_FAILED: "errors.uploadStorageFailed",
    UPLOAD_SESSION_INCOMPLETE: "errors.uploadIncomplete",
    UPLOAD_PROCESSING_CONFIGURATION_REQUIRED: "errors.uploadProcessingConfigurationRequired",
    INVALID_UPLOAD_SESSION: "errors.uploadSelectionChanged",
    INVALID_UPLOAD_MANIFEST_PAGE: "errors.uploadSelectionChanged",
    INVALID_UPLOAD_MANIFEST_ENTRY: "errors.uploadSelectionChanged",
    INVALID_MARKDOWN_CONTENT: "errors.uploadContentChanged"
  };
  const code = typeof error?.code === "string" ? error.code : "";
  return { messageKey: messageKeyByCode[code] ?? "errors.uploadFailed" };
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
    kind: "document_processing";
    scope: "source_file";
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
          kind: "document_processing";
          scope: "source_file";
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
      kind: "document_processing";
      scope: "source_file";
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
    throw await adminReadError(response, "errors.serviceUnavailable");
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
    throw await adminReadError(response, "detail.fileTreeSearchFailed");
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

  if (response.status === 404) return null;
  if (!response.ok) throw await adminReadError(response, "errors.serviceUnavailable");

  return (await response.json()) as GeneratedFileDetail;
}

export async function deleteKnowledgeBaseSourceDirectory(input: {
  knowledgeBaseId: string;
  sourceDirectoryId: string;
  expectedResourceRevision: number;
}): Promise<
  | {
      accepted: true;
      operation: import("@/lib/resource-editing-api").ResourceOperation;
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
        operation: import("@/lib/resource-editing-api").ResourceOperation;
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
    const body = await response.json().catch(() => null);
    const code = body && typeof body === "object"
      ? (body as { error?: { code?: unknown } }).error?.code
      : null;
    if (code === "INVALID_PAGINATION") throw new Error("pagination.expired");
    throw new Error(readFailure(body, "errors.serviceUnavailable").messageKey);
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
  if (response.status === 404) return null;
  if (!response.ok) throw await adminReadError(response, "errors.serviceUnavailable");
  return ((await response.json()) as SourceFileDetail).file;
}

export async function fetchKnowledgeBaseProcessingSummary(input: {
  knowledgeBaseId: string;
}): Promise<ProcessingSummary | null> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/processing-summary`
  );

  if (!response.ok) throw await adminReadError(response, "errors.serviceUnavailable");

  return (await response.json()) as ProcessingSummary;
}

export async function fetchKnowledgeBaseIndexMaintenance(input: {
  knowledgeBaseId: string;
}): Promise<IndexMaintenanceStatus> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/index-maintenance`
  );
  if (!response.ok) throw await adminReadError(response, "errors.serviceUnavailable");
  return ((await response.json()) as { maintenance: IndexMaintenanceStatus }).maintenance;
}

export async function requestKnowledgeBaseIndexMaintenance(input: {
  knowledgeBaseId: string;
  idempotencyKey: string;
}): Promise<{
  result: "accepted" | "already_active";
  maintenance: IndexMaintenanceStatus;
} | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/index-maintenance`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": input.idempotencyKey
      },
      body: JSON.stringify({ idempotencyKey: input.idempotencyKey })
    }
  );
  const body = (await response.json()) as
    | {
        result: "accepted" | "already_active";
        maintenance: IndexMaintenanceStatus;
      }
    | { error?: { messageKey?: string } };

  if (!response.ok) {
    return readFailure(body, "errors.indexMaintenanceRequestFailed");
  }
  return body as {
    result: "accepted" | "already_active";
    maintenance: IndexMaintenanceStatus;
  };
}

export async function cancelKnowledgeBaseIndexMaintenance(input: {
  knowledgeBaseId: string;
}): Promise<{ result: "cancelled" | "not_active" } | ApiFailure> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/index-maintenance/cancel`,
    { method: "POST" }
  );
  const body = (await response.json()) as
    | { result: "cancelled" | "not_active" }
    | { error?: { messageKey?: string } };
  if (!response.ok) {
    return readFailure(body, "errors.indexMaintenanceCancelFailed");
  }
  return body as { result: "cancelled" | "not_active" };
}

export async function fetchKnowledgeBasePublicUrls(input: {
  knowledgeBaseId: string;
}): Promise<KnowledgeBasePublicUrls | null> {
  const response = await adminFetch(
    `/admin/api/knowledge-bases/${encodeURIComponent(input.knowledgeBaseId)}/public-urls`
  );

  if (!response.ok) throw await adminReadError(response, "errors.serviceUnavailable");

  const body = (await response.json()) as { publicUrls: KnowledgeBasePublicUrls | null };
  return body.publicUrls;
}

function readFailure(
  body: unknown,
  fallbackMessageKey: string
): ApiFailure {
  const candidate =
    body && typeof body === "object"
      ? (body as { error?: { messageKey?: string; issues?: unknown } })
      : {};
  const issues = Array.isArray(candidate.error?.issues)
    ? candidate.error.issues.flatMap((issue) => {
      if (!issue || typeof issue !== "object") return [];
      const field = (issue as { field?: unknown }).field;
      return typeof field === "string" && field.length > 0 ? [{ field }] : [];
    })
    : [];
  return {
    messageKey: candidate.error?.messageKey ?? fallbackMessageKey,
    ...(issues.length > 0 ? { issues } : {})
  };
}

async function adminReadError(response: Response, fallbackMessageKey: string): Promise<Error> {
  const body = await response.json().catch(() => null);
  return new Error(readFailure(body, fallbackMessageKey).messageKey);
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
