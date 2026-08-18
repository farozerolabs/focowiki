import type {
  DocumentGeneratedContentAvailability,
  DocumentModelTrace,
  DocumentSafeFailure,
  DocumentState
} from "./contracts.js";
import type { DocumentWorkKind } from "./document-work-graph.js";

export type DocumentWorkPresentation = {
  kind: DocumentWorkKind;
  state: "waiting" | "running" | "completed" | "error" | "cancelled";
  startedAt: string | null;
  endedAt: string | null;
};

export type DocumentGraphPresentationInput = {
  required: boolean;
  completedChunks: number;
  totalChunks: number;
};

export type DocumentProcessingPresentationInput = {
  state: DocumentState;
  work: readonly DocumentWorkPresentation[];
  model: DocumentModelTrace | null;
  graph: DocumentGraphPresentationInput;
  generatedOutput: DocumentGeneratedContentAvailability;
  failure: DocumentSafeFailure | null;
};

export type DocumentProcessingAction =
  | "open_generated_file"
  | "view_failure_details"
  | "retry_document_processing";

export function presentDocumentProcessing(input: DocumentProcessingPresentationInput) {
  const activeWork = input.work
    .filter((work) => work.state === "running")
    .map((work) => work.kind);
  const graphStatus = !input.graph.required
    ? "not_required"
    : input.graph.totalChunks > 0
      && input.graph.completedChunks >= input.graph.totalChunks
      ? "completed"
      : "running";
  const actions: DocumentProcessingAction[] = [];
  if (
    input.generatedOutput === "current_available"
    || input.generatedOutput === "previous_available"
  ) actions.push("open_generated_file");
  if (input.state === "error") {
    actions.push("view_failure_details");
    if (input.failure?.retryable) actions.push("retry_document_processing");
  }
  return {
    state: input.state,
    activeWork,
    model: input.model,
    graph: {
      status: graphStatus,
      completedChunks: input.graph.completedChunks,
      totalChunks: input.graph.totalChunks
    },
    generatedOutput: input.generatedOutput,
    failure: input.failure,
    actions
  };
}
