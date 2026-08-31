import {
  idSchema,
  nullableString,
  nullableTimestampSchema,
  objectSchema,
  pageSchema,
  ref,
  timestampSchema,
  type SchemaObject
} from "./openapi-shared.js";
import { WEBHOOK_EVENT_TYPES } from "../webhooks/events.js";
import {
  okfFrontmatterExamples,
  okfSignalExamples
} from "./openapi-examples.js";

const SOURCE_FILE_PROCESSING_STATE_DESCRIPTION =
  "Current document status. `available` is immediately readable. `error` includes safe failure details and backend-authorized recovery actions.";

const SOURCE_FILE_WORK_PROGRESS_DESCRIPTION =
  "Progress across the work required for this document. Work can run concurrently; completed counts work that finished successfully.";

const GENERATED_OUTPUT_STATUS_DESCRIPTION =
  "`current_available` is the active current revision. `previous_available` is the prior active revision retained after replacement failure. `unavailable` means no generated content can be read.";

const SEARCH_EVIDENCE_FAMILIES = [
  "exact_path",
  "exact_title",
  "lexical",
  "jieba",
  "file_graph",
  "file_relationship",
  "content_vector",
  "entity_vector",
  "relationship_vector",
  "community_vector"
] as const;

const SEMANTIC_SEARCH_SAFE_CODES = [
  "SEMANTIC_ADOPTION_REQUIRED",
  "SEMANTIC_LEXICAL_PROJECTION_UNAVAILABLE",
  "SEMANTIC_PROVIDER_ADOPTION_REQUIRED",
  "SEMANTIC_SEARCH_UNAVAILABLE",
  "SEMANTIC_LANE_PARTIAL_FAILURE"
] as const;

const RERANKER_SEARCH_SAFE_CODES = [
  "RERANKER_DISABLED",
  "RERANKER_RETRIEVAL_UNAVAILABLE",
  "RERANKER_ABORTED",
  "RERANKER_AUTHENTICATION_FAILED",
  "RERANKER_INVALID_REQUEST",
  "RERANKER_INVALID_RESPONSE",
  "RERANKER_CONFIGURATION_UNAVAILABLE",
  "RERANKER_NOT_CONFIGURED",
  "RERANKER_NOT_ACTIVE",
  "RERANKER_NO_CANDIDATES",
  "RERANKER_PAYLOAD_TOO_LARGE",
  "RERANKER_PROVIDER_UNAVAILABLE",
  "RERANKER_RATE_LIMITED",
  "RERANKER_RESPONSE_TOO_LARGE",
  "RERANKER_TIMEOUT",
  "RERANKER_UNAVAILABLE"
] as const;

const SCHEMA_FIELD_DESCRIPTIONS: Record<string, string> = {
  actions: "Actions currently available for this resource.",
  affectedDirectoryCount: "Number of uploaded directories covered by the deletion request.",
  affectedFileCount: "Number of uploaded Markdown files covered by the deletion request.",
  apiVersion: "Developer OpenAPI contract version.",
  attemptCount: "Number of delivery attempts made so far.",
  available: "Whether relationship data is available for this response.",
  activeContentRevision: "Current readable knowledge-base content revision.",
  coalesced: "Whether the retry joined an equivalent retry already in progress.",
  code: "Error or failure code that clients can handle programmatically.",
  completedAt: "Time when processing or deletion finished.",
  content: "Complete readable file content.",
  contentAvailable: "Whether the readable file content can currently be read.",
  contentRevision: "File-content version number. It increases after each successful replacement.",
  contentType: "Media type of the stored or generated content.",
  contentUploadConcurrency: "Recommended maximum number of concurrent content uploads for this session.",
  correlationId: "Identifier that support staff can use to trace the failed background request.",
  counts: "Current upload-session counters.",
  createdAt: "Time when the resource was created.",
  workProgress: "Progress across the work required for this document.",
  cursorProvided: "Whether this request used a pagination token from an earlier response.",
  declaredByteCount: "Total number of Markdown file bytes declared for the upload session.",
  declaredFileCount: "Total number of Markdown files declared for the upload session.",
  declaredSize: "Declared file size in bytes.",
  deletable: "Whether deletion can currently be requested.",
  deleted: "Whether the webhook subscription was deleted.",
  deleting: "Whether deletion is currently in progress.",
  deletion: "Accepted deletion details.",
  delivery: "Webhook delivery created by the redelivery request.",
  depth: "Directory depth or number of relationship levels to explore.",
  descendantFileCount: "Number of uploaded Markdown files below this directory or tree entry.",
  directDirectoryCount: "Number of direct child directories.",
  directFileCount: "Number of uploaded Markdown files directly inside this directory.",
  direction: "Relationship direction relative to `fromFileId` for this traversal step.",
  directory: "Uploaded directory returned by the request.",
  directoryPath: "Parent directory path within the uploaded folder structure.",
  disposition: "Server decision describing whether this entry must upload content.",
  endpointHost: "Public hostname of the webhook endpoint; the full URL is not returned.",
  entries: "File records registered in the upload session.",
  entry: "Upload entry returned by the request.",
  entryType: "Tree entry type.",
  error: "Structured Developer OpenAPI error.",
  eventType: "Webhook event type delivered to the subscription.",
  events: "Webhook event types included in this subscription.",
  existingResourceRevision: "Current file version when an upload is skipped because the same content already exists.",
  expectedResourceRevision: "Resource revision required when the operation was accepted.",
  expiresAt: "Time when an unfinished upload session expires.",
  fanout: "Maximum related records returned for each explored item.",
  file: "Readable file metadata returned by the request.",
  fileContentById: "Request template for reading readable file content by file ID.",
  fileContentByPath: "Request template for reading readable file content by knowledge-base path.",
  fileDetailById: "Request template for reading readable file details.",
  fileKind: "Readable file type.",
  finalized: "Number of uploaded files submitted for background processing.",
  frontmatter: "Metadata parsed from the YAML front matter at the beginning of the Markdown file.",
  generatedPath: "Readable knowledge-base path associated with this uploaded file.",
  graphContext: "Relationship details and follow-up links for this search result.",
  graphExpansionByFileId: "Request template for exploring relationships from this readable file.",
  graphSummary: "File relationship availability and counts for this response.",
  hasMore: "Whether another result page is available.",
  href: "Relative Developer OpenAPI path for this action.",
  httpStatus: "HTTP status returned by the API or webhook endpoint.",
  indexedDocumentCount: "Number of readable files available to relationship search.",
  indexedRelationshipCount: "Number of file relationships available to relationship search.",
  items: "Records returned on this page.",
  kind: "Type of file change, retry, or available action.",
  knowledgeBase: "Knowledge base returned by the request.",
  lastDeliveryAt: "Time of the most recent webhook delivery.",
  limit: "Maximum number of records applied to this request.",
  links: "Developer OpenAPI links for reading or managing this uploaded file.",
  listGraphRoot: "File-tree request for the relationship-data root.",
  manifestPageSize: "Maximum number of file records accepted in one request.",
  matchedFields: "Fields that caused this search result to match.",
  meaning: "Human-readable interpretation of the result.",
  message: "Human-readable error, failure, or availability message.",
  method: "HTTP method used by this action.",
  mutable: "Whether this uploaded Markdown file can currently be changed.",
  name: "Human-readable resource name.",
  nextActions: "Suggested follow-up reads for continued file exploration.",
  occurredAt: "Time when file processing stopped with an error.",
  operation: "File or directory change record returned by the request.",
  parentPath: "Parent directory path of this tree entry.",
  path: "Readable knowledge-base path of the related file.",
  workKind: "Processing step where the document stopped.",
  product: "Product identifier.",
  query: "Search text and options used for this result.",
  readActions: "Developer OpenAPI links for reading this file or exploring its relationships.",
  reason: "Human-readable reason for the relationship.",
  receivedSize: "Number of content bytes received for this upload entry.",
  rejectedDeleting: "Number of upload entries rejected because deletion is in progress.",
  relatedFilesById: "Request template for reading related files by readable file ID.",
  relationType: "Relationship type.",
  relationshipCount: "Number of relationships returned by graph expansion.",
  relationships: "Related readable files found for this search result.",
  relativePath: "Path within the uploaded folder structure.",
  requestId: "Request identifier used for support correlation.",
  resourceRevision: "Current resource version used with `If-Match` to prevent overwriting a concurrent change.",
  resources: "Relationship files and API links available for further exploration.",
  result: "Final result of the file or directory change.",
  resultCount: "Number of results returned on this page.",
  resultSummary: "Summary of the current result page.",
  retry: "Retry request accepted by the server.",
  retryAfterSeconds: "Minimum number of seconds to wait before retrying.",
  retryGuidance: "Instructions for retrying or checking the request again.",
  retryHint: "Recommended way to retry the request.",
  retryKind: "Type of retry that can be requested.",
  scope: "File, directory, or knowledge base affected by this action or retry.",
  selected: "Number of file records accepted into the upload session.",
  self: "Developer OpenAPI path for checking this file or directory change.",
  session: "Upload session returned by the request.",
  sizeBytes: "Content size in bytes.",
  skippedExisting: "Number of upload entries already present with matching content.",
  sourceFile: "Uploaded Markdown file returned by the request.",
  sourceFileStatusById: "Request template for reading uploaded-file processing status.",
  state: "Current processing status.",
  status: "Current health or delivery status.",
  summary: "File relationship counts.",
  tags: "Tags parsed from the readable Markdown file.",
  title: "Resolved related-file title.",
  transferState: "Current content transfer state for this upload entry.",
  transport: "File-list request size and recommended upload concurrency for the new session.",
  updatedAt: "Time when the resource was last updated.",
  uploadRequired: "Number of registered files whose Markdown content must be uploaded.",
  uploaded: "Number of entries whose content upload completed.",
  url: "HTTPS webhook endpoint.",
  version: "Current product release version.",
  waitingReservation: "Number of entries waiting for another upload of the same content to finish.",
  webhook: "Webhook subscription returned by the request.",
};

