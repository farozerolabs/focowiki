import type {
  FileGraphSummaryRecord,
  GeneratedSourceFileOutputRecord,
  SourceFileEventRecord,
  SourceFileRecord
} from "../db/admin-repositories.js";
import {
  deriveSourceFileLifecycle,
  type SourceFileLifecycleActionKind
} from "../domain/source-file-lifecycle.js";

export function toAdminSourceFile(
  file: SourceFileRecord,
  graphSummary?: FileGraphSummaryRecord | null,
  generatedOutput?: GeneratedSourceFileOutputRecord | null
) {
  const hasGeneratedOutputLookup = generatedOutput !== undefined;
  const generatedFilePath = generatedOutput?.logicalPath ?? null;
  const generatedFileId = generatedOutput?.fileId ?? null;
  const generatedOutputStatus = resolveGeneratedOutputStatus(
    file.generatedOutputStatus,
    generatedOutput,
    hasGeneratedOutputLookup,
    Boolean(generatedFilePath)
  );
  const lifecycle = deriveSourceFileLifecycle({
    processingStatus: file.processingStatus ?? "completed",
    processingStage: file.processingStage ?? "generation_activation",
    generatedOutputStatus,
    generatedPath: generatedFilePath,
    failure: file.terminalFailure ?? null
  });

  return {
    id: file.id,
    name: file.name,
    relativePath: file.relativePath,
    resourceRevision: file.resourceRevision ?? 1,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    checksumSha256: file.checksumSha256,
    metadata: file.metadata,
    modelSuggestions: file.modelSuggestions ?? null,
    processingStartedAt: file.processingStartedAt ?? null,
    processingEndedAt: file.processingEndedAt ?? null,
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
    state: lifecycle.state,
    currentStage: lifecycle.currentStage,
    failure: lifecycle.failure,
    actions: lifecycle.actions.map((kind) =>
      adminLifecycleAction(file, kind, generatedFilePath)
    ),
    createdAt: file.createdAt
  };
}

function adminLifecycleAction(
  file: SourceFileRecord,
  kind: SourceFileLifecycleActionKind,
  generatedFilePath: string | null
) {
  const sourceBase = `/admin/api/knowledge-bases/${encodeURIComponent(file.knowledgeBaseId)}`
    + `/source-files/${encodeURIComponent(file.id)}`;
  switch (kind) {
    case "open_generated_file":
      return {
        kind,
        method: "GET" as const,
        href: generatedFilePath
          ? `/admin/api/knowledge-bases/${encodeURIComponent(file.knowledgeBaseId)}`
            + `/files/content?path=${encodeURIComponent(generatedFilePath)}`
          : null,
        scope: "source_file" as const
      };
    case "retry_publication":
      return {
        kind,
        method: "POST" as const,
        href: `${sourceBase}/retry`,
        scope: "knowledge_base_publication" as const
      };
    case "retry_source_processing":
      return {
        kind,
        method: "POST" as const,
        href: `${sourceBase}/retry`,
        scope: "source_file" as const
      };
    case "view_failure_details":
      return {
        kind,
        method: null,
        href: null,
        scope: "source_file" as const
      };
  }
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
      generatedFileId: relationship.generatedFileId,
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
