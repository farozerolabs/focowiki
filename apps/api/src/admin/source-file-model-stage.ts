import type { SourceModelSuggestions } from "@focowiki/okf";
import type { AdminRepositories, SourceFileRecord } from "../db/admin-repositories.js";
import { createModelInvocationTracker } from "./model-invocation-tracker.js";
import { readModelSuggestions, type ModelAssistanceOptions } from "./model-suggestions.js";

type UpdateSourceFileModelSuggestions = NonNullable<
  NonNullable<AdminRepositories["files"]>["updateSourceFileModelSuggestions"]
>;

export async function processSourceFileModelStage(input: {
  repositories: AdminRepositories;
  knowledgeBaseId: string;
  source: SourceFileRecord;
  modelSource: {
    id: string;
    fileName: string;
    title: string;
    type: string;
    tags: string[];
    body: string;
  };
  modelAssistance: ModelAssistanceOptions | null;
  progressClock: () => string;
  updateSourceFileModelSuggestions: UpdateSourceFileModelSuggestions;
}): Promise<{
  suggestions: SourceModelSuggestions | null;
  severity: "info" | "warning";
  endedAt: string;
}> {
  const tracker = createModelInvocationTracker({
    repositories: input.repositories,
    knowledgeBaseId: input.knowledgeBaseId,
    modelName: input.modelAssistance?.modelName ?? null
  });

  if (!input.modelAssistance) {
    const startedAt = input.progressClock();
    const endedAt = input.progressClock();
    await tracker.skip(input.source.id, startedAt, endedAt);
    await input.updateSourceFileModelSuggestions({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFileId: input.source.id,
      suggestions: null
    });

    return {
      suggestions: null,
      severity: "info",
      endedAt
    };
  }

  const result = await readModelSuggestions({
    sources: [input.modelSource],
    modelAssistance: input.modelAssistance,
    onSourceStart: async () => tracker.start(input.source.id, input.progressClock()),
    onSourceComplete: async (_source, modelResult) =>
      tracker.complete(input.source.id, input.progressClock(), modelResult)
  }).catch(async (error: unknown) => {
    await tracker.complete(input.source.id, input.progressClock(), {
      suggestions: null,
      warnings: [error instanceof Error ? error.message : "Model suggestion failed"]
    });
    throw error;
  });
  const suggestions = result.suggestionsBySourceId.get(input.source.id) ?? null;
  const endedAt = input.progressClock();

  await input.updateSourceFileModelSuggestions({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.source.id,
    suggestions
  });

  if (!suggestions && result.warnings.length > 0) {
    throw new Error(summarizeModelSuggestionWarnings(result.warnings));
  }

  return {
    suggestions,
    severity: result.warnings.length > 0 ? "warning" : "info",
    endedAt
  };
}

function summarizeModelSuggestionWarnings(warnings: string[]): string {
  const summary = warnings.join(" | ").trim();
  return summary ? summary.slice(0, 500) : "Model suggestions failed";
}
