import type {
  BundleFileRecord,
  BundleTreeEntryRecord,
  BundleTreeSearchResultRecord,
  FileGraphSummaryRecord,
  GeneratedSourceFileOutputRecord,
  ReleaseRecord,
  SourceFileEventRecord,
  SourceFileRecord
} from "../db/admin-repositories.js";

export function toAdminBundleTreeEntry(entry: BundleTreeEntryRecord) {
  return {
    id: entry.id,
    parentPath: entry.parentPath,
    name: entry.name,
    logicalPath: entry.logicalPath,
    sortKey: entry.sortKey,
    entryType: entry.entryType,
    bundleFileId: entry.bundleFileId,
    sourceFileId: entry.sourceFileId,
    fileKind: entry.fileKind,
    childCount: entry.childCount,
    deletable: entry.fileKind === "page" && Boolean(entry.sourceFileId)
  };
}

export function toAdminBundleTreeSearchResult(result: BundleTreeSearchResultRecord) {
  return {
    entry: toAdminBundleTreeEntry(result.entry),
    ancestors: result.ancestors.map(toAdminBundleTreeEntry)
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

export function toAdminSourceFile(
  file: SourceFileRecord,
  graphSummary?: FileGraphSummaryRecord | null,
  generatedOutput?: GeneratedSourceFileOutputRecord | null
) {
  const hasGeneratedOutputLookup = generatedOutput !== undefined;
  const generatedFilePath = hasGeneratedOutputLookup
    ? generatedOutput?.logicalPath ?? null
    : file.generatedBundleFilePath ?? null;
  const generatedFileId = hasGeneratedOutputLookup
    ? generatedOutput?.bundleFileId ?? null
    : file.generatedBundleFileId ?? null;
  const generatedOutputStatus = resolveGeneratedOutputStatus(
    file.generatedOutputStatus,
    generatedOutput,
    hasGeneratedOutputLookup,
    Boolean(generatedFilePath)
  );

  return {
    id: file.id,
    originalName: file.originalName,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    metadata: file.metadata,
    modelSuggestions: file.modelSuggestions ?? null,
    processingStatus: file.processingStatus ?? "completed",
    processingStage: file.processingStage ?? "release_activation",
    processingStartedAt: file.processingStartedAt ?? file.createdAt,
    processingEndedAt: file.processingEndedAt ?? file.createdAt,
    processingErrorCode: file.processingErrorCode ?? null,
    processingErrorMessage: file.processingErrorMessage ?? null,
    retryCount: file.retryCount ?? 0,
    modelInvocationStatus: file.modelInvocationStatus ?? null,
    modelInvocationModelName: file.modelInvocationModelName ?? null,
    modelInvocationStartedAt: file.modelInvocationStartedAt ?? null,
    modelInvocationEndedAt: file.modelInvocationEndedAt ?? null,
    modelInvocationWarningCount: file.modelInvocationWarningCount ?? null,
    modelInvocationErrorCode: file.modelInvocationErrorCode ?? null,
    generatedOutputStatus,
    generatedFileAvailable: generatedOutputStatus === "visible" && Boolean(generatedFilePath),
    generatedFilePath,
    generatedFileId,
    graphSummary: graphSummary ? toAdminGraphSummary(graphSummary) : null,
    createdAt: file.createdAt
  };
}

function resolveGeneratedOutputStatus(
  storedStatus: SourceFileRecord["generatedOutputStatus"],
  generatedOutput: GeneratedSourceFileOutputRecord | null | undefined,
  hasGeneratedOutputLookup: boolean,
  hasStoredPath: boolean
) {
  if (!hasGeneratedOutputLookup) {
    return storedStatus ?? (hasStoredPath ? "visible" : "pending");
  }

  if (generatedOutput) {
    return "visible";
  }

  return storedStatus === "visible" ? "unavailable" : storedStatus ?? "pending";
}

export function toAdminGraphSummary(summary: FileGraphSummaryRecord) {
  return {
    sourceFileId: summary.sourceFileId,
    relationshipCount: summary.relationshipCount,
    relationships: summary.relationships.map((relationship) => ({
      fileId: relationship.fileId,
      sourceFileId: relationship.sourceFileId,
      bundleFileId: relationship.bundleFileId,
      path: relationship.path,
      title: relationship.title,
      relationType: relationship.relationType,
      direction: relationship.direction,
      weight: relationship.weight,
      reason: relationship.reason,
      source: relationship.source,
      contentAvailable: relationship.contentAvailable
    }))
  };
}

export function toAdminRelease(release: ReleaseRecord) {
  return {
    id: release.id,
    generatedAt: release.generatedAt,
    publishedAt: release.publishedAt,
    fileCount: release.fileCount,
    manifestChecksumSha256: release.manifestChecksumSha256,
    createdAt: release.createdAt
  };
}

export function toAdminSourceFileEvent(event: SourceFileEventRecord) {
  return {
    id: event.id,
    sourceFileId: event.sourceFileId,
    stageKey: event.stageKey,
    messageKey: event.messageKey,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    severity: event.severity,
    createdAt: event.createdAt
  };
}
