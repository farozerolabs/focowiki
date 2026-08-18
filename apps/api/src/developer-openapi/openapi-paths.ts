import {
  deliveryIdParameter,
  errorResponse,
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
import {
  createDeveloperOpenApiResponseExamples,
  okfMarkdownExamples,
  requestExamples
} from "./openapi-examples.js";
import { DEVELOPER_FILE_SEARCH_ERROR_CODES } from "./file-search-filters.js";
import { DEVELOPER_GRAPH_EXPANSION_ERROR_CODES } from
  "./graph-expansion-filters.js";

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
            openapi: {
              type: "string",
              description: "OpenAPI Specification version used by this contract."
            },
            info: {
              type: "object",
              additionalProperties: true,
              description: "Product, contract version, license, and purpose."
            },
            servers: {
              type: "array",
              items: { type: "object", additionalProperties: true },
              description: "Server base URLs declared by this contract."
            },
            security: {
              type: "array",
              items: { type: "object", additionalProperties: true },
              description: "Default authentication requirements."
            },
            tags: {
              type: "array",
              items: { type: "object", additionalProperties: true },
              description: "Operation groups exposed by this contract."
            },
            paths: {
              type: "object",
              additionalProperties: true,
              description: "Documented Developer OpenAPI paths and operations."
            },
            components: {
              type: "object",
              additionalProperties: true,
              description: "Reusable schemas and security definitions."
            }
          },
          ["openapi", "info", "servers", "security", "tags", "paths", "components"]
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
        successSchema: ref("KnowledgeBaseMutationResponse"),
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
        successSchema: ref("CreateUploadSessionResponse"),
        successExample: responseExamples.createUploadSession,
        additionalErrorStatuses: [404, 409, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/upload-sessions/{uploadSessionId}/entries": {
      post: operation({
        tag: "Upload Sessions",
        operationId: "addUploadManifestEntries",
        summary: "Add files to an upload session",
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
        summary: "Confirm the upload file list",
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
              examples: okfMarkdownExamples,
              schema: {
                type: "string",
                description: "Complete Markdown content for the selected upload entry."
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
            schema: { type: "string", enum: ["missing", "uploaded"] }
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
        tag: "Uploaded Files",
        operationId: "listKnowledgeBaseSourceFiles",
        summary: "List uploaded files",
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
        tag: "Uploaded Files",
        operationId: "getKnowledgeBaseSourceFile",
        summary: "Get uploaded file",
        parameters: [knowledgeBaseIdParameter(), sourceFileIdParameter()],
        requestExample: requestExamples.getKnowledgeBaseSourceFile,
        successStatus: 200,
        successSchema: ref("SourceResourceFileResponse"),
        successExample: responseExamples.getKnowledgeBaseSourceFile,
        additionalErrorStatuses: [404]
      }),
      patch: operation({
        tag: "Uploaded Files",
        operationId: "moveSourceFile",
        summary: "Rename or move an uploaded file",
        parameters: [
          knowledgeBaseIdParameter(),
          sourceFileIdParameter(),
          idempotencyKeyHeader(),
          expectedResourceRevisionHeader()
        ],
        requestSchema: ref("MoveSourceFileRequest"),
        requestExample: requestExamples.moveSourceFile,
        successStatus: 202,
        successSchema: ref("ResourceOperationResponse"),
        successExample: responseExamples.moveSourceFile,
        additionalErrorStatuses: [404, 409, 422]
      }),
      delete: operation({
        tag: "Uploaded Files",
        operationId: "deleteSourceFile",
        summary: "Delete an uploaded file",
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
        tag: "Uploaded Files",
        operationId: "getSourceFileContent",
        summary: "Read uploaded Markdown content",
        parameters: [knowledgeBaseIdParameter(), sourceFileIdParameter()],
        requestExample: requestExamples.getSourceFileContent,
        successStatus: 200,
        successSchema: { type: "string" },
        successExample: responseExamples.getSourceFileContent,
        successContentType: "text/markdown",
        additionalErrorStatuses: [404],
        extraResponses: {
          "200": {
            description: "Complete content of the uploaded Markdown file.",
            headers: {
              ETag: {
                description: "Current version number of the uploaded file.",
                schema: { type: "string" }
              },
              "X-Content-Revision": {
                description: "Current version number of the Markdown content.",
                schema: { type: "integer", minimum: 1 }
              }
            },
            content: {
              "text/markdown": {
                schema: { type: "string" },
                example: responseExamples.getSourceFileContent
              }
            }
          }
        }
      }),
      put: operation({
        tag: "Uploaded Files",
        operationId: "replaceSourceFileContent",
        summary: "Replace complete Markdown content and optionally move the uploaded file",
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
              "Optional new path when replacing and moving the file in one request. The destination directory must already exist.",
            schema: { type: "string", example: "handbook/setup/install.md" }
          }
        ],
        requestBody: {
          required: true,
          content: {
            "text/markdown": {
              schema: {
                type: "string",
                description: "Complete Markdown content that will replace the current file."
              },
              examples: okfMarkdownExamples
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
        tag: "Uploaded Directories",
        operationId: "listSourceDirectories",
        summary: "List uploaded directories",
        parameters: [
          knowledgeBaseIdParameter(),
          {
            name: "parentDirectoryId",
            in: "query",
            required: false,
            description: "Parent uploaded-directory ID. Omit it or use `root` to list top-level directories.",
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
        tag: "Uploaded Directories",
        operationId: "getSourceDirectory",
        summary: "Get an uploaded directory",
        parameters: [knowledgeBaseIdParameter(), sourceDirectoryIdParameter()],
        requestExample: requestExamples.getSourceDirectory,
        successStatus: 200,
        successSchema: ref("SourceDirectoryResponse"),
        successExample: responseExamples.getSourceDirectory,
        additionalErrorStatuses: [404]
      }),
      patch: operation({
        tag: "Uploaded Directories",
        operationId: "moveSourceDirectory",
        summary: "Rename or move an uploaded directory",
        parameters: [
          knowledgeBaseIdParameter(),
          sourceDirectoryIdParameter(),
          idempotencyKeyHeader(),
          expectedResourceRevisionHeader()
        ],
        requestSchema: ref("MoveSourceDirectoryRequest"),
        requestExample: requestExamples.moveSourceDirectory,
        successStatus: 202,
        successSchema: ref("ResourceOperationResponse"),
        successExample: responseExamples.moveSourceDirectory,
        additionalErrorStatuses: [404, 409, 422]
      }),
      delete: operation({
        tag: "Uploaded Directories",
        operationId: "deleteSourceDirectory",
        summary: "Delete an uploaded directory and its contents",
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
        tag: "File and Directory Changes",
        operationId: "listResourceOperations",
        summary: "List file and directory changes",
        parameters: [
          knowledgeBaseIdParameter(),
          {
            name: "state",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["processing", "completed", "failed", "cancelled", "superseded"] }
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
        tag: "File and Directory Changes",
        operationId: "getResourceOperation",
        summary: "Get a file or directory change",
        parameters: [knowledgeBaseIdParameter(), resourceOperationIdParameter()],
        requestExample: requestExamples.getResourceOperation,
        successStatus: 200,
        successSchema: ref("ResourceOperationResponse"),
        successExample: responseExamples.getResourceOperation,
        additionalErrorStatuses: [404]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/retry": {
      post: operation({
        tag: "Uploaded Files",
        operationId: "retryKnowledgeBaseSourceFile",
        summary: "Retry an uploaded file",
        parameters: [knowledgeBaseIdParameter(), sourceFileIdParameter()],
        requestExample: requestExamples.retryKnowledgeBaseSourceFile,
        successStatus: 202,
        successSchema: ref("SourceFileRetryResponse"),
        successExample: responseExamples.retryKnowledgeBaseSourceFile,
        additionalErrorStatuses: [404, 409]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/tree": {
      get: operation({
        tag: "Files",
        operationId: "listKnowledgeBaseTree",
        summary: "List readable file tree entries",
        parameters: [
          knowledgeBaseIdParameter(),
          {
            name: "parentPath",
            in: "query",
            required: false,
            description: "Directory path to browse, or \`root\` for the bundle root. Parent traversal, file paths, and storage paths are rejected.",
            schema: { type: "string", default: "root" }
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
        additionalErrorStatuses: [404, 422]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/content": {
      get: operation({
        tag: "Files",
        operationId: "getFileContentByPath",
        summary: "Read a readable file by path",
        parameters: [knowledgeBaseIdParameter(), filePathQueryParameter(true)],
        requestExample: requestExamples.getFileContentByPath,
        successStatus: 200,
        successSchema: ref("FileContentResponse"),
        successExample: responseExamples.getFileContentByPath,
        additionalErrorStatuses: [404, 422],
        extraResponses: {
          "413": generatedContentTooLargeResponse()
        }
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/search": {
      get: {
        ...operation({
          tag: "Files",
          operationId: "searchGeneratedFiles",
          summary: "Search knowledge-base files",
          description: "Search active source Markdown files with one standalone natural-language question. Omitted mode uses hybrid retrieval. Optional request-scoped reranking refines authorized candidates and safely falls back when unavailable. Every result remains a source-file candidate with read actions; read the Markdown before using its content as evidence.",
          parameters: [knowledgeBaseIdParameter(), ...fileSearchParameters()],
          requestExample: requestExamples.searchGeneratedFiles,
          successStatus: 200,
          successSchema: ref("FileSearchResponse"),
          successExample: responseExamples.searchGeneratedFiles,
          additionalErrorStatuses: [404, 422],
          extraResponses: {
            "503": {
              ...errorResponse(
                "The required data or search service is temporarily unavailable or overloaded. Retry after the service recovers.",
                "SEARCH_UNAVAILABLE",
                503
              ),
              "x-error-codes": [
                "DATABASE_REPOSITORY_UNAVAILABLE",
                "SEARCH_UNAVAILABLE",
                "SEARCH_OVERLOADED"
              ]
            },
            "504": errorResponse(
              "Search exceeded the configured response deadline.",
              "SEARCH_TIMEOUT",
              504
            )
          }
        }),
        "x-validation-detail-codes": [...DEVELOPER_FILE_SEARCH_ERROR_CODES]
      }
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/graph/expand": {
      get: {
        ...operation({
          tag: "Files",
          operationId: "expandGraph",
          summary: "Explore related files",
          description:
            "Start from a readable file ID returned by tree, search, file, or related-file operations. The response returns related files up to the requested depth and result limits, with paths for reading the complete files.",
          parameters: [
          knowledgeBaseIdParameter(),
          {
            name: "fileId",
            in: "query",
            required: true,
            description: "Readable file ID returned by tree, search, file, or related-file operations.",
            schema: { type: "string", minLength: 1 }
          },
          {
            name: "depth",
            in: "query",
            required: false,
            description: "Number of relationship levels to explore.",
            schema: { type: "integer", enum: [0, 1, 2] }
          },
          {
            name: "fanout",
            in: "query",
            required: false,
            description: "Maximum related files returned for each explored file. When omitted, the deployment setting is used.",
            schema: { type: "integer", minimum: 0 }
          },
            ...paginationParameters()
          ],
          requestExample: requestExamples.expandGraph,
          successStatus: 200,
          successSchema: ref("GraphExpansionResponse"),
          successExample: responseExamples.expandGraph,
          additionalErrorStatuses: [404, 422]
        }),
        "x-validation-detail-codes": [...DEVELOPER_GRAPH_EXPANSION_ERROR_CODES]
      }
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/graph/overview": {
      get: operation({
        tag: "Files",
        operationId: "getGraphOverview",
        summary: "Get file relationship overview",
        parameters: [knowledgeBaseIdParameter()],
        requestExample: requestExamples.getGraphOverview,
        successStatus: 200,
        successSchema: ref("GraphOverviewResponse"),
        successExample: responseExamples.getGraphOverview,
        additionalErrorStatuses: [404]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/{fileId}": {
      get: operation({
        tag: "Files",
        operationId: "getFileById",
        summary: "Get readable file metadata",
        parameters: [knowledgeBaseIdParameter(), fileIdParameter()],
        requestExample: requestExamples.getFileById,
        successStatus: 200,
        successSchema: ref("FileDetailResponse"),
        successExample: responseExamples.getFileById,
        additionalErrorStatuses: [404]
      })
    },
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/{fileId}/content": {
      get: operation({
        tag: "Files",
        operationId: "getFileContentById",
        summary: "Read a readable file by ID",
        parameters: [knowledgeBaseIdParameter(), fileIdParameter()],
        requestExample: requestExamples.getFileContentById,
        successStatus: 200,
        successSchema: ref("FileContentResponse"),
        successExample: responseExamples.getFileContentById,
        additionalErrorStatuses: [404],
        extraResponses: {
          "413": generatedContentTooLargeResponse()
        }
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
        parameters: [idempotencyKeyHeader()],
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
        parameters: [
          {
            name: "webhookId",
            in: "query",
            required: false,
            description: "Webhook identifier returned by create or list operations.",
            schema: { type: "string" }
          },
          ...paginationParameters()
        ],
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

function generatedContentTooLargeResponse() {
  return errorResponse(
    "The readable file exceeds the configured content read limit.",
    "PAYLOAD_TOO_LARGE",
    413
  );
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
    description: "Client-generated key for safely retrying the same request. Reuse the same value for retries so duplicate work is not created.",
    schema: { type: "string", example: "mutation-2026-07-10-001" }
  };
}

function expectedResourceRevisionHeader() {
  return {
    name: "If-Match",
    in: "header",
    required: true,
    description: "Current `resourceRevision` returned by the API. If the resource changed after it was read, the request returns a conflict instead of overwriting the newer change.",
    schema: { type: "string", example: '"1"' }
  };
}

function sourceDirectoryIdParameter() {
  return {
    name: "directoryId",
    in: "path",
    required: true,
    description: "Uploaded-directory identifier returned by directory or tree APIs.",
    schema: { type: "string", example: "source-directory-123" }
  };
}

function resourceOperationIdParameter() {
  return {
    name: "operationId",
    in: "path",
    required: true,
    description: "Change identifier returned by file and directory move, replace, or delete requests.",
    schema: { type: "string", example: "source-move-123" }
  };
}
