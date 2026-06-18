import OpenAI from "openai";
import { z } from "zod";
import {
  receiveWithProgressTimeout,
  type ModelReceiveTimeouts
} from "./model-receive.js";
import { buildModelSourceView } from "./model-source-view.js";
import type { OkfGraphEdge, OkfGraphNode } from "./graph.js";

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

export const GRAPH_RELATIONSHIP_CONFIRMATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["relationships"],
  properties: {
    relationships: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["targetFileId", "accepted", "relationType", "weight", "reason"],
        properties: {
          targetFileId: {
            type: "string"
          },
          accepted: {
            type: "boolean"
          },
          relationType: {
            type: "string"
          },
          weight: {
            type: "number",
            minimum: 0,
            maximum: 1
          },
          reason: {
            type: "string"
          }
        }
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

export type GraphRelationshipConfirmation = {
  targetFileId: string;
  accepted: boolean;
  relationType: string;
  weight: number;
  reason: string;
};

export type GraphRelationshipConfirmationRequest = {
  model: string;
  instructions: string;
  input: string;
  text: {
    format: {
      type: "json_schema";
      name: "focowiki_graph_relationship_confirmations";
      strict: true;
      schema: typeof GRAPH_RELATIONSHIP_CONFIRMATION_SCHEMA;
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

export type GraphRelationshipConfirmationResult = {
  confirmations: GraphRelationshipConfirmation[];
  warnings: string[];
};

export type OpenAIResponsesClient = {
  responses: {
    create: (
      request: ModelSuggestionRequest | GraphRelationshipConfirmationRequest
    ) => Promise<unknown>;
  };
};

export type OpenAIModelClientConfig = {
  apiKey: string;
  baseUrl: string;
  requestTimeoutMs: number;
};

export type BuildGraphRelationshipConfirmationRequestInput = {
  modelName: string;
  currentFile: OkfGraphNode;
  body: string;
  candidates: OkfGraphEdge[];
  candidateFiles: OkfGraphNode[];
  contextWindowTokens: number;
  repair?: {
    previousError: string;
  };
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

const graphRelationshipConfirmationSchema = z
  .object({
    relationships: z.array(
      z
        .object({
          targetFileId: z.string(),
          accepted: z.boolean(),
          relationType: z.string(),
          weight: z.number().min(0).max(1),
          reason: z.string()
        })
        .strict()
    )
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

export function buildGraphRelationshipConfirmationRequest(
  input: BuildGraphRelationshipConfirmationRequestInput
): GraphRelationshipConfirmationRequest {
  const sourceView = buildModelSourceView({
    title: input.currentFile.title,
    body: input.body,
    candidatePaths: input.candidateFiles.map((candidate) => candidate.path),
    contextWindowTokens: input.contextWindowTokens
  });
  const candidateById = new Map(input.candidateFiles.map((candidate) => [candidate.fileId, candidate]));
  const candidateCards = input.candidates.map((candidate) => {
    const target = candidateById.get(candidate.toFileId);
    return {
      targetFileId: candidate.toFileId,
      targetPath: target?.path ?? "",
      targetTitle: target?.title ?? "",
      targetType: target?.type ?? "",
      targetTags: target?.tags ?? [],
      candidateRelationType: candidate.relationType,
      candidateWeight: candidate.weight,
      deterministicReason: candidate.reason,
      evidence: candidate.evidence ?? {}
    };
  });

  return {
    model: input.modelName,
    instructions: [
      "Confirm file graph relationships for an OKF-style Markdown knowledge bundle.",
      "You must only evaluate the provided candidate relationships.",
      "Do not invent target files, target paths, metadata fields, or facts.",
      "Return exactly one JSON object with a relationships array.",
      "For each item, set accepted to true or false and keep targetFileId from the candidate.",
      "Use a short safe reason that can be shown to developers and Agents.",
      "Return raw JSON only. Do not wrap the JSON in Markdown fences and do not include explanatory text."
    ].join(" "),
    input: [
      `Current file ID: ${input.currentFile.fileId}`,
      `Current path: ${input.currentFile.path}`,
      `Current title: ${input.currentFile.title}`,
      input.currentFile.type ? `Current type: ${input.currentFile.type}` : "",
      input.currentFile.tags?.length ? `Current tags: ${input.currentFile.tags.join(", ")}` : "",
      ...(input.repair
        ? ["", "Previous attempt error:", sanitizeRepairText(input.repair.previousError)]
        : []),
      "",
      "Candidate relationships:",
      JSON.stringify(candidateCards, null, 2),
      "",
      sourceView.body
    ]
      .filter((line) => line !== "")
      .join("\n"),
    text: {
      format: {
        type: "json_schema",
        name: "focowiki_graph_relationship_confirmations",
        description:
          "Model confirmation for already-selected graph relationship candidates.",
        strict: true,
        schema: GRAPH_RELATIONSHIP_CONFIRMATION_SCHEMA
      }
    },
    store: false
  };
}

export function validateModelSuggestions(input: unknown): ModelSuggestions {
  return modelSuggestionsSchema.parse(input);
}

export function validateGraphRelationshipConfirmations(
  input: unknown
): GraphRelationshipConfirmation[] {
  return graphRelationshipConfirmationSchema.parse(input).relationships;
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

export async function requestGraphRelationshipConfirmations(
  input: BuildGraphRelationshipConfirmationRequestInput & {
    client: OpenAIResponsesClient;
    receiveTimeouts: ModelReceiveTimeouts;
  }
): Promise<GraphRelationshipConfirmationResult> {
  if (input.candidates.length === 0) {
    return {
      confirmations: [],
      warnings: []
    };
  }

  let previousError: string | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const requestInput = previousError
      ? { ...input, repair: { previousError } }
      : input;
    const request = buildGraphRelationshipConfirmationRequest(requestInput);
    const result = await runGraphRelationshipConfirmationAttempt({
      client: input.client,
      request,
      receiveTimeouts: input.receiveTimeouts
    });

    if (result.confirmations.length > 0 || result.warnings.length === 0) {
      return result;
    }

    previousError = result.warnings[0] ?? "Graph relationship confirmation failed";
  }

  return {
    confirmations: [],
    warnings: [previousError ?? "Graph relationship confirmation failed"]
  };
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

async function runGraphRelationshipConfirmationAttempt(input: {
  client: OpenAIResponsesClient;
  request: GraphRelationshipConfirmationRequest;
  receiveTimeouts: ModelReceiveTimeouts;
}): Promise<GraphRelationshipConfirmationResult> {
  try {
    const response = await receiveWithProgressTimeout({
      timeouts: input.receiveTimeouts,
      start: () => input.client.responses.create(input.request)
    });

    if (containsRefusal(response)) {
      return graphWarning("Model refused to confirm graph relationships");
    }

    const status = readStringProperty(response, "status");

    if (status === "incomplete") {
      const reason = readIncompleteReason(response) ?? "unknown";
      return graphWarning(`Model graph confirmation was incomplete: ${reason}`);
    }

    if (status && status !== "completed") {
      return graphWarning(`Model graph confirmation did not complete: ${status}`);
    }

    const outputText = readModelOutputText(response);

    if (!outputText) {
      return graphWarning("Graph relationship confirmation failed local schema validation");
    }

    return {
      confirmations: validateGraphRelationshipConfirmations(JSON.parse(outputText)),
      warnings: []
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return graphWarning(
        `Graph relationship confirmation failed local schema validation: ${formatZodIssues(error)}`
      );
    }

    if (error instanceof SyntaxError) {
      return graphWarning(
        "Graph relationship confirmation failed local schema validation: response was not valid JSON"
      );
    }

    return graphWarning(`Model provider error: ${redactSecrets(error)}`);
  }
}

function graphWarning(message: string): GraphRelationshipConfirmationResult {
  return {
    confirmations: [],
    warnings: [message]
  };
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
