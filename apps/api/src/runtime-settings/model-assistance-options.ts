import type {
  ModelReceiveTimeouts,
  OpenAIModelClient
} from "@focowiki/okf";
import type { BoundedTaskRunner } from "../runtime/task-runner.js";
import type { ModelApiMode } from "./types.js";

export type ModelAssistanceOptions = {
  modelConfigId?: string | null;
  apiMode: ModelApiMode;
  client: OpenAIModelClient;
  modelName: string;
  contextWindowTokens: number;
  receiveTimeouts: ModelReceiveTimeouts;
  suggestionConcurrency: number;
  transientRetryDelayMs: number;
  requestRunner?: BoundedTaskRunner | undefined;
};
