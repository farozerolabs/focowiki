import { apiVersion, readProductReleaseVersion } from "../release-version.js";

const exampleTimestamp = "2026-06-17T00:00:00.000Z";
const knowledgeBaseId = "kb_123";
const sourceFileId = "source-file-11111111-1111-4111-8111-111111111111";
const bundleFileId = "bundle-file-11111111-1111-4111-8111-111111111111";
const webhookId = "webhook_123";
const deliveryId = "delivery_123";
const cursor = "cursor_123";

const knowledgeBase = {
  knowledgeBaseId,
  name: "Product Docs",
  description: "Product documentation",
  activeReleaseId: "release_123",
  createdAt: exampleTimestamp,
  updatedAt: exampleTimestamp
};

const sourceFile = {
  fileId: sourceFileId,
  knowledgeBaseId,
  originalFilename: "guide.md",
  contentType: "text/markdown; charset=utf-8",
  sizeBytes: 1024,
  checksumSha256: "sha256_example",
  metadata: {
    title: "Guide"
  },
  modelSuggestions: {
    title: "Guide",
    type: "guide",
    description: "A short guide for product documentation.",
    tags: ["guide", "documentation"],
    related_links: [
      {
        path: "pages/reference.md",
        title: "Reference"
      }
    ],
    keywords: ["guide", "product documentation"]
  },
  processingState: "completed",
  currentStage: "release_activation",
  processingStartedAt: exampleTimestamp,
  processingEndedAt: exampleTimestamp,
  processingErrorCode: null,
  processingErrorMessage: null,
  retryCount: 0,
  modelInvocationStatus: "completed",
  modelInvocationModelName: "gpt-5-mini",
  modelInvocationStartedAt: exampleTimestamp,
  modelInvocationEndedAt: exampleTimestamp,
  modelInvocationWarningCount: 0,
  modelInvocationErrorCode: null,
  generatedOutputStatus: "visible",
  generatedFileAvailable: true,
  generatedFileId: bundleFileId,
  generatedFilePath: "pages/guide.md",
  createdAt: exampleTimestamp
};

const sourceFileEvent = {
  eventId: "event_123",
  knowledgeBaseId,
  fileId: sourceFileId,
  stageKey: "metadata_resolution",
  messageKey: "sourceFiles.phase.metadataResolution",
  startedAt: exampleTimestamp,
  endedAt: exampleTimestamp,
  severity: "info",
  createdAt: exampleTimestamp
};

const bundleFile = {
  fileId: bundleFileId,
  knowledgeBaseId,
  sourceFileId,
  path: "pages/guide.md",
  originalFilename: "guide.md",
  fileKind: "page",
  contentType: "text/markdown; charset=utf-8",
  sizeBytes: 2048,
  checksumSha256: "sha256_example",
  okfType: "page",
  title: "Guide",
  description: "Short summary.",
  tags: ["guide"],
  frontmatter: {
    type: "page",
    title: "Guide"
  },
  deletable: true,
  contentAvailable: true
};

const relatedFile = {
  fileId: "file_source_456",
  sourceFileId: "file_source_456",
  bundleFileId: "file_page_456",
  path: "pages/reference.md",
  title: "Reference",
  relationType: "shared_subject",
  direction: "outgoing",
  weight: 0.72,
  reason: "Both files share body-derived subjects.",
  source: "deterministic",
  evidence: {
    subjects: ["integration", "configuration"]
  },
  contentAvailable: true
};

const treeEntry = {
  id: "tree_123",
  fileId: bundleFileId,
  sourceFileId,
  parentPath: "pages",
  name: "guide.md",
  path: "pages/guide.md",
  sortKey: "1:guide.md",
  entryType: "file",
  fileKind: "page",
  childCount: 0,
  deletable: true
};

const webhook = {
  webhookId,
  name: "Source file updates",
  endpointHost: "hooks.example.com",
  events: ["source_file.completed", "source_file.failed", "release.published"],
  enabled: true,
  createdAt: exampleTimestamp,
  updatedAt: exampleTimestamp,
  lastDeliveryAt: null
};

const delivery = {
  deliveryId,
  webhookId,
  eventId: "event_123",
  eventType: "source_file.completed",
  status: "success",
  attemptCount: 1,
  httpStatus: 200,
  errorCode: null,
  createdAt: exampleTimestamp,
  updatedAt: exampleTimestamp
};

