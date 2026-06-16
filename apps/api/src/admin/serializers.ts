import type {
  BundleFileRecord,
  BundleTreeEntryRecord,
  ReleaseRecord,
  SourceFileRecord,
  UploadTaskEventRecord,
  UploadTaskRecord
} from "../db/admin-repositories.js";

export function toAdminBundleTreeEntry(entry: BundleTreeEntryRecord) {
  return {
    id: entry.id,
    parentPath: entry.parentPath,
    name: entry.name,
    logicalPath: entry.logicalPath,
    entryType: entry.entryType,
    bundleFileId: entry.bundleFileId,
    sourceFileId: entry.sourceFileId,
    fileKind: entry.fileKind,
    deletable: entry.fileKind === "page" && Boolean(entry.sourceFileId)
  };
}

export function toAdminBundleFile(file: BundleFileRecord) {
  return {
    id: file.id,
    sourceFileId: file.sourceFileId,
    fileKind: file.fileKind,
    logicalPath: file.logicalPath,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    okfType: file.okfType,
    title: file.title,
    description: file.description,
    tags: file.tags,
    frontmatter: file.frontmatter,
    deletable: file.fileKind === "page" && Boolean(file.sourceFileId)
  };
}

export function toAdminSourceFile(file: SourceFileRecord) {
  return {
    id: file.id,
    taskId: file.taskId,
    originalName: file.originalName,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    metadata: file.metadata,
    processingStatus: file.processingStatus ?? "completed",
    processingStage: file.processingStage ?? "release_activation",
    processingStartedAt: file.processingStartedAt ?? file.createdAt,
    processingEndedAt: file.processingEndedAt ?? file.createdAt,
    processingErrorCode: file.processingErrorCode ?? null,
    createdAt: file.createdAt
  };
}

export function toAdminRelease(release: ReleaseRecord) {
  return {
    id: release.id,
    taskId: release.taskId,
    generatedAt: release.generatedAt,
    publishedAt: release.publishedAt,
    fileCount: release.fileCount,
    manifestChecksumSha256: release.manifestChecksumSha256,
    createdAt: release.createdAt
  };
}

export function toUploadTaskLifecycle(task: UploadTaskRecord) {
  return {
    id: task.id,
    knowledgeBaseId: task.knowledgeBaseId,
    operation: task.operation,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    lifecycle: task.endedAt ? "ended" : "running",
    sourceCount: task.sourceCount,
    progress: task.progress ?? {
      total: task.sourceCount,
      completed: task.endedAt ? task.sourceCount : 0,
      failed: task.internalErrorCode ? task.sourceCount : 0,
      running: task.endedAt ? 0 : Math.min(task.sourceCount, 1),
      pending: task.endedAt ? 0 : Math.max(task.sourceCount - 1, 0)
    },
    resultReleaseId: task.resultReleaseId
  };
}

export function toAdminUploadTaskEvent(event: UploadTaskEventRecord) {
  return {
    id: event.id,
    taskId: event.taskId,
    phaseKey: event.phaseKey,
    messageKey: event.messageKey,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    severity: event.severity,
    createdAt: event.createdAt
  };
}
