import {
  SEARCH_QUERY_MAX_CHARACTERS,
  SEARCH_QUERY_MAX_BYTES,
  SEARCH_RESULT_DEFAULT_LIMIT,
  SEARCH_RESULT_MAX_LIMIT,
  SEARCH_RERANK_MAX_TOP_K
} from "./search-query-contract.js";

export type SchemaObject = Record<string, unknown>;
export type ParameterObject = Record<string, unknown>;
export type ResponseObject = Record<string, unknown>;
export type OperationObject = Record<string, unknown>;
export type PathItemObject = Record<string, OperationObject>;
type AdditionalErrorStatus = 404 | 409 | 413 | 422;

export const bearerSecurity = [{ bearerAuth: [] }];
export const jsonContentType = "application/json";

const OPERATION_DESCRIPTIONS: Record<string, string> = {
  getDeveloperOpenApiHealth: "Check whether the Developer OpenAPI is available. The response only returns the health state.",
  getDeveloperOpenApiVersion: "Read the product version and Developer OpenAPI version for client compatibility checks.",
  getDeveloperOpenApiContract: "Read the machine-readable OpenAPI contract that describes the Developer OpenAPI.",
  listKnowledgeBases: "Read a paginated list of knowledge bases available to the current OpenAPI key.",
  createKnowledgeBase: "Create a new knowledge base and receive the `knowledgeBaseId` required by its upload, processing-status, published-file, and deletion APIs.",
  getKnowledgeBase: "Read one knowledge base by `knowledgeBaseId`.",
  updateKnowledgeBase: "Update the name or description of one knowledge base. Send its current `resourceRevision` in `If-Match` so a concurrent change is not overwritten.",
  deleteKnowledgeBase: "Start deleting one knowledge base. A successful response confirms that deletion has started and the knowledge base will become unavailable.",
  createUploadSession: "Start a resumable upload and receive the session identifier, the maximum number of files per list request, and the recommended upload concurrency.",
  addUploadManifestEntries: "Add a batch of Markdown files to an upload session by registering each relative path, size, and optional checksum.",
  sealUploadManifest: "Confirm that the upload file list is complete, then read the session to find the files whose Markdown content must be uploaded.",
  uploadSessionEntryContent: "Upload the complete Markdown content for one file marked `upload_required`.",
  getUploadSession: "Read upload progress and the next page of entries needed to resume a session.",
  cancelUploadSession: "Cancel an upload session that has not completed.",
  reconcileUploadSession: "Refresh entries that were temporarily blocked by another change to the same path.",
  finalizeUploadSession: "Submit the uploaded files for background processing. The response confirms submission while individual files can still be processing.",
  listKnowledgeBaseSourceFiles: "Read a paginated list of uploaded Markdown files and their processing status.",
  getKnowledgeBaseSourceFile: "Read the processing status and available actions for one uploaded Markdown file by `sourceFileId`.",
  moveSourceFile: "Rename an uploaded Markdown file or move it to an existing uploaded directory.",
  deleteSourceFile: "Delete one uploaded Markdown file and remove its published page from the readable knowledge base.",
  getSourceFileContent: "Read the complete Markdown content currently stored for one uploaded file.",
  replaceSourceFileContent: "Replace the complete Markdown content of one uploaded file and optionally move it.",
  listSourceDirectories: "Read the direct child directories under an uploaded directory.",
  getSourceDirectory: "Read one uploaded directory and its file counts.",
  moveSourceDirectory: "Rename or move one uploaded directory with all files and subdirectories below it.",
  deleteSourceDirectory: "Delete one uploaded directory and all files and subdirectories below it.",
  listResourceOperations:
    "List file and directory changes for a knowledge base, including moves, renames, content replacements, and deletions. Results can be filtered by processing status.",
  getResourceOperation:
    "Use the `operationId` returned by a change request to read its processing state, final result, and error details.",
  listKnowledgeBaseSourceFileEvents: "Read the processing history for one uploaded Markdown file, including each step, message level, and time.",
  retryKnowledgeBaseSourceFile: "Manually retry one uploaded Markdown file that failed processing.",
  listKnowledgeBaseTree: "Browse the currently published knowledge-base files and directories.",
  getFileContentByPath: "Read a published knowledge-base file by its `path`, such as `index.md` or `pages/example.md`.",
  getFileById: "Read the metadata and available read links for one published file by `fileId`.",
  getFileContentById: "Read a published knowledge-base file by `fileId`.",
  listRelatedFiles: "Read a paginated list of files related to the selected file, with paths for opening their content.",
  searchGeneratedFiles: "Find published files by path, title, heading, Markdown content, metadata, and optional file relationships. Read a returned file before using its content.",
  expandGraph: "Provide exactly one starting point: a file, relationship node, relationship edge, or short query. The response returns related files up to the requested depth and result limits.",
  getGraphOverview: "Read a compact overview of available file relationships.",
  createWebhook: "Create a webhook subscription and receive the signing secret once.",
  listWebhooks: "Read a paginated list of webhook subscriptions.",
  deleteWebhook: "Delete one webhook subscription by `webhookId`.",
  listWebhookDeliveries: "Read a paginated list of webhook delivery records.",
  redeliverWebhook: "Request redelivery for one webhook delivery record by `deliveryId`."
};

