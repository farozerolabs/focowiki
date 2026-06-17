const exampleTimestamp = "2026-06-17T00:00:00.000Z";
const knowledgeBaseId = "kb_123";
const taskId = "task_123";
const deletionTaskId = "task_delete_123";
const sourceFileId = "file_source_123";
const bundleFileId = "file_page_123";
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

const progress = {
  total: 2,
  completed: 1,
  failed: 0,
  running: 1,
  pending: 0,
  currentStage: "okf_validation"
};

const task = {
  taskId,
  knowledgeBaseId,
  operation: "upload",
  lifecycle: "running",
  startedAt: exampleTimestamp,
  endedAt: null,
  sourceCount: 2,
  progress,
  resultReleaseId: null,
  errorCode: null
};

const sourceFile = {
  fileId: sourceFileId,
  knowledgeBaseId,
  taskId,
  originalFilename: "guide.md",
  contentType: "text/markdown; charset=utf-8",
  sizeBytes: 1024,
  checksumSha256: "sha256_example",
  metadata: {
    title: "Guide"
  },
  processingState: "completed",
  currentStage: "release_activation",
  processingStartedAt: exampleTimestamp,
  processingEndedAt: exampleTimestamp,
  processingErrorCode: null,
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

const treeEntry = {
  id: "tree_123",
  fileId: bundleFileId,
  sourceFileId,
  parentPath: "pages",
  name: "guide.md",
  path: "pages/guide.md",
  entryType: "file",
  fileKind: "page",
  deletable: true
};

const webhook = {
  webhookId,
  name: "Task updates",
  endpointHost: "hooks.example.com",
  events: ["task.ended"],
  enabled: true,
  createdAt: exampleTimestamp,
  updatedAt: exampleTimestamp,
  lastDeliveryAt: null
};

const delivery = {
  deliveryId,
  webhookId,
  eventId: "event_123",
  eventType: "task.ended",
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
  listKnowledgeBaseTasks: {
    path: { knowledgeBaseId },
    query: { limit: 50 }
  },
  getKnowledgeBaseTask: {
    path: { knowledgeBaseId, taskId },
    query: { limit: 50 }
  },
  listKnowledgeBaseTree: {
    path: { knowledgeBaseId },
    query: { parentPath: "pages", limit: 50 }
  },
  getFileContentByPath: {
    path: { knowledgeBaseId },
    query: { path: "pages/guide.md" }
  },
  getFileById: {
    path: { knowledgeBaseId, fileId: bundleFileId }
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
      name: "Task updates",
      url: "https://hooks.example.com/focowiki",
      events: ["task.ended"]
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

export const responseExamples = {
  getDeveloperOpenApiHealth: {
    status: "ok"
  },
  getDeveloperOpenApiVersion: {
    product: "focowiki",
    version: "0.1.0",
    apiVersion: "v1"
  },
  getDeveloperOpenApiContract: {
    openapi: "3.1.0",
    info: {
      title: "Focowiki Developer OpenAPI",
      version: "0.1.0"
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
    taskId,
    files: [
      {
        fileId: sourceFileId,
        originalFilename: "guide.md",
        sizeBytes: 1024
      },
      {
        fileId: "file_source_456",
        originalFilename: "faq.md",
        sizeBytes: 2048
      }
    ]
  },
  listKnowledgeBaseTasks: {
    items: [task],
    nextCursor: null
  },
  getKnowledgeBaseTask: {
    task,
    files: {
      items: [sourceFile],
      nextCursor: null
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
  deleteFileById: {
    knowledgeBaseId,
    taskId: deletionTaskId,
    file: bundleFile
  },
  getFileContentById: {
    file: bundleFile,
    content: "---\ntype: page\ntitle: Guide\n---\n# Guide\n\nContent."
  },
  deleteFileByPath: {
    knowledgeBaseId,
    taskId: deletionTaskId,
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

export type DeveloperOpenApiOperationId = keyof typeof requestExamples & keyof typeof responseExamples;
