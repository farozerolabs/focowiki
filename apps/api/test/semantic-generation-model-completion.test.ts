import { describe, expect, it, vi } from "vitest";
import type { ModelAssistanceOptions } from "../src/admin/model-suggestions.js";
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
});

function modelAssistance(
  apiMode: "responses" | "chat_completions",
  create: (request: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
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