export function createDeveloperOpenApiSchemas(): Record<string, SchemaObject> {
  const schemas = {
    Error: objectSchema(
      {
        error: objectSchema(
          {
            code: {
              type: "string",
              enum: [
                "UNAUTHORIZED",
                "FORBIDDEN",
                "NOT_FOUND",
                "CONFLICT",
                "PAYLOAD_TOO_LARGE",
                "VALIDATION_ERROR",
                "RATE_LIMITED",
                "UNSUPPORTED_ROUTE",
                "INTERNAL_ERROR",
                "DATABASE_REPOSITORY_UNAVAILABLE",
                "SEARCH_TIMEOUT",
                "SEARCH_UNAVAILABLE",
                "SEARCH_OVERLOADED"
              ]
            },
            message: { type: "string" },
            httpStatus: { type: "integer" },
            details: {
              type: "object",
              additionalProperties: true,
              description:
                "Additional error information. `RATE_LIMITED` responses can include how long to wait and how to retry.",
              properties: {
                retryHint: { type: "string" },
                retryAfterSeconds: { type: "integer", minimum: 1 },
                retryGuidance: { type: "string" }
              }
            }
          },
          ["code", "message", "httpStatus"]
        ),
        requestId: { type: "string" }
      },
      ["error", "requestId"]
    ),
    HealthResponse: objectSchema(
      {
        status: {
          type: "string",
          const: "ok",
          description: "Current Developer OpenAPI health state."
        }
      },
      ["status"]
    ),
    VersionResponse: objectSchema(
      {
        product: { type: "string", const: "focowiki" },
        version: { type: "string" },
        apiVersion: { type: "string", const: "v2" }
      },
      ["product", "version", "apiVersion"]
    ),
    Page: objectSchema(
      {
        items: { type: "array", items: {} },
        nextCursor: nullableString(
          "Pagination token returned by this endpoint. Reuse it only with the same endpoint and unchanged filters. If it is rejected, restart without a cursor."
        )
      },
      ["items", "nextCursor"]
    ),
    KnowledgeBase: objectSchema(
      {
        knowledgeBaseId: idSchema("Knowledge-base identifier used by every path that operates on this knowledge base."),
        name: { type: "string" },
        description: nullableString("Optional knowledge-base description."),
        activeContentRevision: {
          type: "integer",
          minimum: 0,
          description: SCHEMA_FIELD_DESCRIPTIONS.activeContentRevision
        },
        resourceRevision: { type: "integer", minimum: 1 },
        createdAt: timestampSchema(),
        updatedAt: timestampSchema()
      },
      ["knowledgeBaseId", "name", "description", "activeContentRevision", "resourceRevision", "createdAt", "updatedAt"]
    ),
    KnowledgeBaseListResponse: pageSchema(ref("KnowledgeBase")),
    KnowledgeBaseResponse: objectSchema({ knowledgeBase: ref("KnowledgeBase") }, ["knowledgeBase"]),
    KnowledgeBaseMutationResponse: objectSchema(
      { knowledgeBase: ref("KnowledgeBase") },
      ["knowledgeBase"]
    ),
    CreateKnowledgeBaseRequest: objectSchema(
      {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          description: "Human-readable resource name, limited to 255 UTF-8 bytes."
        },
        description: boundedNullableString(
          "Optional description, limited to 16384 UTF-8 bytes.",
          16_384
        )
      },
      ["name"]
    ),
    UpdateKnowledgeBaseRequest: {
      ...objectSchema({
        name: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          description: "Human-readable resource name, limited to 255 UTF-8 bytes."
        },
        description: boundedNullableString(
          "Updated description or null to clear it, limited to 16384 UTF-8 bytes.",
          16_384
        )
      }),
      minProperties: 1
    },
    CreateUploadSessionRequest: objectSchema(
      {
        declaredFileCount: { type: "integer", minimum: 0, example: 2 },
        declaredByteCount: { type: "integer", minimum: 0, example: 4096 }
      },
      ["declaredFileCount", "declaredByteCount"]
    ),
    UploadManifestEntryRequest: uploadManifestEntryRequestSchema(),
    UploadManifestPageRequest: objectSchema(
      {
        entries: {
          type: "array",
          minItems: 1,
          items: ref("UploadManifestEntryRequest"),
          description: "One or more Markdown file records added in this request."
        }
      },
      ["entries"]
    ),
    UploadSessionCounts: uploadSessionCountsSchema(),
    UploadSession: uploadSessionSchema(),
    UploadSessionEntry: uploadSessionEntrySchema(),
    UploadSessionTransport: objectSchema(
      {
        manifestPageSize: { type: "integer", minimum: 1 },
        contentUploadConcurrency: { type: "integer", minimum: 1, maximum: 16 }
      },
      ["manifestPageSize", "contentUploadConcurrency"]
    ),
    CreateUploadSessionResponse: objectSchema(
      {
        session: ref("UploadSession"),
        transport: ref("UploadSessionTransport")
      },
      ["session", "transport"]
    ),
    UploadSessionResponse: objectSchema(
      {
        session: ref("UploadSession")
      },
      ["session"]
    ),
    UploadSessionStatusResponse: objectSchema(
      {
        session: ref("UploadSession"),
        entries: {
          ...pageSchema(ref("UploadSessionEntry")),
          description: "Requested page of upload file records and the token for reading the next page."
        }
      },
      ["session", "entries"]
    ),
    UploadEntryResponse: objectSchema(
      {
        entry: ref("UploadSessionEntry")
      },
      ["entry"]
    ),
    SourceDirectory: sourceDirectorySchema(),
    SourceDirectoryResponse: objectSchema(
      { directory: ref("SourceDirectory") },
      ["directory"]
    ),
    SourceDirectoryListResponse: pageSchema(ref("SourceDirectory")),
    SourceResourceFile: sourceResourceFileSchema(),
    SourceResourceFileResponse: objectSchema(
      { sourceFile: ref("SourceResourceFile") },
      ["sourceFile"]
    ),
    SourceFileRetryResponse: objectSchema(
      {
        sourceFile: ref("SourceResourceFile"),
        retry: objectSchema(
          {
            kind: { type: "string" },
            scope: { type: "string" },
            coalesced: { type: "boolean" }
          },
          ["kind", "scope", "coalesced"]
        )
      },
      ["sourceFile", "retry"]
    ),
    SourceResourceFileListResponse: pageSchema(ref("SourceResourceFile")),
    MoveSourceFileRequest: objectSchema(
      {
        relativePath: {
          type: "string",
          minLength: 4,
          maxLength: 2_048,
          pattern: "^(?:[^/]{1,1000}/)*[^/]{1,997}\\.md$",
          example: "handbook/setup/install.md",
          description:
            "Target Markdown path inside the knowledge base. Its parent directory must already exist, except when moving the file to the root directory."
        }
      },
      ["relativePath"]
    ),
    MoveSourceDirectoryRequest: objectSchema(
      {
        relativePath: {
          type: "string",
          minLength: 1,
          maxLength: 2_048,
          pattern: "^(?:[^/]{1,1000}/)*[^/]{1,1000}$",
          example: "handbook/archive",
          description:
            "Target directory path inside the knowledge base. Its parent directory must already exist, except when moving the directory to the root."
        }
      },
      ["relativePath"]
    ),
    ResourceOperation: resourceOperationSchema(),
    ResourceOperationResponse: objectSchema(
      { operation: ref("ResourceOperation") },
      ["operation"]
    ),
    ResourceOperationListResponse: pageSchema(ref("ResourceOperation")),
    KnowledgeBaseDeletionResponse: objectSchema(
      {
        operation: ref("ResourceOperation"),
        deletion: objectSchema(
          {
            knowledgeBaseId: idSchema("Deleted knowledge-base identifier."),
            accepted: { type: "boolean", description: "Whether the deletion request was accepted." },
            affectedDirectoryCount: { type: "integer", minimum: 0 },
            affectedFileCount: { type: "integer", minimum: 0 }
          },
          ["knowledgeBaseId", "accepted", "affectedDirectoryCount", "affectedFileCount"]
        )
      },
      ["operation", "deletion"]
    ),
    ResourceDeletionResponse: objectSchema(
      {
        operation: ref("ResourceOperation"),
        deletion: objectSchema({
          sourceFileId: nullableString("Identifier of the deleted uploaded file."),
          directoryId: nullableString("Identifier of the deleted uploaded directory."),
          affectedDirectoryCount: { type: "integer", minimum: 0 },
          affectedFileCount: { type: "integer", minimum: 0 },
          visibility: nullableString("Current visibility of the deleted file or directory.")
        })
      },
      ["operation", "deletion"]
    ),
    GeneratedTreeEntry: generatedTreeEntrySchema(),
    TreeResponse: generationPageSchema(ref("GeneratedTreeEntry")),
    OkfSignals: okfSignalsSchema(),
    GeneratedFile: generatedFileSchema(),
    FileSearchResult: fileSearchResultSchema(),
    FileSearchQueryContext: fileSearchQueryContextSchema(),
    FileSearchResultSummary: fileSearchResultSummarySchema(),
    FileSearchResponse: fileSearchResponseSchema(),
    FileDetailResponse: objectSchema(
      {
        file: ref("GeneratedFile")
      },
      ["file"]
    ),
    FileContentResponse: objectSchema(
      {
        file: ref("GeneratedFile"),
        content: { type: "string" }
      },
      ["file", "content"]
    ),
    RelatedFile: relatedFileSchema(),
    RelatedFileListResponse: objectSchema(
      {
        activeContentRevision: activeContentRevisionSchema(),
        fileId: idSchema("Requested file identifier."),
        sourceFileId: idSchema("Uploaded-file identifier associated with the requested readable file."),
        items: { type: "array", items: ref("RelatedFile") },
        nextCursor: nullableString("Pagination token returned by this endpoint for reading the next page with the same file and filters."),
        message: nullableString("Status and suggested next step when no related files are available."),
        nextActions: { type: "array", items: { type: "string" } }
      },
      ["activeContentRevision", "fileId", "sourceFileId", "items", "nextCursor"]
    ),
    GraphExpansionResponse: graphExpansionResponseSchema(),
    GraphOverviewResponse: graphOverviewResponseSchema(),
    DeleteResponse: objectSchema(
      {
        deleted: { type: "boolean" },
        webhookId: idSchema("Deleted webhook identifier.")
      },
      ["deleted", "webhookId"]
    ),
    Webhook: objectSchema(
      {
        webhookId: idSchema("Webhook identifier."),
        name: { type: "string" },
        endpointHost: { type: "string" },
        events: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", enum: [...WEBHOOK_EVENT_TYPES] }
        },
        createdAt: timestampSchema(),
        lastDeliveryAt: nullableTimestampSchema()
      },
      ["webhookId", "name", "endpointHost", "events", "createdAt", "lastDeliveryAt"]
    ),
    WebhookCreateRequest: objectSchema(
      {
        name: nullableString("Optional webhook name."),
        url: {
          type: "string",
          format: "uri",
          pattern: "^[Hh][Tt][Tt][Pp][Ss]://",
          description: "Public HTTPS receiver URL. Loopback, private, link-local, reserved, credential-bearing, fragment-bearing, and redirect targets are rejected."
        },
        events: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", enum: [...WEBHOOK_EVENT_TYPES] }
        }
      },
      ["url", "events"]
    ),
    WebhookCreateResponse: objectSchema(
      {
        webhook: ref("Webhook"),
        signingSecret: {
          type: "string",
          description: "Returned only by this create operation. An identical idempotent replay returns the same value; list operations never return it."
        }
      },
      ["webhook", "signingSecret"]
    ),
    WebhookListResponse: pageSchema(ref("Webhook")),
    WebhookDelivery: objectSchema(
      {
        deliveryId: idSchema("Webhook delivery identifier."),
        webhookId: idSchema("Webhook identifier."),
        eventId: idSchema("Webhook event identifier."),
        eventType: { type: "string" },
        payload: {
          type: "object",
          additionalProperties: true,
          description: "Original safe public event payload delivered to the webhook endpoint."
        },
        status: { type: "string", enum: ["pending", "success", "failed"] },
        attemptCount: { type: "integer", minimum: 0 },
        httpStatus: { anyOf: [{ type: "integer" }, { type: "null" }] },
        errorCode: nullableString("Delivery error code when delivery fails."),
        createdAt: timestampSchema(),
        updatedAt: timestampSchema()
      },
      [
        "deliveryId",
        "webhookId",
        "eventId",
        "eventType",
        "payload",
        "status",
        "attemptCount",
        "httpStatus",
        "errorCode",
        "createdAt",
        "updatedAt"
      ]
    ),
    WebhookDeliveryListResponse: pageSchema(ref("WebhookDelivery")),
    WebhookRedeliveryResponse: objectSchema({ delivery: ref("WebhookDelivery") }, ["delivery"])
  };
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      addMissingFieldDescriptions(schema)
    ])
  );
}

