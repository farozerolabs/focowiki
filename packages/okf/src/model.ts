import OpenAI from "openai";
import { z } from "zod";
import {
  receiveWithProgressTimeout,
  type ModelReceiveTimeouts
} from "./model-receive.js";
import { buildModelSourceView } from "./model-source-view.js";

export { receiveWithProgressTimeout } from "./model-receive.js";
export type { ModelReceiveTimeouts } from "./model-receive.js";

export const MODEL_SUGGESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["description", "related_links", "keywords"],
  properties: {
    description: {
      type: "string"
    },
    related_links: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "title"],
        properties: {
          path: {
            type: "string"
          },
          title: {
            type: "string"
          }
        }
      }
    },
    keywords: {
      type: "array",
      items: {
        type: "string"
      }
    }
  }
} as const;

export type ModelSuggestions = {
  description: string;
  related_links: Array<{
    path: string;
    title: string;
  }>;
  keywords: string[];
};

export type ModelSuggestionRequest = {
  model: string;
  instructions: string;
  input: string;
  text: {
    format: {
      type: "json_schema";
      name: "focowiki_model_suggestions";
      strict: true;
      schema: typeof MODEL_SUGGESTION_SCHEMA;
      description: string;
    };
  };
  store: false;
};

export type BuildModelSuggestionRequestInput = {
  modelName: string;
  title: string;
  body: string;
  candidatePaths: string[];
  contextWindowTokens: number;
  repair?: {
    previousError: string;
  };
};

export type ModelSuggestionResult = {
  suggestions: ModelSuggestions | null;
  warnings: string[];
};

export type OpenAIResponsesClient = {
  responses: {
    create: (request: ModelSuggestionRequest) => Promise<unknown>;
  };
};

export type OpenAIModelClientConfig = {
  apiKey: string;
  baseUrl: string;
  requestTimeoutMs: number;
};

const modelSuggestionsSchema = z
  .object({
    description: z.string(),
    related_links: z.array(
      z
        .object({
          path: z.string(),
          title: z.string()
        })
        .strict()
    ),
    keywords: z.array(z.string())
  })
  .strict();

export function createOpenAIResponsesClient(
  config: OpenAIModelClientConfig
): OpenAIResponsesClient {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    timeout: config.requestTimeoutMs,
    maxRetries: 0
  }) as OpenAIResponsesClient;
}

export function buildModelSuggestionRequest(
  input: BuildModelSuggestionRequestInput
): ModelSuggestionRequest {
  const sourceView = buildModelSourceView({
    title: input.title,
    body: input.body,
    candidatePaths: input.candidatePaths,
    contextWindowTokens: input.contextWindowTokens
  });

  return {
    model: input.modelName,
    instructions: [
      "Suggest optional presentation metadata for an OKF-style Markdown knowledge bundle.",
      "Return only description, related_links, and keywords.",
      "Do not create or modify factual metadata such as resource, timestamp, official identifiers, type, or title."
    ].join(" "),
    input: [
      `Title: ${input.title}`,
      ...(input.repair
        ? ["", "Previous attempt error:", sanitizeRepairText(input.repair.previousError)]
        : []),
      "",
      "Candidate related bundle paths:",
      ...input.candidatePaths.map((path) => `- ${path}`),
      "",
      sourceView.body
    ].join("\n"),
    text: {
      format: {
        type: "json_schema",
        name: "focowiki_model_suggestions",
        description:
          "Optional suggestions for generated descriptions, related Markdown links, and search keywords.",
        strict: true,
        schema: MODEL_SUGGESTION_SCHEMA
      }
    },
    store: false
  };
}

export function validateModelSuggestions(input: unknown): ModelSuggestions {
  return modelSuggestionsSchema.parse(input);
}

export async function requestModelSuggestions(
  input: BuildModelSuggestionRequestInput & {
    client: OpenAIResponsesClient;
    receiveTimeouts: ModelReceiveTimeouts;
  }
): Promise<ModelSuggestionResult> {
  let previousError: string | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const requestInput = previousError
      ? { ...input, repair: { previousError } }
      : input;
    const request = buildModelSuggestionRequest(requestInput);
    const result = await runModelSuggestionAttempt({
      client: input.client,
      request,
      receiveTimeouts: input.receiveTimeouts
    });

    if (result.suggestions) {
      return result;
    }

    previousError = result.warnings[0] ?? "Model suggestions failed";
  }

  return warning(previousError ?? "Model suggestions failed");
}

function warning(message: string): ModelSuggestionResult {
  return {
    suggestions: null,
    warnings: [message]
  };
}

async function runModelSuggestionAttempt(input: {
  client: OpenAIResponsesClient;
  request: ModelSuggestionRequest;
  receiveTimeouts: ModelReceiveTimeouts;
}): Promise<ModelSuggestionResult> {
  try {
    const response = await receiveWithProgressTimeout({
      timeouts: input.receiveTimeouts,
      start: () => input.client.responses.create(input.request)
    });

    if (containsRefusal(response)) {
      return warning("Model refused to provide suggestions");
    }

    const status = readStringProperty(response, "status");

    if (status === "incomplete") {
      const reason = readIncompleteReason(response) ?? "unknown";
      return warning(`Model response was incomplete: ${reason}`);
    }

    if (status && status !== "completed") {
      return warning(`Model response did not complete: ${status}`);
    }

    const outputText = readStringProperty(response, "output_text");

    if (!outputText) {
      return warning("Model suggestions failed local schema validation");
    }

    return {
      suggestions: validateModelSuggestions(JSON.parse(outputText)),
      warnings: []
    };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return warning("Model suggestions failed local schema validation");
    }

    return warning(`Model provider error: ${redactSecrets(error)}`);
  }
}

function containsRefusal(response: unknown): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }

  const output = (response as { output?: unknown }).output;

  if (!Array.isArray(output)) {
    return false;
  }

  return output.some((item) => {
    if (!item || typeof item !== "object") {
      return false;
    }

    const content = (item as { content?: unknown }).content;

    if (!Array.isArray(content)) {
      return false;
    }

    return content.some(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "refusal"
    );
  });
}

function readStringProperty(value: unknown, property: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const propertyValue = (value as Record<string, unknown>)[property];
  return typeof propertyValue === "string" ? propertyValue : null;
}

function readIncompleteReason(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const incompleteDetails = (value as { incomplete_details?: unknown }).incomplete_details;

  if (!incompleteDetails || typeof incompleteDetails !== "object") {
    return null;
  }

  return readStringProperty(incompleteDetails, "reason");
}

function redactSecrets(input: unknown): string {
  const message = input instanceof Error ? input.message : String(input);

  return message
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;}\]]+/gi, "$1<redacted>")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1<redacted>")
    .replace(/(MODEL_API_KEY\s*[:=]\s*)[^\s,;}\]]+/gi, "$1<redacted>");
}

function sanitizeRepairText(value: string): string {
  return redactSecrets(value).replace(/\s+/g, " ").slice(0, 500);
}
