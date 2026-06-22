import type { RuntimeConfig } from "../config.js";
import { createBoundedTaskRunner } from "./task-runner.js";

export function createModelSuggestionTaskRunner(config: RuntimeConfig) {
  return createBoundedTaskRunner(config.model.enabled ? config.model.suggestionConcurrency : 1, {
    minStartIntervalMs: config.model.enabled ? config.model.requestMinIntervalMs : 0
  });
}
