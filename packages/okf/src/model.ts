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
const STRUCTURED_OUTPUT_MAX_TOKENS = 8_192;
const MODEL_DESCRIPTION_MAX_CHARACTERS = 600;
const MODEL_RELATIONSHIP_REASON_MAX_CHARACTERS = 240;
const MODEL_RELATIONSHIP_MAX_ITEMS = 50;
const MODEL_ANALYSIS_CONTEXT_WINDOW_TOKENS = 24_000;

export const MODEL_GRAPH_ANALYSIS_PROMPT_CONTRACT_VERSION =
  "portable-model-graph-analysis-v9";
export const GRAPH_RELATIONSHIP_PROMPT_CONTRACT_VERSION =
  "portable-graph-relationship-confirmation-v6";

export const MODEL_SUGGESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "type", "description", "tags", "keywords"],
  properties: {
    title: {
      type: "string"
    },
    type: {
      type: "string"
    },
    description: {
      type: "string",
      maxLength: MODEL_DESCRIPTION_MAX_CHARACTERS
    },
    tags: {
      type: "array",
      maxItems: 16,
      items: {
        type: "string",
        maxLength: 128
      }
    },
    keywords: {
      type: "array",
      maxItems: 32,
      items: {
        type: "string",
        maxLength: 128
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
      maxItems: MODEL_RELATIONSHIP_MAX_ITEMS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidateId", "relationType", "confidence", "reason"],
        properties: {
          candidateId: {
            type: "string",
            minLength: 1
          },
          relationType: {
            type: "string",
            enum: GRAPH_RELATIONSHIP_TYPES
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1
          },
          reason: {
            type: "string",
            maxLength: MODEL_RELATIONSHIP_REASON_MAX_CHARACTERS
          }
        }
      }
    }
  }
} as const;

export const MODEL_GRAPH_ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions", "relationships"],
  properties: {
    suggestions: MODEL_SUGGESTION_SCHEMA,
    relationships: GRAPH_RELATIONSHIP_CONFIRMATION_SCHEMA.properties.relationships
  }
} as const;

const MODEL_SUGGESTION_VALUE_INSTRUCTIONS = [
  "For title, use the provided title when it is clear. If the title is missing or weak, derive a short title from the Markdown content.",
  "For type, suggest a generic document type from the visible content. Use an empty string when uncertain.",
  "For description, write a short factual summary grounded in the Markdown content.",
  `Keep description within ${MODEL_DESCRIPTION_MAX_CHARACTERS} characters. Summarize instead of reproducing source passages.`,
  "Use the primary natural language of the Markdown content for title, type, description, tags, and keywords.",
  "For tags and keywords, return short topic labels found or clearly supported by the Markdown content.",
  "Return at most 16 tags and at most 32 keywords.",
  "Each tag and keyword must be at most 128 UTF-8 bytes; prefer a short noun phrase rather than a sentence or excerpt.",
  "Use an empty string or empty array when no safe suggestion is available.",
  "Do not invent facts, dates, identifiers, status values, source URLs, citations, owners, departments, locations, or user-provided metadata fields.",
  "Do not create or modify factual metadata such as resource, timestamp, official identifiers, source URLs, hashes, status, owner fields, or other frontmatter fields from the source file."
] as const;

