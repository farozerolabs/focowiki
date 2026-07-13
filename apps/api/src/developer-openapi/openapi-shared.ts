export type SchemaObject = Record<string, unknown>;
export type ParameterObject = Record<string, unknown>;
export type ResponseObject = Record<string, unknown>;
export type OperationObject = Record<string, unknown>;
export type PathItemObject = Record<string, OperationObject>;
type AdditionalErrorStatus = 404 | 409 | 413 | 422;

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
  successContentType?: string;
  additionalErrorStatuses?: AdditionalErrorStatus[];
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
      [String(input.successStatus)]: input.successContentType
        ? contentResponse(
            "Successful response.",
            input.successContentType,
            input.successSchema,
            input.successExample
          )
        : jsonResponse("Successful response.", input.successSchema, input.successExample),
      ...standardErrorResponses(input.additionalErrorStatuses),
      ...input.extraResponses
    }
  };
}

function contentResponse(
  description: string,
  contentType: string,
  schema: SchemaObject,
  example?: unknown
): ResponseObject {
  return {
    description,
    content: {
      [contentType]: {
        schema,
        ...(example === undefined ? {} : { example })
      }
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
      description: "Maximum number of records to return. The deployment can enforce a lower limit.",
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
    queryParameter("directoryId", "Parent source-directory identifier. Use `root` for root files.", {
      type: "string",
      minLength: 1,
      maxLength: 200,
      example: "source-directory-handbook"
    }),
    queryParameter("pathQuery", "Case-insensitive source-relative path substring filter.", {
      type: "string",
      minLength: 1,
      maxLength: 160,
      example: "handbook/guide"
    }),
    queryParameter("sourceFileIdPrefix", "Source file ID prefix filter.", {
      type: "string",
      minLength: 8,
      maxLength: 160,
      example: "source-file-11111111"
    }),
    queryParameter("processingState", "Source-file processing state filter.", {
      type: "string",
      enum: ["queued", "running", "completed", "failed"],
      example: "completed"
    }),
    queryParameter("currentStage", "Current source-file stage filter.", {
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
      ],
      example: "release_activation"
    }),
    queryParameter("generatedOutputStatus", "Generated output state filter.", {
      type: "string",
      enum: ["pending", "visible", "unavailable"],
      example: "visible"
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
  return pathParameter("fileId", "Generated file identifier returned by tree, search, related-file, or file APIs.");
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

export function fileSearchParameters(): ParameterObject[] {
  return [
    queryParameter("query", "Search phrase used to find candidate generated files.", {
      type: "string",
      minLength: 2,
      maxLength: 160
    }),
    queryParameter("scope", "Search field scope. The default searches path and metadata.", {
      type: "string",
      enum: ["all", "path", "metadata"],
      default: "all"
    }),
    queryParameter("fileKind", "Generated file kind filter. The default searches page files.", {
      type: "string",
      enum: [
        "all",
        "page",
        "index",
        "log",
        "schema",
        "manifest_index",
        "manifest_index_shard",
        "search_index",
        "search_index_shard",
        "link_index",
        "link_index_shard",
        "change_index",
        "change_index_shard",
        "graph_index",
        "graph_manifest",
        "graph_node_index",
        "graph_edge_shard",
        "graph_file",
        "graph_community",
        "graph_insight"
      ],
      default: "page"
    }),
    queryParameter("mode", "Search mode. `file` is the default and searches generated file documents. `hybrid` merges file and graph candidates. `graph` searches graph relationships only.", {
      type: "string",
      enum: ["file", "graph", "hybrid"],
      default: "file"
    }),
    queryParameter("graphDepth", "Number of relationship levels included by graph and hybrid search.", {
      type: "integer",
      enum: [0, 1, 2],
      default: 1
    }),
    queryParameter("graphFanout", "Maximum relationship records returned per graph search item.", {
      type: "integer",
      minimum: 0,
      maximum: 25,
      default: 10
    }),
    ...paginationParameters()
  ];
}

function standardErrorResponses(additionalStatuses: AdditionalErrorStatus[] = []): Record<string, ResponseObject> {
  const responses: Record<string, ResponseObject> = {
    "401": errorResponse(
      "Bearer API key is missing, malformed, unknown, revoked, or deleted.",
      "UNAUTHORIZED",
      401
    ),
    "429": errorResponse("The request exceeded configured rate limits.", "RATE_LIMITED", 429),
    "500": errorResponse("The API encountered an internal error.", "INTERNAL_ERROR", 500)
  };

  const additional: Record<AdditionalErrorStatus, ResponseObject> = {
    404: errorResponse("The requested resource was not found.", "NOT_FOUND", 404),
    409: errorResponse("The request conflicts with the current resource state.", "CONFLICT", 409),
    413: errorResponse("The request body exceeds the accepted size limit.", "PAYLOAD_TOO_LARGE", 413),
    422: errorResponse("The request failed validation.", "VALIDATION_ERROR", 422)
  };

  for (const status of [404, 409, 413, 422] as const) {
    if (additionalStatuses.includes(status)) {
      responses[String(status)] = additional[status];
    }
  }

  return reorderResponses(responses);
}

function reorderResponses(responses: Record<string, ResponseObject>): Record<string, ResponseObject> {
  const ordered: Record<string, ResponseObject> = {};
  for (const status of ["401", "404", "409", "413", "422", "429", "500"]) {
    if (responses[status]) ordered[status] = responses[status];
  }
  return ordered;
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
  if (code === "RATE_LIMITED") {
    return jsonResponse(description, ref("Error"), {
      error: {
        code,
        message: "Too many requests. Wait briefly and retry.",
        httpStatus,
        details: {
          retryHint: "retry_after_short_delay",
          retryAfterSeconds: 60,
          retryGuidance: "Wait briefly before sending the next Developer OpenAPI request."
        }
      },
      requestId: "req-11111111-1111-4111-8111-111111111111"
    });
  }

  return jsonResponse(description, ref("Error"), {
    error: {
      code,
      message: description,
      httpStatus
    },
    requestId: "req-11111111-1111-4111-8111-111111111111"
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
