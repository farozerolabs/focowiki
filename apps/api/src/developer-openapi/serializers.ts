import type {
  BundleFileRecord,
  BundleTreeEntryRecord,
  FileGraphRelatedRecord,
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

export function toDeveloperSourceFile(record: SourceFileRecord) {
  return {
    fileId: record.id,
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
    createdAt: record.createdAt
  };
}

export function toDeveloperSourceFileEvent(record: SourceFileEventRecord) {
  return {
    eventId: record.id,
    knowledgeBaseId: record.knowledgeBaseId,
    fileId: record.sourceFileId,
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
    entryType: record.entryType,
    fileKind: record.fileKind,
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

export function toDeveloperSourceFileDetail(record: SourceFileRecord) {
  return {
    fileId: record.id,
    knowledgeBaseId: record.knowledgeBaseId,
    path: null,
    originalFilename: record.originalName,
    fileKind: "source",
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    checksumSha256: record.checksumSha256,
    processingState: record.processingStatus ?? "completed",
    currentStage: record.processingStage ?? "release_activation",
    contentAvailable: false
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