const GRAPH_RELATIONSHIP_DECISION_INSTRUCTIONS = [
  "Return only accepted relationships. Omit every rejected or unsupported candidate.",
  `Return at most ${MODEL_RELATIONSHIP_MAX_ITEMS} accepted relationships, choosing the strongest evidence-grounded candidates when more are available.`,
  "For each returned item, copy candidateId exactly from one provided candidate card.",
  "candidateId is the only authoritative target identity; titles, paths, summaries, and evidence help semantic review but never identify the returned target.",
  "Do not copy or reconstruct a title, path, or database identifier to identify a relationship.",
  `Use only these relationType values: ${GRAPH_RELATIONSHIP_TYPES.join(", ")}.`,
  "candidateRelationType is a preliminary proposal, not a required final classification.",
  "When visible evidence supports a different allowed relationship type, return the evidence-accurate relationType and explain that evidence in reason.",
  "Return a relationship only when clear content evidence shows that the target helps readers or AI agents continue exploring the current file.",
  "Accept relationships supported by direct mention, same specific subject, same entity, version relationship, background relationship, adjacent process, or clearly connected topic.",
  "For same_entity and same_specific_subject, require the shared subject or entity to be a central subject or primary entity in both files.",
  "Use same_entity only when the same uniquely identifiable entity is a substantive focus in both files.",
  "A shared location, publisher, authority, owner, namespace, or collection does not establish same_entity by itself.",
  "Use same_specific_subject only when both files materially address the same narrow topic, object, or problem.",
  "Use version_relation only for the same document or a visible replacement, revision, supersession, or version chain.",
  "Use direct_reference only when the current content visibly identifies or links the target.",
  "Use background or process_adjacent only when the target supplies a visible prerequisite, explanation, or neighboring process step.",
  "Reject relationships based on incidental references, generic authorities, common templates, boilerplate, background citations, or an entity that is central to only one file.",
  "Reject a candidate when the visible evidence supports none of the allowed relationship types.",
  "Reject weak relationships based only on generic shared words, broad category matches, dates, status words, missing evidence, or product-specific assumptions.",
  "Do not create relationship labels for broad metadata groups, locations, teams, departments, document status, dates, or file type alone.",
  "confidence must be a JSON number between 0 and 1.",
  `reason must be a factual JSON string of at most ${MODEL_RELATIONSHIP_REASON_MAX_CHARACTERS} characters based on visible evidence.`,
  "Write reason as a direction-neutral durable fact that names or structurally identifies both connected subjects or their visible evidence.",
  "Do not use deictic role phrases such as current file, target file, this document, or related file in reason.",
  "Do not invent target files, target paths, metadata fields, facts, citations, or hidden context."
] as const;

export type ModelSuggestions = {
  title: string;
  type: string;
  description: string;
  tags: string[];
  keywords: string[];
};

export type SourceModelSuggestions = ModelSuggestions;

export type GraphRelationshipConfirmation = {
  targetFileId: string;
  accepted: boolean;
  relationType: string;
  weight: number;
  reason: string;
};

export type GraphRelationshipConfirmationRequest = {
  model: string;
  max_output_tokens: number;
  instructions: string;
  input: ModelRequestInput;
  text: {
    format: {
      type: "json_schema";
      name: "portable_graph_relationship_confirmations";
      strict: true;
      schema: typeof GRAPH_RELATIONSHIP_CONFIRMATION_SCHEMA;
      description: string;
    };
  };
  store: false;
};

