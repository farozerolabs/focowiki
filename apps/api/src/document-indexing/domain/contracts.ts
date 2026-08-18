export const DOCUMENT_STATES = [
  "waiting",
  "processing",
  "available",
  "error",
  "deleting",
  "cancelled",
  "superseded"
] as const;

export type DocumentState = (typeof DOCUMENT_STATES)[number];

export const DOCUMENT_MODEL_STATUSES = [
  "not_required",
  "running",
  "completed",
  "failed"
] as const;

export type DocumentModelStatus = (typeof DOCUMENT_MODEL_STATUSES)[number];

export const DOCUMENT_GENERATED_CONTENT_AVAILABILITIES = [
  "unavailable",
  "previous_available",
  "current_available"
] as const;

export type DocumentGeneratedContentAvailability =
  (typeof DOCUMENT_GENERATED_CONTENT_AVAILABILITIES)[number];

export const DOCUMENT_SAFE_ERROR_CODE_MAX_BYTES = 128;
export const DOCUMENT_SAFE_ERROR_MESSAGE_MAX_BYTES = 2_048;

export type DocumentModelTrace =
  | {
      status: "not_required";
      modelName: null;
      startedAt: null;
      endedAt: string;
      warningCount: 0;
      errorCode: null;
    }
  | {
      status: "running";
      modelName: string;
      startedAt: string;
      endedAt: null;
      warningCount: number;
      errorCode: null;
    }
  | {
      status: "completed";
      modelName: string;
      startedAt: string;
      endedAt: string;
      warningCount: number;
      errorCode: null;
    }
  | {
      status: "failed";
      modelName: string;
      startedAt: string;
      endedAt: string;
      warningCount: number;
      errorCode: string;
    };

export type DocumentSafeFailure = {
  code: string;
  message: string | null;
  retryable: boolean;
};

export function isDocumentTerminalState(state: DocumentState): boolean {
  return state === "available"
    || state === "error"
    || state === "cancelled"
    || state === "superseded";
}