function boundedNullableString(description: string, maxLength: number): SchemaObject {
  return {
    anyOf: [{ type: "string", maxLength }, { type: "null" }],
    description
  };
}

function addMissingFieldDescriptions(schema: SchemaObject): SchemaObject {
  const output = { ...schema };
  const properties = schema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    output.properties = Object.fromEntries(
      Object.entries(properties as Record<string, unknown>).map(([name, value]) => {
        const property = value && typeof value === "object" && !Array.isArray(value)
          ? addMissingFieldDescriptions(value as SchemaObject)
          : value;
        const propertySchema = property as SchemaObject | undefined;
        if (
          propertySchema
          && typeof propertySchema === "object"
          && propertySchema.description === undefined
          && SCHEMA_FIELD_DESCRIPTIONS[name]
        ) {
          return [name, {
            ...propertySchema,
            description: SCHEMA_FIELD_DESCRIPTIONS[name]
          }];
        }
        return [name, property];
      })
    );
  }
  for (const keyword of ["items", "anyOf", "oneOf", "allOf"] as const) {
    const value = schema[keyword];
    if (Array.isArray(value)) {
      output[keyword] = value.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? addMissingFieldDescriptions(item as SchemaObject)
          : item
      );
    } else if (value && typeof value === "object") {
      output[keyword] = addMissingFieldDescriptions(value as SchemaObject);
    }
  }
  return output;
}