export type ModelGraphAnalysisRequest = {
  model: string;
  max_output_tokens: number;
  instructions: string;
  input: ModelRequestInput;
  text: {
    format: {
      type: "json_schema";
      name: "portable_model_graph_analysis";
      strict: true;
      schema: typeof MODEL_GRAPH_ANALYSIS_SCHEMA;
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

export type ModelSuggestionResult = {
  suggestions: ModelSuggestions | null;
  warnings: string[];
};

export type GraphRelationshipConfirmationResult = {
  confirmations: GraphRelationshipConfirmation[];
  warnings: string[];
};

export type ModelGraphAnalysisResult = {
  suggestions: ModelSuggestions | null;
  confirmations: GraphRelationshipConfirmation[];
  warnings: string[];
};

export type ModelProviderObservation = {
  apiMode: ModelApiMode;
  structuredOutputCapability: Exclude<StructuredOutputCapability, "auto"> | "unknown";
  attempt: number;
  repair: boolean;
  requestId: string | null;
  finishState: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  serviceTimeMs: number;
  errorClass: "none" | "refusal" | "incomplete" | "schema_validation" | "transient" | "provider";
};

export type ModelApiMode = "responses" | "chat_completions";
export type StructuredOutputCapability =
  | "auto"
  | "native_json_schema"
  | "json_object_compatibility";

export type OpenAIResponsesClient = {
  apiMode?: "responses";
  responses: {
    create: (
      request: GraphRelationshipConfirmationRequest | ModelGraphAnalysisRequest
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
  } | {
    type: "json_schema";
    json_schema: {
      name: string;
      description: string;
      strict: true;
      schema: Readonly<Record<string, unknown>>;
    };
  };
  max_tokens: number;
  stream: false;
};

export type OpenAIChatCompletionsClient = {
  apiMode: "chat_completions";
  readonly structuredOutputCapability?: StructuredOutputCapability;
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
  onProviderRequest?: () => void;
  onProviderObservation?: (observation: ModelProviderObservation) => void;
  repair?: {
    previousError: string;
  };
};

export type BuildModelGraphAnalysisRequestInput =
  BuildGraphRelationshipConfirmationRequestInput;

const modelSuggestionsSchema = z
  .object({
    title: z.string(),
    type: z.string(),
    description: z.string().max(MODEL_DESCRIPTION_MAX_CHARACTERS),
    tags: z.array(z.string().max(128)).max(16),
    keywords: z.array(z.string().max(128)).max(32)
  })
  .strict();

const graphRelationshipConfirmationSchema = z
  .object({
    relationships: z.array(
      z
        .object({
          candidateId: z.string().min(1),
          relationType: z.enum(GRAPH_RELATIONSHIP_TYPES),
          confidence: z.number().min(0).max(1),
          reason: z.string().max(MODEL_RELATIONSHIP_REASON_MAX_CHARACTERS)
        })
        .strict()
    ).max(MODEL_RELATIONSHIP_MAX_ITEMS)
  })
  .strict();

const modelGraphAnalysisSchema = z
  .object({
    suggestions: modelSuggestionsSchema,
    relationships: graphRelationshipConfirmationSchema.shape.relationships
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
    return createRevisionScopedChatCompletionsClient(
      (request) => client.chat.completions.create(request as never)
    );
  }

  return {
    apiMode: "responses",
    responses: client.responses as OpenAIResponsesClient["responses"]
  };
}

export function createRevisionScopedChatCompletionsClient(
  create: (request: ChatCompletionsJsonRequest) => Promise<unknown>
): OpenAIChatCompletionsClient {
  let capability: StructuredOutputCapability = "auto";
  return {
    apiMode: "chat_completions",
    get structuredOutputCapability() {
      return capability;
    },
    chat: {
      completions: {
        async create(request) {
          const effectiveRequest = capability === "json_object_compatibility"
            ? toJsonObjectCompatibilityRequest(request)
            : request;
          try {
            const response = await create(effectiveRequest);
            if (capability === "auto"
              && effectiveRequest.response_format.type === "json_schema") {
              capability = "native_json_schema";
            }
            return response;
          } catch (error) {
            if (capability !== "auto"
              || effectiveRequest.response_format.type !== "json_schema"
              || !isExplicitUnsupportedJsonSchemaError(error)) {
              throw error;
            }
            capability = "json_object_compatibility";
            return create(toJsonObjectCompatibilityRequest(request));
          }
        }
      }
    }
  };
}

export function buildGraphRelationshipConfirmationRequest(
  input: BuildGraphRelationshipConfirmationRequestInput
): GraphRelationshipConfirmationRequest {
  const candidateById = new Map(input.candidateFiles.map((candidate) => [candidate.fileId, candidate]));
  const candidateCards = input.candidates.map((candidate) => {
    const target = candidateById.get(candidate.toFileId);
    const sourceEvidence = boundedPromptEvidence(candidate.evidence);
    return {
      candidateId: candidate.toFileId,
      targetPath: target?.path ?? "",
      targetTitle: target?.title ?? "",
      ...(target?.type ? { targetType: boundedPromptText(target.type, 120) } : {}),
      ...(target?.summary
        ? { targetSummary: boundedPromptText(target.summary, 160) } : {}),
      ...(target?.subjects?.length
        ? { targetSubjects: boundedPromptArray(target.subjects) } : {}),
      ...(target?.tags?.length
        ? { targetTags: boundedPromptArray(target.tags) } : {}),
      ...(target?.entities?.length
        ? { targetEntities: boundedPromptArray(target.entities) } : {}),
      ...(target?.evidenceExcerpt
        ? { targetEvidenceExcerpt: boundedPromptText(target.evidenceExcerpt, 160) }
        : {}),
      candidateRelationType: candidate.relationType,
      candidateReason: boundedPromptText(candidate.reason, 160),
      ...(Object.keys(sourceEvidence).length > 0 ? { sourceEvidence } : {})
    };
  });
  const candidateContext = JSON.stringify(candidateCards);
  const sourceView = buildModelSourceView({
    title: input.currentFile.title,
    body: input.body,
    candidateContext,
    contextWindowTokens: Math.min(
      input.contextWindowTokens,
      MODEL_ANALYSIS_CONTEXT_WINDOW_TOKENS
    )
  });

  const userInput = [
    "Current token: current",
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
    candidateContext,
    "",
    sourceView.body
  ]
    .filter((line) => line !== "")
    .join("\n");

  return {
    model: input.modelName,
    max_output_tokens: STRUCTURED_OUTPUT_MAX_TOKENS,
    instructions: [
      "You are a Markdown file relationship reviewer.",
      "Review only the provided candidate relationships.",
      "Use only the current file metadata, current Markdown content, bounded candidate identity cards, and candidate evidence excerpts.",
      "Candidate evidence excerpts are the only candidate content evidence; never infer or reconstruct an unprovided candidate body.",
      "Return one JSON object that matches the supplied schema, with no Markdown or commentary.",
      'JSON-object compatibility example: {"relationships":[{"candidateId":"candidate-0001","relationType":"same_specific_subject","confidence":0.85,"reason":"Short factual reason based on visible evidence."}]}.',
      'If no candidate relationship is strong enough, return {"relationships":[]}.',
      ...GRAPH_RELATIONSHIP_DECISION_INSTRUCTIONS
    ].join(" "),
    input: createUserTextInput(userInput),
    text: {
      format: {
        type: "json_schema",
        name: "portable_graph_relationship_confirmations",
        description:
          "Relationship decisions for path-linked Markdown candidates.",
        strict: true,
        schema: GRAPH_RELATIONSHIP_CONFIRMATION_SCHEMA
      }
    },
    store: false
  };
}

export function buildModelGraphAnalysisRequest(
  input: BuildModelGraphAnalysisRequestInput
): ModelGraphAnalysisRequest {
  const relationshipRequest = buildGraphRelationshipConfirmationRequest(input);
  return {
    model: input.modelName,
    max_output_tokens: STRUCTURED_OUTPUT_MAX_TOKENS,
    instructions: [
      "You are a Markdown file analysis and relationship review assistant.",
      "In one response, produce source-grounded presentation suggestions and review only the provided candidate relationships.",
      "Use only the current file metadata, Markdown content, bounded candidate identity cards, and candidate evidence excerpts.",
      "Read the current Markdown body once for both tasks. Candidate cards are context only and do not contain complete candidate documents.",
      "Return one JSON object that matches the supplied schema, with no Markdown, commentary, reasoning, null, or extra keys.",
      `Keep description within ${MODEL_DESCRIPTION_MAX_CHARACTERS} characters and each relationship reason within ${MODEL_RELATIONSHIP_REASON_MAX_CHARACTERS} characters. Complete the compact JSON object within the output budget; never reproduce the Markdown body.`,
      'JSON-object compatibility example: {"suggestions":{"title":"","type":"","description":"","tags":[],"keywords":[]},"relationships":[]}.',
      "When no candidate relationship is supported, return an empty relationships array.",
      ...MODEL_SUGGESTION_VALUE_INSTRUCTIONS,
      ...GRAPH_RELATIONSHIP_DECISION_INSTRUCTIONS
    ].join(" "),
    input: relationshipRequest.input,
    text: {
      format: {
        type: "json_schema",
        name: "portable_model_graph_analysis",
        description:
          "Suggestions and evidence-grounded path-linked relationship decisions.",
        strict: true,
        schema: MODEL_GRAPH_ANALYSIS_SCHEMA
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

function boundedPromptText(value: string, maximumCharacters: number): string {
  return [...value.normalize("NFKC").trim()]
    .slice(0, maximumCharacters).join("");
}

function boundedPromptArray(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => boundedPromptText(value, 80)))]
    .filter(Boolean)
    .slice(0, 8);
}

function boundedPromptEvidence(
  evidence: Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, unknown>> {
  if (!evidence) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence).slice(0, 8)) {
    const safeKey = boundedPromptText(key, 64);
    if (!safeKey) continue;
    if (typeof value === "string") {
      const text = boundedPromptText(value, 160);
      if (text) result[safeKey] = text;
      continue;
    }
    if ((typeof value === "number" && Number.isFinite(value))
      || typeof value === "boolean") {
      result[safeKey] = value;
      continue;
    }
    if (!Array.isArray(value)) continue;
    const items: Array<string | number | boolean> = [];
    for (const item of value) {
      if (typeof item === "string") {
        const text = boundedPromptText(item, 80);
        if (text) items.push(text);
      } else if ((typeof item === "number" && Number.isFinite(item))
        || typeof item === "boolean") {
        items.push(item);
      }
      if (items.length === 8) break;
    }
    if (items.length > 0) result[safeKey] = items;
  }
  return result;
}

export function validateModelSuggestions(input: unknown): ModelSuggestions {
  return modelSuggestionsSchema.parse(input);
}

export function validateGraphRelationshipConfirmations(
  input: unknown
): GraphRelationshipConfirmation[] {
  return graphRelationshipConfirmationSchema.parse(input).relationships.map(
    (relationship) => ({
      targetFileId: relationship.candidateId,
      accepted: true,
      relationType: relationship.relationType,
      weight: relationship.confidence,
      reason: relationship.reason
    })
  );
}

export function validateModelGraphAnalysis(input: unknown): {
  suggestions: ModelSuggestions;
  confirmations: GraphRelationshipConfirmation[];
} {
  const value = modelGraphAnalysisSchema.parse(input);
  return {
    suggestions: value.suggestions,
    confirmations: value.relationships.map((relationship) => ({
      targetFileId: relationship.candidateId,
      accepted: true,
      relationType: relationship.relationType,
      weight: relationship.confidence,
      reason: relationship.reason
    }))
  };
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
      receiveTimeouts: input.receiveTimeouts,
      attempt: attempt + 1,
      repair: previousError !== null,
      ...(input.onProviderRequest
        ? { onProviderRequest: input.onProviderRequest }
        : {}),
      ...(input.onProviderObservation
        ? { onProviderObservation: input.onProviderObservation }
        : {})
    });

    if (result.confirmations.length > 0 || result.warnings.length === 0) {
      return result;
    }

    previousError = result.warnings[0] ?? "Graph relationship confirmation failed";

    const retry = classifyModelRetry(input.client, previousError);
    if (attempt === 0 && retry === "transient") {
      await sleep(resolveTransientRetryDelayMs(previousError, input.transientRetryDelayMs));
    } else if (attempt > 0 || retry !== "schema_repair") {
      return result;
    }
  }

  return {
    confirmations: [],
    warnings: [previousError ?? "Graph relationship confirmation failed"]
  };
}

export async function requestModelGraphAnalysis(
  input: BuildModelGraphAnalysisRequestInput & {
    client: OpenAIModelClient;
    receiveTimeouts: ModelReceiveTimeouts;
  }
): Promise<ModelGraphAnalysisResult> {
  let previousError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const requestInput = previousError
      ? { ...input, repair: { previousError } }
      : input;
    const result = await runModelGraphAnalysisAttempt({
      client: input.client,
      request: buildModelGraphAnalysisRequest(requestInput),
      receiveTimeouts: input.receiveTimeouts,
      attempt: attempt + 1,
      repair: previousError !== null,
      ...(input.onProviderRequest
        ? { onProviderRequest: input.onProviderRequest }
        : {}),
      ...(input.onProviderObservation
        ? { onProviderObservation: input.onProviderObservation }
        : {})
    });
    if (result.suggestions) return result;
    previousError = result.warnings[0] ?? "Model graph analysis failed";
    const retry = classifyModelRetry(input.client, previousError);
    if (attempt === 0 && retry === "transient") {
      await sleep(resolveTransientRetryDelayMs(
        previousError, input.transientRetryDelayMs
      ));
    } else if (attempt > 0 || retry !== "schema_repair") {
      return result;
    }
  }
  return modelGraphWarning(previousError ?? "Model graph analysis failed");
}

