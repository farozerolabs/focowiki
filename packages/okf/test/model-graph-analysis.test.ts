import { describe, expect, it, vi } from "vitest";
import {
  buildGraphRelationshipConfirmationRequest,
  buildModelGraphAnalysisRequest,
  createRevisionScopedChatCompletionsClient,
  requestGraphRelationshipConfirmations,
  requestModelGraphAnalysis,
  resolveChatCompletionsThinkingControl,
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("model graph analysis", () => {
  it("streams Chat front-layer analysis and renews the idle deadline on every event", async () => {
    const requests: unknown[] = [];
    const output = JSON.stringify({
      suggestions: {
        title: "Climate Operations",
        type: "guide",
        description: "Operations guidance.",
        tags: ["climate"],
        keywords: ["maintenance"]
      }
    });
    const create = vi.fn(async (request: unknown) => {
      requests.push(request);
      return (async function* () {
        for (const part of [output.slice(0, 30), output.slice(30, 70), output.slice(70)]) {
          await wait(15);
          yield {
            id: "chat-stream-1",
            choices: [{ delta: { content: part }, finish_reason: null }]
          };
        }
        await wait(15);
        yield {
          id: "chat-stream-1",
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 320,
            completion_tokens: 84,
            prompt_tokens_details: { cached_tokens: 128 }
          }
        };
      })();
    });

    const result = await requestModelGraphAnalysis({
      ...input,
      receiveTimeouts: { maxMs: 500, idleMs: 25 },
      client: {
        apiMode: "chat_completions",
        structuredOutputCapability: "native_json_schema",
        chat: { completions: { create } }
      }
    });

    expect(result).toMatchObject({
      suggestions: { title: "Climate Operations" },
      warnings: []
    });
    expect(requests).toEqual([expect.objectContaining({ stream: true })]);
    expect(requests).toEqual([expect.objectContaining({
      stream_options: { include_usage: true }
    })]);
  });

  it("streams Chat relationship confirmation before validating complete JSON", async () => {
    const requests: unknown[] = [];
    const output = JSON.stringify({
      relationships: [{
        candidateId: "source-b",
        relationType: "direct_reference",
        reason: "Climate Operations explicitly names Maintenance Guide."
      }]
    });
    const create = vi.fn(async (request: unknown) => {
      requests.push(request);
      return (async function* () {
        yield { choices: [{ delta: { content: output.slice(0, 50) }, finish_reason: null }] };
        yield { choices: [{ delta: { content: output.slice(50) }, finish_reason: "stop" }] };
      })();
    });

    const result = await requestGraphRelationshipConfirmations({
      ...input,
      receiveTimeouts: { maxMs: 500, idleMs: 100 },
      client: {
        apiMode: "chat_completions",
        structuredOutputCapability: "native_json_schema",
        chat: { completions: { create } }
      }
    });

    expect(result).toMatchObject({
      confirmations: [{ targetFileId: "source-b", relationType: "direct_reference" }],
      warnings: []
    });
    expect(requests).toEqual([expect.objectContaining({ stream: true })]);
  });

  it("streams Responses structured output and preserves terminal observations", async () => {
    const requests: unknown[] = [];
    const observations: unknown[] = [];
    const output = JSON.stringify({
      suggestions: {
        title: "Climate Operations",
        type: "guide",
        description: "Operations guidance.",
        tags: ["climate"],
        keywords: ["maintenance"]
      }
    });
    const create = vi.fn(async (request: unknown) => {
      requests.push(request);
      return (async function* () {
        yield { type: "response.output_text.delta", delta: output.slice(0, 40) };
        yield { type: "response.output_text.delta", delta: output.slice(40) };
        yield {
          type: "response.completed",
          response: {
            id: "response-stream-1",
            status: "completed",
            usage: {
              input_tokens: 280,
              output_tokens: 40,
              input_tokens_details: { cached_tokens: 96 }
            }
          }
        };
      })();
    });

    const result = await requestModelGraphAnalysis({
      ...input,
      receiveTimeouts: { maxMs: 500, idleMs: 100 },
      onProviderObservation: (observation) => observations.push(observation),
      client: { responses: { create } }
    });

    expect(result).toMatchObject({
      suggestions: { title: "Climate Operations" },
      warnings: []
    });
    expect(requests).toEqual([expect.objectContaining({ stream: true })]);
    expect(observations).toEqual([expect.objectContaining({
      requestId: "response-stream-1",
      finishState: "completed",
      inputTokens: 280,
      outputTokens: 40,
      cachedInputTokens: 96,
      errorClass: "none"
    })]);
  });

  it("rejects a Chat stream that closes without a terminal finish reason", async () => {
    const output = JSON.stringify({
      suggestions: {
        title: "Climate Operations",
        type: "guide",
        description: "Operations guidance.",
        tags: [],
        keywords: []
      }
    });
    const create = vi.fn(async () => (async function* () {
      yield { choices: [{ delta: { content: output }, finish_reason: null }] };
    })());

    const result = await requestModelGraphAnalysis({
      ...input,
      receiveTimeouts: { maxMs: 500, idleMs: 100 },
      client: {
        apiMode: "chat_completions",
        structuredOutputCapability: "native_json_schema",
        chat: { completions: { create } }
      }
    });

    expect(result.suggestions).toBeNull();
    expect(result.warnings).toEqual([
      "Model graph analysis did not complete: stream_ended"
    ]);
  });

  it("rejects a Responses stream that closes without a terminal event", async () => {
    const output = JSON.stringify({
      suggestions: {
        title: "Climate Operations",
        type: "guide",
        description: "Operations guidance.",
        tags: [],
        keywords: []
      }
    });
    const create = vi.fn(async () => (async function* () {
      yield { type: "response.output_text.delta", delta: output };
    })());

    const result = await requestModelGraphAnalysis({
      ...input,
      receiveTimeouts: { maxMs: 500, idleMs: 100 },
      client: { responses: { create } }
    });

    expect(result.suggestions).toBeNull();
    expect(result.warnings).toEqual([
      "Model graph analysis did not complete: stream_ended"
    ]);
  });

  it("times out and rejects partial streamed JSON after progress stops", async () => {
    const create = vi.fn(async () => (async function* () {
      yield { choices: [{ delta: { content: "{\"suggestions\":" }, finish_reason: null }] };
      await wait(80);
      yield { choices: [{ delta: { content: "{}" }, finish_reason: "stop" }] };
    })());

    const result = await requestModelGraphAnalysis({
      ...input,
      transientRetryDelayMs: 0,
      receiveTimeouts: { maxMs: 200, idleMs: 20 },
      client: {
        apiMode: "chat_completions",
        structuredOutputCapability: "native_json_schema",
        chat: { completions: { create } }
      }
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.suggestions).toBeNull();
    expect(result.warnings[0]).toContain("idle timeout");
  });

  it("builds one compact strict response containing only suggestions", () => {
    const request = buildModelGraphAnalysisRequest(input);
    expect(request.instructions).toContain("# Task");
    expect(request.instructions).toContain("## Output contract");
    expect(request.instructions).toContain("```json");
    expect(request.text.format.name).toBe("portable_model_graph_analysis");
    expect(request.text.format.schema.required).toEqual(["suggestions"]);
    const prompt = request.input[0]!.content[0]!.text;
    expect(prompt).toContain("# Current document");
    expect(prompt).toContain("# Source Markdown");
    expect(prompt).not.toContain("source-b");
    expect(prompt).not.toContain("Candidate relationships:");
    expect(prompt).not.toContain("The guide describes maintenance procedures.");
    expect(prompt.split(input.body)).toHaveLength(2);
    expect(request.instructions).toContain("Return one JSON object");
    expect(request.instructions).not.toContain("relationship reviewer");
    expect(request.instructions).not.toContain("candidateId");
    expect(request.instructions).toContain(
      "Each tag and keyword must be at most 128 UTF-8 bytes"
    );
    expect(request.instructions).toContain(
      "Return at most 16 tags and at most 32 keywords"
    );
    expect(request).not.toHaveProperty("max_output_tokens");
    expect(request.reasoning).toEqual({ effort: "none" });
    expect(request.text.format.schema.properties.suggestions.properties.tags)
      .toMatchObject({ maxItems: 16, items: { maxLength: 128 } });
    expect(request.text.format.schema.properties.suggestions.properties.keywords)
      .toMatchObject({ maxItems: 32, items: { maxLength: 128 } });
    expect(request.text.format.schema.properties.suggestions.properties)
      .not.toHaveProperty("related_links");
    expect(request.text.format.schema.properties).not.toHaveProperty("relationships");
  });

  it("builds a minimal top-ten relationship request and output contract", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      ...input.candidates[0]!,
      toFileId: `candidate-${String(index + 1).padStart(4, "0")}`,
      reason: `Internal preliminary reason ${index + 1}`,
      evidence: {
        sourceExcerpt: `Source evidence ${index + 1}`,
        internalScore: 0.9
      }
    }));
    const candidateFiles = candidates.map((candidate, index) => ({
      ...input.candidateFiles[0]!,
      fileId: candidate.toFileId,
      path: `pages/private-${index + 1}.md`,
      title: `Candidate ${index + 1}`,
      type: "private-type",
      summary: `Private summary ${index + 1}`,
      tags: ["private-tag"],
      entities: ["private-entity"],
      evidenceExcerpt: `Target evidence ${index + 1}`
    }));

    const request = buildGraphRelationshipConfirmationRequest({
      ...input,
      body: "FULL_CURRENT_BODY_MUST_NOT_APPEAR",
      candidates,
      candidateFiles
    });
    const prompt = request.input[0]!.content[0]!.text;

    expect(request.instructions).toContain("# Task");
    expect(request.instructions).toContain("## Output contract");
    expect(request.instructions).toContain("### Supported relationship");
    expect(request.instructions).toContain("### No supported relationship");
    expect(request.instructions).toContain("```json");
    expect(request.instructions).toContain(
      "Write reason in the primary natural language of the supplied title and evidence"
    );
    expect(request.instructions).toContain(
      "Output the JSON object immediately without restating or analyzing candidates"
    );
    expect(prompt).toContain("# Current document");
    expect(prompt).toContain("# Candidate documents");
    expect(request).not.toHaveProperty("max_output_tokens");
    expect(request.reasoning).toEqual({ effort: "none" });
    expect(request.text.format.schema.properties.relationships)
      .toMatchObject({ maxItems: 10 });
    expect(request.text.format.schema.properties.relationships.items.required)
      .toEqual(["candidateId", "relationType", "reason"]);
    expect(request.text.format.schema.properties.relationships.items.properties)
      .not.toHaveProperty("confidence");
    expect(request.text.format.schema.properties.relationships.items.properties.reason)
      .toMatchObject({ maxLength: 120 });
    expect(request.instructions).toContain(
      '{"relationships":[{"candidateId":"candidate-0001","relationType":"same_specific_subject","reason":"Both documents address the same specific subject."}]}'
    );
    expect(request.instructions).toContain('{"relationships":[]}');
    expect(prompt).toContain("candidate-0010");
    expect(prompt).not.toContain("candidate-0011");
    expect(prompt).toContain("Source evidence 1");
    expect(prompt).toContain("Target evidence 1");
    expect(prompt).not.toContain("FULL_CURRENT_BODY_MUST_NOT_APPEAR");
    expect(prompt).not.toContain("private-1.md");
    expect(prompt).not.toContain("private-type");
    expect(prompt).not.toContain("Private summary");
    expect(prompt).not.toContain("private-tag");
    expect(prompt).not.toContain("private-entity");
    expect(prompt).not.toContain("Internal preliminary reason");
  });

  it("accepts the minimal relationship output without model confidence", async () => {
    const create = vi.fn(async () => ({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        relationships: [{
          candidateId: "source-b",
          relationType: "direct_reference",
          reason: "Climate Operations explicitly names Maintenance Guide."
        }]
      }) } }]
    }));

    await expect(requestGraphRelationshipConfirmations({
      ...input,
      receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
      client: {
        apiMode: "chat_completions",
        structuredOutputCapability: "native_json_schema",
        chat: { completions: { create } }
      }
    })).resolves.toMatchObject({
      confirmations: [{
        targetFileId: "source-b",
        accepted: true,
        relationType: "direct_reference"
      }],
      warnings: []
    });
  });

  it("rejects suggestion terms that exceed the structured-output contract", () => {
    expect(() => validateModelGraphAnalysis({
      suggestions: {
        title: "Climate Operations",
        type: "guide",
        description: "Operations guidance.",
        tags: ["x".repeat(129)],
        keywords: []
      }
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
  ])("keeps multilingual source independent from relationship candidates for $title", (fixture) => {
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
    expect(prompt).not.toContain(fixture.excerpt);
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
        }
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

  it("returns source suggestions from one provider call", async () => {
    const observations: unknown[] = [];
    const create = vi.fn(async (_request: {
      response_format: unknown;
      reasoning_effort?: "none";
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
            }
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
      confirmations: [],
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
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("max_tokens");
    expect(create.mock.calls[0]?.[0].reasoning_effort).toBe("none");
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
        }
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
    expect(sent).not.toHaveProperty("max_output_tokens");
    expect(sent.reasoning).toEqual({ effort: "none" });
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
        }
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

  it("keeps plain Chat completions unstructured and forwards request options", async () => {
    const formats: Array<string | null> = [];
    const options: unknown[] = [];
    const rawCreate = vi.fn(async (
      request: { response_format?: { type: string } },
      requestOptions?: { signal?: AbortSignal }
    ) => {
      formats.push(request.response_format?.type ?? null);
      options.push(requestOptions ?? null);
      if (request.response_format?.type === "json_schema") {
        throw Object.assign(new Error(
          "Invalid value for response_format: json_schema. Supported values are text and json_object"
        ), { status: 400, code: "invalid_request_error" });
      }
      return { choices: [{ finish_reason: "stop", message: { content: "ok" } }] };
    });
    const client = createRevisionScopedChatCompletionsClient(rawCreate as never);
    const structuredRequest = {
      model: "model-a",
      messages: [{ role: "user", content: "Return JSON" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "test",
          description: "test",
          strict: true,
          schema: { type: "object" }
        }
      },
      max_tokens: 100,
      stream: true,
      stream_options: { include_usage: true }
    } as const;
    await client.chat.completions.create(structuredRequest as never);
    const controller = new AbortController();
    const createPlain = client.chat.completions.create as unknown as (
      request: {
        model: string;
        messages: Array<{ role: "system" | "user"; content: string }>;
        stream: true;
      },
      options?: { signal?: AbortSignal }
    ) => Promise<unknown>;
    await createPlain({
      model: "model-a",
      messages: [
        { role: "system", content: "Return tuple records" },
        { role: "user", content: "Extract relationships" }
      ],
      stream: true
    }, { signal: controller.signal });

    expect(formats).toEqual(["json_schema", "json_object", null]);
    expect(options[2]).toEqual({ signal: controller.signal });
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
        }
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

  it("accepts an exact flat suggestion object from JSON-object compatibility",
    async () => {
      const create = vi.fn(async () => ({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
          title: "Climate Operations",
          type: "guide",
          description: "Operations guidance.",
          tags: ["climate"],
          keywords: ["maintenance"]
        }) } }]
      }));
      const client = createRevisionScopedChatCompletionsClient(create);
      Object.defineProperty(client, "structuredOutputCapability", {
        get: () => "json_object_compatibility"
      });

      const result = await requestModelGraphAnalysis({
        ...input,
        receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
        client
      });

      expect(result).toMatchObject({
        suggestions: { title: "Climate Operations" },
        warnings: []
      });
      expect(create).toHaveBeenCalledOnce();
    });

  it("uses the official DeepSeek non-thinking request control", async () => {
    expect(resolveChatCompletionsThinkingControl("https://api.deepseek.com"))
      .toBe("deepseek_disabled");
    expect(resolveChatCompletionsThinkingControl("https://api.openai.com/v1"))
      .toBe("openai_reasoning_effort_none");
    const requests: Array<Record<string, unknown>> = [];
    const create = vi.fn(async (request: Record<string, unknown>) => {
      requests.push(request);
      return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        suggestions: {
          title: "Climate Operations",
          type: "guide",
          description: "Operations guidance.",
          tags: [],
          keywords: []
        }
      }) } }] };
    });
    const client = createRevisionScopedChatCompletionsClient(create as never, {
      thinkingControl: "deepseek_disabled"
    });

    await requestModelGraphAnalysis({
      ...input,
      modelName: "deepseek-v4-flash",
      receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
      client
    });

    await client.chat.completions.create({
      model: "deepseek-v4-flash",
      reasoning_effort: "none",
      messages: [{ role: "user", content: "Return tuple records." }],
      stream: true
    } as never);

    expect(requests[0]).toMatchObject({
      thinking: { type: "disabled" }
    });
    expect(requests[0]).not.toHaveProperty("reasoning_effort");
    expect(requests[1]).toMatchObject({
      thinking: { type: "disabled" },
      stream: true
    });
    expect(requests[1]).not.toHaveProperty("reasoning_effort");
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
          }
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