const OPERATION_SUCCESS_DESCRIPTIONS: Record<string, string> = {
  getDeveloperOpenApiHealth: "Current Developer OpenAPI health state.",
  getDeveloperOpenApiVersion: "Current product and Developer OpenAPI versions.",
  getDeveloperOpenApiContract: "Complete OpenAPI 3.1 contract for the Developer OpenAPI.",
  listKnowledgeBases: "Requested page of knowledge bases and the token for reading the next page.",
  createKnowledgeBase: "Newly created knowledge base.",
  getKnowledgeBase: "Requested knowledge base.",
  updateKnowledgeBase: "Knowledge base after the metadata update.",
  deleteKnowledgeBase: "Knowledge-base deletion request and the number of affected files and directories.",
  createUploadSession: "New upload session and its file-list and content-upload settings.",
  addUploadManifestEntries: "Upload session after accepting this batch of file records.",
  sealUploadManifest: "Upload session after confirming the complete file list.",
  uploadSessionEntryContent: "Upload entry after receiving its Markdown content.",
  getUploadSession: "Current upload session and the requested page of file records.",
  cancelUploadSession: "Upload session after cancellation.",
  reconcileUploadSession: "Upload session after rechecking blocked entries.",
  finalizeUploadSession: "Upload session after submitting uploaded files for background processing.",
  listKnowledgeBaseSourceFiles: "Requested page of uploaded Markdown files and the token for reading the next page.",
  getKnowledgeBaseSourceFile: "Requested uploaded Markdown file and its current processing status.",
  moveSourceFile: "File move or rename request accepted for background processing.",
  getSourceFileContent: "Complete current Markdown content of the uploaded file.",
  replaceSourceFileContent: "File content replacement accepted for background processing.",
  deleteSourceFile: "File deletion accepted for background processing.",
  listSourceDirectories: "Requested page of direct child directories from the uploaded folder structure.",
  getSourceDirectory: "Requested directory from the uploaded folder structure.",
  moveSourceDirectory: "Directory move or rename request accepted for background processing.",
  deleteSourceDirectory: "Directory deletion accepted for background processing, with the number of affected files and directories.",
  listResourceOperations: "Requested page of file and directory changes.",
  getResourceOperation: "Requested file or directory change.",
  listKnowledgeBaseSourceFileEvents: "Requested page of processing history for the uploaded Markdown file.",
  retryKnowledgeBaseSourceFile: "Uploaded file and accepted retry details.",
  listKnowledgeBaseTree: "Requested page of published files and directories, including parent directories for search results.",
  getFileContentByPath: "Complete content of the published file at the requested path.",
  searchGeneratedFiles: "Published files ranked by relevance to the supplied query.",
  expandGraph: "Related files and relationship details for the selected starting point.",
  getGraphOverview: "Relationship counts and links for exploring the currently published knowledge-base version.",
  getFileById: "Requested published file metadata and links for reading or exploring it.",
  getFileContentById: "Complete content of the published file with the requested identifier.",
  listRelatedFiles: "Requested page of files related to the selected published file.",
  createWebhook: "New webhook subscription and its signing secret.",
  listWebhooks: "Requested page of webhook subscriptions.",
  deleteWebhook: "Confirmation that the webhook subscription was deleted.",
  listWebhookDeliveries: "Requested page of webhook delivery attempts.",
  redeliverWebhook: "New delivery attempt created from the selected webhook delivery."
};

