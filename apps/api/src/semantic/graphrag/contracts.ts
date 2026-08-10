export const GRAPHRAG_REQUEST_SCHEMA = "focowiki.graphrag.request.v1";
export const GRAPHRAG_RESPONSE_SCHEMA = "focowiki.graphrag.response.v1";

export type GraphRagAdapterRequest = {
  schemaVersion: typeof GRAPHRAG_REQUEST_SCHEMA;
  requestId: string;
  operation: "health" | "prepare" | "extract" | "cluster";
  [key: string]: unknown;
};

export type GraphRagAdapterResponse = {
  schemaVersion: typeof GRAPHRAG_RESPONSE_SCHEMA;
  requestId: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
};

export class GraphRagAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "GraphRagAdapterError";
  }
}

export function parseGraphRagAdapterResponse(value: unknown): GraphRagAdapterResponse {
  if (!isObject(value)) {
    throw new GraphRagAdapterError("INVALID_ADAPTER_RESPONSE", "Adapter response must be an object");
  }
  const requestId = readString(value.requestId);
  if (
    value.schemaVersion !== GRAPHRAG_RESPONSE_SCHEMA ||
    !requestId ||
    typeof value.ok !== "boolean"
  ) {
    throw new GraphRagAdapterError("INVALID_ADAPTER_RESPONSE", "Adapter response contract is invalid");
  }
  if (!value.ok) {
    const error = value.error;
    if (!isObject(error) || !readString(error.code) || !readString(error.message)) {
      throw new GraphRagAdapterError("INVALID_ADAPTER_RESPONSE", "Adapter error contract is invalid");
    }
    return {
      schemaVersion: GRAPHRAG_RESPONSE_SCHEMA,
      requestId,
      ok: false,
      error: { code: error.code as string, message: error.message as string }
    };
  }
  if (!isObject(value.result)) {
    throw new GraphRagAdapterError("INVALID_ADAPTER_RESPONSE", "Adapter result contract is invalid");
  }
  return {
    schemaVersion: GRAPHRAG_RESPONSE_SCHEMA,
    requestId,
    ok: true,
    result: value.result
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}
