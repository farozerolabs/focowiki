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

const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 15_000;
const DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 30_000;
const DEFAULT_COOLING_DOWN_RETRY_DELAY_MS = 60_000;

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

export const GRAPH_RELATIONSHIP_TYPES = [
  "direct_reference",
  "same_specific_subject",
  "same_entity",
  "version_relation",
  "background",
  "process_adjacent",
  "parent_child",
  "collection_neighbor"
] as const;

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
            type: "string",
            enum: GRAPH_RELATIONSHIP_TYPES
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

export type SourceModelSuggestions = ModelSuggestions;

export type ModelSuggestionRequest = {
  model: string;
  instructions: string;
  input: ModelRequestInput;
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
  input: ModelRequestInput;
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

export type ModelRequestInput = Array<{
  role: "user";
  content: Array<{
    type: "input_text";
    text: string;
  }>;
}>;

export type BuildModelSuggestionRequestInput = {
  modelName: string;
  title: string;
  body: string;
  candidatePaths: string[];
  contextWindowTokens: number;
  transientRetryDelayMs?: number;
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

export type ModelApiMode = "responses" | "chat_completions";

export type OpenAIResponsesClient = {
  apiMode?: "responses";
  responses: {
    create: (
      request: ModelSuggestionRequest | GraphRelationshipConfirmationRequest
    ) => Promise<unknown>;
  };
};

export type ChatCompletionsJsonRequest = {
  model: string;
  messages: Array<{
    role: "system" | "user";
    content: string;
  }>;
  response_format: {
    type: "json_object";
  };
  stream: false;
};

export type OpenAIChatCompletionsClient = {
  apiMode: "chat_completions";
  chat: {
    completions: {
      create: (request: ChatCompletionsJsonRequest) => Promise<unknown>;
    };
  };
};

export type OpenAIModelClient = OpenAIResponsesClient | OpenAIChatCompletionsClient;

export type OpenAIModelClientConfig = {
  apiMode?: ModelApiMode | undefined;
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
  transientRetryDelayMs?: number;
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
          relationType: z.enum(GRAPH_RELATIONSHIP_TYPES),
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

export function createOpenAIModelClient(
  config: OpenAIModelClientConfig
): OpenAIModelClient {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    timeout: config.requestTimeoutMs,
    maxRetries: 0
  });

  if (config.apiMode === "chat_completions") {
    return {
      apiMode: "chat_completions",
      chat: client.chat as OpenAIChatCompletionsClient["chat"]
    };
  }

  return {
    apiMode: "responses",
    responses: client.responses as OpenAIResponsesClient["responses"]
  };
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

  const userInput = [
    `Title: ${input.title}`,
    ...(input.repair
      ? ["", "Previous attempt error:", sanitizeRepairText(input.repair.previousError)]
      : []),
    "",
    "Candidate related bundle paths:",
    ...input.candidatePaths.map((path) => `- ${path}`),
    "",
    sourceView.body
  ].join("\n");

  return {
    model: input.modelName,
    instructions: [
      "You are a Markdown file analysis assistant.",
      "Task: read one uploaded Markdown file and return safe suggestions for generated presentation and navigation fields.",
      "Use only the provided title, candidate related paths, and Markdown content.",
      "Return exactly one JSON object with all required keys: title, type, description, tags, related_links, and keywords.",
      "Return raw JSON only. Do not wrap the JSON in Markdown fences and do not include explanatory text.",
      "Inside JSON string values, avoid ASCII double quote characters; use plain words or non-ASCII quotation marks when a quoted term is needed.",
      "Do not omit any required key.",
      'Example output structure: {"title":"","type":"","description":"","tags":[],"related_links":[{"path":"","title":""}],"keywords":[]}.',
      "For title, use the provided title when it is clear. If the title is missing or weak, derive a short title from the Markdown content.",
      "For type, suggest a generic document type from the visible content. Use an empty string when uncertain.",
      "For description, write a short factual summary grounded in the Markdown content.",
      "Use the primary natural language of the Markdown content for title, type, description, tags, and keywords.",
      "For tags and keywords, return short topic labels found or clearly supported by the Markdown content.",
      "For related_links, include only useful related files from the provided candidate related paths.",
      "Every related_links.path must exactly match one provided candidate path.",
      "Use an empty string or empty array when no safe suggestion is available.",
      "Do not invent facts, dates, identifiers, status values, source URLs, citations, owners, departments, locations, or user-provided metadata fields.",
      "Do not create or modify factual metadata such as resource, timestamp, official identifiers, source URLs, hashes, status, owner fields, or other frontmatter fields from the source file."
    ].join(" "),
    input: createUserTextInput(userInput),
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
      targetSummary: target?.summary ?? "",
      targetSubjects: target?.subjects ?? [],
      targetTags: target?.tags ?? [],
      targetKeywords: target?.keywords ?? [],
      targetEntities: target?.entities ?? [],
      candidateRelationType: candidate.relationType,
      candidateWeight: candidate.weight,
      deterministicReason: candidate.reason,
      evidence: candidate.evidence ?? {}
    };
  });

  const userInput = [
    `Current file ID: ${input.currentFile.fileId}`,
    `Current path: ${input.currentFile.path}`,
    `Current title: ${input.currentFile.title}`,
    input.currentFile.type ? `Current type: ${input.currentFile.type}` : "",
    input.currentFile.summary ? `Current summary: ${input.currentFile.summary}` : "",
    input.currentFile.subjects?.length ? `Current subjects: ${input.currentFile.subjects.join(", ")}` : "",
    input.currentFile.tags?.length ? `Current tags: ${input.currentFile.tags.join(", ")}` : "",
    input.currentFile.keywords?.length ? `Current keywords: ${input.currentFile.keywords.join(", ")}` : "",
    input.currentFile.entities?.length ? `Current entities: ${input.currentFile.entities.join(", ")}` : "",
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
    .join("\n");

  return {
    model: input.modelName,
    instructions: [
      "You are a Markdown file relationship reviewer.",
      "Task: review candidate relationships between the current Markdown file and other Markdown files.",
      "Evaluate only the provided candidate relationships.",
      "Use only the current file metadata, current Markdown content, candidate relationship records, and candidate file summaries.",
      "Return exactly one JSON object with one key: relationships.",
      "Return raw JSON only. Do not wrap the JSON in Markdown fences and do not include explanatory text.",
      "Inside JSON string values, avoid ASCII double quote characters; use plain words or non-ASCII quotation marks when a quoted term is needed.",
      'Return this JSON structure: {"relationships":[{"targetFileId":"source-file-id-from-candidate","accepted":true,"relationType":"same_specific_subject","weight":0.85,"reason":"Short factual reason based on visible evidence."}]}.',
      'If no candidate relationship is strong enough, return {"relationships":[]}.',
      "For each returned item, keep targetFileId exactly as provided.",
      `Use only these relationType values: ${GRAPH_RELATIONSHIP_TYPES.join(", ")}.`,
      "For accepted relationships, relationType must exactly match the candidateRelationType value from that candidate.",
      "Set accepted to true only when there is clear content evidence that the target file helps readers or AI agents continue exploring the current file.",
      "Accept relationships supported by direct mention, same specific subject, same entity, version relationship, background relationship, adjacent process, or clearly connected topic.",
      "For same_entity and same_specific_subject, require the shared subject or entity to be a central subject or primary entity in both files.",
      "Use same_entity only when the same uniquely identifiable entity is a substantive focus in both files.",
      "A shared location, publisher, authority, owner, namespace, or collection does not establish same_entity by itself.",
      "Use same_specific_subject only when both files materially address the same narrow topic, object, or problem.",
      "Use version_relation only for the same document or a visible replacement, revision, supersession, or version chain.",
      "Use direct_reference only when the current content visibly identifies or links the target.",
      "Use background or process_adjacent only when the target supplies a visible prerequisite, explanation, or neighboring process step.",
      "Reject relationships based on incidental references, generic authorities, common templates, boilerplate, background citations, or an entity that is central to only one file.",
      "Reject a candidate when its candidate relationship type does not match the visible evidence, including replacement, revision, or version evidence presented as another relationship type.",
      "Reject weak relationships based only on generic shared words, broad category matches, dates, status words, missing evidence, or product-specific assumptions.",
      "Do not create relationship labels for broad metadata groups, locations, teams, departments, document status, dates, or file type alone.",
      "weight must be between 0 and 1.",
      "reason must be short, factual, and based on visible evidence.",
      "Write reason as a direction-neutral durable fact that names or structurally identifies both connected subjects or their visible evidence.",
      "Do not use deictic role phrases such as current file, target file, this document, or related file in reason.",
      "Do not invent target files, target paths, metadata fields, facts, citations, or hidden context."
    ].join(" "),
    input: createUserTextInput(userInput),
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

function createUserTextInput(text: string): ModelRequestInput {
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text
        }
      ]
    }
  ];
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
    client: OpenAIModelClient;
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

    if (attempt === 0 && isTransientModelWarning(previousError)) {
      await sleep(resolveTransientRetryDelayMs(previousError, input.transientRetryDelayMs));
    }
  }

  return warning(previousError ?? "Model suggestions failed");
}

