export function createDeveloperOpenApiFieldContinuity(): Record<string, string[]> {
  return {
    knowledgeBaseId: [
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}",
      "DELETE /openapi/v1/knowledge-bases/{knowledgeBaseId}",
      "POST /openapi/v1/knowledge-bases/{knowledgeBaseId}/uploads",
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files",
      "POST /openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/task-deletions",
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/tree",
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/search",
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/content",
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/related"
    ],
    sourceFileId: [
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}",
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/events",
      "POST /openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/retry",
      "POST /openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/task-deletions"
    ],
    fileId: [
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}",
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/content",
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/related",
      "DELETE /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}"
    ],
    generatedFileId: [
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}",
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/content",
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/related",
      "DELETE /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}"
    ],
    webhookId: ["DELETE /openapi/v1/webhooks/{webhookId}"],
    deliveryId: ["POST /openapi/v1/webhook-deliveries/{deliveryId}/redeliver"],
    cursor: [
      "GET /openapi/v1/knowledge-bases",
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files",
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/events",
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/tree",
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/related",
      "GET /openapi/v1/webhooks",
      "GET /openapi/v1/webhook-deliveries"
    ],
    path: [
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/content",
      "DELETE /openapi/v1/knowledge-bases/{knowledgeBaseId}/files"
    ],
    generatedFilePath: [
      "GET /openapi/v1/knowledge-bases/{knowledgeBaseId}/files/content",
      "DELETE /openapi/v1/knowledge-bases/{knowledgeBaseId}/files"
    ]
  };
}
