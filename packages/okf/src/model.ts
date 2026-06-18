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
  required: ["title", "type", "description", "tags", "related_links", "keywords"],
  properties: {
    title: {
      type: "string"
    },
    type: {
      type: "string"
    },
    description: {
      type: "string"
    },
    tags: {
      type: "array",
      items: {
        type: "string"
      }
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
  title: string;
  type: string;
  description: string;
  tags: string[];
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
    title: z.string(),
    type: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
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
      "Return exactly one JSON object with all required keys: title, type, description, tags, related_links, and keywords.",
      "Return raw JSON only. Do not wrap the JSON in Markdown fences and do not include explanatory text.",
      "Do not omit any required key.",
      "Use an empty string or empty array when no safe suggestion is available.",
      "Suggest title and type only as generic fallbacks when the source does not provide them.",
      "Do not create or modify factual metadata such as resource, timestamp, official identifiers, source URLs, hashes, status, owner fields, or other domain-specific frontmatter."
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

    const outputText = readModelOutputText(response);

    if (!outputText) {
      return warning("Model suggestions failed local schema validation");
    }

    return {
      suggestions: validateModelSuggestions(JSON.parse(outputText)),
      warnings: []
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return warning(`Model suggestions failed local schema validation: ${formatZodIssues(error)}`);
    }

    if (error instanceof SyntaxError) {
      return warning("Model suggestions failed local schema validation: response was not valid JSON");
    }

    return warning(`Model provider error: ${redactSecrets(error)}`);
  }
}

function formatZodIssues(error: z.ZodError): string {
  const summary = error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

  return sanitizeRepairText(summary || "schema mismatch");
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

function readModelOutputText(response: unknown): string | null {
  const outputText = readStringProperty(response, "output_text");

  if (outputText) {
    return outputText;
  }

  const responseObject = readRecord(response);
  const output = Array.isArray(responseObject?.output) ? responseObject.output : [];

  for (const item of output) {
    const itemRecord = readRecord(item);
    const content = Array.isArray(itemRecord?.content) ? itemRecord.content : [];

    for (const part of content) {
      const partRecord = readRecord(part);
      const text = readStringProperty(partRecord, "text") ?? readStringProperty(partRecord, "output_text");

      if (text) {
        return text;
      }
    }
  }

  const choices = Array.isArray(responseObject?.choices) ? responseObject.choices : [];

  for (const choice of choices) {
    const message = readRecord(readRecord(choice)?.message);
    const content = message?.content;

    if (typeof content === "string" && content.trim()) {
      return content;
    }

    if (Array.isArray(content)) {
      for (const part of content) {
        const text = readStringProperty(part, "text");

        if (text) {
          return text;
        }
      }
    }
  }

  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
