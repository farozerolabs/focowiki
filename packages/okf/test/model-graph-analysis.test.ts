import { describe, expect, it, vi } from "vitest";
import {
  buildModelGraphAnalysisRequest,
  createRevisionScopedChatCompletionsClient,
  requestModelGraphAnalysis,
  validateModelGraphAnalysis
} from "../src/model.js";
import { estimateTokenCount } from "../src/model-source-view.js";

const input = {
  modelName: "general-model",
  currentFile: {
    fileId: "source-a",
    path: "pages/a.md",
    title: "Climate Operations"
  },
  body: "# Climate Operations\n\nSee the maintenance guide.",
  candidates: [{
    fromFileId: "source-a",
    toFileId: "source-b",
    relationType: "direct_reference",
    weight: 0.9,
    reason: "The source names the maintenance guide.",
    source: "deterministic" as const,
    evidence: { sourceExcerpt: "See the maintenance guide." }
  }],
  candidateFiles: [{
    fileId: "source-b",
    path: "pages/maintenance.md",
    title: "Maintenance Guide",
    evidenceExcerpt: "The guide describes maintenance procedures."
  }],
  contextWindowTokens: 32_000
};

describe("combined model graph analysis", () => {
  it("builds one strict response containing suggestions and relationships", () => {
    const request = buildModelGraphAnalysisRequest(input);
    expect(request.text.format.name).toBe("portable_model_graph_analysis");
    expect(request.text.format.schema.required).toEqual([
      "suggestions", "relationships"
    ]);
    const prompt = request.input[0]!.content[0]!.text;
    expect(prompt).toContain("source-b");
    expect(prompt).toContain(
      "The guide describes maintenance procedures."
    );
    expect(prompt.split(input.body)).toHaveLength(2);
    expect(request.instructions).toContain("Return one JSON object");
    expect(request.instructions).toContain("same uniquely identifiable entity");
    expect(request.instructions).toContain("direction-neutral durable fact");
    expect(request.instructions).toContain("preliminary proposal");
    expect(request.instructions).toContain("return the evidence-accurate relationType");
    expect(request.instructions).toContain(
      "Each tag and keyword must be at most 128 UTF-8 bytes"
    );
    expect(request.instructions).toContain(
      "Return at most 16 tags and at most 32 keywords"
    );
    expect(request.instructions).toContain(
      "Return at most 50 accepted relationships"
    );
    expect(request.instructions).toContain(
      "Keep description within 600 characters and each relationship reason within 240 characters"
    );
    expect(request.max_output_tokens).toBe(8_192);
    expect(request.text.format.schema.properties.suggestions.properties.tags)
      .toMatchObject({ maxItems: 16, items: { maxLength: 128 } });
    expect(request.text.format.schema.properties.suggestions.properties.keywords)
      .toMatchObject({ maxItems: 32, items: { maxLength: 128 } });
    expect(request.text.format.schema.properties.suggestions.properties)
      .not.toHaveProperty("related_links");
    expect(request.text.format.schema.properties.relationships.items.required)
      .toEqual(["candidateId", "relationType", "confidence", "reason"]);
    expect(request.instructions).toContain(
      "candidateId is the only authoritative target identity"
    );
    expect(request.text.format.schema.properties.relationships)
      .toMatchObject({ maxItems: 50 });
    expect(request.text.format.schema.properties.relationships.items.properties.reason)
      .toMatchObject({ maxLength: 240 });
  });

  it("rejects suggestion terms that exceed the structured-output contract", () => {
    expect(() => validateModelGraphAnalysis({
      suggestions: {
        title: "Climate Operations",
        type: "guide",
        description: "Operations guidance.",
        tags: ["x".repeat(129)],
        keywords: []
      },
      relationships: []
    })).toThrow();
  });

  it.each([
    {
      title: "海岸气象站维护",
      body: "# 海岸气象站维护\n\n参见设备校准指南。",
      excerpt: "设备校准指南说明传感器校准步骤。"
    },
    {
      title: "Habitat Operations",
      body: "# Habitat Operations\n\nSee the restoration field guide.",
      excerpt: "The field guide covers habitat restoration."
    }
  ])("keeps multilingual source and bounded candidate evidence distinct for $title", (fixture) => {
    const candidateBodySentinel = "FULL_CANDIDATE_BODY_MUST_NOT_APPEAR";
    const request = buildModelGraphAnalysisRequest({
      ...input,
      currentFile: { ...input.currentFile, title: fixture.title },
      body: fixture.body,
      candidateFiles: [{
        ...input.candidateFiles[0]!,
        evidenceExcerpt: fixture.excerpt
      }]
    });
    const prompt = request.input[0]!.content[0]!.text;
    expect(prompt).toContain(fixture.body);
    expect(prompt.split(fixture.body)).toHaveLength(2);
    expect(prompt).toContain(fixture.excerpt);
    expect(prompt).not.toContain(candidateBodySentinel);
  });

  it("builds a bounded representative source view for long CJK documents", () => {
    const longBody = Array.from({ length: 48 }, (_, index) =>
      `## 第${index + 1}章\n${"中华人民共和国法律条文与实施规则。".repeat(900)}`
    ).join("\n\n");
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      ...input.candidates[0]!,
      toFileId: `source-${index + 1}`,
      reason: `Candidate ${index + 1} ${"候选理由".repeat(300)}`,
      evidence: { sourceExcerpt: "来源证据".repeat(1_000) }
    }));
    const candidateFiles = candidates.map((candidate, index) => ({
      ...input.candidateFiles[0]!,
      fileId: candidate.toFileId,
      path: `pages/candidate-${index + 1}.md`,
      title: `候选文档 ${index + 1}`,
      summary: "候选文档摘要。".repeat(20),
      evidenceExcerpt: "候选证据。".repeat(2_000)
    }));

    const request = buildModelGraphAnalysisRequest({
      ...input,
      body: longBody,
      candidates,
      candidateFiles,
      contextWindowTokens: 1_000_000
    });
    const prompt = request.input[0]!.content[0]!.text;

    expect(prompt).toContain("truncated: true");
    expect(prompt).toContain("Middle excerpt 1:");
    expect(prompt).toContain("Middle excerpt 2:");
    expect(prompt).not.toContain("候选证据。".repeat(100));
    expect(prompt).not.toContain("来源证据".repeat(100));
    expect(estimateTokenCount(`${request.instructions}\n${prompt}`))
      .toBeLessThanOrEqual(16_500);
  });

  it("adds one explicit schema repair only in JSON-object compatibility mode", async () => {
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const create = vi.fn(async (request: {
      messages: Array<{ role: string; content: string }>;
    }) => {
      requests.push(request);
      if (requests.length === 1) {
        return { choices: [{ message: { content: JSON.stringify({
          title: "Wrong top-level shape",
          relationships: []
        }) } }] };
      }
      return { choices: [{ message: { content: JSON.stringify({
        suggestions: {
          title: "Climate Operations",
          type: "guide",
          description: "Operations guidance.",
          tags: ["climate"],
          keywords: ["maintenance"]
        },
        relationships: []
      }) } }] };
    });

    const result = await requestModelGraphAnalysis({
      ...input,
      receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
      client: {
        apiMode: "chat_completions",
        structuredOutputCapability: "json_object_compatibility",
        chat: { completions: { create } }
      }
    });

    expect(result.warnings).toEqual([]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(requests[1]?.messages[1]?.content).toContain("Previous attempt error:");
    expect(requests[1]?.messages[1]?.content).toContain("suggestions");
    expect(requests[1]?.messages[0]?.content).toContain("Return one JSON object");
  });

  it("returns suggestions and relationship decisions from one provider call", async () => {
    const observations: unknown[] = [];
    const create = vi.fn(async (_request: {
      response_format: unknown;
      max_tokens: number;
    }) => ({
      id: "chat-request-1",
      choices: [{
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            suggestions: {
              title: "Climate Operations",
              type: "guide",
              description: "Operations guidance.",
              tags: ["climate"],
              keywords: ["maintenance"]
            },
            relationships: [{
              candidateId: "source-b",
              relationType: "direct_reference",
              confidence: 0.94,
              reason: "The maintenance guide is visibly referenced."
            }]
          })
        }
      }],
      usage: {
        prompt_tokens: 320,
        completion_tokens: 84,
        prompt_tokens_details: { cached_tokens: 128 }
      }
    }));

    await expect(requestModelGraphAnalysis({
      ...input,
      receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
      onProviderObservation: (observation) => observations.push(observation),
      client: {
        apiMode: "chat_completions",
        structuredOutputCapability: "native_json_schema",
        chat: { completions: { create } }
      }
    })).resolves.toMatchObject({
      suggestions: { title: "Climate Operations" },
      confirmations: [{ targetFileId: "source-b", accepted: true }],
      warnings: []
    });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0].response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "portable_model_graph_analysis",
        strict: true
      }
    });
    expect(create.mock.calls[0]?.[0].max_tokens).toBe(8_192);
    expect(observations).toEqual([expect.objectContaining({
      apiMode: "chat_completions",
      structuredOutputCapability: "native_json_schema",
      attempt: 1,
      repair: false,
      requestId: "chat-request-1",
      finishState: "stop",
      inputTokens: 320,
      outputTokens: 84,
      cachedInputTokens: 128,
      errorClass: "none"
    })]);
  });

  it("keeps strict schema in the Responses API text format", async () => {
    const create = vi.fn(async (request: unknown) => ({
      id: "response-request-1",
      status: "completed",
      output_text: JSON.stringify({
        suggestions: {
          title: "Climate Operations",
          type: "guide",
          description: "Operations guidance.",
          tags: ["climate"],
          keywords: ["maintenance"]
        },
        relationships: []
      }),
      usage: {
        input_tokens: 280,
        output_tokens: 40,
        input_tokens_details: { cached_tokens: 96 }
      },
      request
    }));
    const observations: unknown[] = [];

    const result = await requestModelGraphAnalysis({
      ...input,
      receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
      onProviderObservation: (observation) => observations.push(observation),
      client: { responses: { create } }
    });

    expect(result.suggestions?.title).toBe("Climate Operations");
    expect(create).toHaveBeenCalledOnce();
    const sent = create.mock.calls[0]?.[0] as ReturnType<
      typeof buildModelGraphAnalysisRequest
    >;
    expect(sent.text.format).toMatchObject({
      type: "json_schema",
      name: "portable_model_graph_analysis",
      strict: true
    });
    expect(sent.max_output_tokens).toBe(8_192);
    expect(observations).toEqual([expect.objectContaining({
      apiMode: "responses",
      structuredOutputCapability: "native_json_schema",
      requestId: "response-request-1",
      finishState: "completed",
      inputTokens: 280,
      outputTokens: 40,
      cachedInputTokens: 96,
      errorClass: "none"
    })]);
  });

  it("pins an explicit unsupported Chat JSON Schema response to JSON-object compatibility", async () => {
    const formats: string[] = [];
    const rawCreate = vi.fn(async (request: { response_format: { type: string } }) => {
      formats.push(request.response_format.type);
      if (request.response_format.type === "json_schema") {
        throw Object.assign(new Error(
          "Invalid value for response_format: json_schema. Supported values are text and json_object"
        ), {
          status: 400,
          code: "invalid_request_error"
        });
      }
      return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        suggestions: {
          title: "Climate Operations",
          type: "guide",
          description: "Operations guidance.",
          tags: ["climate"],
          keywords: ["maintenance"]
        },
        relationships: []
      }) } }] };
    });
    const client = createRevisionScopedChatCompletionsClient(rawCreate);

    await requestModelGraphAnalysis({
      ...input,
      receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
      client
    });
    await requestModelGraphAnalysis({
      ...input,
      receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
      client
    });

    expect(formats).toEqual(["json_schema", "json_object", "json_object"]);
    expect(client.structuredOutputCapability).toBe("json_object_compatibility");
  });

  it("pins an explicitly unavailable Chat response format to JSON-object compatibility", async () => {
    const formats: string[] = [];
    const rawCreate = vi.fn(async (request: { response_format: { type: string } }) => {
      formats.push(request.response_format.type);
      if (request.response_format.type === "json_schema") {
        throw Object.assign(new Error("400 This response_format type is unavailable now"), {
          status: 400,
          code: "invalid_request_error"
        });
      }
      return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        suggestions: {
          title: "Climate Operations",
          type: "guide",
          description: "Operations guidance.",
          tags: ["climate"],
          keywords: ["maintenance"]
        },
        relationships: []
      }) } }] };
    });
    const client = createRevisionScopedChatCompletionsClient(rawCreate);

    const result = await requestModelGraphAnalysis({
      ...input,
      receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
      client
    });

    expect(result.suggestions?.title).toBe("Climate Operations");
    expect(formats).toEqual(["json_schema", "json_object"]);
    expect(client.structuredOutputCapability).toBe("json_object_compatibility");
  });

  it("does not downgrade or duplicate unrelated provider failures", async () => {
    const rawCreate = vi.fn(async () => {
      throw Object.assign(new Error("invalid api key sk-secret-value"), {
        status: 401,
        code: "authentication_error"
      });
    });
    const client = createRevisionScopedChatCompletionsClient(rawCreate);

    const result = await requestModelGraphAnalysis({
      ...input,
      receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
      client
    });

    expect(rawCreate).toHaveBeenCalledOnce();
    expect(client.structuredOutputCapability).toBe("auto");
    expect(result.suggestions).toBeNull();
    expect(result.warnings[0]).not.toContain("sk-secret-value");
  });

  it("treats Chat length termination as incomplete without schema repair", async () => {
    const create = vi.fn(async () => ({
      choices: [{ finish_reason: "length", message: { content: "{}" } }]
    }));

    const result = await requestModelGraphAnalysis({
      ...input,
      receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
      client: {
        apiMode: "chat_completions",
        structuredOutputCapability: "json_object_compatibility",
        chat: { completions: { create } }
      }
    });

    expect(create).toHaveBeenCalledOnce();
    expect(result.warnings).toEqual([
      "Model graph analysis was incomplete: length"
    ]);
  });

  it("does not repair a native-schema response that violates the local contract", async () => {
    const create = vi.fn(async () => ({
      choices: [{ finish_reason: "stop", message: { content: "{}" } }]
    }));

    const result = await requestModelGraphAnalysis({
      ...input,
      receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
      client: {
        apiMode: "chat_completions",
        structuredOutputCapability: "native_json_schema",
        chat: { completions: { create } }
      }
    });

    expect(create).toHaveBeenCalledOnce();
    expect(result.warnings[0]).toContain("local schema validation");
  });

  it("retries one transient rate limit without changing structured capability", async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("429 rate limit"), {
        status: 429
      }))
      .mockResolvedValueOnce({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
          suggestions: {
            title: "Climate Operations",
            type: "guide",
            description: "Operations guidance.",
            tags: ["climate"],
            keywords: ["maintenance"]
          },
          relationships: []
        }) } }]
      });
    const client = createRevisionScopedChatCompletionsClient(create);

    const result = await requestModelGraphAnalysis({
      ...input,
      transientRetryDelayMs: 0,
      receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
      client
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(client.structuredOutputCapability).toBe("native_json_schema");
    expect(result.suggestions?.title).toBe("Climate Operations");
  });

  it("keeps Responses refusal terminal", async () => {
    const create = vi.fn(async () => ({
      status: "completed",
      output: [{ content: [{ type: "refusal", refusal: "Cannot comply" }] }]
    }));

    const result = await requestModelGraphAnalysis({
      ...input,
      receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
      client: { responses: { create } }
    });

    expect(create).toHaveBeenCalledOnce();
    expect(result.warnings).toEqual(["Model refused to analyze the file graph"]);
  });
});
