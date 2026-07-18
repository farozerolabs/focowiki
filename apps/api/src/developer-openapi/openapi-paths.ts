import {
  deliveryIdParameter,
  fileSearchParameters,
  fileIdParameter,
  filePathQueryParameter,
  knowledgeBaseIdParameter,
  objectSchema,
  operation,
  paginationParameters,
  ref,
  sourceFileListFilterParameters,
  sourceFileIdParameter,
  webhookIdParameter,
  type PathItemObject
} from "./openapi-shared.js";
import { createDeveloperOpenApiResponseExamples, requestExamples } from "./openapi-examples.js";

export function createDeveloperOpenApiPaths(): Record<string, PathItemObject> {
  const responseExamples = createDeveloperOpenApiResponseExamples();

  return {
    "/openapi/v2/health": {
      get: operation({
        tag: "Metadata",
        operationId: "getDeveloperOpenApiHealth",
        summary: "Get health state",
        requestExample: requestExamples.getDeveloperOpenApiHealth,
        successStatus: 200,
        successSchema: ref("HealthResponse"),
        successExample: responseExamples.getDeveloperOpenApiHealth
      })
    },
    "/openapi/v2/version": {
      get: operation({
        tag: "Metadata",
        operationId: "getDeveloperOpenApiVersion",
        summary: "Get API version",
        requestExample: requestExamples.getDeveloperOpenApiVersion,
        successStatus: 200,
        successSchema: ref("VersionResponse"),
        successExample: responseExamples.getDeveloperOpenApiVersion
      })
    },
    "/openapi/v2/openapi.json": {
      get: operation({
        tag: "Metadata",
        operationId: "getDeveloperOpenApiContract",
        summary: "Get OpenAPI contract",
        requestExample: requestExamples.getDeveloperOpenApiContract,
        successStatus: 200,
        successSchema: objectSchema(
          {
            openapi: { type: "string" },
            info: { type: "object", additionalProperties: true },
            paths: { type: "object", additionalProperties: true }
          },
          ["openapi", "info", "paths"]
        ),
        successExample: responseExamples.getDeveloperOpenApiContract
      })
    },
    "/openapi/v2/knowledge-bases": {
      get: operation({
        tag: "Knowledge Bases",
        operationId: "listKnowledgeBases",
        summary: "List knowledge bases",
        parameters: paginationParameters(),
        requestExample: requestExamples.listKnowledgeBases,
        successStatus: 200,
        successSchema: ref("KnowledgeBaseListResponse"),
        successExample: responseExamples.listKnowledgeBases,
        additionalErrorStatuses: [422]
      }),
      post: operation({
        tag: "Knowledge Bases",
        operationId: "createKnowledgeBase",
        summary: "Create a knowledge base",
        requestSchema: ref("CreateKnowledgeBaseRequest"),
        requestExample: requestExamples.createKnowledgeBase,
        successStatus: 201,
        successSchema: ref("KnowledgeBaseResponse"),
        successExample: responseExamples.createKnowledgeBase,
        additionalErrorStatuses: [422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}": {
      get: operation({
        tag: "Knowledge Bases",
        operationId: "getKnowledgeBase",
        summary: "Get a knowledge base",
        parameters: [knowledgeBaseIdParameter()],
        requestExample: requestExamples.getKnowledgeBase,
        successStatus: 200,
        successSchema: ref("KnowledgeBaseResponse"),
        successExample: responseExamples.getKnowledgeBase,
        additionalErrorStatuses: [404]
      }),
      patch: operation({
        tag: "Knowledge Bases",
        operationId: "updateKnowledgeBase",
        summary: "Update knowledge-base metadata",
        parameters: [knowledgeBaseIdParameter(), expectedResourceRevisionHeader()],
        requestSchema: ref("UpdateKnowledgeBaseRequest"),
        requestExample: requestExamples.updateKnowledgeBase,
        successStatus: 200,
        successSchema: ref("KnowledgeBaseResponse"),
        successExample: responseExamples.updateKnowledgeBase,
        additionalErrorStatuses: [404, 409, 422]
      }),
      delete: operation({
        tag: "Knowledge Bases",
        operationId: "deleteKnowledgeBase",
        summary: "Delete a knowledge base",
        parameters: [knowledgeBaseIdParameter(), idempotencyKeyHeader(), expectedResourceRevisionHeader()],
        requestExample: requestExamples.deleteKnowledgeBase,
        successStatus: 202,
        successSchema: ref("KnowledgeBaseDeletionResponse"),
        successExample: responseExamples.deleteKnowledgeBase,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions": {
      post: operation({
        tag: "Upload Sessions",
        operationId: "createUploadSession",
        summary: "Create a resumable upload session",
        parameters: [knowledgeBaseIdParameter(), idempotencyKeyHeader()],
        requestSchema: ref("CreateUploadSessionRequest"),
        requestExample: requestExamples.createUploadSession,
        successStatus: 201,
        successSchema: ref("UploadSessionResponse"),
        successExample: responseExamples.createUploadSession,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/entries": {
      post: operation({
        tag: "Upload Sessions",
        operationId: "addUploadManifestEntries",
        summary: "Add files to an upload manifest",
        parameters: [knowledgeBaseIdParameter(), uploadSessionIdParameter()],
        requestSchema: ref("UploadManifestPageRequest"),
        requestExample: requestExamples.addUploadManifestEntries,
        successStatus: 200,
        successSchema: ref("UploadSessionResponse"),
        successExample: responseExamples.addUploadManifestEntries,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/seal": {
      post: operation({
        tag: "Upload Sessions",
        operationId: "sealUploadManifest",
        summary: "Confirm an upload manifest",
        parameters: [knowledgeBaseIdParameter(), uploadSessionIdParameter()],
        requestExample: requestExamples.sealUploadManifest,
        successStatus: 200,
        successSchema: ref("UploadSessionResponse"),
        successExample: responseExamples.sealUploadManifest,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/entries/{entryId}/content": {
      put: operation({
        tag: "Upload Sessions",
        operationId: "uploadSessionEntryContent",
        summary: "Upload one Markdown file body",
        parameters: [knowledgeBaseIdParameter(), uploadSessionIdParameter(), uploadEntryIdParameter()],
        requestExample: requestExamples.uploadSessionEntryContent,
        requestBody: {
          required: true,
          content: {
            "text/markdown": {
              example: requestExamples.uploadSessionEntryContent.body,
              schema: {
                type: "string",
                description: "The Markdown body for the server-issued upload entry."
              }
            }
          }
        },
        successStatus: 200,
        successSchema: ref("UploadEntryResponse"),
        successExample: responseExamples.uploadSessionEntryContent,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}": {
      get: operation({
        tag: "Upload Sessions",
        operationId: "getUploadSession",
        summary: "Get upload progress",
        parameters: [
          knowledgeBaseIdParameter(),
          uploadSessionIdParameter(),
          ...paginationParameters(),
          {
            name: "transferState",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["missing", "failed", "uploaded"] }
          }
        ],
        requestExample: requestExamples.getUploadSession,
        successStatus: 200,
        successSchema: ref("UploadSessionStatusResponse"),
        successExample: responseExamples.getUploadSession,
        additionalErrorStatuses: [404, 422]
      }),
      delete: operation({
        tag: "Upload Sessions",
        operationId: "cancelUploadSession",
        summary: "Cancel an unfinished upload session",
        parameters: [knowledgeBaseIdParameter(), uploadSessionIdParameter()],
        requestExample: requestExamples.cancelUploadSession,
        successStatus: 200,
        successSchema: ref("UploadSessionResponse"),
        successExample: responseExamples.cancelUploadSession,
        additionalErrorStatuses: [404, 409]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/reconcile": {
      post: operation({
        tag: "Upload Sessions",
        operationId: "reconcileUploadSession",
        summary: "Refresh blocked upload entries",
        parameters: [knowledgeBaseIdParameter(), uploadSessionIdParameter()],
        requestExample: requestExamples.reconcileUploadSession,
        successStatus: 200,
        successSchema: ref("UploadSessionResponse"),
        successExample: responseExamples.reconcileUploadSession,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/finalize": {
      post: operation({
        tag: "Upload Sessions",
        operationId: "finalizeUploadSession",
        summary: "Complete an upload session",
        parameters: [knowledgeBaseIdParameter(), uploadSessionIdParameter()],
        requestExample: requestExamples.finalizeUploadSession,
        successStatus: 200,
        successSchema: ref("UploadSessionResponse"),
        successExample: responseExamples.finalizeUploadSession,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files": {
      get: operation({
        tag: "Source Files",
        operationId: "listKnowledgeBaseSourceFiles",
        summary: "List source files",
        parameters: [
          knowledgeBaseIdParameter(),
          ...paginationParameters(),
          ...sourceFileListFilterParameters()
        ],
        requestExample: requestExamples.listKnowledgeBaseSourceFiles,
        successStatus: 200,
        successSchema: ref("SourceResourceFileListResponse"),
        successExample: responseExamples.listKnowledgeBaseSourceFiles,
        additionalErrorStatuses: [404, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}": {
      get: operation({
        tag: "Source Files",
        operationId: "getKnowledgeBaseSourceFile",
        summary: "Get source file",
        parameters: [knowledgeBaseIdParameter(), sourceFileIdParameter()],
        requestExample: requestExamples.getKnowledgeBaseSourceFile,
        successStatus: 200,
        successSchema: ref("SourceResourceFileResponse"),
        successExample: responseExamples.getKnowledgeBaseSourceFile,
        additionalErrorStatuses: [404]
      }),
      patch: operation({
        tag: "Source Files",
        operationId: "moveSourceFile",
        summary: "Rename or move a source file",
        parameters: [
          knowledgeBaseIdParameter(),
          sourceFileIdParameter(),
          idempotencyKeyHeader(),
          expectedResourceRevisionHeader()
        ],
        requestSchema: ref("MoveSourceResourceRequest"),
        requestExample: requestExamples.moveSourceFile,
        successStatus: 202,
        successSchema: ref("ResourceOperationResponse"),
        successExample: responseExamples.moveSourceFile,
        additionalErrorStatuses: [404, 409, 422]
      }),
      delete: operation({
        tag: "Source Files",
        operationId: "deleteSourceFile",
        summary: "Delete a source file",
        parameters: [
          knowledgeBaseIdParameter(),
          sourceFileIdParameter(),
          idempotencyKeyHeader(),
          expectedResourceRevisionHeader()
        ],
        requestExample: requestExamples.deleteSourceFile,
        successStatus: 202,
        successSchema: ref("ResourceDeletionResponse"),
        successExample: responseExamples.deleteSourceFile,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/content": {
      get: operation({
        tag: "Source Files",
        operationId: "getSourceFileContent",
        summary: "Read source Markdown content",
        parameters: [knowledgeBaseIdParameter(), sourceFileIdParameter()],
        requestExample: requestExamples.getSourceFileContent,
        successStatus: 200,
        successSchema: { type: "string" },
        successExample: responseExamples.getSourceFileContent,
        successContentType: "text/markdown",
        additionalErrorStatuses: [404]
      }),
      put: operation({
        tag: "Source Files",
        operationId: "replaceSourceFileContent",
        summary: "Replace complete Markdown content and optionally move the source file",
        parameters: [
          knowledgeBaseIdParameter(),
          sourceFileIdParameter(),
          idempotencyKeyHeader(),
          expectedResourceRevisionHeader(),
          {
            name: "X-Source-Relative-Path",
            in: "header",
            required: false,
            description:
              "Optional safe target relative path for a combined replace-and-move operation. Its target parent directory must already exist and be active.",
            schema: { type: "string", example: "handbook/setup/install.md" }
          }
        ],
        requestBody: {
          required: true,
          content: {
            "text/markdown": {
              schema: { type: "string" },
              example: requestExamples.replaceSourceFileContent.body
            }
          }
        },
        requestExample: requestExamples.replaceSourceFileContent,
        successStatus: 202,
        successSchema: ref("ResourceOperationResponse"),
        successExample: responseExamples.replaceSourceFileContent,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-directories": {
      get: operation({
        tag: "Source Directories",
        operationId: "listSourceDirectories",
        summary: "List direct source directories",
        parameters: [
          knowledgeBaseIdParameter(),
          {
            name: "parentDirectoryId",
            in: "query",
            required: false,
            description: "Stable parent directory ID. Omit or use `root` for top-level directories.",
            schema: { type: "string" }
          },
          ...paginationParameters()
        ],
        requestExample: requestExamples.listSourceDirectories,
        successStatus: 200,
        successSchema: ref("SourceDirectoryListResponse"),
        successExample: responseExamples.listSourceDirectories,
        additionalErrorStatuses: [404, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-directories/{directoryId}": {
      get: operation({
        tag: "Source Directories",
        operationId: "getSourceDirectory",
        summary: "Get one source directory",
        parameters: [knowledgeBaseIdParameter(), sourceDirectoryIdParameter()],
        requestExample: requestExamples.getSourceDirectory,
        successStatus: 200,
        successSchema: ref("SourceDirectoryResponse"),
        successExample: responseExamples.getSourceDirectory,
        additionalErrorStatuses: [404]
      }),
      patch: operation({
        tag: "Source Directories",
        operationId: "moveSourceDirectory",
        summary: "Rename or move a source directory",
        parameters: [
          knowledgeBaseIdParameter(),
          sourceDirectoryIdParameter(),
          idempotencyKeyHeader(),
          expectedResourceRevisionHeader()
        ],
        requestSchema: ref("MoveSourceResourceRequest"),
        requestExample: requestExamples.moveSourceDirectory,
        successStatus: 202,
        successSchema: ref("ResourceOperationResponse"),
        successExample: responseExamples.moveSourceDirectory,
        additionalErrorStatuses: [404, 409, 422]
      }),
      delete: operation({
        tag: "Source Directories",
        operationId: "deleteSourceDirectory",
        summary: "Delete a source directory and its contents",
        parameters: [
          knowledgeBaseIdParameter(),
          sourceDirectoryIdParameter(),
          idempotencyKeyHeader(),
          expectedResourceRevisionHeader()
        ],
        requestExample: requestExamples.deleteSourceDirectory,
        successStatus: 202,
        successSchema: ref("ResourceDeletionResponse"),
        successExample: responseExamples.deleteSourceDirectory,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/operations": {
      get: operation({
        tag: "Resource Operations",
        operationId: "listResourceOperations",
        summary: "List resource operations",
        parameters: [
          knowledgeBaseIdParameter(),
          {
            name: "state",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["accepted", "validating", "processing", "publishing", "completed", "failed", "cancelled", "superseded"] }
          },
          ...paginationParameters()
        ],
        requestExample: requestExamples.listResourceOperations,
        successStatus: 200,
        successSchema: ref("ResourceOperationListResponse"),
        successExample: responseExamples.listResourceOperations,
        additionalErrorStatuses: [404, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/operations/{operationId}": {
      get: operation({
        tag: "Resource Operations",
        operationId: "getResourceOperation",
        summary: "Get a resource operation",
        parameters: [knowledgeBaseIdParameter(), resourceOperationIdParameter()],
        requestExample: requestExamples.getResourceOperation,
        successStatus: 200,
        successSchema: ref("ResourceOperationResponse"),
        successExample: responseExamples.getResourceOperation,
        additionalErrorStatuses: [404]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/events": {
      get: operation({
        tag: "Source Files",
        operationId: "listKnowledgeBaseSourceFileEvents",
        summary: "List source file events",
        parameters: [knowledgeBaseIdParameter(), sourceFileIdParameter(), ...paginationParameters()],
        requestExample: requestExamples.listKnowledgeBaseSourceFileEvents,
        successStatus: 200,
        successSchema: ref("SourceFileEventListResponse"),
        successExample: responseExamples.listKnowledgeBaseSourceFileEvents,
        additionalErrorStatuses: [404, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/retry": {
      post: operation({
        tag: "Source Files",
        operationId: "retryKnowledgeBaseSourceFile",
        summary: "Retry source file",
        parameters: [knowledgeBaseIdParameter(), sourceFileIdParameter()],
        requestExample: requestExamples.retryKnowledgeBaseSourceFile,
        successStatus: 202,
        successSchema: ref("SourceResourceFileResponse"),
        successExample: responseExamples.retryKnowledgeBaseSourceFile,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/tree": {
      get: operation({
        tag: "Files",
        operationId: "listKnowledgeBaseTree",
        summary: "List generated file tree entries",
        parameters: [
          knowledgeBaseIdParameter(),
          {
            name: "parentPath",
            in: "query",
            required: false,
            description: "Logical parent path. Traversal and storage paths are rejected.",
            schema: { type: "string", default: "" }
          },
          {
            name: "query",
            in: "query",
            required: false,
            description: "Optional fuzzy tree search query. When set, matching files and directories are returned with ancestor chains.",
            schema: { type: "string", example: "guide" }
          },
          {
            name: "entryType",
            in: "query",
            required: false,
            description: "Optional tree node type filter.",
            schema: { type: "string", enum: ["file", "directory"] }
          },
          ...paginationParameters()
        ],
        requestExample: requestExamples.listKnowledgeBaseTree,
        successStatus: 200,
        successSchema: ref("TreeResponse"),
        successExample: responseExamples.listKnowledgeBaseTree,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/content": {
      get: operation({
        tag: "Files",
        operationId: "getFileContentByPath",
        summary: "Read generated file content by logical path",
        parameters: [knowledgeBaseIdParameter(), filePathQueryParameter(true)],
        requestExample: requestExamples.getFileContentByPath,
        successStatus: 200,
        successSchema: ref("FileContentResponse"),
        successExample: responseExamples.getFileContentByPath,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/search": {
      get: operation({
        tag: "Files",
        operationId: "searchGeneratedFiles",
        summary: "Search generated files",
        parameters: [knowledgeBaseIdParameter(), ...fileSearchParameters()],
        requestExample: requestExamples.searchGeneratedFiles,
        successStatus: 200,
        successSchema: ref("FileSearchResponse"),
        successExample: responseExamples.searchGeneratedFiles,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/graph/expand": {
      get: operation({
        tag: "Files",
        operationId: "expandGraph",
        summary: "Expand file graph relationships",
        parameters: [
          knowledgeBaseIdParameter(),
          {
            name: "fileId",
            in: "query",
            required: false,
            description: "Generated file ID or source file ID used to start exploration. Provide exactly one seed parameter.",
            schema: { type: "string" }
          },
          {
            name: "nodeId",
            in: "query",
            required: false,
            description: "Relationship node identifier returned by a graph response. Provide exactly one seed parameter.",
            schema: { type: "string" }
          },
          {
            name: "edgeId",
            in: "query",
            required: false,
            description: "Relationship edge identifier returned by a graph response. Provide exactly one seed parameter.",
            schema: { type: "string" }
          },
          {
            name: "query",
            in: "query",
            required: false,
            description: "Short query used to find a starting file. Provide exactly one seed parameter.",
            schema: { type: "string", minLength: 2, maxLength: 160 }
          },
          {
            name: "depth",
            in: "query",
            required: false,
            description: "Number of relationship levels to explore.",
            schema: { type: "integer", enum: [0, 1, 2], default: 1 }
          },
          {
            name: "fanout",
            in: "query",
            required: false,
            description: "Maximum related files returned for each explored file.",
            schema: { type: "integer", minimum: 0, maximum: 25, default: 10 }
          },
          ...paginationParameters()
        ],
        requestExample: requestExamples.expandGraph,
        successStatus: 200,
        successSchema: ref("GraphExpansionResponse"),
        successExample: responseExamples.expandGraph,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/graph/insights": {
      get: operation({
        tag: "Files",
        operationId: "getGraphInsights",
        summary: "Get graph insights",
        parameters: [knowledgeBaseIdParameter()],
        requestExample: requestExamples.getGraphInsights,
        successStatus: 200,
        successSchema: ref("GraphInsightsResponse"),
        successExample: responseExamples.getGraphInsights,
        additionalErrorStatuses: [404, 409]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/{fileId}": {
      get: operation({
        tag: "Files",
        operationId: "getFileById",
        summary: "Get generated file metadata",
        parameters: [knowledgeBaseIdParameter(), fileIdParameter()],
        requestExample: requestExamples.getFileById,
        successStatus: 200,
        successSchema: ref("FileDetailResponse"),
        successExample: responseExamples.getFileById,
        additionalErrorStatuses: [404, 409]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/{fileId}/content": {
      get: operation({
        tag: "Files",
        operationId: "getFileContentById",
        summary: "Read generated file content by file identifier",
        parameters: [knowledgeBaseIdParameter(), fileIdParameter()],
        requestExample: requestExamples.getFileContentById,
        successStatus: 200,
        successSchema: ref("FileContentResponse"),
        successExample: responseExamples.getFileContentById,
        additionalErrorStatuses: [404, 409]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/{fileId}/related": {
      get: operation({
        tag: "Files",
        operationId: "listRelatedFiles",
        summary: "List related files",
        parameters: [knowledgeBaseIdParameter(), fileIdParameter(), ...paginationParameters()],
        requestExample: requestExamples.listRelatedFiles,
        successStatus: 200,
        successSchema: ref("RelatedFileListResponse"),
        successExample: responseExamples.listRelatedFiles,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/webhooks": {
      post: operation({
        tag: "Webhooks",
        operationId: "createWebhook",
        summary: "Create a webhook subscription",
        requestSchema: ref("WebhookCreateRequest"),
        requestExample: requestExamples.createWebhook,
        successStatus: 201,
        successSchema: ref("WebhookCreateResponse"),
        successExample: responseExamples.createWebhook,
        additionalErrorStatuses: [422]
      }),
      get: operation({
        tag: "Webhooks",
        operationId: "listWebhooks",
        summary: "List webhook subscriptions",
        parameters: paginationParameters(),
        requestExample: requestExamples.listWebhooks,
        successStatus: 200,
        successSchema: ref("WebhookListResponse"),
        successExample: responseExamples.listWebhooks,
        additionalErrorStatuses: [422]
      })
    },
    "/openapi/v2/webhooks/{webhookId}": {
      delete: operation({
        tag: "Webhooks",
        operationId: "deleteWebhook",
        summary: "Delete a webhook subscription",
        parameters: [webhookIdParameter()],
        requestExample: requestExamples.deleteWebhook,
        successStatus: 200,
        successSchema: ref("DeleteResponse"),
        successExample: responseExamples.deleteWebhook,
        additionalErrorStatuses: [404]
      })
    },
    "/openapi/v2/webhook-deliveries": {
      get: operation({
        tag: "Webhooks",
        operationId: "listWebhookDeliveries",
        summary: "List webhook deliveries",
        parameters: paginationParameters(),
        requestExample: requestExamples.listWebhookDeliveries,
        successStatus: 200,
        successSchema: ref("WebhookDeliveryListResponse"),
        successExample: responseExamples.listWebhookDeliveries,
        additionalErrorStatuses: [422]
      })
    },
    "/openapi/v2/webhook-deliveries/{deliveryId}/redeliver": {
      post: operation({
        tag: "Webhooks",
        operationId: "redeliverWebhook",
        summary: "Redeliver a webhook delivery",
        parameters: [deliveryIdParameter()],
        requestExample: requestExamples.redeliverWebhook,
        successStatus: 202,
        successSchema: ref("WebhookRedeliveryResponse"),
        successExample: responseExamples.redeliverWebhook,
        additionalErrorStatuses: [404, 409]
      })
    }
  };
}

function uploadSessionIdParameter() {
  return {
    name: "uploadSessionId",
    in: "path",
    required: true,
    description: "Upload session identifier returned by createUploadSession.",
    schema: { type: "string", example: "upload-session-123" }
  };
}

function uploadEntryIdParameter() {
  return {
    name: "entryId",
    in: "path",
    required: true,
    description: "Upload entry identifier returned by getUploadSession.",
    schema: { type: "string", example: "upload-entry-123" }
  };
}

function idempotencyKeyHeader() {
  return {
    name: "Idempotency-Key",
    in: "header",
    required: true,
    description: "Stable client key for replaying the same mutation safely.",
    schema: { type: "string", example: "upload-folder-2026-07-10-001" }
  };
}

function expectedResourceRevisionHeader() {
  return {
    name: "If-Match",
    in: "header",
    required: true,
    description: "Current positive resource revision. A stale revision returns a conflict.",
    schema: { type: "string", example: '"3"' }
  };
}

function sourceDirectoryIdParameter() {
  return {
    name: "directoryId",
    in: "path",
    required: true,
    description: "Stable source-directory identifier returned by source-directory or tree reads.",
    schema: { type: "string", example: "source-directory-123" }
  };
}

function resourceOperationIdParameter() {
  return {
    name: "operationId",
    in: "path",
    required: true,
    description: "Asynchronous resource-operation identifier returned by a source mutation.",
    schema: { type: "string", example: "resource-operation-123" }
  };
}
