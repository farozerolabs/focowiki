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
  successStatus: number;
  successSchema: SchemaObject;
  extraResponses?: Record<string, ResponseObject>;
}): OperationObject {
  return {
    tags: [input.tag],
    operationId: input.operationId,
    summary: input.summary,
    security: bearerSecurity,
    ...(input.parameters ? { parameters: input.parameters } : {}),
    ...(input.requestBody ? { requestBody: input.requestBody } : {}),
    ...(input.requestSchema
      ? {
          requestBody: {
            required: true,
            content: {
              [jsonContentType]: {
                schema: input.requestSchema
              }
            }
          }
        }
      : {}),
    responses: {
      [String(input.successStatus)]: jsonResponse("Successful response.", input.successSchema),
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

export function knowledgeBaseIdParameter(): ParameterObject {
  return pathParameter("knowledgeBaseId", "Knowledge-base identifier returned by knowledge-base APIs.");
}

export function taskIdParameter(): ParameterObject {
  return pathParameter("taskId", "Task identifier returned by upload or deletion APIs.");
}

export function fileIdParameter(): ParameterObject {
  return pathParameter("fileId", "File identifier returned by upload, task, tree, or file detail APIs.");
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
    "401": errorResponse("Bearer API key is missing, malformed, unknown, revoked, or deleted."),
    "404": errorResponse("The requested resource or route was not found."),
    "409": errorResponse("The requested operation conflicts with the current resource state."),
    "422": errorResponse("The request failed validation."),
    "429": errorResponse("The request exceeded configured rate limits."),
    "500": errorResponse("The API encountered an internal error.")
  };
}

function jsonResponse(description: string, schema: SchemaObject): ResponseObject {
  return {
    description,
    content: {
      [jsonContentType]: {
        schema
      }
    }
  };
}

function errorResponse(description: string): ResponseObject {
  return jsonResponse(description, ref("Error"));
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
