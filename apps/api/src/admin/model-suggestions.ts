import {
  requestModelSuggestions,
  type ModelSuggestionResult,
  type ModelReceiveTimeouts,
  type ModelSuggestions,
  type OpenAIResponsesClient
} from "@focowiki/okf";
import { mapWithConcurrency } from "../runtime/bounded.js";
import type { BoundedTaskRunner } from "../runtime/task-runner.js";
import { selectModelCandidatePaths } from "./model-candidates.js";

export type ModelAssistanceOptions = {
  client: OpenAIResponsesClient;
  modelName: string;
  contextWindowTokens: number;
  receiveTimeouts: ModelReceiveTimeouts;
  suggestionConcurrency: number;
  transientRetryDelayMs: number;
  requestRunner?: BoundedTaskRunner | undefined;
};

export type ModelSuggestionSource = {
  id: string;
  fileName: string;
  title: string;
  type?: string;
  tags?: string[];
  body: string;
};

export async function readModelSuggestions(input: {
  sources: ModelSuggestionSource[];
  modelAssistance: ModelAssistanceOptions | null;
  onSourceStart?: (source: ModelSuggestionSource) => Promise<void>;
  onSourceComplete?: (
    source: ModelSuggestionSource,
    result: ModelSuggestionResult
  ) => Promise<void>;
}): Promise<{
  suggestionsBySourceId: Map<string, ModelSuggestions>;
  warnings: string[];
}> {
  const suggestionsBySourceId = new Map<string, ModelSuggestions>();
  const warnings: string[] = [];

  if (!input.modelAssistance) {
    return {
      suggestionsBySourceId,
      warnings
    };
  }

  const modelAssistance = input.modelAssistance;

  await mapWithConcurrency(input.sources, modelAssistance.suggestionConcurrency, async (source) => {
    await input.onSourceStart?.(source);
    const candidatePaths = selectModelCandidatePaths({
      source,
      sources: input.sources
    });
    const request = () =>
      requestModelSuggestions({
        client: modelAssistance.client,
        modelName: modelAssistance.modelName,
        contextWindowTokens: modelAssistance.contextWindowTokens,
        receiveTimeouts: modelAssistance.receiveTimeouts,
        transientRetryDelayMs: modelAssistance.transientRetryDelayMs,
        title: source.title,
        body: source.body,
        candidatePaths
      });
    const result = modelAssistance.requestRunner
      ? await modelAssistance.requestRunner.run(request)
      : await request();

    if (result.suggestions) {
      suggestionsBySourceId.set(source.id, result.suggestions);
    }

    warnings.push(...result.warnings);
    await input.onSourceComplete?.(source, result);
  });

  return {
    suggestionsBySourceId,
    warnings
  };
}