export const requestExamples = {
  getDeveloperOpenApiHealth: {},
  getDeveloperOpenApiVersion: {},
  getDeveloperOpenApiContract: {},
  listKnowledgeBases: {
    query: { limit: 50 }
  },
  createKnowledgeBase: {
    body: {
      name: "Product Docs",
      description: "Product documentation"
    }
  },
  getKnowledgeBase: {
    path: { knowledgeBaseId }
  },
  deleteKnowledgeBase: {
    path: { knowledgeBaseId }
  },
  uploadMarkdownFiles: {
    path: { knowledgeBaseId },
    body: {
      files: ["guide.md", "faq.md"]
    }
  },
  listKnowledgeBaseSourceFiles: {
    path: { knowledgeBaseId },
    query: {
      limit: 50,
      processingStatus: "completed",
      generatedOutputStatus: "visible",
      fileNameQuery: "guide"
    }
  },
  getKnowledgeBaseSourceFile: {
    path: { knowledgeBaseId, sourceFileId }
  },
  listKnowledgeBaseSourceFileEvents: {
    path: { knowledgeBaseId, sourceFileId },
    query: { limit: 50 }
  },
  retryKnowledgeBaseSourceFile: {
    path: { knowledgeBaseId, sourceFileId }
  },
  deleteKnowledgeBaseSourceFileTasks: {
    path: { knowledgeBaseId },
    body: {
      sourceFileIds: [sourceFileId, "source-file-22222222-2222-4222-8222-222222222222"]
    }
  },
  listKnowledgeBaseTree: {
    path: { knowledgeBaseId },
    query: { parentPath: "pages", entryType: "file", limit: 50 }
  },
  getFileContentByPath: {
    path: { knowledgeBaseId },
    query: { path: "pages/guide.md" }
  },
  getFileById: {
    path: { knowledgeBaseId, fileId: bundleFileId }
  },
  listRelatedFiles: {
    path: { knowledgeBaseId, fileId: bundleFileId },
    query: { limit: 50 }
  },
  deleteFileById: {
    path: { knowledgeBaseId, fileId: bundleFileId }
  },
  getFileContentById: {
    path: { knowledgeBaseId, fileId: bundleFileId }
  },
  deleteFileByPath: {
    path: { knowledgeBaseId },
    query: { path: "pages/guide.md" }
  },
  createWebhook: {
    body: {
      name: "Source file updates",
      url: "https://hooks.example.com/focowiki",
      events: ["source_file.completed", "source_file.failed", "release.published"]
    }
  },
  listWebhooks: {
    query: { limit: 50 }
  },
  deleteWebhook: {
    path: { webhookId }
  },
  listWebhookDeliveries: {
    query: { limit: 50 }
  },
  redeliverWebhook: {
    path: { deliveryId }
  }
} as const;

export function createDeveloperOpenApiResponseExamples() {
  const productVersion = readProductReleaseVersion();

  return {
    getDeveloperOpenApiHealth: {
      status: "ok"
    },
    getDeveloperOpenApiVersion: {
      product: "focowiki",
      version: productVersion,
      apiVersion
    },
    getDeveloperOpenApiContract: {
      openapi: "3.1.0",
      info: {
        title: "Focowiki Developer OpenAPI",
        version: productVersion
      },
      paths: {
        "/openapi/v1/knowledge-bases": {
          get: {
            operationId: "listKnowledgeBases",
            summary: "List knowledge bases"
          },
          post: {
            operationId: "createKnowledgeBase",
            summary: "Create a knowledge base"
          }
        }
      }
    },
    listKnowledgeBases: {
      items: [knowledgeBase],
      nextCursor: null
    },
    createKnowledgeBase: {
      knowledgeBase
    },
    getKnowledgeBase: {
      knowledgeBase
    },
    deleteKnowledgeBase: {
      deleted: true,
      knowledgeBaseId
    },
    uploadMarkdownFiles: {
      knowledgeBaseId,
      files: [
        {
          fileId: sourceFileId,
          originalFilename: "guide.md",
          sizeBytes: 1024,
          processingState: "queued",
          currentStage: "upload_storage"
        },
        {
          fileId: "file_source_456",
          originalFilename: "faq.md",
          sizeBytes: 2048,
          processingState: "queued",
          currentStage: "upload_storage"
        }
      ]
    },
    listKnowledgeBaseSourceFiles: {
      items: [sourceFile],
      nextCursor: null
    },
    getKnowledgeBaseSourceFile: {
      file: sourceFile
    },
    listKnowledgeBaseSourceFileEvents: {
      items: [sourceFileEvent],
      nextCursor: null
    },
    retryKnowledgeBaseSourceFile: {
      file: {
        ...sourceFile,
        processingState: "queued",
        currentStage: "upload_storage",
        processingStartedAt: exampleTimestamp,
        processingEndedAt: null,
        retryCount: 1
      }
    },
    deleteKnowledgeBaseSourceFileTasks: {
      results: [
        {
          sourceFileId,
          result: "hidden",
          generatedFileId: bundleFileId,
          generatedFilePath: "pages/guide.md"
        },
        {
          sourceFileId: "source-file-22222222-2222-4222-8222-222222222222",
          result: "skipped",
          reason: "missing"
        }
      ],
      summary: {
        deleted: 0,
        hidden: 1,
        skipped: 1
      }
    },
    listKnowledgeBaseTree: {
      items: [treeEntry],
      nextCursor: null
    },
    getFileContentByPath: {
      file: bundleFile,
      content: "---\ntype: page\ntitle: Guide\n---\n# Guide\n\nContent."
    },
    getFileById: {
      file: bundleFile
    },
    listRelatedFiles: {
      fileId: bundleFileId,
      sourceFileId,
      items: [relatedFile],
      nextCursor: null
    },
    deleteFileById: {
      knowledgeBaseId,
      deleted: true,
      publicationQueued: true,
      file: bundleFile
    },
    getFileContentById: {
      file: bundleFile,
      content: "---\ntype: page\ntitle: Guide\n---\n# Guide\n\nContent."
    },
    deleteFileByPath: {
      knowledgeBaseId,
      deleted: true,
      publicationQueued: true,
      file: bundleFile
    },
    createWebhook: {
      webhook,
      signingSecret: "<webhook-signing-secret>"
    },
    listWebhooks: {
      items: [webhook],
      nextCursor: null
    },
    deleteWebhook: {
      deleted: true,
      webhookId
    },
    listWebhookDeliveries: {
      items: [delivery],
      nextCursor: null
    },
    redeliverWebhook: {
      delivery
    }
  } as const;
}

export function errorExample(code: string, httpStatus: number, message: string) {
  return {
    error: {
      code,
      message,
      httpStatus
    },
    requestId: "req_123"
  };
}

export function payloadTooLargeExample() {
  return errorExample("PAYLOAD_TOO_LARGE", 413, "Uploaded files exceed configured limits.");
}

export type DeveloperOpenApiOperationId = keyof typeof requestExamples &
  keyof ReturnType<typeof createDeveloperOpenApiResponseExamples>;
