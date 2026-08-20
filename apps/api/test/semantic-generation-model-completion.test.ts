import { describe, expect, it, vi } from "vitest";
import type { ModelAssistanceOptions } from
  "../src/runtime-settings/model-assistance-options.js";
import {
  createGraphRagGenerationModelCompletion
} from "../src/semantic/graphrag/generation-model-completion.js";

describe("GraphRAG generation-model completion", () => {
  it.each(["responses", "chat_completions"] as const)(
    "uses the configured %s API mode without requesting JSON",
    async (apiMode) => {
      const create = vi.fn(async (_request: unknown) => apiMode === "responses"
        ? { status: "completed", output_text: "tuples<|COMPLETE|>" }
        : { choices: [{ message: { content: "tuples<|COMPLETE|>" } }] });
      const assistance = modelAssistance(apiMode, create);
      assistance.onProviderFailure = vi.fn();
      const completion = createGraphRagGenerationModelCompletion(assistance);
      await expect(completion.complete({
        prompt: "Extract the bounded text.",
        signal: new AbortController().signal
      })).resolves.toBe("tuples<|COMPLETE|>");
      const request = create.mock.calls[0]![0] as Record<string, unknown>;
      expect(JSON.stringify(request)).not.toContain("json_object");
      expect(JSON.stringify(request)).not.toContain("json_schema");
      expect(request.model).toBe("test-model");
      expect(request.stream).toBe(true);
      if (apiMode === "responses") {
        expect(request.reasoning).toEqual({ effort: "none" });
        expect(request).not.toHaveProperty("reasoning_effort");
      } else {
        expect(request.reasoning_effort).toBe("none");
        expect(request).not.toHaveProperty("reasoning");
      }
      expect(assistance.onProviderFailure).not.toHaveBeenCalled();
    }
  );

  it.each(["responses", "chat_completions"] as const)(
    "keeps the configured %s request alive while streamed progress continues",
    async (apiMode) => {
      const create = vi.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          for (const text of ["tuples", "<|COMPLETE", "|>"]) {
            await new Promise((resolve) => setTimeout(resolve, 8));
            yield apiMode === "responses"
              ? { type: "response.output_text.delta", delta: text }
              : { choices: [{ delta: { content: text }, finish_reason: null }] };
          }
          if (apiMode === "responses") {
            yield { type: "response.completed", response: { status: "completed" } };
          } else {
            yield { choices: [{ delta: {}, finish_reason: "stop" }] };
          }
        }
      }));
      const assistance = modelAssistance(apiMode, create);
      assistance.receiveTimeouts = { maxMs: 200, idleMs: 15 };
      const completion = createGraphRagGenerationModelCompletion(assistance);

      await expect(completion.complete({
        prompt: "Extract streamed text.",
        signal: new AbortController().signal
      })).resolves.toBe("tuples<|COMPLETE|>");
      expect(create).toHaveBeenCalledOnce();
    }
  );

  it.each(["responses", "chat_completions"] as const)(
    "stops the %s stream at the GraphRAG completion delimiter",
    async (apiMode) => {
      let requestedTrailingOutput = false;
      const create = vi.fn(async () => ({
        async *[Symbol.asyncIterator]() {
          yield apiMode === "responses"
            ? { type: "response.output_text.delta", delta: "tuples<|COMPLETE|>" }
            : { choices: [{ delta: { content: "tuples<|COMPLETE|>" }, finish_reason: null }] };
          requestedTrailingOutput = true;
          yield apiMode === "responses"
            ? { type: "response.output_text.delta", delta: "ignored trailing output" }
            : { choices: [{ delta: { content: "ignored trailing output" }, finish_reason: null }] };
        }
      }));
      const completion = createGraphRagGenerationModelCompletion(
        modelAssistance(apiMode, create)
      );

      await expect(completion.complete({
        prompt: "Extract streamed text.",
        signal: new AbortController().signal
      })).resolves.toBe("tuples<|COMPLETE|>");
      expect(requestedTrailingOutput).toBe(false);
    }
  );

  it("rejects invalid output locally without exposing provider payloads", async () => {
    const create = vi.fn(async () => ({ status: "completed", output_text: "" }));
    const completion = createGraphRagGenerationModelCompletion(
      modelAssistance("responses", create)
    );
    await expect(completion.complete({
      prompt: "Extract.",
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      code: "semantic_generation_output_invalid",
      retryable: false
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it("retries one HTTP 429 generation failure", async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
      .mockResolvedValueOnce({
        status: "completed",
        output_text: "retried tuples<|COMPLETE|>"
      });
    const completion = createGraphRagGenerationModelCompletion(
      modelAssistance("responses", create)
    );

    await expect(completion.complete({
      prompt: "Extract.",
      signal: new AbortController().signal
    })).resolves.toBe("retried tuples<|COMPLETE|>");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retries one retryable generation failure", async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("temporary"), { retryable: true }))
      .mockResolvedValueOnce({
        status: "completed",
        output_text: "retried tuples<|COMPLETE|>"
      });
    const completion = createGraphRagGenerationModelCompletion(
      modelAssistance("responses", create)
    );

    await expect(completion.complete({
      prompt: "Extract.",
      signal: new AbortController().signal
    })).resolves.toBe("retried tuples<|COMPLETE|>");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable generation failure", async () => {
    const failure = Object.assign(new Error("invalid request"), { retryable: false });
    const create = vi.fn().mockRejectedValue(failure);
    const completion = createGraphRagGenerationModelCompletion(
      modelAssistance("responses", create)
    );

    await expect(completion.complete({
      prompt: "Extract.",
      signal: new AbortController().signal
    })).rejects.toBe(failure);
    expect(create).toHaveBeenCalledOnce();
  });

  it("classifies an HTTP request rejection as a terminal safe failure", async () => {
    const create = vi.fn().mockRejectedValue(
      Object.assign(new Error("provider payload must stay private"), { status: 400 })
    );
    const completion = createGraphRagGenerationModelCompletion(
      modelAssistance("responses", create)
    );

    await expect(completion.complete({
      prompt: "Extract.",
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      code: "semantic_generation_request_rejected",
      retryable: false
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it("reports a sanitized generation provider failure once", async () => {
    const failure = Object.assign(
      new Error("Invalid request; Authorization: Bearer generation-secret"),
      {
        status: 400,
        request_id: "generation-request-123",
        type: "invalid_request_error",
        code: "invalid_schema",
        param: "response_format"
      }
    );
    const create = vi.fn().mockRejectedValue(failure);
    const assistance = modelAssistance("responses", create);
    assistance.onProviderFailure = vi.fn();
    const completion = createGraphRagGenerationModelCompletion(assistance);

    await expect(completion.complete({
      prompt: "Extract.",
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      code: "semantic_generation_request_rejected"
    });
    expect(assistance.onProviderFailure).toHaveBeenCalledOnce();
    expect(assistance.onProviderFailure).toHaveBeenCalledWith(expect.objectContaining({
      providerKind: "generation",
      apiMode: "responses",
      modelName: "test-model",
      httpStatusCode: 400,
      providerRequestId: "generation-request-123",
      providerErrorType: "invalid_request_error",
      providerErrorCode: "invalid_schema",
      providerErrorParam: "response_format",
      errorMessage: "Invalid request; Authorization=<redacted>"
    }));
    expect(JSON.stringify((assistance.onProviderFailure as ReturnType<typeof vi.fn>)
      .mock.calls)).not.toContain("generation-secret");
  });

  it("distinguishes a forbidden provider request from invalid credentials", async () => {
    const create = vi.fn().mockRejectedValue(
      Object.assign(new Error("provider payload must stay private"), { status: 403 })
    );
    const completion = createGraphRagGenerationModelCompletion(
      modelAssistance("responses", create)
    );

    await expect(completion.complete({
      prompt: "Extract.",
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      code: "semantic_generation_request_forbidden",
      retryable: false
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it("classifies an exhausted HTTP service failure as retryable", async () => {
    const create = vi.fn().mockRejectedValue(
      Object.assign(new Error("provider payload must stay private"), { status: 503 })
    );
    const completion = createGraphRagGenerationModelCompletion(
      modelAssistance("responses", create)
    );

    await expect(completion.complete({
      prompt: "Extract.",
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      code: "semantic_generation_provider_unavailable",
      retryable: true
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each(["responses", "chat_completions"] as const)(
    "aborts and retries one timed-out %s request inside the same completion",
    async (apiMode) => {
      const providerSignals: AbortSignal[] = [];
      const create = vi.fn(async (_request: unknown, options?: {
        signal?: AbortSignal;
      }) => {
        if (!options?.signal) throw new Error("missing provider signal");
        providerSignals.push(options.signal);
        if (providerSignals.length === 1) {
          return new Promise<unknown>((_resolve, reject) => {
            options.signal!.addEventListener("abort", () => {
              reject(options.signal!.reason);
            }, { once: true });
          });
        }
        return apiMode === "responses"
          ? { status: "completed", output_text: "retried tuples<|COMPLETE|>" }
          : { choices: [{ message: { content: "retried tuples<|COMPLETE|>" } }] };
      });
      const assistance = modelAssistance(apiMode, create);
      assistance.receiveTimeouts = { maxMs: 100, idleMs: 10 };
      const completion = createGraphRagGenerationModelCompletion(assistance);

      await expect(completion.complete({
        prompt: "Extract the bounded text.",
        signal: new AbortController().signal
      })).resolves.toBe("retried tuples<|COMPLETE|>");
      expect(create).toHaveBeenCalledTimes(2);
      expect(providerSignals[0]?.aborted).toBe(true);
      expect(providerSignals[1]?.aborted).toBe(true);
    }
  );

  it("returns a safe retryable timeout after the bounded provider retry is exhausted", async () => {
    const providerSignals: AbortSignal[] = [];
    const create = vi.fn(async (_request: unknown, options?: {
      signal?: AbortSignal;
    }) => {
      if (!options?.signal) throw new Error("missing provider signal");
      providerSignals.push(options.signal);
      return new Promise<unknown>((_resolve, reject) => {
        options.signal!.addEventListener("abort", () => {
          reject(options.signal!.reason);
        }, { once: true });
      });
    });
    const assistance = modelAssistance("responses", create);
    assistance.receiveTimeouts = { maxMs: 100, idleMs: 10 };
    const completion = createGraphRagGenerationModelCompletion(assistance);

    await expect(completion.complete({
      prompt: "Extract the bounded text.",
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      code: "semantic_generation_timeout",
      retryable: true
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(providerSignals).toHaveLength(2);
    expect(providerSignals.every((signal) => signal.aborted)).toBe(true);
  });
});

function modelAssistance(
  apiMode: "responses" | "chat_completions",
  create: (
    request: unknown,
    options?: { signal?: AbortSignal }
  ) => Promise<unknown>
): ModelAssistanceOptions {
  const client = apiMode === "responses"
    ? { apiMode: "responses" as const, responses: { create } }
    : { apiMode: "chat_completions" as const, chat: { completions: { create } } };
  return {
    apiMode,
    client,
    modelName: "test-model",
    contextWindowTokens: 16_384,
    receiveTimeouts: { maxMs: 5_000, idleMs: 5_000 },
    suggestionConcurrency: 1,
    transientRetryDelayMs: 0
  };
}