function graphOverviewResponseSchema(): SchemaObject {
  return objectSchema(
    {
      activeContentRevision: activeContentRevisionSchema(),
      availability: {
        type: "string",
        enum: ["available", "empty", "unavailable"],
        description: "Whether the readable knowledge-base version contains readable relationship data. An empty result does not mean the knowledge base is empty."
      },
      summary: objectSchema(
        {
          readableFileCount: { type: "integer", minimum: 0 },
          relationshipCount: { type: "integer", minimum: 0 }
        },
        ["readableFileCount", "relationshipCount"]
      ),
      resources: objectSchema(
        {
          graphIndexPath: nullableString("Readable relationship index path when available."),
          byDirectoryPath: nullableString("Readable relationships grouped by source directory when available."),
          byFilePath: nullableString("Readable relationships grouped by source file when available.")
        },
        ["graphIndexPath", "byDirectoryPath", "byFilePath"]
      ),
      readActions: objectSchema(
        {
          graphIndexContent: nullableString("Read the readable relationship index file when available."),
          listGraphRoot: { type: "string" },
          listRelationshipsByDirectory: nullableString("List relationship records grouped by source directory when available."),
          listRelationshipsByFile: nullableString("List relationship records grouped by source file when available.")
        },
        [
          "graphIndexContent", "listGraphRoot", "listRelationshipsByDirectory",
          "listRelationshipsByFile"
        ]
      )
    },
    ["activeContentRevision", "availability", "summary", "resources", "readActions"]
  );
}

function graphExpansionResponseSchema(): SchemaObject {
  return objectSchema(
    {
      activeContentRevision: activeContentRevisionSchema(),
      seedFile: {
        ...ref("GeneratedFile"),
        description: "Current readable starting file resolved from `fileId`."
      },
      relationships: {
        type: "array",
        items: ref("RelatedFile"),
        description: "Related files found up to the requested depth and result limits."
      },
      graphPaths: {
        type: "array",
        items: { type: "string" },
        description: "Readable relationship-data files under `_graph/` that can be read with the path-based file content endpoint."
      },
      nextCursor: nullableString(
        "Pagination token returned by this endpoint. Reuse it only with the same starting point and readable knowledge-base version. If it is rejected, restart without a cursor."
      ),
      resultSummary: objectSchema(
        {
          relationshipCount: { type: "integer", minimum: 0 },
          hasMore: { type: "boolean" },
          depth: { type: "integer", enum: [0, 1, 2] },
          fanout: { type: "integer", minimum: 0 },
          meaning: { type: "string" }
        },
        ["relationshipCount", "hasMore", "depth", "fanout", "meaning"]
      )
    },
    [
      "activeContentRevision",
      "seedFile",
      "relationships",
      "graphPaths",
      "nextCursor",
      "resultSummary"
    ]
  );
}

function relatedFileSchema(): SchemaObject {
  return objectSchema(
    {
      activeContentRevision: activeContentRevisionSchema(),
      fileId: idSchema(
        "Related readable file identifier accepted by file detail, content, related-file, and relationship-exploration operations."
      ),
      sourceFileId: idSchema("Uploaded-file identifier associated with the related readable file."),
      path: { type: "string" },
      title: { type: "string" },
      relationType: { type: "string" },
      direction: {
        type: "string",
        enum: ["outgoing", "incoming", "bidirectional"]
      },
      fromFileId: idSchema(
        "Readable source-file identifier from which this traversal step starts."
      ),
      relationshipDepth: {
        type: "integer",
        minimum: 1,
        maximum: 2,
        description: "Relationship level of this traversal step from the requested seed file."
      },
      reason: nullableString(
        "Human-readable relationship reason when the indexed source evidence supplies one."
      ),
      contentAvailable: { type: "boolean" },
      readActions: fileReadActionsSchema()
    },
    [
      "fileId",
      "activeContentRevision",
      "sourceFileId",
      "path",
      "title",
      "relationType",
      "direction",
      "fromFileId",
      "relationshipDepth",
      "reason",
      "contentAvailable",
      "readActions"
    ]
  );
}

