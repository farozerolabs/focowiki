import { receiveWithProgressTimeout } from "@focowiki/okf";
import type { ModelAssistanceOptions } from
  "../../runtime-settings/model-assistance-options.js";
import type { GraphRagModelCompletionPort } from "./extraction-gateway.js";

type RequestOptions = { signal?: AbortSignal };

type ResponsesTextClient = {
  responses: {
    create(request: Record<string, unknown>, options?: RequestOptions): Promise<unknown>;
  };
};

type ChatTextClient = {
  chat: {
    completions: {
      create(request: Record<string, unknown>, options?: RequestOptions): Promise<unknown>;
    };
  };
};

export function createGraphRagGenerationModelCompletion(
  assistance: ModelAssistanceOptions,
  onProviderRequest?: () => void
): GraphRagModelCompletionPort {
  return createSemanticTextModelCompletion(assistance, {
    instructions: "Return only the requested GraphRAG tuple records.",
    maximumOutputCharacters: 256_000,
    stopSequence: "<|COMPLETE|>",
    ...(onProviderRequest ? { onProviderRequest } : {})
  });
}

export function createSemanticTextModelCompletion(
  assistance: ModelAssistanceOptions,
  options: {
    instructions: string;
    maximumOutputCharacters: number;
    stopSequence?: string;
    onProviderRequest?: () => void;
  }
): GraphRagModelCompletionPort {
  if (!options.instructions.trim()
    || Buffer.byteLength(options.instructions) > 4_096
    || !Number.isSafeInteger(options.maximumOutputCharacters)
    || options.maximumOutputCharacters < 1
    || options.maximumOutputCharacters > 1_000_000
    || options.stopSequence !== undefined
      && (!options.stopSequence || options.stopSequence.length > 128)) {
    throw new Error("Semantic text completion options are invalid");
  }
  return {
    async complete(input) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        throwIfAborted(input.signal);
        const requestController = new AbortController();
        const requestSignal = AbortSignal.any([
          input.signal,
          requestController.signal
        ]);
        try {
          options.onProviderRequest?.();
          const operation = () => receiveWithProgressTimeout({
            timeouts: assistance.receiveTimeouts,
            start: (progress) => sendTextRequest(
              assistance,
              input.prompt,
              options.instructions,
              requestSignal,
              progress,
              options.maximumOutputCharacters,
              options.stopSequence
            )
          });
          const response = assistance.requestRunner
            ? await assistance.requestRunner.run(operation)
            : await operation();
          throwIfAborted(input.signal);
          const status = stringProperty(response, "status");
          if (status === "incomplete") {
            throw completionError("semantic_generation_incomplete", true);
          }
          if (status && status !== "completed") {
            throw completionError("semantic_generation_failed", true);
          }
          const output = trimAtStopSequence(
            readOutputText(response),
            options.stopSequence
          );
          if (!output || output.length > options.maximumOutputCharacters) {
            throw completionError("semantic_generation_output_invalid", false);
          }
          return output;
        } catch (error) {
          requestController.abort(error);
          if (attempt === 0 && !input.signal.aborted && isTransient(error)) {
            await waitForRetry(assistance.transientRetryDelayMs, input.signal);
            continue;
          }
          throw normalizeCompletionError(error);
        } finally {
          requestController.abort();
        }
      }
      throw completionError("semantic_generation_failed", true);
    }
  };
}

function sendTextRequest(
  assistance: ModelAssistanceOptions,
  prompt: string,
  instructions: string,
  signal: AbortSignal,
  progress: () => void,
  maximumOutputCharacters: number,
  stopSequence?: string
): Promise<unknown> {
  if (assistance.apiMode === "chat_completions") {
    const client = assistance.client as unknown as ChatTextClient;
    return client.chat.completions.create({
      model: assistance.modelName,
      messages: [{
        role: "system",
        content: instructions
      }, { role: "user", content: prompt }],
      stream: true
    }, { signal }).then((response) => consumeStreamedResponse({
      response,
      mode: "chat_completions",
      progress,
      maximumOutputCharacters,
      ...(stopSequence === undefined ? {} : { stopSequence })
    }));
  }
  const client = assistance.client as unknown as ResponsesTextClient;
  return client.responses.create({
    model: assistance.modelName,
    instructions,
    input: prompt,
    text: { format: { type: "text" } },
    store: false,
    stream: true
  }, { signal }).then((response) => consumeStreamedResponse({
    response,
    mode: "responses",
    progress,
    maximumOutputCharacters,
    ...(stopSequence === undefined ? {} : { stopSequence })
  }));
}