export async function requestGraphRelationshipConfirmations(
  input: BuildGraphRelationshipConfirmationRequestInput & {
    client: OpenAIModelClient;
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

    if (attempt === 0 && isTransientModelWarning(previousError)) {
      await sleep(resolveTransientRetryDelayMs(previousError, input.transientRetryDelayMs));
    }
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
  client: OpenAIModelClient;
  request: ModelSuggestionRequest;
  receiveTimeouts: ModelReceiveTimeouts;
}): Promise<ModelSuggestionResult> {
  try {
    const response = await receiveWithProgressTimeout({
      timeouts: input.receiveTimeouts,
      start: () => sendModelRequest(input.client, input.request)
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
      suggestions: validateModelSuggestions(parseModelOutputJson(outputText)),
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
  client: OpenAIModelClient;
  request: GraphRelationshipConfirmationRequest;
  receiveTimeouts: ModelReceiveTimeouts;
}): Promise<GraphRelationshipConfirmationResult> {
  try {
    const response = await receiveWithProgressTimeout({
      timeouts: input.receiveTimeouts,
      start: () => sendModelRequest(input.client, input.request)
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
      confirmations: validateGraphRelationshipConfirmations(parseModelOutputJson(outputText)),
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

function sendModelRequest(
  client: OpenAIModelClient,
  request: ModelSuggestionRequest | GraphRelationshipConfirmationRequest
): Promise<unknown> {
  if (isChatCompletionsClient(client)) {
    return client.chat.completions.create(toChatCompletionsJsonRequest(request));
  }

  return client.responses.create(request);
}

function isChatCompletionsClient(client: OpenAIModelClient): client is OpenAIChatCompletionsClient {
  return client.apiMode === "chat_completions";
}

function toChatCompletionsJsonRequest(
  request: ModelSuggestionRequest | GraphRelationshipConfirmationRequest
): ChatCompletionsJsonRequest {
  return {
    model: request.model,
    messages: [
      {
        role: "system",
        content: request.instructions
      },
      {
        role: "user",
        content: readModelInputText(request.input)
      }
    ],
    response_format: {
      type: "json_object"
    },
    stream: false
  };
}

function readModelInputText(input: ModelRequestInput): string {
  return input
    .flatMap((item) => item.content.map((part) => part.text))
    .join("\n");
}

function graphWarning(message: string): GraphRelationshipConfirmationResult {
  return {
    confirmations: [],
    warnings: [message]
  };
}

function isTransientModelWarning(message: string) {
  const normalized = message.toLowerCase();

  return (
    normalized.includes("429") ||
    normalized.includes("rate limit") ||
    normalized.includes("cooling down") ||
    normalized.includes("timeout") ||
    normalized.includes("temporarily unavailable")
  );
}

function resolveTransientRetryDelayMs(message: string, override?: number) {
  if (Number.isFinite(override) && Number(override) >= 0) {
    return Number(override);
  }

  const normalized = message.toLowerCase();

  if (normalized.includes("cooling down")) {
    return DEFAULT_COOLING_DOWN_RETRY_DELAY_MS;
  }

  if (normalized.includes("429") || normalized.includes("rate limit")) {
    return DEFAULT_RATE_LIMIT_RETRY_DELAY_MS;
  }

  return DEFAULT_TRANSIENT_RETRY_DELAY_MS;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  if (Array.isArray(output)) {
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

  const choices = Array.isArray((response as { choices?: unknown }).choices)
    ? (response as { choices: unknown[] }).choices
    : [];

  return choices.some((choice) => {
    const message = readRecord(readRecord(choice)?.message);
    return typeof message?.refusal === "string" && message.refusal.trim().length > 0;
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

function parseModelOutputJson(outputText: string): unknown {
  try {
    return JSON.parse(outputText);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }

  const trimmed = outputText.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);

  if (fenced?.[1]) {
    return JSON.parse(fenced[1]);
  }

  const objectText = extractFirstJsonObject(trimmed);

  if (objectText) {
    return JSON.parse(objectText);
  }

  return JSON.parse(outputText);
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");

  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        return text.slice(start, index + 1);
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