function sourceDirectorySchema(): SchemaObject {
  return objectSchema(
    {
      directoryId: idSchema("Uploaded-directory identifier."),
      knowledgeBaseId: idSchema("Owning knowledge-base identifier."),
      parentDirectoryId: nullableString("Parent uploaded-directory identifier."),
      name: { type: "string" },
      relativePath: { type: "string" },
      generatedPath: { type: "string" },
      depth: { type: "integer", minimum: 1 },
      resourceRevision: { type: "integer", minimum: 1 },
      directFileCount: { type: "integer", minimum: 0 },
      descendantFileCount: { type: "integer", minimum: 0 },
      mutable: { type: "boolean" },
      deletable: { type: "boolean" },
      deleting: { type: "boolean" },
      actions: { type: "object", additionalProperties: { type: ["string", "null"] } },
      createdAt: timestampSchema(),
      updatedAt: timestampSchema()
    },
    [
      "directoryId",
      "knowledgeBaseId",
      "parentDirectoryId",
      "name",
      "relativePath",
      "generatedPath",
      "depth",
      "resourceRevision",
      "directFileCount",
      "descendantFileCount",
      "mutable",
      "deletable",
      "deleting",
      "actions",
      "createdAt",
      "updatedAt"
    ]
  );
}

function sourceResourceFileSchema(): SchemaObject {
  return objectSchema(
    {
      sourceFileId: idSchema("Uploaded-file identifier."),
      knowledgeBaseId: idSchema("Owning knowledge-base identifier."),
      directoryId: nullableString("Parent uploaded-directory identifier."),
      name: { type: "string" },
      relativePath: { type: "string" },
      generatedPath: nullableString("Readable knowledge-base path when the file is ready to read."),
      contentType: { type: "string" },
      sizeBytes: { type: "integer", minimum: 0 },
      resourceRevision: { type: "integer", minimum: 1 },
      contentRevision: {
        type: "integer",
        minimum: 0,
        description: "Readable generated-content revision. Zero means that no generated output is available yet."
      },
      state: {
        type: "string",
        enum: ["waiting", "processing", "available", "error", "deleting"],
        description: SOURCE_FILE_PROCESSING_STATE_DESCRIPTION
      },
      workProgress: sourceFileWorkProgressSchema(),
      failure: {
        ...sourceFileFailureSchema(),
        type: ["object", "null"],
        description: "Error details when file processing stopped."
      },
      generatedOutputStatus: {
        type: "string",
        enum: ["unavailable", "previous_available", "current_available"],
        description: GENERATED_OUTPUT_STATUS_DESCRIPTION
      },
      actions: {
        type: "array",
        items: sourceFileLifecycleActionSchema(),
        description: "Actions currently available for this uploaded Markdown file."
      },
      links: { type: "object", additionalProperties: { type: ["string", "null"] } },
      createdAt: timestampSchema()
    },
    [
      "sourceFileId",
      "knowledgeBaseId",
      "directoryId",
      "name",
      "relativePath",
      "generatedPath",
      "contentType",
      "sizeBytes",
      "resourceRevision",
      "contentRevision",
      "state",
      "workProgress",
      "failure",
      "generatedOutputStatus",
      "actions",
      "links",
      "createdAt"
    ]
  );
}

function sourceFileFailureSchema(): SchemaObject {
  return objectSchema(
    {
      workKind: {
        type: "string",
        enum: [
          "prepare", "first_layer", "content_projection", "graphrag",
          "relation_reconcile", "knowledge_projection", "activate", "cleanup"
        ]
      },
      code: { type: "string", maxLength: 64 },
      message: { type: "string", maxLength: 500 },
      occurredAt: timestampSchema(),
      retryKind: {
        type: "string",
        enum: ["document_processing", "none"]
      },
      correlationId: { type: "string", maxLength: 128 }
    },
    ["workKind", "code", "message", "occurredAt", "retryKind", "correlationId"]
  );
}

function sourceFileWorkProgressSchema(): SchemaObject {
  const workKinds = [
    "prepare", "first_layer", "content_projection", "graphrag",
    "relation_reconcile", "knowledge_projection", "activate", "cleanup"
  ];
  const workKind = {
    type: "string",
    enum: workKinds
  } satisfies SchemaObject;
  return {
    ...objectSchema({
      required: { type: "integer", minimum: 0 },
      completed: { type: "integer", minimum: 0 },
      activeKinds: { type: "array", items: workKind },
      blockingKind: { ...workKind, type: ["string", "null"], enum: [...workKinds, null] },
      retryingKind: { ...workKind, type: ["string", "null"], enum: [...workKinds, null] }
    }, ["required", "completed", "activeKinds", "blockingKind", "retryingKind"]),
    description: SOURCE_FILE_WORK_PROGRESS_DESCRIPTION
  };
}

function sourceFileLifecycleActionSchema(): SchemaObject {
  return objectSchema(
    {
      kind: {
        type: "string",
        enum: [
          "open_generated_file",
          "view_failure_details",
          "replace_source_content",
          "retry_document_processing"
        ]
      },
      method: { type: "string", enum: ["GET", "POST", "PUT"] },
      href: { type: "string" },
      scope: {
        type: "string",
        enum: ["source_file"]
      }
    },
    ["kind", "method", "href", "scope"]
  );
}

function resourceOperationSchema(): SchemaObject {
  return objectSchema(
    {
      operationId: idSchema("Identifier used to check the status and result of this file or directory change."),
      knowledgeBaseId: idSchema("Owning knowledge-base identifier."),
      kind: {
        type: "string",
        enum: [
          "upload",
          "knowledge_base_metadata",
          "source_file_metadata",
          "source_file_replace",
          "source_file_move",
          "source_directory_move",
          "source_file_delete",
          "source_directory_delete",
          "knowledge_base_delete"
        ]
      },
      state: {
        type: "string",
        enum: ["processing", "completed", "failed", "cancelled", "superseded"]
      },
      expectedResourceRevision: { type: ["integer", "null"], minimum: 1 },
      targetKind: {
        type: ["string", "null"],
        enum: ["source_file", "source_directory", "knowledge_base", null],
        description: "Type of item changed by this request."
      },
      targetId: nullableString("Identifier of the file, directory, or knowledge base changed by this request."),
      candidateRelativePath: nullableString("Requested destination path for a move or replacement that is still processing."),
      result: {
        type: ["object", "null"],
        description: "Bounded document progress for `upload` and `source_directory_move`; null for other operation kinds. Available uploaded documents are immediately readable before the aggregate upload completes.",
        properties: {
          totalCount: { type: "integer", minimum: 0 },
          waitingCount: { type: "integer", minimum: 0 },
          processingCount: { type: "integer", minimum: 0 },
          availableCount: { type: "integer", minimum: 0 },
          failedCount: { type: "integer", minimum: 0 },
          deletingCount: { type: "integer", minimum: 0 },
          cancelledCount: { type: "integer", minimum: 0 },
          supersededCount: { type: "integer", minimum: 0 }
        },
        additionalProperties: false
      },
      errorCode: nullableString("Final operation error code."),
      retryGuidance: nullableString("Instructions for checking the change again while it is still processing."),
      actions: objectSchema({ self: { type: "string" } }, ["self"]),
      createdAt: timestampSchema(),
      updatedAt: timestampSchema(),
      completedAt: nullableTimestampSchema()
    },
    [
      "operationId",
      "knowledgeBaseId",
      "kind",
      "state",
      "expectedResourceRevision",
      "targetKind",
      "targetId",
      "candidateRelativePath",
      "result",
      "errorCode",
      "retryGuidance",
      "actions",
      "createdAt",
      "updatedAt",
      "completedAt"
    ]
  );
}

