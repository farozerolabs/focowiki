import type { DocumentModelTrace } from "../domain/contracts.js";

export type DocumentSemanticSelection = {
  selected: boolean;
  decisionSha256: string;
  reasons: readonly string[];
};

export type DocumentSemanticArtifactReference = {
  kind: string;
  publicId: string;
};

type SemanticRequest = {
  documentJobPublicId: string;
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  body: string;
  contentProfile: Readonly<Record<string, unknown>>;
  modelName: string | null;
  signal: AbortSignal;
};

export function createDocumentSemanticEnrichment(input: {
  select(request: SemanticRequest): Promise<DocumentSemanticSelection>;
  enrich(request: SemanticRequest & {
    selection: DocumentSemanticSelection;
    modelName: string;
  }): Promise<{
    artifacts: readonly DocumentSemanticArtifactReference[];
    warnings: readonly string[];
  }>;
  traces: {
    record(input: {
      documentJobPublicId: string;
      trace: DocumentModelTrace;
    }): Promise<void>;
  };
  clock?: () => string;
}) {
  const clock = input.clock ?? (() => new Date().toISOString());
  return async (request: SemanticRequest) => {
    throwIfAborted(request.signal);
    const selection = await input.select(request);
    validateSelection(selection);
    throwIfAborted(request.signal);
    if (request.modelName === null) {
      const modelTrace = {
        status: "not_required",
        modelName: null,
        startedAt: null,
        endedAt: timestamp(clock()),
        warningCount: 0,
        errorCode: null
      } satisfies DocumentModelTrace;
      await input.traces.record({
        documentJobPublicId: request.documentJobPublicId,
        trace: modelTrace
      });
      return { selection, modelTrace, warnings: [], artifacts: [] };
    }
    const modelName = boundedIdentity(request.modelName, "model_configuration_missing");
    const startedAt = timestamp(clock());
    const running = {
      status: "running",
      modelName,
      startedAt,
      endedAt: null,
      warningCount: 0,
      errorCode: null
    } satisfies DocumentModelTrace;
    await input.traces.record({
      documentJobPublicId: request.documentJobPublicId,
      trace: running
    });
    try {
      const result = await input.enrich({ ...request, selection, modelName });
      throwIfAborted(request.signal);
      const warnings = validateWarnings(result.warnings);
      const artifacts = validateArtifacts(result.artifacts);
      const completed = {
        status: "completed",
        modelName,
        startedAt,
        endedAt: timestamp(clock()),
        warningCount: warnings.length,
        errorCode: null
      } satisfies DocumentModelTrace;
      await input.traces.record({
        documentJobPublicId: request.documentJobPublicId,
        trace: completed
      });
      return { selection, modelTrace: completed, warnings, artifacts };
    } catch (error) {
      const failed = {
        status: "failed",
        modelName,
        startedAt,
        endedAt: timestamp(clock()),
        warningCount: 0,
        errorCode: safeErrorCode(error)
      } satisfies DocumentModelTrace;
      await input.traces.record({
        documentJobPublicId: request.documentJobPublicId,
        trace: failed
      });
      throw error;
    }
  };
}

function validateSelection(selection: DocumentSemanticSelection): void {
  if (typeof selection.selected !== "boolean"
    || !/^[0-9a-f]{64}$/u.test(selection.decisionSha256)
    || !Array.isArray(selection.reasons) || selection.reasons.length > 16
    || selection.reasons.some((reason) => !reason || reason.length > 128)) {
    throw semanticError("selection_invalid");
  }
}

function validateWarnings(warnings: readonly string[]): string[] {
  if (!Array.isArray(warnings) || warnings.length > 1_000
    || warnings.some((warning) => !warning || warning.length > 256)) {
    throw semanticError("warnings_invalid");
  }
  return [...warnings];
}

function validateArtifacts(
  artifacts: readonly DocumentSemanticArtifactReference[]
): DocumentSemanticArtifactReference[] {
  if (!Array.isArray(artifacts) || artifacts.length > 1_000
    || artifacts.some((artifact) => !artifact.kind || artifact.kind.length > 128
      || !artifact.publicId || artifact.publicId.length > 255)) {
    throw semanticError("artifacts_invalid");
  }
  return artifacts.map((artifact) => ({ ...artifact }));
}

function safeErrorCode(error: unknown): string {
  const value = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return typeof value === "string" && /^[A-Z0-9_]{1,128}$/u.test(value)
    ? value
    : "SEMANTIC_ENRICHMENT_FAILED";
}

function boundedIdentity(value: string | null, code: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > 255) throw semanticError(code);
  return value;
}

function timestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw semanticError("clock_invalid");
  return new Date(value).toISOString();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? semanticError("cancelled");
}

function semanticError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document semantic enrichment error: ${code}`), { code });
}
