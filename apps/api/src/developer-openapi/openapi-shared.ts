export type SchemaObject = Record<string, unknown>;
export type ParameterObject = Record<string, unknown>;
export type ResponseObject = Record<string, unknown>;
export type OperationObject = Record<string, unknown>;
export type PathItemObject = Record<string, OperationObject>;

export const bearerSecurity = [{ bearerAuth: [] }];
export const jsonContentType = "application/json";

export function operation(input: {
  tag: string;
  operationId: string;
  summary: string;
  parameters?: ParameterObject[];
  requestSchema?: SchemaObject;
  requestBody?: Record<string, unknown>;
  requestExample?: unknown;
  successStatus: number;
  successSchema: SchemaObject;
  successExample?: unknown;
  extraResponses?: Record<string, ResponseObject>;
}): OperationObject {
  return {
    tags: [input.tag],
    operationId: input.operationId,
    summary: input.summary,
    security: bearerSecurity,
    "x-request-example": input.requestExample ?? {},
    ...(input.parameters ? { parameters: input.parameters } : {}),
    ...(input.requestBody ? { requestBody: input.requestBody } : {}),
    ...(input.requestSchema
      ? {
          requestBody: {
            required: true,
            content: {
              [jsonContentType]: {
                schema: input.requestSchema,
                ...(input.requestExample && readRecord(input.requestExample).body
                  ? { example: readRecord(input.requestExample).body }
                  : {})
              }
            }
          }
        }
      : {}),
    responses: {
      [String(input.successStatus)]: jsonResponse(
        "Successful response.",
        input.successSchema,
        input.successExample
      ),
      ...standardErrorResponses(),
      ...input.extraResponses
    }
  };
}

export function ref(schemaName: string): SchemaObject {
  return { $ref: `#/components/schemas/${schemaName}` };
}

export function objectSchema(properties: Record<string, unknown>, required: string[] = []): SchemaObject {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {})
  };
}

export function pageSchema(itemSchema: SchemaObject): SchemaObject {
  return {
    ...objectSchema(
      {
        items: { type: "array", items: itemSchema },
        nextCursor: nullableString("Opaque cursor accepted only by the same list family.")
      },
      ["items", "nextCursor"]
    ),
    allOf: [ref("Page")]
  };
}

export function idSchema(description: string): SchemaObject {
  return { type: "string", description };
}

export function timestampSchema(): SchemaObject {
  return { type: "string", format: "date-time" };
}

export function nullableTimestampSchema(): SchemaObject {
  return { anyOf: [timestampSchema(), { type: "null" }] };
}

export function nullableString(description: string): SchemaObject {
  return { anyOf: [{ type: "string" }, { type: "null" }], description };
}

export function paginationParameters(): ParameterObject[] {
  return [
    {
      name: "limit",
      in: "query",
      required: false,
      description: "Maximum number of records to return, bounded by runtime configuration.",
      schema: { type: "integer", minimum: 1 }
    },
    {
      name: "cursor",
      in: "query",
      required: false,
      description: "Opaque cursor returned by the same list endpoint family.",
      schema: { type: "string" }
    }
  ];
}

