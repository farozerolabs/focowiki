import {
  deliveryIdParameter,
  fileIdParameter,
  filePathQueryParameter,
  knowledgeBaseIdParameter,
  objectSchema,
  operation,
  paginationParameters,
  ref,
  taskIdParameter,
  webhookIdParameter,
  type PathItemObject
} from "./openapi-shared.js";

export function createDeveloperOpenApiPaths(): Record<string, PathItemObject> {
  return {
    "/openapi/v1/health": {
      get: operation({
        tag: "Metadata",
        operationId: "getDeveloperOpenApiHealth",
        summary: "Get health state",
        successStatus: 200,
        successSchema: ref("HealthResponse")
      })
    },
    "/openapi/v1/version": {
      get: operation({
        tag: "Metadata",
        operationId: "getDeveloperOpenApiVersion",
        summary: "Get API version",
        successStatus: 200,
        successSchema: ref("VersionResponse")
      })
    },
    "/openapi/v1/openapi.json": {
      get: operation({
        tag: "Metadata",
        operationId: "getDeveloperOpenApiContract",
        summary: "Get OpenAPI contract",
        successStatus: 200,
        successSchema: {
          type: "object",
          additionalProperties: true
        }
      })
    },
    "/openapi/v1/knowledge-bases": {
      get: operation({
        tag: "Knowledge Bases",
        operationId: "listKnowledgeBases",
        summary: "List knowledge bases",
        parameters: paginationParameters(),
        successStatus: 200,
        successSchema: ref("KnowledgeBaseListResponse")
      }),
      post: operation({
        tag: "Knowledge Bases",
        operationId: "createKnowledgeBase",
        summary: "Create a knowledge base",
        requestSchema: ref("CreateKnowledgeBaseRequest"),
        successStatus: 201,
        successSchema: ref("KnowledgeBaseResponse")
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}": {
      get: operation({
        tag: "Knowledge Bases",
        operationId: "getKnowledgeBase",
        summary: "Get a knowledge base",
        parameters: [knowledgeBaseIdParameter()],
        successStatus: 200,
        successSchema: ref("KnowledgeBaseResponse")
      }),
      delete: operation({
        tag: "Knowledge Bases",
        operationId: "deleteKnowledgeBase",
        summary: "Delete a knowledge base",
        parameters: [knowledgeBaseIdParameter()],
        successStatus: 200,
        successSchema: ref("DeleteKnowledgeBaseResponse")
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/uploads": {
      post: operation({
        tag: "Knowledge Bases",
        operationId: "uploadMarkdownFiles",
        summary: "Upload one or more Markdown files",
        parameters: [knowledgeBaseIdParameter()],
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
              )
            }
          }
        },
        successStatus: 202,
        successSchema: ref("UploadResponse"),
        extraResponses: {
          "413": {
            description: "Uploaded files exceed configured limits.",
            content: {
              "application/json": {
                schema: ref("Error")
              }
            }
          }
        }
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/tasks": {
      get: operation({
        tag: "Tasks",
        operationId: "listKnowledgeBaseTasks",
        summary: "List tasks for a knowledge base",
        parameters: [knowledgeBaseIdParameter(), ...paginationParameters()],
        successStatus: 200,
        successSchema: ref("TaskListResponse")
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/tasks/{taskId}": {
      get: operation({
        tag: "Tasks",
        operationId: "getKnowledgeBaseTask",
        summary: "Get a task and its file page",
        parameters: [knowledgeBaseIdParameter(), taskIdParameter(), ...paginationParameters()],
        successStatus: 200,
        successSchema: ref("TaskDetailResponse")
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
          ...paginationParameters()
        ],
        successStatus: 200,
        successSchema: ref("TreeResponse")
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/content": {
      get: operation({
        tag: "Files",
        operationId: "getFileContentByPath",
        summary: "Read generated file content by logical path",
        parameters: [knowledgeBaseIdParameter(), filePathQueryParameter(true)],
        successStatus: 200,
        successSchema: ref("FileContentResponse")
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}": {
      get: operation({
        tag: "Files",
        operationId: "getFileById",
        summary: "Get generated or source file metadata",
        parameters: [knowledgeBaseIdParameter(), fileIdParameter()],
        successStatus: 200,
        successSchema: ref("FileDetailResponse")
      }),
      delete: operation({
        tag: "Files",
        operationId: "deleteFileById",
        summary: "Delete a source-backed generated file",
        parameters: [knowledgeBaseIdParameter(), fileIdParameter()],
        successStatus: 202,
        successSchema: ref("FileDeletionResponse")
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/content": {
      get: operation({
        tag: "Files",
        operationId: "getFileContentById",
        summary: "Read generated file content by file identifier",
        parameters: [knowledgeBaseIdParameter(), fileIdParameter()],
        successStatus: 200,
        successSchema: ref("FileContentResponse")
      })
    },
    "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files": {
      delete: operation({
        tag: "Files",
        operationId: "deleteFileByPath",
        summary: "Delete a source-backed generated file by logical path",
        parameters: [knowledgeBaseIdParameter(), filePathQueryParameter(true)],
        successStatus: 202,
        successSchema: ref("FileDeletionResponse")
      })
    },
    "/openapi/v1/webhooks": {
      post: operation({
        tag: "Webhooks",
        operationId: "createWebhook",
        summary: "Create a webhook subscription",
        requestSchema: ref("WebhookCreateRequest"),
        successStatus: 201,
        successSchema: ref("WebhookCreateResponse")
      }),
      get: operation({
        tag: "Webhooks",
        operationId: "listWebhooks",
        summary: "List webhook subscriptions",
        parameters: paginationParameters(),
        successStatus: 200,
        successSchema: ref("WebhookListResponse")
      })
    },
    "/openapi/v1/webhooks/{webhookId}": {
      delete: operation({
        tag: "Webhooks",
        operationId: "deleteWebhook",
        summary: "Delete a webhook subscription",
        parameters: [webhookIdParameter()],
        successStatus: 200,
        successSchema: ref("DeleteResponse")
      })
    },
    "/openapi/v1/webhook-deliveries": {
      get: operation({
        tag: "Webhooks",
        operationId: "listWebhookDeliveries",
        summary: "List webhook deliveries",
        parameters: paginationParameters(),
        successStatus: 200,
        successSchema: ref("WebhookDeliveryListResponse")
      })
    },
    "/openapi/v1/webhook-deliveries/{deliveryId}/redeliver": {
      post: operation({
        tag: "Webhooks",
        operationId: "redeliverWebhook",
        summary: "Redeliver a webhook delivery",
        parameters: [deliveryIdParameter()],
        successStatus: 202,
        successSchema: ref("WebhookRedeliveryResponse")
      })
    }
  };
}
