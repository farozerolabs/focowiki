import type { ModelSuggestionResult } from "@focowiki/okf";
import type { AdminRepositories } from "../db/admin-repositories.js";

export type ModelInvocationTracker = {
  start: (sourceFileId: string, startedAt: string) => Promise<void>;
  complete: (
    sourceFileId: string,
    endedAt: string,
    result: ModelSuggestionResult
  ) => Promise<void>;
  skip: (sourceFileId: string, startedAt: string, endedAt: string) => Promise<void>;
};

export function createModelInvocationTracker(input: {
  repositories: AdminRepositories;
  knowledgeBaseId: string;
  modelName: string | null;
  modelConfigId?: string | null;
}): ModelInvocationTracker {
  const invocations = input.repositories.modelInvocations;
  const invocationIdsBySourceId = new Map<string, string>();

  return {
    async start(sourceFileId, startedAt) {
      const invocation = await invocations?.createModelInvocation({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId,
        modelConfigId: input.modelConfigId ?? null,
        modelName: input.modelName ?? "disabled",
        status: "running",
        startedAt,
        endedAt: null,
        warningCount: 0,
        errorCode: null,
        errorMessage: null
      });

      if (invocation) {
        invocationIdsBySourceId.set(sourceFileId, invocation.id);
      }
    },
    async complete(sourceFileId, endedAt, result) {
      const invocationId = invocationIdsBySourceId.get(sourceFileId);

      if (!invocationId) {
        return;
      }

      await invocations?.completeModelInvocation({
        id: invocationId,
        status: result.suggestions ? "completed" : "failed",
        endedAt,
        warningCount: result.warnings.length,
        errorCode:
          !result.suggestions && result.warnings.length > 0
            ? "MODEL_SUGGESTION_FAILED"
            : null,
        errorMessage: summarizeModelWarnings(result.warnings)
      });
    },
    async skip(sourceFileId, startedAt, endedAt) {
      await invocations?.createModelInvocation({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId,
        modelName: "disabled",
        status: "skipped",
        startedAt,
        endedAt,
        warningCount: 0,
        errorCode: null,
        errorMessage: null
      });
    }
  };
}

function summarizeModelWarnings(warnings: string[]): string | null {
  const summary = warnings.join(" | ").trim();
  return summary ? summary.slice(0, 500) : null;
}
