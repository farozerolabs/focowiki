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

const SOURCE_FILE_PROCESSING_STATE_DESCRIPTION =
  "Backend-derived lifecycle state. `pending_publication` has completed source processing and is waiting for activation. `visible` has readable generated content. `failed` includes a canonical failure and server-authorized actions.";

const SOURCE_FILE_CURRENT_STAGE_DESCRIPTION =
  "Current source-file stage. Values include `upload_storage`, `metadata_resolution`, `llm_suggestion`, `graph_generation`, `projection_generation`, `generation_validation`, and `generation_activation`.";

const GENERATED_OUTPUT_STATUS_DESCRIPTION =
  "`pending` means generated output is not readable yet. `visible` means the generated page can be read through file APIs. `unavailable` means no generated output is currently available. A file is ready when `state` is `visible`.";

export function createDeveloperOpenApiSchemas(): Record<string, SchemaObject> {
  return {
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
                "DATABASE_REPOSITORY_UNAVAILABLE"
              ]
            },
            message: { type: "string" },
            httpStatus: { type: "integer" },
            details: {
              type: "object",
              additionalProperties: true,
              description:
                "Optional safe details. `RATE_LIMITED` responses can include coarse `retryHint`, `retryAfterSeconds`, and `retryGuidance` values for Agent retry planning.",
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
    HealthResponse: objectSchema({ status: { type: "string", const: "ok" } }, ["status"]),
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
        nextCursor: nullableString("Opaque cursor accepted only by the same list family.")
      },
      ["items", "nextCursor"]
    ),
    KnowledgeBase: objectSchema(
      {
        knowledgeBaseId: idSchema("Knowledge-base identifier used by scoped routes."),
        name: { type: "string" },
        description: nullableString("Optional knowledge-base description."),
        activeGenerationId: nullableString("Identifier of the currently active knowledge-base generation."),
        resourceRevision: { type: "integer", minimum: 1 },
        catalogGeneration: { type: "integer", minimum: 0 },
        createdAt: timestampSchema(),
        updatedAt: timestampSchema()
      },
      ["knowledgeBaseId", "name", "description", "activeGenerationId", "resourceRevision", "catalogGeneration", "createdAt", "updatedAt"]
    ),
    KnowledgeBaseListResponse: pageSchema(ref("KnowledgeBase")),
    KnowledgeBaseResponse: objectSchema({ knowledgeBase: ref("KnowledgeBase") }, ["knowledgeBase"]),
    CreateKnowledgeBaseRequest: objectSchema(
      {
        name: { type: "string", minLength: 1 },
        description: nullableString("Optional description.")
      },
      ["name"]
    ),
    UpdateKnowledgeBaseRequest: objectSchema({
      name: { type: "string", minLength: 1 },
      description: nullableString("Updated description or null to clear it.")
    }),
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
        entries: { type: "array", minItems: 1, items: ref("UploadManifestEntryRequest") }
      },
      ["entries"]
    ),
    UploadSessionCounts: uploadSessionCountsSchema(),
    UploadSession: uploadSessionSchema(),
    UploadSessionEntry: uploadSessionEntrySchema(),
    UploadSessionTransport: objectSchema(
      {
        manifestPageSize: { type: "integer", minimum: 1 }
      },
      ["manifestPageSize"]
    ),
    UploadSessionResponse: objectSchema(
      {
        session: ref("UploadSession"),
        transport: ref("UploadSessionTransport")
      },
      ["session"]
    ),
    UploadSessionStatusResponse: objectSchema(
      {
        session: ref("UploadSession"),
        entries: pageSchema(ref("UploadSessionEntry"))
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
    SourceResourceFileListResponse: pageSchema(ref("SourceResourceFile")),
    MoveSourceResourceRequest: objectSchema(
      {
        relativePath: {
          type: "string",
          minLength: 1,
          description:
            "Safe normalized knowledge-base-relative target path. The target parent directory must already exist and be active; a root-level target has no parent requirement."
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
      ["deletion"]
    ),
    ResourceDeletionResponse: objectSchema(
      {
        operation: ref("ResourceOperation"),
        deletion: objectSchema({
          sourceFileId: nullableString("Deleted source-file identifier."),
          directoryId: nullableString("Deleted source-directory identifier."),
          affectedDirectoryCount: { type: "integer", minimum: 0 },
          affectedFileCount: { type: "integer", minimum: 0 },
          visibility: nullableString("Current public visibility of the deleted resource.")
        })
      },
      ["operation", "deletion"]
    ),
    SourceFileEvent: sourceFileEventSchema(),
    SourceFileEventListResponse: pageSchema(ref("SourceFileEvent")),
    GeneratedTreeEntry: generatedTreeEntrySchema(),
    TreeResponse: generationPageSchema(ref("GeneratedTreeEntry")),
    GeneratedFile: generatedFileSchema(),
    FileSearchResult: fileSearchResultSchema(),
    FileSearchQueryContext: fileSearchQueryContextSchema(),
    FileSearchResultSummary: fileSearchResultSummarySchema(),
    FileSearchNextRequestTemplates: fileSearchNextRequestTemplatesSchema(),
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
        generationId: idSchema("Active generation used for every item in this response."),
        fileId: idSchema("Requested file identifier."),
        sourceFileId: idSchema("Source file identifier used for graph lookup."),
        items: { type: "array", items: ref("RelatedFile") },
        nextCursor: nullableString("Opaque cursor accepted by this related-file endpoint."),
        message: nullableString("Safe guidance when no relationship matches are available."),
        nextActions: { type: "array", items: { type: "string" } }
      },
      ["generationId", "fileId", "sourceFileId", "items", "nextCursor"]
    ),
    GraphExpansionResponse: graphExpansionResponseSchema(),
    GraphInsightsResponse: graphInsightsResponseSchema(),
    DeleteResponse: objectSchema(
      {
        deleted: { type: "boolean" },
        webhookId: idSchema("Deleted webhook identifier.")
      },
      ["deleted"]
    ),
    Webhook: objectSchema(
      {
        webhookId: idSchema("Webhook identifier."),
        name: { type: "string" },
        endpointHost: { type: "string" },
        events: { type: "array", items: { type: "string" } },
        enabled: { type: "boolean" },
        createdAt: timestampSchema(),
        updatedAt: timestampSchema(),
        lastDeliveryAt: nullableTimestampSchema()
      },
      ["webhookId", "name", "endpointHost", "events", "enabled", "createdAt", "updatedAt", "lastDeliveryAt"]
    ),
    WebhookCreateRequest: objectSchema(
      {
        name: nullableString("Optional webhook name."),
        url: { type: "string", format: "uri" },
        events: { type: "array", items: { type: "string" } }
      },
      ["url", "events"]
    ),
    WebhookCreateResponse: objectSchema(
      {
        webhook: ref("Webhook"),
        signingSecret: {
          type: "string",
          description: "Returned only once when the webhook is created."
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
        status: { type: "string", enum: ["pending", "success", "failed"] },
        attemptCount: { type: "integer", minimum: 0 },
        httpStatus: { anyOf: [{ type: "integer" }, { type: "null" }] },
        errorCode: nullableString("Stable delivery error code when delivery fails."),
        createdAt: timestampSchema(),
        updatedAt: timestampSchema()
      },
      [
        "deliveryId",
        "webhookId",
        "eventId",
        "eventType",
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
}

function graphInsightsResponseSchema(): SchemaObject {
  return objectSchema(
    {
      generationId: idSchema("Active generation used for this graph insight response."),
      file: {
        oneOf: [ref("GeneratedFile"), { type: "null" }],
        description: "Optional generated graph insight file. It is null when insights are not available."
      },
      contentPath: {
        type: "string",
        const: "_graph/insights.json",
        description: "Logical generated graph insights file path."
      },
      insights: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true
        },
        description: "Published graph quality or navigation insight records."
      },
      generatedAt: nullableString("Timestamp from the generated graph insights file."),
      resultSummary: objectSchema(
        {
          insightCount: { type: "integer", minimum: 0 },
          meaning: { type: "string" }
        },
        ["insightCount", "meaning"]
      ),
      readActions: objectSchema(
        {
          graphIndex: { type: "string" },
          graphManifest: { type: "string" },
          graphInsightsFile: { type: "string" },
          graphInsightsContent: { type: "string" }
        },
        ["graphIndex", "graphManifest", "graphInsightsFile", "graphInsightsContent"]
      ),
      nextActions: {
        type: "array",
        items: { type: "string" }
      }
    },
    ["generationId", "file", "contentPath", "insights", "generatedAt", "resultSummary", "readActions", "nextActions"]
  );
}

function graphExpansionResponseSchema(): SchemaObject {
  return objectSchema(
    {
      generationId: idSchema("Active generation used for graph expansion."),
      query: objectSchema(
        {
          fileId: nullableString("Seed file identifier when expansion starts from a known file."),
          nodeId: nullableString("Seed graph node identifier when expansion starts from a graph node."),
          edgeId: nullableString("Seed graph edge identifier when expansion starts from a graph edge."),
          query: nullableString("Seed query when expansion starts from graph search."),
          normalizedQuery: nullableString("Normalized query when `query` is provided."),
          depth: { type: "integer", enum: [0, 1, 2] },
          fanout: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1 },
          cursorProvided: { type: "boolean" }
        },
        ["fileId", "nodeId", "edgeId", "query", "normalizedQuery", "depth", "fanout", "limit", "cursorProvided"]
      ),
      seedFile: {
        oneOf: [ref("GeneratedFile"), { type: "null" }],
        description: "Resolved seed file when expansion starts from `fileId`."
      },
      seedResults: {
        type: "array",
        items: ref("FileSearchResult"),
        description: "Graph search seed candidates when expansion starts from `query`."
      },
      relationships: {
        type: "array",
        items: ref("RelatedFile"),
        description: "Bounded related files discovered from graph expansion."
      },
      graphPaths: {
        type: "array",
        items: { type: "string" },
        description: "Logical `_graph/*` files that can be read through the path content endpoint."
      },
      nextCursor: nullableString("Opaque cursor accepted by this graph expansion endpoint with the same seed."),
      resultSummary: objectSchema(
        {
          seedCount: { type: "integer", minimum: 0 },
          relationshipCount: { type: "integer", minimum: 0 },
          hasMore: { type: "boolean" },
          depth: { type: "integer", enum: [0, 1, 2] },
          fanout: { type: "integer", minimum: 0 },
          meaning: { type: "string" }
        },
        ["seedCount", "relationshipCount", "hasMore", "depth", "fanout", "meaning"]
      ),
      message: nullableString("Safe guidance when graph expansion returns no candidates."),
      nextActions: {
        type: "array",
        items: { type: "string" },
        description: "Suggested OpenAPI reads that keep Agent exploration moving."
      }
    },
    [
      "query",
      "generationId",
      "seedFile",
      "seedResults",
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
      generationId: idSchema("Active generation containing this relationship."),
      fileId: idSchema(
        "Related generated file identifier accepted by file detail, content, related-file, and graph-expansion operations."
      ),
      sourceFileId: idSchema("Related source file identifier."),
      path: { type: "string" },
      title: { type: "string" },
      relationType: { type: "string" },
      direction: { type: "string", enum: ["outgoing", "incoming"] },
      weight: { type: "number", minimum: 0, maximum: 1 },
      reason: { type: "string" },
      source: { type: "string" },
      evidence: { type: "object", additionalProperties: true },
      contentAvailable: { type: "boolean" },
      readActions: fileReadActionsSchema()
    },
    [
      "fileId",
      "generationId",
      "sourceFileId",
      "path",
      "title",
      "relationType",
      "direction",
      "weight",
      "reason",
      "source",
      "evidence",
      "contentAvailable",
      "readActions"
    ]
  );
}

function sourceDirectorySchema(): SchemaObject {
  return objectSchema(
    {
      directoryId: idSchema("Stable source-directory identifier."),
      knowledgeBaseId: idSchema("Owning knowledge-base identifier."),
      parentDirectoryId: nullableString("Stable parent directory identifier."),
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
      sourceFileId: idSchema("Stable source-file identifier."),
      knowledgeBaseId: idSchema("Owning knowledge-base identifier."),
      directoryId: nullableString("Stable parent source-directory identifier."),
      name: { type: "string" },
      relativePath: { type: "string" },
      generatedPath: nullableString("Canonical generated Markdown path when published."),
      contentType: { type: "string" },
      sizeBytes: { type: "integer", minimum: 0 },
      checksumSha256: { type: "string" },
      resourceRevision: { type: "integer", minimum: 1 },
      contentRevision: { type: "integer", minimum: 1 },
      activeRevisionId: idSchema("Identifier of the source content version currently in use."),
      state: {
        type: "string",
        enum: ["queued", "running", "pending_publication", "visible", "failed"],
        description: SOURCE_FILE_PROCESSING_STATE_DESCRIPTION
      },
      currentStage: { type: "string", description: SOURCE_FILE_CURRENT_STAGE_DESCRIPTION },
      failure: {
        ...sourceFileFailureSchema(),
        type: ["object", "null"],
        description: "Canonical terminal failure when lifecycle progress stopped."
      },
      generatedOutputStatus: {
        type: "string",
        enum: ["pending", "visible", "unavailable"],
        description: GENERATED_OUTPUT_STATUS_DESCRIPTION
      },
      mutable: { type: "boolean" },
      deletable: { type: "boolean" },
      deleting: { type: "boolean" },
      actions: {
        type: "array",
        items: sourceFileLifecycleActionSchema(),
        description: "Server-authorized lifecycle actions for the current state."
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
      "checksumSha256",
      "resourceRevision",
      "contentRevision",
      "activeRevisionId",
      "state",
      "currentStage",
      "failure",
      "generatedOutputStatus",
      "mutable",
      "deletable",
      "deleting",
      "actions",
      "links",
      "createdAt"
    ]
  );
}

function sourceFileFailureSchema(): SchemaObject {
  return objectSchema(
    {
      stage: {
        type: "string",
        enum: [
          "upload_storage",
          "metadata_resolution",
          "llm_suggestion",
          "graph_generation",
          "projection_generation",
          "generation_validation",
          "generation_activation"
        ]
      },
      code: { type: "string", maxLength: 64 },
      message: { type: "string", maxLength: 500 },
      occurredAt: timestampSchema(),
      retryKind: {
        type: "string",
        enum: ["source_processing", "publication", "none"]
      },
      correlationId: { type: "string", maxLength: 128 }
    },
    ["stage", "code", "message", "occurredAt", "retryKind", "correlationId"]
  );
}

function sourceFileLifecycleActionSchema(): SchemaObject {
  return objectSchema(
    {
      kind: {
        type: "string",
        enum: [
          "open_generated_file",
          "view_failure_details",
          "retry_source_processing",
          "retry_publication"
        ]
      },
      method: { type: "string", enum: ["GET", "POST"] },
      href: { type: "string" },
      scope: {
        type: "string",
        enum: ["source_file", "knowledge_base_publication"]
      }
    },
    ["kind", "method", "href", "scope"]
  );
}

function resourceOperationSchema(): SchemaObject {
  return objectSchema(
    {
      operationId: idSchema("Stable asynchronous resource-operation identifier."),
      knowledgeBaseId: idSchema("Owning knowledge-base identifier."),
      kind: {
        type: "string",
        enum: [
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
        enum: ["accepted", "validating", "processing", "publishing", "completed", "failed", "cancelled", "superseded"]
      },
      expectedResourceRevision: { type: ["integer", "null"], minimum: 1 },
      targetKind: {
        type: ["string", "null"],
        enum: ["source_file", "source_directory", "knowledge_base", null],
        description: "Stable resource kind affected by the operation."
      },
      targetId: nullableString("Stable source file, source directory, or knowledge-base ID."),
      candidateRelativePath: nullableString("Safe candidate source path for a pending move or replacement."),
      result: { type: ["object", "null"], additionalProperties: true },
      errorCode: nullableString("Safe terminal operation error code."),
      retryGuidance: nullableString("Safe polling guidance for non-terminal operations."),
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

function sourceFileEventSchema(): SchemaObject {
  return objectSchema(
    {
      eventId: idSchema("Source-file event identifier."),
      knowledgeBaseId: idSchema("Knowledge-base identifier."),
      sourceFileId: idSchema("Source file identifier accepted by source-file status, events, and retry APIs."),
      stageKey: { type: "string" },
      messageKey: { type: "string" },
      startedAt: nullableTimestampSchema(),
      endedAt: nullableTimestampSchema(),
      severity: { type: "string", enum: ["info", "warning", "error"] },
      createdAt: timestampSchema()
    },
    [
      "eventId",
      "knowledgeBaseId",
      "sourceFileId",
      "stageKey",
      "messageKey",
      "startedAt",
      "endedAt",
      "severity",
      "createdAt"
    ]
  );
}

function generatedTreeEntrySchema(): SchemaObject {
  return objectSchema(
    {
      generationId: idSchema("Active generation containing this tree entry."),
      id: idSchema("Tree entry identifier."),
      fileId: nullableString("Generated file identifier when this entry is a persisted file."),
      sourceFileId: nullableString("Source file identifier when this generated file is source-backed."),
      directoryId: nullableString("Stable source-directory identifier for directory entries."),
      parentPath: { type: "string" },
      name: { type: "string" },
      path: {
        type: "string",
        description: "Logical generated file path. It is not a storage path."
      },
      sortKey: {
        type: "string",
        description: "Stable tree ordering key for cursor pagination."
      },
      entryType: { type: "string", enum: ["file", "directory"] },
      fileKind: nullableString("Generated file classification."),
      childCount: {
        type: "integer",
        minimum: 0,
        description: "Direct child count for directory entries. File entries return 0."
      },
      directFileCount: { type: "integer", minimum: 0 },
      descendantFileCount: { type: "integer", minimum: 0 },
      resourceRevision: {
        anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
        description: "Source resource revision when available."
      },
      deletable: { type: "boolean" },
      contentAvailable: {
        type: "boolean",
        description: "Whether this tree entry can be read through generated file content APIs."
      },
      readActions: {
        oneOf: [fileReadActionsSchema(), { type: "null" }],
        description: "Concrete read actions for file entries. Directory entries return null."
      },
      ancestors: {
        type: "array",
        items: ref("GeneratedTreeEntry"),
        description: "Ancestor chain returned by tree search results."
      }
    },
    [
      "generationId",
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
      "childCount",
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
      generationId: idSchema("Active generation containing this file."),
      fileId: idSchema("Generated file identifier."),
      knowledgeBaseId: idSchema("Knowledge-base identifier."),
      sourceFileId: nullableString("Source file identifier when this generated file is source-backed."),
      path: {
        type: "string",
        description: "Logical generated file path accepted by path-based reads."
      },
      fileKind: { type: "string" },
      contentType: { type: "string" },
      sizeBytes: { type: "integer", minimum: 0 },
      checksumSha256: { type: "string" },
      okfType: nullableString("OKF document type when available."),
      title: nullableString("Resolved title when available."),
      description: nullableString("Resolved description when available."),
      tags: { type: "array", items: { type: "string" } },
      frontmatter: { type: "object", additionalProperties: true },
      deletable: { type: "boolean" },
      contentAvailable: { type: "boolean" },
      readActions: fileReadActionsSchema()
    },
    [
      "generationId",
      "fileId",
      "knowledgeBaseId",
      "sourceFileId",
      "path",
      "fileKind",
      "contentType",
      "sizeBytes",
      "checksumSha256",
      "okfType",
      "title",
      "description",
      "tags",
      "frontmatter",
      "deletable",
      "contentAvailable",
      "readActions"
    ]
  );
}

function fileSearchResultSchema(): SchemaObject {
  return objectSchema(
    {
      generationId: idSchema("Active generation searched for this result."),
      fileId: idSchema("Generated file identifier accepted by file detail, content, and related-file APIs."),
      generatedFileId: idSchema(
        "Generated file identifier. Same value as `fileId`; included to align with source-file list responses."
      ),
      knowledgeBaseId: idSchema("Knowledge-base identifier."),
      sourceFileId: nullableString("Source file identifier when this generated file is source-backed."),
      path: {
        type: "string",
        description: "Logical generated file path accepted by path-based content reads."
      },
      generatedFilePath: {
        type: "string",
        description: "Logical generated file path. Same value as `path`; included to align with source-file list responses."
      },
      fileKind: { type: "string" },
      title: nullableString("Resolved title when available."),
      description: nullableString("Resolved description when available."),
      tags: { type: "array", items: { type: "string" } },
      frontmatter: { type: "object", additionalProperties: true },
      matchedFields: {
        type: "array",
        items: { type: "string", enum: ["path", "title", "description", "metadata"] }
      },
      score: {
        type: "integer",
        minimum: 0,
        description: "Small relative score for ordering candidates within the same query."
      },
      contentAvailable: { type: "boolean" },
      readActions: fileReadActionsSchema(),
      matchType: {
        type: "string",
        enum: ["file_direct", "graph_node", "graph_edge", "graph_neighbor", "hybrid"],
        description: "Match source used to rank and explain this search result."
      },
      graphContext: graphSearchContextSchema()
    },
    [
      "generationId",
      "fileId",
      "generatedFileId",
      "knowledgeBaseId",
      "sourceFileId",
      "path",
      "generatedFilePath",
      "fileKind",
      "title",
      "description",
      "tags",
      "frontmatter",
      "matchedFields",
      "score",
      "contentAvailable",
      "readActions"
    ]
  );
}

function fileReadActionsSchema(): SchemaObject {
  return objectSchema(
    {
      fileDetailById: nullableString("Concrete generated-file detail request path when a generated file identifier is available."),
      fileContentById: nullableString("Concrete generated-file content request path using `fileId` when available."),
      fileContentByPath: {
        type: "string",
        description: "Concrete generated-file content request path using the encoded logical file path."
      },
      relatedFilesById: nullableString("Concrete related-file request path when a generated file identifier is available."),
      graphExpansionByFileId: nullableString("Concrete graph expansion request path when a generated file identifier is available."),
      sourceFileStatusById: nullableString("Concrete source-file status request path when this result is source-backed."),
      sourceFileEventsById: nullableString("Concrete source-file event request path when this result is source-backed.")
    },
    [
      "fileDetailById",
      "fileContentById",
      "fileContentByPath",
      "relatedFilesById",
      "graphExpansionByFileId",
      "sourceFileStatusById",
      "sourceFileEventsById"
    ]
  );
}

function fileSearchResponseSchema(): SchemaObject {
  return objectSchema(
    {
      generationId: nullableString("Active generation searched by this response. It is null before the first activation."),
      query: ref("FileSearchQueryContext"),
      items: { type: "array", items: ref("FileSearchResult") },
      nextCursor: nullableString("Opaque cursor accepted by this search endpoint with the same query and filters."),
      searchStatus: {
        type: "string",
        enum: ["ok", "no_candidates", "index_unavailable"],
        description:
          "`ok` means candidates are returned. `no_candidates` means the current query matched no files. `index_unavailable` means file search is not available for this knowledge base yet."
      },
      searchMode: {
        type: "string",
        enum: ["file", "graph", "hybrid"],
        description: "Search mode applied to this response."
      },
      graphStatus: {
        type: "string",
        enum: ["available", "index_unavailable", "disabled_for_file_mode"],
        description: "Relationship-search availability for this response. `disabled_for_file_mode` is returned for file-only search."
      },
      graphSummary: graphSearchSummarySchema(),
      resultSummary: ref("FileSearchResultSummary"),
      nextRequestTemplates: ref("FileSearchNextRequestTemplates"),
      message: nullableString("Safe status message when no candidates or no index is available."),
      nextActions: {
        type: "array",
        items: { type: "string" },
        description: "Suggested OpenAPI reads that keep Agent exploration moving."
      }
    },
    [
      "generationId",
      "query",
      "items",
      "nextCursor",
      "searchStatus",
      "searchMode",
      "graphStatus",
      "graphSummary",
      "resultSummary",
      "nextRequestTemplates"
    ]
  );
}

function fileSearchQueryContextSchema(): SchemaObject {
  return objectSchema(
    {
      query: { type: "string", description: "Original search phrase received by the endpoint." },
      normalizedQuery: {
        type: "string",
        description: "Normalized phrase used by the generated-file search index."
      },
      scope: {
        type: "string",
        enum: ["all", "path", "metadata"],
        description: "Search field scope applied to this response."
      },
      fileKind: {
        type: "string",
        description: "Generated file kind filter applied to this response. `all` means no kind filter."
      },
      mode: {
        type: "string",
        enum: ["file", "graph", "hybrid"],
        description: "Search mode applied to this response."
      },
      graphDepth: {
        type: "integer",
        enum: [0, 1, 2],
        description: "Bounded graph context depth."
      },
      graphFanout: {
        type: "integer",
        minimum: 0,
        description: "Maximum relationship records returned per graph item."
      },
      limit: { type: "integer", minimum: 1, description: "Requested page size after validation." },
      cursorProvided: {
        type: "boolean",
        description: "Whether the request used a cursor returned by the same search family."
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
      "limit",
      "cursorProvided"
    ]
  );
}

function graphSearchSummarySchema(): SchemaObject {
  return objectSchema(
    {
      available: { type: "boolean" },
      indexedDocumentCount: { type: "integer", minimum: 0 },
      indexedRelationshipCount: { type: "integer", minimum: 0 },
      depth: { type: "integer", enum: [0, 1, 2] },
      fanout: { type: "integer", minimum: 0 }
    },
    ["available", "indexedDocumentCount", "indexedRelationshipCount", "depth", "fanout"]
  );
}

function graphSearchContextSchema(): SchemaObject {
  return objectSchema(
    {
      graphRef: {
        type: "string",
        description: "Logical `_graph/by-file/{sourceFileId}.json` path for this candidate."
      },
      depth: { type: "integer", enum: [0, 1, 2] },
      seedSourceFileId: idSchema("Source file identifier used as the graph search seed."),
      matchedNodeFields: { type: "array", items: { type: "string" } },
      matchedRelationshipFields: { type: "array", items: { type: "string" } },
      relationships: { type: "array", items: ref("RelatedFile") },
      graphPaths: {
        type: "array",
        items: { type: "string" },
        description: "Logical graph files that can be read through the path content endpoint."
      }
    },
    [
      "graphRef",
      "depth",
      "seedSourceFileId",
      "matchedNodeFields",
      "matchedRelationshipFields",
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
        description: "Human-readable interpretation for Agent planning."
      }
    },
    ["resultCount", "hasMore", "sort", "meaning"]
  );
}

function fileSearchNextRequestTemplatesSchema(): SchemaObject {
  return objectSchema(
    {
      searchAgain: { type: "string" },
      listTree: { type: "string" },
      readIndex: { type: "string" },
      fileDetailById: { type: "string" },
      fileContentById: { type: "string" },
      fileContentByPath: { type: "string" },
      relatedFilesById: { type: "string" },
      graphExpansionByFileId: { type: "string" },
      sourceFileStatusById: { type: "string" },
      sourceFileEventsById: { type: "string" }
    },
    [
      "searchAgain",
      "listTree",
      "readIndex",
      "fileDetailById",
      "fileContentById",
      "fileContentByPath",
      "relatedFilesById",
      "graphExpansionByFileId",
      "sourceFileStatusById",
      "sourceFileEventsById"
    ]
  );
}

function generationPageSchema(itemSchema: SchemaObject): SchemaObject {
  return objectSchema(
    {
      generationId: nullableString("Active generation used for this page. It is null before the first activation."),
      items: { type: "array", items: itemSchema },
      nextCursor: nullableString("Opaque cursor accepted only by the same list family and active generation.")
    },
    ["generationId", "items", "nextCursor"]
  );
}

function uploadManifestEntryRequestSchema(): SchemaObject {
  return objectSchema(
    {
      relativePath: {
        type: "string",
        description: "NFC Markdown path relative to the selected loose-file or folder root.",
        example: "handbook/onboarding/guide.md"
      },
      declaredSize: { type: "integer", minimum: 0, example: 2048 },
      checksumSha256: {
        type: "string",
        pattern: "^[a-f0-9]{64}$",
        example: "0".repeat(64)
      }
    },
    ["relativePath", "declaredSize", "checksumSha256"]
  );
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
      failed: count,
      finalized: count
    },
    [
      "selected",
      "uploadRequired",
      "skippedExisting",
      "waitingReservation",
      "rejectedDeleting",
      "uploaded",
      "failed",
      "finalized"
    ]
  );
}

function uploadSessionSchema(): SchemaObject {
  return objectSchema(
    {
      id: idSchema("Upload session identifier used by every following session action."),
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
          "failed",
          "cancelled",
          "expired"
        ]
      },
      declaredFileCount: { type: "integer", minimum: 0 },
      declaredByteCount: { type: "integer", minimum: 0 },
      counts: ref("UploadSessionCounts"),
      errorCode: nullableString("Safe terminal upload-session error code."),
      expiresAt: timestampSchema(),
      completedAt: nullableTimestampSchema(),
      createdAt: timestampSchema(),
      updatedAt: timestampSchema()
    },
    [
      "id",
      "knowledgeBaseId",
      "state",
      "declaredFileCount",
      "declaredByteCount",
      "counts",
      "expiresAt"
    ]
  );
}

function uploadSessionEntrySchema(): SchemaObject {
  return objectSchema(
    {
      id: idSchema("Upload entry identifier used as the multipart content field name."),
      relativePath: { type: "string", example: "handbook/onboarding/guide.md" },
      directoryPath: { type: "string", example: "handbook/onboarding" },
      name: { type: "string", example: "guide.md" },
      declaredSize: { type: "integer", minimum: 0 },
      receivedSize: { type: ["integer", "null"], minimum: 0 },
      checksumSha256: { type: "string" },
      disposition: {
        type: "string",
        enum: [
          "pending",
          "upload_required",
          "skipped_existing",
          "waiting_reservation",
          "rejected_deleting"
        ]
      },
      transferState: {
        type: "string",
        enum: ["pending", "missing", "uploading", "uploaded", "failed", "skipped"]
      },
      sourceDirectoryId: nullableString("Stable parent source-directory identifier."),
      sourceFileId: nullableString("New or existing stable source-file identifier."),
      existingResourceRevision: { type: ["integer", "null"], minimum: 1 },
      generatedPath: { type: "string", example: "pages/handbook/onboarding/guide.md" },
      errorCode: nullableString("Safe entry error code.")
    },
    [
      "id",
      "relativePath",
      "directoryPath",
      "name",
      "declaredSize",
      "receivedSize",
      "checksumSha256",
      "disposition",
      "transferState",
      "sourceDirectoryId",
      "sourceFileId",
      "existingResourceRevision",
      "generatedPath",
      "errorCode"
    ]
  );
}