export function operation(input: {
  tag: string;
  operationId: string;
  summary: string;
  description?: string;
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
    description: input.description ?? operationDescription(input.operationId),
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
            successDescription(input.operationId),
            input.successContentType,
            input.successSchema,
            input.successExample
          )
        : jsonResponse(
            successDescription(input.operationId),
            input.successSchema,
            input.successExample
          ),
      ...standardErrorResponses(input.additionalErrorStatuses),
      ...input.extraResponses
    }
  };
}

function operationDescription(operationId: string): string {
  const description = OPERATION_DESCRIPTIONS[operationId];
  if (!description) {
    throw new Error(`Missing Developer OpenAPI operation description for ${operationId}.`);
  }
  return description;
}

function successDescription(operationId: string): string {
  const description = OPERATION_SUCCESS_DESCRIPTIONS[operationId];
  if (!description) {
    throw new Error(`Missing Developer OpenAPI success description for ${operationId}.`);
  }
  return description;
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
        nextCursor: nullableString(
          "Pagination token returned by this endpoint. Reuse it only with the same endpoint and unchanged filters. If it is rejected, restart without a cursor."
        )
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
      description: "Pagination token returned by the same endpoint for reading the next page.",
      schema: { type: "string" }
    }
  ];
}

export function sourceFileListFilterParameters(): ParameterObject[] {
  return [
    queryParameter("directoryId", "Parent uploaded-directory identifier. Use `root` for files at the knowledge-base root.", {
      type: "string",
      minLength: 1,
      maxLength: 200,
      example: "source-directory-handbook"
    }),
    queryParameter("pathQuery", "Case-insensitive partial match against uploaded file paths.", {
      type: "string",
      minLength: 1,
      maxLength: 160,
      example: "handbook/guide"
    }),
    queryParameter("sourceFileIdPrefix", "Uploaded-file ID prefix used to filter results.", {
      type: "string",
      minLength: 8,
      maxLength: 160,
      example: "source-file-11111111"
    }),
    queryParameter("state", "Filter by the uploaded file's current processing status.", {
      type: "string",
      enum: ["queued", "running", "pending_publication", "visible", "failed"],
      example: "visible"
    }),
    queryParameter("currentStage", "Filter by the current file-processing step.", {
      type: "string",
      enum: [
        "upload_storage",
        "metadata_resolution",
        "llm_suggestion",
        "graph_generation",
        "graphrag_processing",
        "semantic_reconciliation",
        "embedding_generation",
        "affected_projection",
        "search_publication",
        "semantic_maintenance_required",
        "projection_generation",
        "generation_validation",
        "generation_activation"
      ],
      example: "generation_activation"
    }),
    queryParameter("generatedOutputStatus", "Filter by whether the published file is ready to read.", {
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
  return pathParameter("sourceFileId", "Uploaded-file identifier returned by upload or uploaded-file list APIs.");
}

export function fileIdParameter(): ParameterObject {
  return pathParameter("fileId", "Published file identifier returned by tree, search, related-file, or file APIs.");
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
    description: "Published knowledge-base file path returned by tree, search, or file APIs. Parent traversal, backslashes, and storage paths are rejected.",
    schema: { type: "string", minLength: 1 }
  };
}

export function fileSearchParameters(): ParameterObject[] {
  return [
    {
      ...queryParameter("query", `One standalone natural-language question or search text. After Unicode and whitespace normalization it must contain 2 through ${SEARCH_QUERY_MAX_CHARACTERS} grapheme clusters, use at most ${SEARCH_QUERY_MAX_BYTES} UTF-8 bytes, and contain no unsafe control characters. Results are source files that must be read before their content is used as evidence.`, {
        type: "string",
        minLength: 2,
        maxLength: SEARCH_QUERY_MAX_CHARACTERS
      }),
      required: true
    },
    queryParameter("scope", "Eligible evidence fields. `path` runs exact-path and grounded-title families, `metadata` runs the lexical metadata family, and `all` uses every family enabled by the selected mode.", {
      type: "string",
      enum: ["all", "path", "metadata"],
      default: "all"
    }),
    queryParameter("fileKind", "Published-file type filter. Search returns active Markdown pages created from uploaded files. `all` removes the explicit type predicate but currently returns the same page set.", {
      type: "string",
      enum: ["all", "page"],
      default: "page"
    }),
    queryParameter("mode", "Evidence plan. With `scope=all`, `file` runs exact path, grounded title, lexical, Jieba, and content vector retrieval; `graph` runs exact path, grounded title, file relationships, and entity, relationship, and community vector retrieval; `hybrid` runs both plans. `scope=path` or `scope=metadata` narrows these families as documented. Every result remains a readable source file.", {
      type: "string",
      enum: ["file", "graph", "hybrid"],
      default: "hybrid"
    }),
    queryParameter("graphDepth", "Relationship context depth returned for graph and hybrid results. `0` returns the seed graph reference without relationships, `1` includes direct relationships, and `2` may include second-level relationships within `graphFanout`. Values above the deployment maximum return 422.", {
      type: "integer",
      enum: [0, 1, 2]
    }),
    queryParameter("graphFanout", "Maximum relationship records returned per graph search result across the requested depth. When omitted, the deployment setting is used; values above the deployment maximum return 422.", {
      type: "integer",
      minimum: 0
    }),
    queryParameter("okfStatus", "Return only files whose normalized OKF document status matches this value. Files with an invalid status are excluded.", {
      type: "string",
      enum: ["draft", "stable", "deprecated"]
    }),
    queryParameter("okfTrustTier", "Return only files whose normalized OKF verification tier matches this value. Files with invalid verification metadata are excluded.", {
      type: "string",
      enum: ["unverified", "machine-confirmed", "human-reviewed"]
    }),
    queryParameter("okfFreshness", "Return only files whose valid `stale_after` date is fresh or stale on the request date. Files without a valid stale date are excluded.", {
      type: "string",
      enum: ["fresh", "stale"]
    }),
    queryParameter("rerank", "Optionally rerank the authorized fused source-file candidates with the active Admin-configured reranker. The default keeps deterministic fused ranking.", {
      type: "boolean",
      default: false
    }),
    queryParameter("rerankTopK", "Candidate count sent to the optional reranker. It is valid only with `rerank=true`, must be at least `limit`, and defaults to the greater of 30 and `limit`.", {
      type: "integer",
      minimum: 1,
      maximum: SEARCH_RERANK_MAX_TOP_K
    }),
    queryParameter("rerankScoreThreshold", "Minimum normalized reranker score for non-exact candidates. It is valid only with `rerank=true` and defaults to 0.35.", {
      type: "number",
      minimum: 0,
      maximum: 1,
      example: 0.35
    }),
    queryParameter("limit", "Final source-file result count for this search request.", {
      type: "integer",
      minimum: 1,
      maximum: SEARCH_RESULT_MAX_LIMIT,
      default: SEARCH_RESULT_DEFAULT_LIMIT
    }),
    queryParameter("cursor", "Pagination token returned by the same search query, filters, active generation, and effective ranking settings.", {
      type: "string"
    })
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
    "500": errorResponse("The API encountered an internal error.", "INTERNAL_ERROR", 500),
    "503": errorResponse(
      "The data required by this operation is temporarily unavailable. Retry later and keep the request ID if support assistance is needed.",
      "DATABASE_REPOSITORY_UNAVAILABLE",
      503
    )
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
  for (const status of ["401", "404", "409", "413", "422", "429", "500", "503"]) {
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
