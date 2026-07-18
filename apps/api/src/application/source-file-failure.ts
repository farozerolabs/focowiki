import { MetadataValidationError } from "@focowiki/okf";
import type {
  SourceFileFailureStage,
  SourceFileTerminalFailure
} from "../domain/source-file-lifecycle.js";

const MAX_FAILURE_CODE_LENGTH = 64;
const MAX_FAILURE_MESSAGE_LENGTH = 500;
const MAX_CORRELATION_ID_LENGTH = 128;

export class SourceFileAttemptError extends Error {
  public constructor(
    public readonly failure: SourceFileTerminalFailure,
    public readonly automaticRetryAllowed: boolean,
    options?: { cause?: unknown }
  ) {
    super(failure.message, options);
    this.name = "SourceFileAttemptError";
  }
}

export function createSourceProcessingFailure(input: {
  stage: SourceFileFailureStage;
  error: unknown;
  occurredAt: string;
  correlationId: string;
}): SourceFileTerminalFailure {
  const deterministic = input.error instanceof MetadataValidationError;
  const code = sourceProcessingFailureCode(input.stage, deterministic);
  return createTerminalFailure({
    stage: input.stage,
    code,
    message: sourceProcessingFailureMessage(code),
    occurredAt: input.occurredAt,
    retryKind: deterministic ? "none" : "source_processing",
    correlationId: input.correlationId
  });
}


export function createTerminalFailure(
  input: SourceFileTerminalFailure
): SourceFileTerminalFailure {
  return {
    stage: input.stage,
    code: normalizeFailureCode(input.code),
    message: normalizeFailureText(input.message, MAX_FAILURE_MESSAGE_LENGTH),
    occurredAt: requireIsoTimestamp(input.occurredAt),
    retryKind: input.retryKind,
    correlationId: normalizeFailureText(
      input.correlationId,
      MAX_CORRELATION_ID_LENGTH
    )
  };
}

function sourceProcessingFailureCode(
  stage: SourceFileFailureStage,
  deterministic: boolean
): string {
  if (deterministic) return "METADATA_VALIDATION_FAILED";
  switch (stage) {
    case "upload_storage": return "UPLOAD_STORAGE_FAILED";
    case "metadata_resolution": return "METADATA_RESOLUTION_FAILED";
    case "llm_suggestion": return "MODEL_SUGGESTION_FAILED";
    case "graph_generation": return "GRAPH_GENERATION_FAILED";
    case "projection_generation": return "PROJECTION_GENERATION_FAILED";
    case "generation_validation": return "GENERATION_VALIDATION_FAILED";
    case "generation_activation": return "GENERATION_ACTIVATION_FAILED";
  }
}

function sourceProcessingFailureMessage(code: string): string {
  const messages: Record<string, string> = {
    METADATA_VALIDATION_FAILED: "Source metadata contains an invalid or unsafe generated identity.",
    UPLOAD_STORAGE_FAILED: "The uploaded source could not be read from storage.",
    METADATA_RESOLUTION_FAILED: "Source metadata could not be resolved.",
    MODEL_SUGGESTION_FAILED: "Required model processing did not complete.",
    GRAPH_GENERATION_FAILED: "File relationships could not be generated.",
    PROJECTION_GENERATION_FAILED: "Generated Markdown files and projections could not be prepared.",
    GENERATION_VALIDATION_FAILED: "Generated knowledge files did not pass validation.",
    GENERATION_ACTIVATION_FAILED: "The generated knowledge state could not be activated."
  };
  return messages[code] ?? "Source-file processing did not complete.";
}

function normalizeFailureCode(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_FAILURE_CODE_LENGTH);
  return normalized || "SOURCE_FILE_FAILED";
}

function normalizeFailureText(value: string, limit: number): string {
  const normalized = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\p{White_Space}+/gu, " ")
    .trim();
  if (!normalized) {
    throw new Error("Terminal failure text is required");
  }
  return normalized.slice(0, limit);
}


function requireIsoTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("Terminal failure timestamp is invalid");
  }
  return new Date(parsed).toISOString();
}
