export type SourceFileLifecycleState =
  | "queued"
  | "running"
  | "pending_publication"
  | "visible"
  | "failed";

export type SourceFileFailureStage =
  | "upload_storage"
  | "metadata_resolution"
  | "llm_suggestion"
  | "graph_generation"
  | "projection_generation"
  | "generation_validation"
  | "generation_activation";

export type SourceFileRetryKind = "source_processing" | "publication" | "none";

export type SourceFileTerminalFailure = {
  stage: SourceFileFailureStage;
  code: string;
  message: string;
  occurredAt: string;
  retryKind: SourceFileRetryKind;
  correlationId: string;
};

export type SourceFileLifecycleActionKind =
  | "open_generated_file"
  | "view_failure_details"
  | "retry_source_processing"
  | "retry_publication";

export type SourceFileLifecycleProjection = {
  state: SourceFileLifecycleState;
  currentStage: SourceFileFailureStage;
  failure: SourceFileTerminalFailure | null;
  actions: SourceFileLifecycleActionKind[];
};

export function deriveSourceFileLifecycle(input: {
  processingStatus: "queued" | "running" | "completed" | "failed";
  processingStage: SourceFileFailureStage;
  generatedOutputStatus: "pending" | "visible" | "unavailable";
  generatedPath: string | null;
  failure: SourceFileTerminalFailure | null;
}): SourceFileLifecycleProjection {
  if (input.failure) {
    return {
      state: "failed",
      currentStage: input.failure.stage,
      failure: input.failure,
      actions: failureActions(input.failure.retryKind)
    };
  }
  if (input.processingStatus === "queued") {
    return projection("queued", input.processingStage);
  }
  if (input.processingStatus === "running") {
    return projection("running", input.processingStage);
  }
  if (input.generatedOutputStatus === "visible" && input.generatedPath) {
    return {
      ...projection("visible", "generation_activation"),
      actions: ["open_generated_file"]
    };
  }
  return projection("pending_publication", input.processingStage);
}

function projection(
  state: SourceFileLifecycleState,
  currentStage: SourceFileFailureStage
): SourceFileLifecycleProjection {
  return { state, currentStage, failure: null, actions: [] };
}

function failureActions(retryKind: SourceFileRetryKind): SourceFileLifecycleActionKind[] {
  if (retryKind === "source_processing") {
    return ["view_failure_details", "retry_source_processing"];
  }
  if (retryKind === "publication") {
    return ["view_failure_details", "retry_publication"];
  }
  return ["view_failure_details"];
}