function generatedTreeEntrySchema(): SchemaObject {
  return objectSchema(
    {
      activeContentRevision: activeContentRevisionSchema(true),
      id: idSchema("Tree entry identifier."),
      fileId: nullableString("Readable file identifier when this entry is a file."),
      sourceFileId: nullableString("Uploaded Markdown file identifier when this readable file was generated from one."),
      directoryId: nullableString("Uploaded-directory identifier for directory entries."),
      parentPath: { type: "string" },
      name: { type: "string" },
      path: {
        type: "string",
        description: "Readable knowledge-base file path. It is not an S3 or local filesystem path."
      },
      sortKey: {
        type: "string",
        description: "Value that keeps tree entries in a consistent order across pages."
      },
      entryType: { type: "string", enum: ["file", "directory"] },
      fileKind: nullableString("Readable file type."),
      directEntryCount: {
        type: "integer",
        minimum: 0,
        description: "Direct directory and file entry count. File entries return 0."
      },
      directDirectoryCount: { type: "integer", minimum: 0 },
      directFileCount: { type: "integer", minimum: 0 },
      descendantFileCount: { type: "integer", minimum: 0 },
      resourceRevision: {
        anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
        description: "Uploaded-file version when available."
      },
      deletable: { type: "boolean" },
      contentAvailable: {
        type: "boolean",
        description: "Whether this tree entry can be read through the readable-file content APIs."
      },
      readActions: {
        oneOf: [fileReadActionsSchema(), { type: "null" }],
        description: "Links for reading file entries. Directory entries return null."
      }
    },
    [
      "activeContentRevision",
      "id",
      "fileId",
      "sourceFileId",
      "directoryId",
      "parentPath",
      "name",
      "path",
      "sortKey",
      "entryType",
      "fileKind",
      "directEntryCount",
      "directDirectoryCount",
      "directFileCount",
      "descendantFileCount",
      "resourceRevision",
      "deletable",
      "contentAvailable",
      "readActions"
    ]
  );
}

function generatedFileSchema(): SchemaObject {
  return objectSchema(
    {
      activeContentRevision: activeContentRevisionSchema(),
      fileId: idSchema("Readable file identifier."),
      knowledgeBaseId: idSchema("Knowledge-base identifier."),
      sourceFileId: nullableString("Uploaded Markdown file identifier when this readable file was generated from one."),
      path: {
        type: "string",
        description: "Readable knowledge-base file path accepted by the path-based file read API."
      },
      fileKind: { type: "string" },
      contentType: { type: "string" },
      sizeBytes: { type: "integer", minimum: 0 },
      okfType: nullableString("OKF document type when available."),
      title: nullableString("Resolved title when available."),
      description: nullableString("Resolved description when available."),
      tags: { type: "array", items: { type: "string" } },
      frontmatter: {
        type: "object",
        additionalProperties: true,
        examples: Object.values(okfFrontmatterExamples)
      },
      okfSignals: ref("OkfSignals"),
      deletable: { type: "boolean" },
      contentAvailable: { type: "boolean" },
      readActions: fileReadActionsSchema()
    },
    [
      "activeContentRevision",
      "fileId",
      "knowledgeBaseId",
      "sourceFileId",
      "path",
      "fileKind",
      "contentType",
      "sizeBytes",
      "okfType",
      "title",
      "description",
      "tags",
      "frontmatter",
      "okfSignals",
      "deletable",
      "contentAvailable",
      "readActions"
    ]
  );
}

function okfSignalsSchema(): SchemaObject {
  return {
    ...objectSchema(
    {
      effectiveStatus: {
        anyOf: [
          { type: "string", enum: ["draft", "stable", "deprecated"] },
          { type: "null" }
        ],
        description:
          "Normalized OKF document status. An omitted status is `stable`; an invalid supplied status is null."
      },
      trustTier: {
        anyOf: [
          {
            type: "string",
            enum: ["unverified", "machine-confirmed", "human-reviewed"]
          },
          { type: "null" }
        ],
        description:
          "Normalized OKF verification tier. Omitted verification is `unverified`; malformed supplied verification is null."
      },
      isStale: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
        description:
          "Whether `stale_after` is on or before the current request date. It is null without a valid stale date."
      },
      staleAfter: {
        anyOf: [
          { type: "string", format: "date" },
          { type: "null" }
        ],
        description: "Normalized OKF stale date, or null when absent or invalid."
      },
      generatedAt: {
        ...nullableTimestampSchema(),
        description:
          "Normalized `generated.at`, or the legacy `timestamp` fallback when available."
      },
      generatedAtSource: {
        anyOf: [
          { type: "string", enum: ["generated", "legacy_timestamp"] },
          { type: "null" }
        ],
        description:
          "Field that supplied `generatedAt`, distinguishing native OKF 0.2 metadata from the legacy fallback."
      },
      latestVerifiedAt: {
        ...nullableTimestampSchema(),
        description: "Latest valid OKF verification event time, or null when unavailable."
      },
      sourceCount: {
        anyOf: [
          { type: "integer", minimum: 0 },
          { type: "null" }
        ],
        description:
          "Number of normalized OKF sources. Omitted sources produce zero; malformed supplied sources produce null."
      }
    },
    [
      "effectiveStatus",
      "trustTier",
      "isStale",
      "staleAfter",
      "generatedAt",
      "generatedAtSource",
      "latestVerifiedAt",
      "sourceCount"
      ]
    ),
    examples: okfSignalExamples
  };
}