export function sourceFileListFilterParameters(): ParameterObject[] {
  return [
    queryParameter("fileNameQuery", "Case-insensitive filename substring filter.", {
      type: "string",
      minLength: 1,
      maxLength: 160
    }),
    queryParameter("fileIdQuery", "Source file ID prefix filter.", {
      type: "string",
      minLength: 8,
      maxLength: 160
    }),
    queryParameter("processingStatus", "Source-file processing state filter.", {
      type: "string",
      enum: ["queued", "running", "completed", "failed"]
    }),
    queryParameter("processingStage", "Current source-file stage filter.", {
      type: "string",
      enum: [
        "upload_storage",
        "metadata_resolution",
        "llm_suggestion",
        "graph_generation",
        "okf_validation",
        "bundle_generation",
        "index_publication",
        "release_activation"
      ]
    }),
    queryParameter("modelInvocationStatus", "Latest model-assistance state filter.", {
      type: "string",
      enum: ["running", "completed", "failed", "skipped", "not_recorded"]
    }),
    queryParameter("generatedOutputStatus", "Generated output state filter.", {
      type: "string",
      enum: ["pending", "visible", "unavailable"]
    }),
    queryParameter("startedFrom", "Processing start lower bound.", {
      type: "string",
      format: "date-time"
    }),
    queryParameter("startedTo", "Processing start upper bound.", {
      type: "string",
      format: "date-time"
    }),
    queryParameter("endedFrom", "Processing end lower bound.", {
      type: "string",
      format: "date-time"
    }),
    queryParameter("endedTo", "Processing end upper bound.", {
      type: "string",
      format: "date-time"
    }),
    queryParameter("errorState", "Processing or publication error state filter.", {
      type: "string",
      enum: ["with_error", "without_error"]
    }),
    queryParameter("errorCodeQuery", "Processing or publication error-code substring filter.", {
      type: "string",
      minLength: 2,
      maxLength: 160
    }),
    queryParameter("actionState", "Available follow-up action filter.", {
      type: "string",
      enum: ["openable", "retryable", "none"]
    })
  ];
}

export function knowledgeBaseIdParameter(): ParameterObject {
  return pathParameter("knowledgeBaseId", "Knowledge-base identifier returned by knowledge-base APIs.");
}

export function sourceFileIdParameter(): ParameterObject {
  return pathParameter("sourceFileId", "Source file identifier returned by upload or source-file list APIs.");
}

export function fileIdParameter(): ParameterObject {
  return pathParameter("fileId", "File identifier returned by upload, source-file, tree, or file detail APIs.");
}

export function webhookIdParameter(): ParameterObject {
  return pathParameter("webhookId", "Webhook identifier returned by webhook APIs.");
}

export function deliveryIdParameter(): ParameterObject {
  return pathParameter("deliveryId", "Webhook delivery identifier returned by delivery listing APIs.");
}

export function filePathQueryParameter(required: boolean): ParameterObject {
  return {
    name: "path",
    in: "query",
    required,
    description: "Logical generated file path. Traversal, backslashes, and storage paths are rejected.",
    schema: { type: "string", minLength: 1 }
  };
}

function standardErrorResponses(): Record<string, ResponseObject> {
  return {
    "401": errorResponse(
      "Bearer API key is missing, malformed, unknown, revoked, or deleted.",
      "UNAUTHORIZED",
      401
    ),
    "404": errorResponse("The requested resource or route was not found.", "NOT_FOUND", 404),
    "409": errorResponse(
      "The requested operation conflicts with the current resource state.",
      "CONFLICT",
      409
    ),
    "422": errorResponse("The request failed validation.", "VALIDATION_ERROR", 422),
    "429": errorResponse("The request exceeded configured rate limits.", "RATE_LIMITED", 429),
    "500": errorResponse("The API encountered an internal error.", "INTERNAL_ERROR", 500)
  };
}

export function jsonResponse(description: string, schema: SchemaObject, example?: unknown): ResponseObject {
  return {
    description,
    content: {
      [jsonContentType]: {
        schema,
        ...(example !== undefined ? { example } : {})
      }
    }
  };
}

export function errorResponse(description: string, code: string, httpStatus: number): ResponseObject {
  return jsonResponse(description, ref("Error"), {
    error: {
      code,
      message: description,
      httpStatus
    },
    requestId: "req_123"
  });
}

function pathParameter(name: string, description: string): ParameterObject {
  return {
    name,
    in: "path",
    required: true,
    description,
    schema: { type: "string", minLength: 1 }
  };
}

function queryParameter(
  name: string,
  description: string,
  schema: Record<string, unknown>
): ParameterObject {
  return {
    name,
    in: "query",
    required: false,
    description,
    schema
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