async function runGraphRelationshipConfirmationAttempt(input: {
  client: OpenAIModelClient;
  request: GraphRelationshipConfirmationRequest;
  receiveTimeouts: ModelReceiveTimeouts;
  attempt: number;
  repair: boolean;
  onProviderRequest?: () => void;
  onProviderObservation?: (observation: ModelProviderObservation) => void;
}): Promise<GraphRelationshipConfirmationResult> {
  const startedAt = Date.now();
  let providerResponse: unknown = null;
  try {
    input.onProviderRequest?.();
    const response = await receiveWithProgressTimeout({
      timeouts: input.receiveTimeouts,
      start: () => sendModelRequest(input.client, input.request)
    });
    providerResponse = response;

    if (containsRefusal(response)) {
      observeProviderAttempt(input, response, startedAt, "refusal");
      return graphWarning("Model refused to confirm graph relationships");
    }

    const status = readStringProperty(response, "status");

    if (status === "incomplete") {
      const reason = readIncompleteReason(response) ?? "unknown";
      observeProviderAttempt(input, response, startedAt, "incomplete");
      return graphWarning(`Model graph confirmation was incomplete: ${reason}`);
    }

    if (status && status !== "completed") {
      observeProviderAttempt(input, response, startedAt, "incomplete");
      return graphWarning(`Model graph confirmation did not complete: ${status}`);
    }

    const finishReason = readChatFinishReason(response);
    if (finishReason === "length") {
      observeProviderAttempt(input, response, startedAt, "incomplete");
      return graphWarning("Model graph confirmation was incomplete: length");
    }
    if (finishReason === "content_filter") {
      observeProviderAttempt(input, response, startedAt, "refusal");
      return graphWarning("Model refused to confirm graph relationships: content_filter");
    }
    if (finishReason && !["stop", "tool_calls"].includes(finishReason)) {
      observeProviderAttempt(input, response, startedAt, "incomplete");
      return graphWarning(`Model graph confirmation did not complete: ${finishReason}`);
    }

    const outputText = readModelOutputText(response);

    if (!outputText) {
      observeProviderAttempt(input, response, startedAt, "schema_validation");
      return graphWarning("Graph relationship confirmation failed local schema validation");
    }
    const result = {
      confirmations: validateGraphRelationshipConfirmations(parseModelOutputJson(outputText)),
      warnings: []
    };
    observeProviderAttempt(input, response, startedAt, "none");
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      observeProviderAttempt(input, providerResponse ?? error, startedAt, "schema_validation");
      return graphWarning(
        `Graph relationship confirmation failed local schema validation: ${formatZodIssues(error)}`
      );
    }

    if (error instanceof SyntaxError) {
      observeProviderAttempt(input, providerResponse ?? error, startedAt, "schema_validation");
      return graphWarning(
        "Graph relationship confirmation failed local schema validation: response was not valid JSON"
      );
    }
    const warning = `Model provider error: ${redactSecrets(error)}`;
    observeProviderAttempt(input, error, startedAt,
      isTransientModelWarning(warning) ? "transient" : "provider");
    return graphWarning(warning);
  }
}

