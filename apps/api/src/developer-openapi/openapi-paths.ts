import {
  deliveryIdParameter,
  errorResponse,
  fileIdParameter,
  filePathQueryParameter,
  knowledgeBaseIdParameter,
  objectSchema,
  operation,
  paginationParameters,
  ref,
  sourceFileIdParameter,
  webhookIdParameter,
  type PathItemObject
} from "./openapi-shared.js";
import { createDeveloperOpenApiResponseExamples, requestExamples } from "./openapi-examples.js";

export function createDeveloperOpenApiPaths(): Record<string, PathItemObject> {
  const responseExamples = createDeveloperOpenApiResponseExamples();

  return {
    "/openapi/v1/health": {
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
    "/openapi/v1/version": {
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
    "/openapi/v1/openapi.json": {
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
    "/openapi/v1/knowledge-bases": {
      get: operation({
        tag: "Knowledge Bases",
        operationId: "listKnowledgeBases",
        summary: "List knowledge bases",
        parameters: paginationParameters(),
        requestExample: requestExamples.listKnowledgeBases,
        successStatus: 200,
        successSchema: ref("KnowledgeBaseListResponse"),
        successExample: responseExamples.listKnowledgeBases
      }),
      post: operation({
        tag: "Knowledge Bases",
        operationId: "createKnowledgeBase",
        summary: "Create a knowledge base",
        requestSchema: ref("CreateKnowledgeBaseRequest"),
        requestExample: requestExamples.createKnowledgeBase,
        successStatus: 201,
        successSchema: ref("KnowledgeBaseResponse"),
        successExample: responseExamples.createKnowledgeBase
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}": {
      get: operation({
        tag: "Knowledge Bases",
        operationId: "getKnowledgeBase",
        summary: "Get a knowledge base",
        parameters: [knowledgeBaseIdParameter()],
        requestExample: requestExamples.getKnowledgeBase,
        successStatus: 200,
        successSchema: ref("KnowledgeBaseResponse"),
        successExample: responseExamples.getKnowledgeBase
      }),
      delete: operation({
        tag: "Knowledge Bases",
        operationId: "deleteKnowledgeBase",
        summary: "Delete a knowledge base",
        parameters: [knowledgeBaseIdParameter()],
        requestExample: requestExamples.deleteKnowledgeBase,
        successStatus: 200,
        successSchema: ref("DeleteKnowledgeBaseResponse"),
        successExample: responseExamples.deleteKnowledgeBase
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/uploads": {
      post: operation({
        tag: "Knowledge Bases",
        operationId: "uploadMarkdownFiles",
        summary: "Upload one or more Markdown files",
        parameters: [knowledgeBaseIdParameter()],
        requestExample: requestExamples.uploadMarkdownFiles,
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: objectSchema(
                {
                  files: {
                    type: "array",
                    items: { type: "string", format: "binary" },
                    description: "One or more `.md` Markdown files."
                  }
                },
                ["files"]
              ),
              example: requestExamples.uploadMarkdownFiles.body
            }
          }
        },
        successStatus: 202,
        successSchema: ref("UploadResponse"),
        successExample: responseExamples.uploadMarkdownFiles,
        extraResponses: {
          "413": errorResponse(
            "Uploaded files exceed configured limits.",
            "PAYLOAD_TOO_LARGE",
            413
          ),
          "503": errorResponse(
            "Worker queue is above the configured backpressure limit.",
            "QUEUE_BACKPRESSURE",
            503
          )
        }
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files": {
      get: operation({
        tag: "Source Files",
        operationId: "listKnowledgeBaseSourceFiles",
        summary: "List source files",
        parameters: [knowledgeBaseIdParameter(), ...paginationParameters()],
        requestExample: requestExamples.listKnowledgeBaseSourceFiles,
        successStatus: 200,
        successSchema: ref("SourceFileListResponse"),
        successExample: responseExamples.listKnowledgeBaseSourceFiles
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}": {
      get: operation({
        tag: "Source Files",
        operationId: "getKnowledgeBaseSourceFile",
        summary: "Get source file",
        parameters: [knowledgeBaseIdParameter(), sourceFileIdParameter()],
        requestExample: requestExamples.getKnowledgeBaseSourceFile,
        successStatus: 200,
        successSchema: ref("SourceFileResponse"),
        successExample: responseExamples.getKnowledgeBaseSourceFile
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/events": {
      get: operation({
        tag: "Source Files",
        operationId: "listKnowledgeBaseSourceFileEvents",
        summary: "List source file events",
        parameters: [knowledgeBaseIdParameter(), sourceFileIdParameter(), ...paginationParameters()],
        requestExample: requestExamples.listKnowledgeBaseSourceFileEvents,
        successStatus: 200,
        successSchema: ref("SourceFileEventListResponse"),
        successExample: responseExamples.listKnowledgeBaseSourceFileEvents
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/retry": {
      post: operation({
        tag: "Source Files",
        operationId: "retryKnowledgeBaseSourceFile",
        summary: "Retry source file",
        parameters: [knowledgeBaseIdParameter(), sourceFileIdParameter()],
        requestExample: requestExamples.retryKnowledgeBaseSourceFile,
        successStatus: 202,
        successSchema: ref("SourceFileRetryResponse"),
        successExample: responseExamples.retryKnowledgeBaseSourceFile,
        extraResponses: {
          "503": errorResponse(
            "Worker queue is above the configured backpressure limit.",
            "QUEUE_BACKPRESSURE",
            503
          )
        }
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/tree": {
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
        successExample: responseExamples.listKnowledgeBaseTree
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/content": {
      get: operation({
        tag: "Files",
        operationId: "getFileContentByPath",
        summary: "Read generated file content by logical path",
        parameters: [knowledgeBaseIdParameter(), filePathQueryParameter(true)],
        requestExample: requestExamples.getFileContentByPath,
        successStatus: 200,
        successSchema: ref("FileContentResponse"),
        successExample: responseExamples.getFileContentByPath
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}": {
      get: operation({
        tag: "Files",
        operationId: "getFileById",
        summary: "Get generated or source file metadata",
        parameters: [knowledgeBaseIdParameter(), fileIdParameter()],
        requestExample: requestExamples.getFileById,
        successStatus: 200,
        successSchema: ref("FileDetailResponse"),
        successExample: responseExamples.getFileById
      }),
      delete: operation({
        tag: "Files",
        operationId: "deleteFileById",
        summary: "Delete a source-backed generated file",
        parameters: [knowledgeBaseIdParameter(), fileIdParameter()],
        requestExample: requestExamples.deleteFileById,
        successStatus: 200,
        successSchema: ref("FileDeletionResponse"),
        successExample: responseExamples.deleteFileById
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/content": {
      get: operation({
        tag: "Files",
        operationId: "getFileContentById",
        summary: "Read generated file content by file identifier",
        parameters: [knowledgeBaseIdParameter(), fileIdParameter()],
        requestExample: requestExamples.getFileContentById,
        successStatus: 200,
        successSchema: ref("FileContentResponse"),
        successExample: responseExamples.getFileContentById
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/related": {
      get: operation({
        tag: "Files",
        operationId: "listRelatedFiles",
        summary: "List related files",
        parameters: [knowledgeBaseIdParameter(), fileIdParameter(), ...paginationParameters()],
        requestExample: requestExamples.listRelatedFiles,
        successStatus: 200,
        successSchema: ref("RelatedFileListResponse"),
        successExample: responseExamples.listRelatedFiles
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files": {
      delete: operation({
        tag: "Files",
        operationId: "deleteFileByPath",
        summary: "Delete a source-backed generated file by logical path",
        parameters: [knowledgeBaseIdParameter(), filePathQueryParameter(true)],
        requestExample: requestExamples.deleteFileByPath,
        successStatus: 200,
        successSchema: ref("FileDeletionResponse"),
        successExample: responseExamples.deleteFileByPath
      })
    },
    "/openapi/v1/webhooks": {
      post: operation({
        tag: "Webhooks",
        operationId: "createWebhook",
        summary: "Create a webhook subscription",
        requestSchema: ref("WebhookCreateRequest"),
        requestExample: requestExamples.createWebhook,
        successStatus: 201,
        successSchema: ref("WebhookCreateResponse"),
        successExample: responseExamples.createWebhook
      }),
      get: operation({
        tag: "Webhooks",
        operationId: "listWebhooks",
        summary: "List webhook subscriptions",
        parameters: paginationParameters(),
        requestExample: requestExamples.listWebhooks,
        successStatus: 200,
        successSchema: ref("WebhookListResponse"),
        successExample: responseExamples.listWebhooks
      })
    },
    "/openapi/v1/webhooks/{webhookId}": {
      delete: operation({
        tag: "Webhooks",
        operationId: "deleteWebhook",
        summary: "Delete a webhook subscription",
        parameters: [webhookIdParameter()],
        requestExample: requestExamples.deleteWebhook,
        successStatus: 200,
        successSchema: ref("DeleteResponse"),
        successExample: responseExamples.deleteWebhook
      })
    },
    "/openapi/v1/webhook-deliveries": {
      get: operation({
        tag: "Webhooks",
        operationId: "listWebhookDeliveries",
        summary: "List webhook deliveries",
        parameters: paginationParameters(),
        requestExample: requestExamples.listWebhookDeliveries,
        successStatus: 200,
        successSchema: ref("WebhookDeliveryListResponse"),
        successExample: responseExamples.listWebhookDeliveries
      })
    },
    "/openapi/v1/webhook-deliveries/{deliveryId}/redeliver": {
      post: operation({
        tag: "Webhooks",
        operationId: "redeliverWebhook",
        summary: "Redeliver a webhook delivery",
        parameters: [deliveryIdParameter()],
        requestExample: requestExamples.redeliverWebhook,
        successStatus: 202,
        successSchema: ref("WebhookRedeliveryResponse"),
        successExample: responseExamples.redeliverWebhook
      })
    }
  };
}