async function consumeStreamedResponse(input: {
  response: unknown;
  mode: "responses" | "chat_completions";
  progress: () => void;
  maximumOutputCharacters: number;
  stopSequence?: string;
}): Promise<unknown> {
  if (!isAsyncIterable(input.response)) return input.response;
  let outputText = "";
  let status = "completed";
  for await (const event of input.response) {
    input.progress();
    if (input.mode === "responses") {
      const eventType = stringProperty(event, "type");
      if (eventType === "response.output_text.delta") {
        outputText = appendStreamText(
          outputText,
          stringProperty(event, "delta") ?? "",
          input.maximumOutputCharacters
        );
      } else if (eventType === "response.incomplete") {
        status = "incomplete";
      } else if (eventType === "response.failed" || eventType === "error") {
        throw completionError("semantic_generation_failed", true);
      } else if (eventType === "response.completed") {
        status = stringProperty(object(event)?.response, "status") ?? "completed";
      }
      if (hasStopSequence(outputText, input.stopSequence)) break;
      continue;
    }
    const eventRecord = object(event);
    const choices = Array.isArray(eventRecord?.choices) ? eventRecord.choices : [];
    for (const choice of choices) {
      const choiceRecord = object(choice);
      outputText = appendStreamText(
        outputText,
        stringProperty(choiceRecord?.delta, "content") ?? "",
        input.maximumOutputCharacters
      );
      const finishReason = stringProperty(choiceRecord, "finish_reason");
      if (finishReason && finishReason !== "stop") status = "incomplete";
    }
    if (hasStopSequence(outputText, input.stopSequence)) break;
  }
  return {
    status,
    output_text: trimAtStopSequence(outputText, input.stopSequence)
  };
}

function hasStopSequence(value: string, stopSequence?: string): boolean {
  return stopSequence !== undefined && value.includes(stopSequence);
}

function trimAtStopSequence(
  value: string | null,
  stopSequence?: string
): string | null {
  if (!value || stopSequence === undefined) return value;
  const end = value.indexOf(stopSequence);
  return end < 0 ? value : value.slice(0, end + stopSequence.length);
}

function appendStreamText(current: string, next: string, maximum: number): string {
  if (current.length + next.length > maximum) {
    throw completionError("semantic_generation_output_invalid", false);
  }
  return current + next;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(value && typeof value === "object"
    && Symbol.asyncIterator in value
    && typeof value[Symbol.asyncIterator] === "function");
}

function isTransient(error: unknown): boolean {
  if (error instanceof TypeError
    || error instanceof Error && error.name === "ModelReceiveTimeoutError") {
    return true;
  }
  if (error instanceof Error && "retryable" in error) {
    return error.retryable === true;
  }
  if (error && typeof error === "object" && "status" in error) {
    const status = Number((error as { status: unknown }).status);
    return status === 408 || status === 409 || status === 425 || status === 429
      || status >= 500 && status <= 599;
  }
  return false;
}

function normalizeCompletionError(error: unknown): Error {
  if (error instanceof Error
    && "code" in error
    && "retryable" in error
    && typeof error.retryable === "boolean"
    && /^semantic_[a-z0-9_]+$/u.test(String(error.code))) {
    return error;
  }
  const status = providerHttpStatus(error);
  if (status !== null) {
    if (status === 408 || status === 409 || status === 425 || status === 429
      || status >= 500 && status <= 599) {
      return completionError("semantic_generation_provider_unavailable", true);
    }
    if (status === 401) {
      return completionError("semantic_generation_configuration_invalid", false);
    }
    if (status === 403) {
      return completionError("semantic_generation_request_forbidden", false);
    }
    if (status >= 400 && status <= 499) {
      return completionError("semantic_generation_request_rejected", false);
    }
  }
  if (error instanceof Error && error.name === "ModelReceiveTimeoutError") {
    return completionError("semantic_generation_timeout", true);
  }
  if (error instanceof TypeError) {
    return completionError("semantic_generation_transport_failed", true);
  }
  if (error instanceof Error
    && "retryable" in error
    && typeof error.retryable === "boolean") {
    return error;
  }
  return completionError("semantic_generation_failed", true);
}

function providerHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  const status = Number(error.status);
  return Number.isSafeInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

async function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", abort, { once: true });

    function finish(): void {
      cleanup();
      resolve();
    }

    function abort(): void {
      cleanup();
      reject(signal.reason ?? new DOMException("Semantic generation aborted", "AbortError"));
    }

    function cleanup(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  });
}

function readOutputText(value: unknown): string | null {
  const direct = stringProperty(value, "output_text");
  if (direct) return direct;
  const record = object(value);
  const output = Array.isArray(record?.output) ? record.output : [];
  for (const item of output) {
    const content = Array.isArray(object(item)?.content) ? object(item)!.content as unknown[] : [];
    for (const part of content) {
      const text = stringProperty(part, "text") ?? stringProperty(part, "output_text");
      if (text) return text;
    }
  }
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  for (const choice of choices) {
    const content = object(object(choice)?.message)?.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const text = stringProperty(part, "text");
        if (text) return text;
      }
    }
  }
  return null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringProperty(value: unknown, key: string): string | null {
  const result = object(value)?.[key];
  return typeof result === "string" && result.trim() ? result : null;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Semantic generation aborted", "AbortError");
  }
}

function completionError(code: string, retryable: boolean): Error & {
  code: string;
  retryable: boolean;
} {
  return Object.assign(new Error(`Semantic generation failed: ${code}`), {
    code,
    retryable
  });
}