function fileSearchResultSchema(): SchemaObject {
  return objectSchema(
    {
      activeContentRevision: activeContentRevisionSchema(),
      fileId: idSchema("Readable file identifier accepted by file detail, content, and related-file APIs."),
      knowledgeBaseId: idSchema("Knowledge-base identifier."),
      sourceFileId: nullableString("Uploaded Markdown file identifier when this readable file was generated from one."),
      path: {
        type: "string",
        description: "Readable knowledge-base file path accepted by the path-based file read API."
      },
      fileKind: { type: "string" },
      title: nullableString("Resolved title when available."),
      description: nullableString("Resolved description when available."),
      tags: { type: "array", items: { type: "string" } },
      frontmatter: {
        type: "object",
        additionalProperties: true,
        examples: Object.values(okfFrontmatterExamples)
      },
      okfSignals: ref("OkfSignals"),
      matchedFields: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "path", "title", "description", "metadata", "content",
            "graph_node", "file_relationship"
          ]
        }
      },
      evidenceTypes: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "path", "title", "metadata", "content", "graph_node",
            "file_relationship", "entity", "relationship", "community"
          ]
        },
        description: "Safe evidence categories that supported this source-file candidate."
      },
      sourceExcerpt: nullableString(
        "Short excerpt from the active source Markdown when source-grounded text evidence is available. Read the source file before using it as answer evidence."
      ),
      score: {
        type: "number",
        minimum: 0,
        description: "Relative relevance score used to order results for this query. Higher values rank first."
      },
      contentAvailable: { type: "boolean" },
      readActions: fileReadActionsSchema(),
      matchType: {
        type: "string",
        enum: ["file_direct", "graph_node", "graph_edge", "graph_neighbor", "hybrid"],
        description: "Dominant actual evidence class for this source-file result after duplicate collapse. `hybrid` means both file and relationship evidence supported it."
      },
      graphContext: graphSearchContextSchema()
    },
    [
      "activeContentRevision",
      "fileId",
      "knowledgeBaseId",
      "sourceFileId",
      "path",
      "fileKind",
      "title",
      "description",
      "tags",
      "frontmatter",
      "okfSignals",
      "matchedFields",
      "evidenceTypes",
      "sourceExcerpt",
      "score",
      "contentAvailable",
      "matchType",
      "readActions"
    ]
  );
}

function fileReadActionsSchema(): SchemaObject {
  return objectSchema(
    {
      fileDetailById: nullableString("Request path for readable file details when a file ID is available."),
      fileContentById: nullableString("Request path for readable file content when a file ID is available."),
      fileContentByPath: {
        type: "string",
        description: "Request path for readable file content using its URL-encoded knowledge-base path."
      },
      relatedFilesById: nullableString("Request path for related files when a file ID is available."),
      graphExpansionByFileId: nullableString("Request path for exploring relationships when a file ID is available."),
      sourceFileStatusById: nullableString("File-processing status request path when this result came from an uploaded Markdown file.")
    },
    [
      "fileDetailById",
      "fileContentById",
      "fileContentByPath",
      "relatedFilesById",
      "graphExpansionByFileId",
      "sourceFileStatusById"
    ]
  );
}

function fileSearchResponseSchema(): SchemaObject {
  return objectSchema(
    {
      activeContentRevision: activeContentRevisionSchema(true),
      query: ref("FileSearchQueryContext"),
      items: { type: "array", items: ref("FileSearchResult") },
      nextCursor: nullableString(
        "Pagination token returned by this endpoint. Reuse it only with the same query, filters, and readable knowledge-base version. If it is rejected, restart without a cursor."
      ),
      searchStatus: {
        type: "string",
        enum: ["ok", "no_candidates"],
        description:
          "`ok` means results are returned. `no_candidates` means the current query matched no files. Dependency failures use the documented 503 or 504 error envelope."
      },
      searchMode: {
        type: "string",
        enum: ["file", "graph", "hybrid"],
        description: "Search mode applied to this response."
      },
      semanticStatus: objectSchema(
        {
          state: {
            type: "string",
            enum: ["ready", "degraded", "unavailable"],
            description: "Availability of optional semantic search lanes for this response."
          },
          safeCode: nullableEnumString(
            "Stable non-sensitive reason code when semantic search is degraded or unavailable.",
            SEMANTIC_SEARCH_SAFE_CODES
          )
        },
        ["state", "safeCode"]
      ),
      evidenceStatus: {
        ...objectSchema(
        {
          completedFamilies: {
            type: "array",
            items: { type: "string", enum: [...SEARCH_EVIDENCE_FAMILIES] },
            description: "Retrieval evidence families that completed for this response."
          },
          degradedFamilies: {
            type: "array",
            items: { type: "string", enum: [...SEARCH_EVIDENCE_FAMILIES] },
            description: "Retrieval evidence families that did not complete."
          }
        },
        ["completedFamilies", "degradedFamilies"]
        ),
        description: "Retrieval evidence families that completed or degraded for this response."
      },
      rerankerStatus: {
        ...objectSchema(
        {
          state: {
            type: "string",
            enum: ["not_configured", "skipped", "applied", "degraded"]
          },
          safeCode: nullableEnumString(
            "Stable non-sensitive reason code when reranking was not applied.",
            RERANKER_SEARCH_SAFE_CODES
          )
        },
        ["state", "safeCode"]
        ),
        description: "Whether optional reranking was applied, skipped, unavailable, or degraded without exposing model scores."
      },
      graphStatus: {
        type: "string",
        enum: ["available", "index_unavailable", "disabled_for_file_mode"],
        description: "Relationship-search availability for this response. `disabled_for_file_mode` is returned for file-only search."
      },
      graphSummary: graphSearchSummarySchema(),
      resultSummary: ref("FileSearchResultSummary"),
      message: nullableString("Status message when no files matched or search is not available."),
      nextActions: {
        type: "array",
        items: { type: "string" },
        description: "Suggested file reads or relationship queries for continuing exploration."
      }
    },
    [
      "activeContentRevision",
      "query",
      "items",
      "nextCursor",
      "searchStatus",
      "searchMode",
      "semanticStatus",
      "evidenceStatus",
      "rerankerStatus",
      "graphStatus",
      "graphSummary",
      "resultSummary"
    ]
  );
}

function fileSearchQueryContextSchema(): SchemaObject {
  return objectSchema(
    {
      query: { type: "string", description: "Normalized search text accepted by the endpoint." },
      normalizedQuery: {
        type: "string",
        description: "Search text after standard character and spacing normalization."
      },
      scope: {
        type: "string",
        enum: ["all", "path", "metadata"],
        description: "Search field scope applied to this response."
      },
      fileKind: {
        type: "string",
        description: "Readable file type filter applied to this response. `all` means no type filter."
      },
      mode: {
        type: "string",
        enum: ["file", "graph", "hybrid"],
        description: "Search mode applied to this response."
      },
      graphDepth: {
        type: "integer",
        enum: [0, 1, 2],
        description: "Requested relationship context depth. Zero returns no relationship entries; one returns direct entries; two may include second-level entries within fanout."
      },
      graphFanout: {
        type: "integer",
        minimum: 0,
        description: "Maximum relationship records returned per graph item."
      },
      okfStatus: nullableString(
        "Normalized OKF document-status filter applied to this response."
      ),
      okfTrustTier: nullableString(
        "Normalized OKF verification-tier filter applied to this response."
      ),
      okfFreshness: nullableString(
        "Normalized OKF freshness filter applied to this response."
      ),
      rerank: {
        type: "boolean",
        description: "Whether optional source-grounded reranking was requested."
      },
      rerankTopK: {
        anyOf: [
          { type: "integer", minimum: 1, maximum: 50 },
          { type: "null" }
        ],
        description: "Non-exact candidate window used only when reranking is enabled."
      },
      rerankScoreThreshold: {
        anyOf: [
          { type: "number", minimum: 0, maximum: 1 },
          { type: "null" }
        ],
        description: "Minimum valid reranker score for non-exact candidates, or null when disabled."
      },
      limit: { type: "integer", minimum: 1, description: "Maximum number of results applied to this request." },
      cursorProvided: {
        type: "boolean",
        description: "Whether this request used a pagination token returned by an earlier search with the same query and filters."
      }
    },
    [
      "query",
      "normalizedQuery",
      "scope",
      "fileKind",
      "mode",
      "graphDepth",
      "graphFanout",
      "okfStatus",
      "okfTrustTier",
      "okfFreshness",
      "rerank",
      "rerankTopK",
      "rerankScoreThreshold",
      "limit",
      "cursorProvided"
    ]
  );
}

