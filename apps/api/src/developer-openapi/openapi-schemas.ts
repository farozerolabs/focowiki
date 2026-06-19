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
            details: { type: "object", additionalProperties: true }
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
        apiVersion: { type: "string", const: "v1" }
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
        activeReleaseId: nullableString("Current active release identifier, when published."),
        createdAt: timestampSchema(),
        updatedAt: timestampSchema()
      },
      ["knowledgeBaseId", "name", "description", "activeReleaseId", "createdAt", "updatedAt"]
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
    DeleteKnowledgeBaseResponse: objectSchema(
      {
        deleted: { type: "boolean" },
        knowledgeBaseId: idSchema("Deleted knowledge-base identifier.")
      },
      ["deleted", "knowledgeBaseId"]
    ),
    UploadAcceptedFile: objectSchema(
      {
        fileId: idSchema("Source file identifier accepted by source-file status and file detail reads."),
        originalFilename: { type: "string" },
        sizeBytes: { type: "integer", minimum: 0 },
        processingState: { type: "string", enum: ["queued", "running", "completed", "failed"] },
        currentStage: { type: "string" }
      },
      ["fileId", "originalFilename", "sizeBytes", "processingState", "currentStage"]
    ),
    UploadResponse: objectSchema(
      {
        knowledgeBaseId: idSchema("Knowledge-base identifier."),
        files: { type: "array", items: ref("UploadAcceptedFile") }
      },
      ["knowledgeBaseId", "files"]
    ),
    SourceFile: sourceFileSchema(),
    SourceFileListResponse: pageSchema(ref("SourceFile")),
    SourceFileResponse: objectSchema({ file: ref("SourceFile") }, ["file"]),
    SourceFileEvent: sourceFileEventSchema(),
    SourceFileEventListResponse: pageSchema(ref("SourceFileEvent")),
    SourceFileRetryResponse: objectSchema({ file: ref("SourceFile") }, ["file"]),
    BundleTreeEntry: bundleTreeEntrySchema(),
    TreeResponse: pageSchema(ref("BundleTreeEntry")),
    BundleFile: bundleFileSchema(),
    SourceFileDetail: sourceFileDetailSchema(),
    FileDetailResponse: objectSchema(
      {
        file: {
          oneOf: [ref("BundleFile"), ref("SourceFileDetail")]
        }
      },
      ["file"]
    ),
    FileContentResponse: objectSchema(
      {
        file: ref("BundleFile"),
        content: { type: "string" }
      },
      ["file", "content"]
    ),
    RelatedFile: relatedFileSchema(),
    RelatedFileListResponse: objectSchema(
      {
        fileId: idSchema("Requested file identifier."),
        sourceFileId: idSchema("Source file identifier used for graph lookup."),
        items: { type: "array", items: ref("RelatedFile") },
        nextCursor: nullableString("Opaque cursor accepted by this related-file endpoint.")
      },
      ["fileId", "sourceFileId", "items", "nextCursor"]
    ),
    FileDeletionResponse: objectSchema(
      {
        knowledgeBaseId: idSchema("Knowledge-base identifier."),
        deleted: { type: "boolean" },
        releaseId: idSchema("Active release identifier after deletion."),
        file: ref("BundleFile")
      },
      ["knowledgeBaseId", "deleted", "releaseId", "file"]
    ),
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

function relatedFileSchema(): SchemaObject {
  return objectSchema(
    {
      fileId: idSchema("Related source file identifier."),
      sourceFileId: idSchema("Related source file identifier."),
      bundleFileId: nullableString("Related generated bundle file identifier when published."),
      path: { type: "string" },
      title: { type: "string" },
      relationType: { type: "string" },
      direction: { type: "string", enum: ["outgoing", "incoming"] },
      weight: { type: "number", minimum: 0, maximum: 1 },
      reason: { type: "string" },
      source: { type: "string" },
      evidence: { type: "object", additionalProperties: true },
      contentAvailable: { type: "boolean" }
    },
    [
      "fileId",
      "sourceFileId",
      "bundleFileId",
      "path",
      "title",
      "relationType",
      "direction",
      "weight",
      "reason",
      "source",
      "evidence",
      "contentAvailable"
    ]
  );
}

