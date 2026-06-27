import type {
  BundleFileRecord,
  BundleFileSearchResultRecord,
  BundleTreeEntryRecord,
  FileGraphRelatedRecord,
  GeneratedSourceFileOutputRecord,
  KnowledgeBaseRecord,
  SourceFileEventRecord,
  SourceFileRecord,
  WebhookDeliveryRecord,
  WebhookSubscriptionRecord
} from "../db/admin-repositories.js";

export function toDeveloperKnowledgeBase(record: KnowledgeBaseRecord) {
  return {
    knowledgeBaseId: record.id,
    name: record.name,
    description: record.description,
    activeReleaseId: record.activeReleaseId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export function toDeveloperSourceFile(
  record: SourceFileRecord,
  generatedOutput?: GeneratedSourceFileOutputRecord | null
) {
  const generatedFilePath = record.generatedBundleFilePath ?? generatedOutput?.logicalPath ?? null;
  const generatedFileId = record.generatedBundleFileId ?? generatedOutput?.bundleFileId ?? null;
  const generatedOutputStatus =
    record.generatedOutputStatus ?? (generatedFilePath ? "visible" : "pending");

  return {
    fileId: record.id,
    sourceFileId: record.id,
    knowledgeBaseId: record.knowledgeBaseId,
    originalFilename: record.originalName,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    checksumSha256: record.checksumSha256,
    metadata: record.metadata,
    modelSuggestions: record.modelSuggestions ?? null,
    processingState: record.processingStatus ?? "completed",
    currentStage: record.processingStage ?? "release_activation",
    processingStartedAt: record.processingStartedAt ?? record.createdAt,
    processingEndedAt: record.processingEndedAt ?? record.createdAt,
    processingErrorCode: record.processingErrorCode ?? null,
    processingErrorMessage: record.processingErrorMessage ?? null,
    retryCount: record.retryCount ?? 0,
    modelInvocationStatus: record.modelInvocationStatus ?? null,
    modelInvocationModelName: record.modelInvocationModelName ?? null,
    modelInvocationStartedAt: record.modelInvocationStartedAt ?? null,
    modelInvocationEndedAt: record.modelInvocationEndedAt ?? null,
    modelInvocationWarningCount: record.modelInvocationWarningCount ?? null,
    modelInvocationErrorCode: record.modelInvocationErrorCode ?? null,
    generatedOutputStatus,
    generatedFileAvailable: generatedOutputStatus === "visible" && Boolean(generatedFilePath),
    generatedFileId,
    generatedFilePath,
    createdAt: record.createdAt
  };
}

export function toDeveloperSourceFileEvent(record: SourceFileEventRecord) {
  return {
    eventId: record.id,
    knowledgeBaseId: record.knowledgeBaseId,
    fileId: record.sourceFileId,
    sourceFileId: record.sourceFileId,
    stageKey: record.stageKey,
    messageKey: record.messageKey,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    severity: record.severity,
    createdAt: record.createdAt
  };
}

export function toDeveloperBundleTreeEntry(record: BundleTreeEntryRecord) {
  return {
    id: record.id,
    fileId: record.bundleFileId,
    sourceFileId: record.sourceFileId,
    parentPath: record.parentPath,
    name: record.name,
    path: record.logicalPath,
    sortKey: record.sortKey,
    entryType: record.entryType,
    fileKind: record.fileKind,
    childCount: record.childCount,
    deletable: record.fileKind === "page" && Boolean(record.sourceFileId)
  };
}

export function toDeveloperBundleFile(record: BundleFileRecord, source?: SourceFileRecord | null) {
  return {
    fileId: record.id,
    knowledgeBaseId: record.knowledgeBaseId,
    sourceFileId: record.sourceFileId,
    path: record.logicalPath,
    originalFilename: source?.originalName ?? null,
    fileKind: record.fileKind,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    checksumSha256: record.checksumSha256,
    okfType: record.okfType,
    title: record.title,
    description: record.description,
    tags: record.tags,
    frontmatter: record.frontmatter,
    deletable: record.fileKind === "page" && Boolean(record.sourceFileId),
    contentAvailable: true
  };
}

export function toDeveloperFileSearchResult(record: BundleFileSearchResultRecord) {
  return {
    fileId: record.fileId,
    generatedFileId: record.fileId,
    knowledgeBaseId: record.knowledgeBaseId,
    releaseId: record.releaseId,
    sourceFileId: record.sourceFileId,
    path: record.path,
    generatedFilePath: record.path,
    fileKind: record.fileKind,
    title: record.title,
    description: record.description,
    tags: record.tags,
    frontmatter: record.frontmatter,
    matchedFields: record.matchedFields,
    score: record.score,
    contentAvailable: record.contentAvailable
  };
}

export function toDeveloperRelatedFile(record: FileGraphRelatedRecord) {
  return {
    fileId: record.fileId,
    sourceFileId: record.sourceFileId,
    bundleFileId: record.bundleFileId,
    path: record.path,
    title: record.title,
    relationType: record.relationType,
    direction: record.direction,
    weight: record.weight,
    reason: record.reason,
    source: record.source,
    evidence: record.evidence ?? {},
    contentAvailable: record.contentAvailable
  };
}

export function toDeveloperSourceFileDetail(
  record: SourceFileRecord,
  generatedOutput?: GeneratedSourceFileOutputRecord | null
) {
  return {
    fileId: record.id,
    sourceFileId: record.id,
    knowledgeBaseId: record.knowledgeBaseId,
    path: generatedOutput?.logicalPath ?? null,
    originalFilename: record.originalName,
    fileKind: "source",
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    checksumSha256: record.checksumSha256,
    processingState: record.processingStatus ?? "completed",
    currentStage: record.processingStage ?? "release_activation",
    generatedOutputStatus:
      record.generatedOutputStatus ?? (generatedOutput ? "visible" : "pending"),
    contentAvailable: Boolean(generatedOutput),
    generatedFileAvailable: Boolean(generatedOutput),
    generatedFileId: generatedOutput?.bundleFileId ?? null,
    generatedFilePath: generatedOutput?.logicalPath ?? null
  };
}

export function toDeveloperWebhook(record: WebhookSubscriptionRecord) {
  return {
    webhookId: record.id,
    name: record.name,
    endpointHost: safeUrlHost(record.url),
    events: record.events,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastDeliveryAt: record.lastDeliveryAt
  };
}

export function toDeveloperWebhookDelivery(record: WebhookDeliveryRecord) {
  return {
    deliveryId: record.id,
    webhookId: record.webhookId,
    eventId: record.eventId,
    eventType: record.eventType,
    status: record.status,
    attemptCount: record.attemptCount,
    httpStatus: record.httpStatus,
    errorCode: record.errorCode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function safeUrlHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}
