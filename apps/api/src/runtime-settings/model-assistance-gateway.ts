import { createOpenAIModelClient } from "@focowiki/okf";
import type { ModelAssistanceOptions } from "../admin/model-suggestions.js";
import type { ResourceBudget } from "../runtime/resource-budget.js";
import { createBoundedTaskRunner } from "../runtime/task-runner.js";
import type { RuntimeSettingsSnapshot } from "./types.js";

type ModelClient = ReturnType<typeof createOpenAIModelClient>;

export type ModelAssistanceGateway = {
  resolve(snapshot: RuntimeSettingsSnapshot): ModelAssistanceOptions | null;
};

export function createModelAssistanceGateway(input: {
  budget: Pick<ResourceBudget, "run">;
  createClient?: typeof createOpenAIModelClient;
}): ModelAssistanceGateway {
  const createClient = input.createClient ?? createOpenAIModelClient;
  let cached: {
    key: string;
    client: ModelClient;
    requestRunner: ModelAssistanceOptions["requestRunner"];
  } | null = null;
  return {
    resolve(snapshot) {
      const model = snapshot.activeModel;
      if (!model) return null;
      const key = [
        model.id,
        model.updatedAt,
        model.apiMode,
        model.baseUrl,
        model.modelName,
        model.apiKeyFingerprint
      ].join("\u001f");
      if (!cached || cached.key !== key) {
        const pacing = createBoundedTaskRunner(model.suggestionConcurrency, {
          minStartIntervalMs: model.requestMinIntervalMs
        });
        cached = {
          key,
          client: createClient({
            apiMode: model.apiMode,
            apiKey: model.apiKey,
            baseUrl: model.baseUrl,
            requestTimeoutMs: model.requestMaxTimeoutMs
          }),
          requestRunner: {
            run: (operation) => pacing.run(() => input.budget.run(operation))
          }
        };
      }
      return {
        modelConfigId: model.id,
        apiMode: model.apiMode,
        client: cached.client,
        modelName: model.modelName,
        contextWindowTokens: model.contextWindowTokens,
        receiveTimeouts: {
          maxMs: model.requestMaxTimeoutMs,
          idleMs: model.requestIdleTimeoutMs
        },
        suggestionConcurrency: model.suggestionConcurrency,
        transientRetryDelayMs: model.transientRetryDelayMs,
        requestRunner: cached.requestRunner
      };
    }
  };
}