function sourceFileSchema(): SchemaObject {
  return objectSchema(
    {
      fileId: idSchema("Source file identifier."),
      knowledgeBaseId: idSchema("Knowledge-base identifier."),
      originalFilename: { type: "string" },
      contentType: { type: "string" },
      sizeBytes: { type: "integer", minimum: 0 },
      checksumSha256: { type: "string" },
      metadata: { type: "object", additionalProperties: true },
      modelSuggestions: {
        anyOf: [modelSuggestionsSchema(), { type: "null" }],
        description: "Model-generated presentation suggestions stored for the source file, when available."
      },
      processingState: { type: "string" },
      currentStage: { type: "string" },
      processingStartedAt: timestampSchema(),
      processingEndedAt: nullableTimestampSchema(),
      processingErrorCode: nullableString("Stable processing error code when processing fails."),
      processingErrorMessage: nullableString("Safe processing error message when processing fails."),
      retryCount: { type: "integer", minimum: 0 },
      modelInvocationStatus: nullableString("Model assistance status when model assistance is configured."),
      modelInvocationModelName: nullableString("Model name used for assistance when available."),
      modelInvocationStartedAt: nullableTimestampSchema(),
      modelInvocationEndedAt: nullableTimestampSchema(),
      modelInvocationWarningCount: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
      modelInvocationErrorCode: nullableString("Stable model error code when model assistance fails."),
      generatedFileAvailable: { type: "boolean" },
      generatedFileId: nullableString("Generated bundle file identifier when visible in the active bundle."),
      generatedFilePath: nullableString("Logical generated file path when visible in the active bundle."),
      createdAt: timestampSchema()
    },
    [
      "fileId",
      "knowledgeBaseId",
      "originalFilename",
      "contentType",
      "sizeBytes",
      "checksumSha256",
      "metadata",
      "modelSuggestions",
      "processingState",
      "currentStage",
      "processingStartedAt",
      "processingEndedAt",
      "processingErrorCode",
      "processingErrorMessage",
      "retryCount",
      "modelInvocationStatus",
      "modelInvocationModelName",
      "modelInvocationStartedAt",
      "modelInvocationEndedAt",
      "modelInvocationWarningCount",
      "modelInvocationErrorCode",
      "generatedFileAvailable",
      "generatedFileId",
      "generatedFilePath",
      "createdAt"
    ]
  );
}

function sourceFileEventSchema(): SchemaObject {
  return objectSchema(
    {
      eventId: idSchema("Source-file event identifier."),
      knowledgeBaseId: idSchema("Knowledge-base identifier."),
      fileId: idSchema("Source file identifier."),
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
      "fileId",
      "stageKey",
      "messageKey",
      "startedAt",
      "endedAt",
      "severity",
      "createdAt"
    ]
  );
}

function bundleTreeEntrySchema(): SchemaObject {
  return objectSchema(
    {
      id: idSchema("Tree entry identifier."),
      fileId: nullableString("Bundle file identifier when this entry is a persisted file."),
      sourceFileId: nullableString("Source file identifier when this generated file is source-backed."),
      parentPath: { type: "string" },
      name: { type: "string" },
      path: {
        type: "string",
        description: "Logical generated file path. It is not a storage path."
      },
      entryType: { type: "string", enum: ["file", "directory"] },
      fileKind: nullableString("Generated file classification."),
      deletable: { type: "boolean" }
    },
    ["id", "fileId", "sourceFileId", "parentPath", "name", "path", "entryType", "fileKind", "deletable"]
  );
}

function bundleFileSchema(): SchemaObject {
  return objectSchema(
    {
      fileId: idSchema("Bundle file identifier."),
      knowledgeBaseId: idSchema("Knowledge-base identifier."),
      sourceFileId: nullableString("Source file identifier when this generated file is source-backed."),
      path: {
        type: "string",
        description: "Logical generated file path accepted by path-based reads."
      },
      originalFilename: nullableString("Original uploaded filename when available."),
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
      contentAvailable: { type: "boolean" }
    },
    [
      "fileId",
      "knowledgeBaseId",
      "sourceFileId",
      "path",
      "originalFilename",
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
      "contentAvailable"
    ]
  );
}

function sourceFileDetailSchema(): SchemaObject {
  return objectSchema(
    {
      fileId: idSchema("Source file identifier."),
      knowledgeBaseId: idSchema("Knowledge-base identifier."),
      path: nullableString("Logical generated file path when this source file has published output."),
      originalFilename: { type: "string" },
      fileKind: { type: "string", const: "source" },
      contentType: { type: "string" },
      sizeBytes: { type: "integer", minimum: 0 },
      checksumSha256: { type: "string" },
      processingState: { type: "string" },
      currentStage: { type: "string" },
      contentAvailable: { type: "boolean" },
      generatedFileAvailable: { type: "boolean" },
      generatedFileId: nullableString("Generated bundle file identifier when visible in the active bundle."),
      generatedFilePath: nullableString("Logical generated file path when visible in the active bundle.")
    },
    [
      "fileId",
      "knowledgeBaseId",
      "path",
      "originalFilename",
      "fileKind",
      "contentType",
      "sizeBytes",
      "checksumSha256",
      "processingState",
      "currentStage",
      "contentAvailable",
      "generatedFileAvailable",
      "generatedFileId",
      "generatedFilePath"
    ]
  );
}

function modelSuggestionsSchema(): SchemaObject {
  return objectSchema(
    {
      title: { type: "string" },
      type: { type: "string" },
      description: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      related_links: {
        type: "array",
        items: objectSchema(
          {
            path: { type: "string" },
            title: { type: "string" }
          },
          ["path", "title"]
        )
      },
      keywords: { type: "array", items: { type: "string" } }
    },
    ["title", "type", "description", "tags", "related_links", "keywords"]
  );
}
