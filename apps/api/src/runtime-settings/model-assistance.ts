import { createOpenAIResponsesClient } from "@focowiki/okf";
import type { ModelAssistanceOptions } from "../admin/model-suggestions.js";
import { createBoundedTaskRunner } from "../runtime/task-runner.js";
import type { RuntimeSettingsSnapshot } from "./types.js";

export function createModelAssistanceFromRuntimeSettings(
  snapshot: RuntimeSettingsSnapshot
): ModelAssistanceOptions | null {
  const model = snapshot.activeModel;

  if (!model) {
    return null;
  }

  return {
    modelConfigId: model.id,
    client: createOpenAIResponsesClient({
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      requestTimeoutMs: model.requestMaxTimeoutMs
    }),
    modelName: model.modelName,
    contextWindowTokens: model.contextWindowTokens,
    receiveTimeouts: {
      maxMs: model.requestMaxTimeoutMs,
      idleMs: model.requestIdleTimeoutMs
    },
    suggestionConcurrency: model.suggestionConcurrency,
    transientRetryDelayMs: model.transientRetryDelayMs,
    requestRunner: createBoundedTaskRunner(model.suggestionConcurrency, {
      minStartIntervalMs: model.requestMinIntervalMs
    })
  };
}