async function runModelGraphAnalysisAttempt(input: {
  client: OpenAIModelClient;
  request: ModelGraphAnalysisRequest;
  receiveTimeouts: ModelReceiveTimeouts;
  attempt: number;
  repair: boolean;
  onProviderRequest?: () => void;
  onProviderObservation?: (observation: ModelProviderObservation) => void;
}): Promise<ModelGraphAnalysisResult> {
  const startedAt = Date.now();
  let providerResponse: unknown = null;
  try {
    input.onProviderRequest?.();
    const response = await receiveWithProgressTimeout({
      timeouts: input.receiveTimeouts,
      start: () => sendModelRequest(input.client, input.request)
    });
    providerResponse = response;
    if (containsRefusal(response)) {
      observeProviderAttempt(input, response, startedAt, "refusal");
      return modelGraphWarning("Model refused to analyze the file graph");
    }
    const status = readStringProperty(response, "status");
    if (status === "incomplete") {
      observeProviderAttempt(input, response, startedAt, "incomplete");
      return modelGraphWarning(
        `Model graph analysis was incomplete: ${readIncompleteReason(response) ?? "unknown"}`
      );
    }
    if (status && status !== "completed") {
      observeProviderAttempt(input, response, startedAt, "incomplete");
      return modelGraphWarning(`Model graph analysis did not complete: ${status}`);
    }
    const finishReason = readChatFinishReason(response);
    if (finishReason === "length") {
      observeProviderAttempt(input, response, startedAt, "incomplete");
      return modelGraphWarning("Model graph analysis was incomplete: length");
    }
    if (finishReason === "content_filter") {
      observeProviderAttempt(input, response, startedAt, "refusal");
      return modelGraphWarning("Model refused to analyze the file graph: content_filter");
    }
    if (finishReason && !["stop", "tool_calls"].includes(finishReason)) {
      observeProviderAttempt(input, response, startedAt, "incomplete");
      return modelGraphWarning(`Model graph analysis did not complete: ${finishReason}`);
    }
    const outputText = readModelOutputText(response);
    if (!outputText) {
      observeProviderAttempt(input, response, startedAt, "schema_validation");
      return modelGraphWarning("Model graph analysis failed local schema validation");
    }
    const value = validateModelGraphAnalysis(parseModelOutputJson(outputText));
    const result = {
      suggestions: value.suggestions,
      confirmations: value.confirmations,
      warnings: []
    };
    observeProviderAttempt(input, response, startedAt, "none");
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      observeProviderAttempt(input, providerResponse ?? error, startedAt, "schema_validation");
      return modelGraphWarning(
        `Model graph analysis failed local schema validation: ${formatZodIssues(error)}`
      );
    }
    if (error instanceof SyntaxError) {
      observeProviderAttempt(input, providerResponse ?? error, startedAt, "schema_validation");
      return modelGraphWarning(
        "Model graph analysis failed local schema validation: response was not valid JSON"
      );
    }
    const warning = `Model provider error: ${redactSecrets(error)}`;
    observeProviderAttempt(input, error, startedAt,
      isTransientModelWarning(warning) ? "transient" : "provider");
    return modelGraphWarning(warning);
  }
}

