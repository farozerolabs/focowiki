import type {
  BundleFileRecord,
  BundleFileSearchResultRecord,
  BundleGraphSearchResultRecord,
  BundleTreeEntryRecord,
  BundleTreeSearchResultRecord,
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
    resourceRevision: record.resourceRevision ?? 1,
    catalogGeneration: record.catalogGeneration ?? 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

export function toDeveloperSourceFileEvent(record: SourceFileEventRecord) {
  return {
    eventId: record.id,
    knowledgeBaseId: record.knowledgeBaseId,
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
  const isReadableFile = record.entryType === "file" && Boolean(record.bundleFileId);

  return {
    id: record.id,
    fileId: record.bundleFileId,
    sourceFileId: record.sourceFileId,
    directoryId: record.sourceDirectoryId ?? null,
    parentPath: record.parentPath,
    name: record.name,
    path: record.logicalPath,
    sortKey: record.sortKey,
    entryType: record.entryType,
    fileKind: record.fileKind,
    childCount: record.childCount,
    directFileCount: record.directFileCount ?? 0,
    descendantFileCount: record.descendantFileCount ?? 0,
    resourceRevision: record.resourceRevision ?? null,
    deletable:
      (record.fileKind === "page" && Boolean(record.sourceFileId)) ||
      (record.entryType === "directory" && Boolean(record.sourceDirectoryId)),
    contentAvailable: isReadableFile,
    readActions: isReadableFile
      ? createDeveloperFileReadActions({
          knowledgeBaseId: record.knowledgeBaseId,
          generatedFileId: record.bundleFileId,
          generatedFilePath: record.logicalPath,
          sourceFileId: record.sourceFileId
        })
      : null
  };
}

export function toDeveloperBundleTreeSearchEntry(record: BundleTreeSearchResultRecord) {
  return {
    ...toDeveloperBundleTreeEntry(record.entry),
    ancestors: record.ancestors.map(toDeveloperBundleTreeEntry)
  };
}

export function toDeveloperBundleFile(record: BundleFileRecord, source?: SourceFileRecord | null) {
  return {
    fileId: record.id,
    knowledgeBaseId: record.knowledgeBaseId,
    sourceFileId: record.sourceFileId,
    path: record.logicalPath,
    sourceName: source?.name ?? null,
    sourceRelativePath: source?.relativePath ?? null,
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

export function toDeveloperFileSearchResult(
  record: BundleFileSearchResultRecord | BundleGraphSearchResultRecord
) {
  const graphContext = "graphContext" in record
    ? {
        ...record.graphContext,
        relationships: record.graphContext.relationships.map((relationship) =>
          toDeveloperRelatedFile(relationship, record.knowledgeBaseId)
        )
      }
    : null;

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
    contentAvailable: record.contentAvailable,
    readActions: createDeveloperFileReadActions({
      knowledgeBaseId: record.knowledgeBaseId,
      generatedFileId: record.fileId,
      generatedFilePath: record.path,
      sourceFileId: record.sourceFileId
    }),
    ...("matchType" in record ? { matchType: record.matchType } : {}),
    ...(graphContext ? { graphContext } : {})
  };
}

function createDeveloperFileReadActions(input: {
  knowledgeBaseId: string;
  generatedFileId: string | null;
  generatedFilePath: string;
  sourceFileId: string | null;
}) {
  const base = `/openapi/v2/knowledge-bases/${input.knowledgeBaseId}`;
  const encodedPath = encodeURIComponent(input.generatedFilePath);

  return {
    fileDetailById: input.generatedFileId ? `${base}/files/${input.generatedFileId}` : null,
    fileContentById: input.generatedFileId ? `${base}/files/${input.generatedFileId}/content` : null,
    fileContentByPath: `${base}/files/content?path=${encodedPath}`,
    relatedFilesById: input.generatedFileId ? `${base}/files/${input.generatedFileId}/related` : null,
    graphExpansionByFileId: input.generatedFileId ? `${base}/graph/expand?fileId=${input.generatedFileId}` : null,
    sourceFileStatusById: input.sourceFileId ? `${base}/source-files/${input.sourceFileId}` : null,
    sourceFileEventsById: input.sourceFileId ? `${base}/source-files/${input.sourceFileId}/events` : null
  };
}

export function toDeveloperRelatedFile(record: FileGraphRelatedRecord, knowledgeBaseId: string) {
  if (!record.bundleFileId) {
    throw new Error("Related file is missing its published bundle identity");
  }

  return {
    fileId: record.bundleFileId,
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
    contentAvailable: record.contentAvailable,
    readActions: createDeveloperFileReadActions({
      knowledgeBaseId,
      generatedFileId: record.bundleFileId,
      generatedFilePath: record.path,
      sourceFileId: record.sourceFileId
    })
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