function graphSearchSummarySchema(): SchemaObject {
  return objectSchema(
    {
      available: { type: "boolean" },
      indexedDocumentCount: {
        type: "integer",
        minimum: 0,
        description: "Total readable file-graph nodes available to relationship search, not the current result-page count."
      },
      indexedRelationshipCount: {
        type: "integer",
        minimum: 0,
        description: "Total readable file relationships available to relationship search, not the current result-page count."
      },
      depth: { type: "integer", enum: [0, 1, 2] },
      fanout: { type: "integer", minimum: 0 }
    },
    ["available", "indexedDocumentCount", "indexedRelationshipCount", "depth", "fanout"]
  );
}

function nullableEnumString(
  description: string,
  values: readonly string[]
): SchemaObject {
  return {
    anyOf: [{ type: "string", enum: [...values] }, { type: "null" }],
    description
  };
}

function graphSearchContextSchema(): SchemaObject {
  return objectSchema(
    {
      graphRef: {
        type: "string",
        description: "Readable relationship-data path under `_graph/by-file/` for this result."
      },
      depth: { type: "integer", enum: [0, 1, 2] },
      seedSourceFileId: idSchema("Uploaded-file identifier used as the starting point for relationship search."),
      relationships: { type: "array", items: ref("RelatedFile") },
      graphPaths: {
        type: "array",
        items: { type: "string" },
        description: "Readable relationship-data files that can be read with the path-based file content endpoint."
      }
    },
    [
      "graphRef",
      "depth",
      "seedSourceFileId",
      "relationships",
      "graphPaths"
    ]
  );
}

function fileSearchResultSummarySchema(): SchemaObject {
  return objectSchema(
    {
      resultCount: { type: "integer", minimum: 0 },
      hasMore: {
        type: "boolean",
        description: "Whether the same query and filters can continue with `nextCursor`."
      },
      sort: {
        type: "array",
        items: { type: "string" },
        description: "Ordering applied to this result page."
      },
      meaning: {
        type: "string",
        description: "Plain-language explanation of what the current result page means."
      }
    },
    ["resultCount", "hasMore", "sort", "meaning"]
  );
}

function generationPageSchema(itemSchema: SchemaObject): SchemaObject {
  return objectSchema(
    {
      activeContentRevision: activeContentRevisionSchema(true),
      items: { type: "array", items: itemSchema },
      nextCursor: nullableString(
        "Pagination token returned by this endpoint. Reuse it only with the same endpoint and readable knowledge-base version. If it is rejected, restart without a cursor."
      )
    },
    ["activeContentRevision", "items", "nextCursor"]
  );
}

function uploadManifestEntryRequestSchema(): SchemaObject {
  return objectSchema(
    {
      relativePath: {
        type: "string",
        description: "Markdown path relative to the selected upload root. The server stores the path in Unicode NFC form.",
        example: "handbook/onboarding/guide.md"
      },
      declaredSize: { type: "integer", minimum: 0, example: 2048 },
      checksumSha256: {
        anyOf: [
          {
            type: "string",
            pattern: "^[a-f0-9]{64}$",
            example: "0".repeat(64)
          },
          { type: "null" }
        ],
        description: "Optional lowercase SHA-256 checksum used to detect unchanged content."
      }
    },
    ["relativePath", "declaredSize"]
  );
}

function activeContentRevisionSchema(nullable = false): SchemaObject {
  return {
    type: nullable ? ["integer", "null"] : "integer",
    minimum: 1,
    description: SCHEMA_FIELD_DESCRIPTIONS.activeContentRevision
  };
}

function uploadSessionCountsSchema(): SchemaObject {
  const count = { type: "integer", minimum: 0 };
  return objectSchema(
    {
      selected: count,
      uploadRequired: count,
      skippedExisting: count,
      waitingReservation: count,
      rejectedDeleting: count,
      uploaded: count,
      finalized: count
    },
    [
      "selected",
      "uploadRequired",
      "skippedExisting",
      "waitingReservation",
      "rejectedDeleting",
      "uploaded",
      "finalized"
    ]
  );
}

function uploadSessionSchema(): SchemaObject {
  return objectSchema(
    {
      id: idSchema("Upload session identifier used by every following session action."),
      operationId: idSchema("Operation identifier used to monitor each submitted document after finalizing the upload."),
      knowledgeBaseId: idSchema("Owning knowledge-base identifier."),
      state: {
        type: "string",
        enum: [
          "draft",
          "manifest_building",
          "manifest_sealed",
          "uploading",
          "finalizing",
          "completed",
          "cancelled",
          "expired"
        ],
        description: "Current upload-session state, from file-list creation through upload completion, cancellation, or expiration."
      },
      declaredFileCount: { type: "integer", minimum: 0 },
      declaredByteCount: { type: "integer", minimum: 0 },
      counts: ref("UploadSessionCounts"),
      errorCode: nullableString("Final upload-session error code."),
      expiresAt: timestampSchema(),
      completedAt: nullableTimestampSchema(),
      createdAt: timestampSchema(),
      updatedAt: timestampSchema(),
      actions: objectSchema(
        { operation: { type: "string" } },
        ["operation"]
      )
    },
    [
      "id",
      "operationId",
      "knowledgeBaseId",
      "state",
      "declaredFileCount",
      "declaredByteCount",
      "counts",
      "errorCode",
      "expiresAt",
      "completedAt",
      "createdAt",
      "updatedAt",
      "actions"
    ]
  );
}

function uploadSessionEntrySchema(): SchemaObject {
  return objectSchema(
    {
      id: idSchema("Upload entry identifier used by the Markdown content upload endpoint."),
      relativePath: { type: "string", example: "handbook/onboarding/guide.md" },
      directoryPath: { type: "string", example: "handbook/onboarding" },
      name: { type: "string", example: "guide.md" },
      declaredSize: { type: "integer", minimum: 0 },
      receivedSize: { type: ["integer", "null"], minimum: 0 },
      disposition: {
        type: "string",
        enum: [
          "upload_required",
          "skipped_existing",
          "waiting_reservation",
          "rejected_deleting"
        ]
      },
      transferState: {
        type: "string",
        enum: ["missing", "uploaded", "skipped"]
      },
      sourceFileId: nullableString("Identifier of the new or existing uploaded Markdown file."),
      existingResourceRevision: { type: ["integer", "null"], minimum: 1 }
    },
    [
      "id",
      "relativePath",
      "directoryPath",
      "name",
      "declaredSize",
      "receivedSize",
      "disposition",
      "transferState",
      "sourceFileId",
      "existingResourceRevision"
    ]
  );
}
