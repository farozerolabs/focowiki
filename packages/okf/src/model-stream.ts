const DEFAULT_MAXIMUM_STRUCTURED_OUTPUT_CHARACTERS = 256_000;

export type ModelStreamMode = "responses" | "chat_completions";

export async function consumeStructuredModelStream(input: {
  response: unknown;
  mode: ModelStreamMode;
  progress: () => void;
  maximumOutputCharacters?: number;
}): Promise<unknown> {
  if (!isAsyncIterable(input.response)) return input.response;
  const maximumOutputCharacters = input.maximumOutputCharacters
    ?? DEFAULT_MAXIMUM_STRUCTURED_OUTPUT_CHARACTERS;
  assertMaximumOutputCharacters(maximumOutputCharacters);
  return input.mode === "chat_completions"
    ? consumeChatCompletionsStream(input.response, input.progress, maximumOutputCharacters)
    : consumeResponsesStream(input.response, input.progress, maximumOutputCharacters);
}

async function consumeChatCompletionsStream(
  response: AsyncIterable<unknown>,
  progress: () => void,
  maximumOutputCharacters: number
): Promise<unknown> {
  let outputText = "";
  let refusal = "";
  let requestId: string | null = null;
  let finishReason: string | null = null;
  let usage: unknown = undefined;

  for await (const event of response) {
    progress();
    const eventRecord = object(event);
    requestId = stringProperty(eventRecord, "id") ?? requestId;
    if (eventRecord?.usage !== undefined) usage = eventRecord.usage;
    const choices = Array.isArray(eventRecord?.choices) ? eventRecord.choices : [];
    for (const choice of choices) {
      const choiceRecord = object(choice);
      const delta = object(choiceRecord?.delta);
      outputText = appendBounded(
        outputText,
        readContentText(delta?.content),
        maximumOutputCharacters
      );
      refusal = appendBounded(
        refusal,
        stringProperty(delta, "refusal") ?? "",
        maximumOutputCharacters
      );
      finishReason = stringProperty(choiceRecord, "finish_reason") ?? finishReason;
    }
  }

  return {
    ...(requestId ? { id: requestId } : {}),
    choices: [{
      finish_reason: finishReason ?? "stream_ended",
      message: {
        content: outputText,
        ...(refusal ? { refusal } : {})
      }
    }],
    ...(usage === undefined ? {} : { usage })
  };
}

async function consumeResponsesStream(
  response: AsyncIterable<unknown>,
  progress: () => void,
  maximumOutputCharacters: number
): Promise<unknown> {
  let outputText = "";
  let refusal = "";
  let requestId: string | null = null;
  let terminalResponse: Readonly<Record<string, unknown>> | null = null;
  let terminalStatus: string | null = null;

  for await (const event of response) {
    progress();
    const eventRecord = object(event);
    const eventType = stringProperty(eventRecord, "type");
    const eventResponse = object(eventRecord?.response);
    requestId = stringProperty(eventResponse, "id")
      ?? stringProperty(eventRecord, "response_id")
      ?? requestId;

    if (eventType === "response.output_text.delta") {
      outputText = appendBounded(
        outputText,
        stringProperty(eventRecord, "delta") ?? "",
        maximumOutputCharacters
      );
      continue;
    }
    if (eventType === "response.refusal.delta") {
      refusal = appendBounded(
        refusal,
        stringProperty(eventRecord, "delta") ?? "",
        maximumOutputCharacters
      );
      continue;
    }
    if (eventType === "error") {
      throw modelStreamError(eventRecord);
    }
    if (eventType === "response.completed"
      || eventType === "response.incomplete"
      || eventType === "response.failed") {
      terminalResponse = eventResponse;
      terminalStatus = stringProperty(eventResponse, "status")
        ?? eventType.replace("response.", "");
    }
  }

  const completed = terminalResponse ?? {};
  return {
    ...completed,
    ...(requestId && typeof completed.id !== "string" ? { id: requestId } : {}),
    status: stringProperty(completed, "status") ?? terminalStatus ?? "stream_ended",
    ...(outputText ? { output_text: outputText } : {}),
    ...(refusal ? {
      output: [{ content: [{ type: "refusal", refusal }] }]
    } : {})
  };
}

function appendBounded(
  current: string,
  delta: string,
  maximumOutputCharacters: number
): string {
  if (!delta) return current;
  if (current.length + delta.length > maximumOutputCharacters) {
    throw new Error("Model response stream exceeded the structured output limit");
  }
  return current + delta;
}

function readContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => stringProperty(object(part), "text") ?? "").join("");
}

function modelStreamError(event: Readonly<Record<string, unknown>> | null): Error {
  const errorRecord = object(event?.error);
  const message = stringProperty(errorRecord, "message")
    ?? stringProperty(event, "message")
    ?? "Model response stream failed";
  const error = new Error(message);
  const code = stringProperty(errorRecord, "code") ?? stringProperty(event, "code");
  if (code) Object.assign(error, { code });
  return error;
}

function assertMaximumOutputCharacters(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new Error("Structured model stream output limit is invalid");
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object"
    && value !== null
    && Symbol.asyncIterator in value
    && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";
}

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function stringProperty(
  value: Readonly<Record<string, unknown>> | null,
  property: string
): string | null {
  const propertyValue = value?.[property];
  return typeof propertyValue === "string" ? propertyValue : null;
}
