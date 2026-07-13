import type { ModelReceiveTimeouts, OpenAIModelClient } from "@focowiki/okf";

export type GraphModelConfirmationOptions = {
  client: OpenAIModelClient;
  modelName: string;
  contextWindowTokens: number;
  receiveTimeouts: ModelReceiveTimeouts;
};