function sendModelRequest(
  client: OpenAIModelClient,
  request: GraphRelationshipConfirmationRequest | ModelGraphAnalysisRequest
): Promise<unknown> {
  if (isChatCompletionsClient(client)) {
    return client.chat.completions.create(toChatCompletionsJsonRequest(
      request,
      client.structuredOutputCapability ?? "native_json_schema"
    ));
  }

  return client.responses.create(request);
}

function isChatCompletionsClient(client: OpenAIModelClient): client is OpenAIChatCompletionsClient {
  return client.apiMode === "chat_completions";
}

function toChatCompletionsJsonRequest(
  request: GraphRelationshipConfirmationRequest | ModelGraphAnalysisRequest,
  capability: StructuredOutputCapability
): ChatCompletionsJsonRequest {
  const converted: ChatCompletionsJsonRequest = {
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
      type: "json_schema",
      json_schema: {
        name: request.text.format.name,
        description: request.text.format.description,
        strict: true,
        schema: request.text.format.schema
      }
    },
    max_tokens: request.max_output_tokens,
    stream: false
  };
  return capability === "json_object_compatibility"
    ? toJsonObjectCompatibilityRequest(converted)
    : converted;
}

function toJsonObjectCompatibilityRequest(
  request: ChatCompletionsJsonRequest
): ChatCompletionsJsonRequest {
  return {
    ...request,
    response_format: { type: "json_object" }
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

function modelGraphWarning(message: string): ModelGraphAnalysisResult {
  return {
    suggestions: null,
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

function classifyModelRetry(
  client: OpenAIModelClient,
  message: string
): "none" | "transient" | "schema_repair" {
  if (isTransientModelWarning(message)) return "transient";
  if (isChatCompletionsClient(client)
    && client.structuredOutputCapability === "json_object_compatibility"
    && message.toLowerCase().includes("local schema validation")) {
    return "schema_repair";
  }
  return "none";
}

function isExplicitUnsupportedJsonSchemaError(error: unknown): boolean {
  const record = readRecord(error);
  const status = typeof record?.status === "number" ? record.status : null;
  if (status !== 400 && status !== 422) return false;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const namesStructuredField = normalized.includes("json_schema")
    || normalized.includes("response_format");
  const saysUnsupported = normalized.includes("unsupported")
    || normalized.includes("not supported")
    || normalized.includes("unavailable")
    || normalized.includes("unknown")
    || normalized.includes("invalid type")
    || normalized.includes("invalid value")
    || normalized.includes("supported values")
    || normalized.includes("must be one of");
  return namesStructuredField && saysUnsupported;
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

function readChatFinishReason(response: unknown): string | null {
  const responseObject = readRecord(response);
  const choices = Array.isArray(responseObject?.choices) ? responseObject.choices : [];
  const firstChoice = readRecord(choices[0]);
  return readStringProperty(firstChoice, "finish_reason");
}

function observeProviderAttempt(
  input: {
    client: OpenAIModelClient;
    attempt: number;
    repair: boolean;
    onProviderObservation?: (observation: ModelProviderObservation) => void;
  },
  response: unknown,
  startedAt: number,
  errorClass: ModelProviderObservation["errorClass"]
): void {
  if (!input.onProviderObservation) return;
  const usage = readRecord(readRecord(response)?.usage);
  const inputDetails = readRecord(
    usage?.input_tokens_details ?? usage?.prompt_tokens_details
  );
  const chatClient = isChatCompletionsClient(input.client)
    ? input.client : null;
  const apiMode = chatClient
    ? "chat_completions" : "responses";
  const capability = apiMode === "responses" ? "native_json_schema"
    : chatClient?.structuredOutputCapability === "auto"
      || chatClient?.structuredOutputCapability === undefined
      ? "unknown"
      : chatClient.structuredOutputCapability;
  input.onProviderObservation({
    apiMode,
    structuredOutputCapability: capability,
    attempt: input.attempt,
    repair: input.repair,
    requestId: readStringProperty(response, "id")
      ?? readStringProperty(response, "request_id"),
    finishState: readStringProperty(response, "status")
      ?? readChatFinishReason(response),
    inputTokens: readFiniteInteger(
      usage?.input_tokens ?? usage?.prompt_tokens
    ),
    outputTokens: readFiniteInteger(
      usage?.output_tokens ?? usage?.completion_tokens
    ),
    cachedInputTokens: readFiniteInteger(inputDetails?.cached_tokens),
    serviceTimeMs: Math.max(0, Date.now() - startedAt),
    errorClass
  });
}

function readFiniteInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
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
    .replace(/(MODEL_API_KEY\s*[:=]\s*)[^\s,;}\]]+/gi, "$1<redacted>")
    .replace(/\bsk-[A-Za-z0-9._~+/-]{6,}=*/gi, "<redacted>");
}

function sanitizeRepairText(value: string): string {
  return redactSecrets(value).replace(/\s+/g, " ").slice(0, 500);
}
