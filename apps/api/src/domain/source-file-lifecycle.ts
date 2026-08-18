export type SourceFileLifecycleState =
  | "waiting"
  | "processing"
  | "available"
  | "error"
  | "deleting";

export type SourceFileWorkKind =
  | "prepare"
  | "first_layer"
  | "content_projection"
  | "graphrag"
  | "relation_reconcile"
  | "knowledge_projection"
  | "activate"
  | "cleanup";

export type SourceFileRetryKind = "document_processing" | "none";

export type SourceFileTerminalFailure = {
  workKind: SourceFileWorkKind;
  code: string;
  message: string;
  occurredAt: string;
  retryKind: SourceFileRetryKind;
  correlationId: string;
};

export type SourceFileLifecycleActionKind =
  | "open_generated_file"
  | "view_failure_details"
  | "replace_source_content"
  | "retry_document_processing";

export type SourceFileGeneratedOutputStatus =
  | "unavailable"
  | "previous_available"
  | "current_available";

export type SourceFileLifecycleProjection = {
  state: SourceFileLifecycleState;
  blockingWorkKind: SourceFileWorkKind | null;
  failure: SourceFileTerminalFailure | null;
  actions: SourceFileLifecycleActionKind[];
};

export function deriveSourceFileLifecycle(input: {
  processingStatus: SourceFileLifecycleState;
  blockingWorkKind: SourceFileWorkKind | null;
  generatedOutputStatus: SourceFileGeneratedOutputStatus;
  generatedPath: string | null;
  failure: SourceFileTerminalFailure | null;
}): SourceFileLifecycleProjection {
  if (input.processingStatus === "error" && input.failure) {
    const open = input.generatedOutputStatus === "previous_available"
      && input.generatedPath
      ? ["open_generated_file" as const]
      : [];
    return {
      state: "error",
      blockingWorkKind: null,
      failure: input.failure,
      actions: [...open, ...failureActions(input.failure)]
    };
  }
  if (input.processingStatus === "available") {
    return {
      state: "available",
      blockingWorkKind: null,
      failure: null,
      actions: input.generatedOutputStatus === "current_available"
        && input.generatedPath ? ["open_generated_file"] : []
    };
  }
  return {
    state: input.processingStatus,
    blockingWorkKind: input.processingStatus === "processing"
      || input.processingStatus === "waiting"
      ? input.blockingWorkKind
      : null,
    failure: null,
    actions: []
  };
}

function failureActions(
  failure: SourceFileTerminalFailure
): SourceFileLifecycleActionKind[] {
  if (deterministicSourceInputError(failure.code)) {
    return ["view_failure_details", "replace_source_content"];
  }
  if (failure.retryKind === "document_processing") {
    return ["view_failure_details", "retry_document_processing"];
  }
  return ["view_failure_details"];
}

function deterministicSourceInputError(code: string): boolean {
  return code === "semantic_source_body_empty"
    || code === "semantic_source_metadata_invalid"
    || code === "source_body_empty"
    || code === "source_frontmatter_invalid";
}
