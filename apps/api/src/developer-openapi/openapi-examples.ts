import { apiVersion, readProductReleaseVersion } from "../release-version.js";

const exampleTimestamp = "2026-06-17T00:00:00.000Z";
const knowledgeBaseId = "kb-11111111-1111-4111-8111-111111111111";
const sourceFileId = "source-file-11111111-1111-4111-8111-111111111111";
const bundleFileId = "bundle-file-11111111-1111-4111-8111-111111111111";
const webhookId = "webhook-11111111-1111-4111-8111-111111111111";
const deliveryId = "delivery-11111111-1111-4111-8111-111111111111";
const knowledgeBase = {
  knowledgeBaseId,
  name: "Product Docs",
  description: "Product documentation",
  activeReleaseId: "release-11111111-1111-4111-8111-111111111111",
  resourceRevision: 1,
  catalogGeneration: 1,
  createdAt: exampleTimestamp,
  updatedAt: exampleTimestamp
};

const uploadSessionCounts = {
  selected: 2,
  uploadRequired: 1,
  skippedExisting: 1,
  waitingReservation: 0,
  rejectedDeleting: 0,
  uploaded: 1,
  failed: 0,
  finalized: 1
};

const uploadSession = {
  id: "upload-session-11111111-1111-4111-8111-111111111111",
  knowledgeBaseId,
  state: "completed",
  declaredFileCount: 2,
  declaredByteCount: 4096,
  counts: uploadSessionCounts,
  errorCode: null,
  expiresAt: "2026-06-18T00:00:00.000Z",
  completedAt: exampleTimestamp,
  createdAt: exampleTimestamp,
  updatedAt: exampleTimestamp
};

const uploadSessionLimits = {
  manifestPageSize: 500,
  contentBatchMaxFiles: 24,
  contentBatchMaxBytes: 16_777_216,
  maxFileBytes: 1_048_576
};

const uploadSessionEntry = {
  id: "upload-entry-11111111-1111-4111-8111-111111111111",
  relativePath: "handbook/onboarding/guide.md",
  directoryPath: "handbook/onboarding",
  name: "guide.md",
  declaredSize: 2048,
  receivedSize: 2048,
  checksumSha256: "0".repeat(64),
  disposition: "upload_required",
  transferState: "uploaded",
  sourceDirectoryId: "source-directory-11111111-1111-4111-8111-111111111111",
  sourceFileId,
  existingResourceRevision: null,
  generatedPath: "pages/handbook/onboarding/guide.md",
  errorCode: null
};

const sourceDirectory = {
  directoryId: "source-directory-11111111-1111-4111-8111-111111111111",
  knowledgeBaseId,
  parentDirectoryId: "source-directory-handbook",
  name: "onboarding",
  relativePath: "handbook/onboarding",
  generatedPath: "pages/handbook/onboarding",
  depth: 2,
  resourceRevision: 1,
  directFileCount: 1,
  descendantFileCount: 1,
  mutable: true,
  deletable: true,
  deleting: false,
  actions: {
    self: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/source-directories/source-directory-11111111-1111-4111-8111-111111111111`,
    children: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/source-directories?parentDirectoryId=source-directory-11111111-1111-4111-8111-111111111111`,
    sourceFiles: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/source-files?directoryId=source-directory-11111111-1111-4111-8111-111111111111`,
    generatedTree: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/tree?parentPath=pages%2Fhandbook%2Fonboarding`
  },
  createdAt: exampleTimestamp,
  updatedAt: exampleTimestamp
};

const sourceMoveOperation = {
  operationId: "resource-operation-11111111-1111-4111-8111-111111111111",
  knowledgeBaseId,
  kind: "source_file_move",
  state: "accepted",
  expectedResourceRevision: 1,
  targetKind: "source_file",
  targetId: sourceFileId,
  candidateRelativePath: "handbook/getting-started.md",
  result: null,
  errorCode: null,
  retryGuidance: "Read the operation again after a short delay.",
  actions: {
    self: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/operations/resource-operation-11111111-1111-4111-8111-111111111111`
  },
  createdAt: exampleTimestamp,
  updatedAt: exampleTimestamp,
  completedAt: null
};

const sourceResourceFile = {
  sourceFileId,
  knowledgeBaseId,
  directoryId: "source-directory-11111111-1111-4111-8111-111111111111",
  name: "guide.md",
  relativePath: "handbook/guide.md",
  generatedPath: "pages/handbook/guide.md",
  contentType: "text/markdown; charset=utf-8",
  sizeBytes: 1024,
  checksumSha256: "sha256_example",
  resourceRevision: 1,
  contentRevision: 1,
  activeRevisionId: "source-revision-11111111-1111-4111-8111-111111111111",
  processingState: "completed",
  currentStage: "release_activation",
  processingErrorCode: null,
  generatedOutputStatus: "visible",
  mutable: true,
  deletable: true,
  deleting: false,
  actions: {
    self: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/source-files/${sourceFileId}`,
    events: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/source-files/${sourceFileId}/events`,
    retry: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/source-files/${sourceFileId}/retry`,
    generatedContent: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/content?path=pages%2Fhandbook%2Fguide.md`,
    search: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/search?query=guide.md`
  },
  createdAt: exampleTimestamp
};

const sourceFileEvent = {
  eventId: "source-event-11111111-1111-4111-8111-111111111111",
  knowledgeBaseId,
  sourceFileId,
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
  sourceName: "guide.md",
  sourceRelativePath: "guide.md",
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

const fileSearchResult = {
  fileId: bundleFileId,
  generatedFileId: bundleFileId,
  knowledgeBaseId,
  releaseId: "release-11111111-1111-4111-8111-111111111111",
  sourceFileId,
  path: "pages/guide.md",
  generatedFilePath: "pages/guide.md",
  fileKind: "page",
  title: "Guide",
  description: "Short summary.",
  tags: ["guide"],
  frontmatter: {
    type: "page",
    title: "Guide"
  },
  matchedFields: ["path", "title"],
  score: 9,
  contentAvailable: true,
  readActions: {
    fileDetailById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/${bundleFileId}`,
    fileContentById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/${bundleFileId}/content`,
    fileContentByPath: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/content?path=pages%2Fguide.md`,
    relatedFilesById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/${bundleFileId}/related`,
    graphExpansionByFileId: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/expand?fileId=${bundleFileId}`,
    sourceFileStatusById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/source-files/${sourceFileId}`,
    sourceFileEventsById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/source-files/${sourceFileId}/events`
  }
};

const fileSearchQueryContext = {
  query: "guide",
  normalizedQuery: "guide",
  scope: "all",
  fileKind: "page",
  mode: "hybrid",
  graphDepth: 1,
  graphFanout: 10,
  limit: 10,
  cursorProvided: false
};

const fileSearchGraphSummary = {
  available: true,
  indexedDocumentCount: 24,
  indexedRelationshipCount: 86,
  depth: 1,
  fanout: 10
};

const fileSearchResultSummary = {
  resultCount: 1,
  hasMore: false,
  sort: ["score desc", "path asc", "fileId asc"],
  meaning: "Candidates matched the query. Read candidate content and related files before answering."
};

const fileSearchNextRequestTemplates = {
  searchAgain: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/search?query={query}`,
  listTree: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/tree?parentPath={parentPath}`,
  readIndex: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/content?path=index.md`,
  fileDetailById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/{generatedFileId}`,
  fileContentById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/{generatedFileId}/content`,
  fileContentByPath: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/content?path={generatedFilePath}`,
  relatedFilesById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/{generatedFileId}/related`,
  graphExpansionByFileId: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/expand?fileId={generatedFileId}`,
  sourceFileStatusById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/source-files/{sourceFileId}`,
  sourceFileEventsById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/source-files/{sourceFileId}/events`
};

const relatedFile = {
  fileId: "bundle-file-22222222-2222-4222-8222-222222222222",
  sourceFileId: "source-file-22222222-2222-4222-8222-222222222222",
  bundleFileId: "bundle-file-22222222-2222-4222-8222-222222222222",
  path: "pages/reference.md",
  title: "Reference",
  relationType: "same_specific_subject",
  direction: "outgoing",
  weight: 0.72,
  reason: "Both files share body-derived subjects.",
  source: "deterministic",
  evidence: {
    subjects: ["integration", "configuration"]
  },
  contentAvailable: true,
  readActions: {
    fileDetailById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/bundle-file-22222222-2222-4222-8222-222222222222`,
    fileContentById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/bundle-file-22222222-2222-4222-8222-222222222222/content`,
    fileContentByPath: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/content?path=pages%2Freference.md`,
    relatedFilesById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/bundle-file-22222222-2222-4222-8222-222222222222/related`,
    graphExpansionByFileId: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/expand?fileId=bundle-file-22222222-2222-4222-8222-222222222222`,
    sourceFileStatusById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/source-files/source-file-22222222-2222-4222-8222-222222222222`,
    sourceFileEventsById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/source-files/source-file-22222222-2222-4222-8222-222222222222/events`
  }
};

const graphExpansion = {
  query: {
    fileId: bundleFileId,
    nodeId: null,
    edgeId: null,
    query: null,
    normalizedQuery: null,
    depth: 1,
    fanout: 10,
    limit: 10,
    cursorProvided: false
  },
  seedFile: bundleFile,
  seedResults: [],
  relationships: [relatedFile],
  graphPaths: [
    `_graph/by-file/${sourceFileId}.json`,
    "_graph/by-file/source-file-22222222-2222-4222-8222-222222222222.json"
  ],
  nextCursor: null,
  resultSummary: {
    seedCount: 1,
    relationshipCount: 1,
    hasMore: false,
    depth: 1,
    fanout: 10,
    meaning: "Graph expansion returned related files. Read file content before answering."
  },
  nextActions: [
    "Read candidate file content before answering.",
    "Continue with related-file reads when more evidence is needed.",
    "Use graph search when this expansion does not provide enough evidence."
  ]
};

const graphInsights = {
  file: {
    ...bundleFile,
    fileId: "bundle-file-graph-insights",
    sourceFileId: null,
    path: "_graph/insights.json",
    sourceName: null,
    sourceRelativePath: null,
    fileKind: "graph_insight",
    title: "Graph insights",
    description: "Graph quality and navigation insights.",
    tags: [],
    frontmatter: {},
    deletable: false
  },
  contentPath: "_graph/insights.json",
  insights: [
    {
      insightId: "insight-11111111-1111-4111-8111-111111111111",
      severity: "info",
      title: "Strong relationship cluster",
      description: "Several files share content-backed relationships.",
      filePaths: ["pages/guide.md", "pages/reference.md"]
    }
  ],
  generatedAt: exampleTimestamp,
  resultSummary: {
    insightCount: 1,
    meaning: "Graph insights can guide further file and graph exploration."
  },
  readActions: {
    graphIndex: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/content?path=_graph%2Findex.md`,
    graphManifest: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/content?path=_graph%2Fmanifest.json`,
    graphInsightsFile: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/content?path=_graph%2Finsights.json`,
    graphInsightsContent: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/content?path=_graph%2Finsights.json`
  },
  nextActions: [
    "Read _graph/index.md to understand available graph files.",
    "Read _graph/manifest.json for graph shard paths.",
    "Use graph expansion or file search before answering from insights alone."
  ]
};

const treeEntry = {
  id: "tree-file-11111111111111111111111111111111",
  fileId: bundleFileId,
  sourceFileId,
  parentPath: "pages",
  name: "guide.md",
  path: "pages/guide.md",
  sortKey: "1:guide.md",
  entryType: "file",
  fileKind: "page",
  childCount: 0,
  deletable: true,
  contentAvailable: true,
  readActions: {
    fileDetailById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/${bundleFileId}`,
    fileContentById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/${bundleFileId}/content`,
    fileContentByPath: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/content?path=pages%2Fguide.md`,
    relatedFilesById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/files/${bundleFileId}/related`,
    graphExpansionByFileId: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/graph/expand?fileId=${bundleFileId}`,
    sourceFileStatusById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/source-files/${sourceFileId}`,
    sourceFileEventsById: `/openapi/v2/knowledge-bases/${knowledgeBaseId}/source-files/${sourceFileId}/events`
  }
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
  eventId: "event-11111111-1111-4111-8111-111111111111",
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
  updateKnowledgeBase: {
    path: { knowledgeBaseId },
    body: { name: "Product handbook", description: "Current product guidance." }
  },
  deleteKnowledgeBase: {
    path: { knowledgeBaseId }
  },
  createUploadSession: {
    path: { knowledgeBaseId },
    body: { declaredFileCount: 2, declaredByteCount: 4096 }
  },
  addUploadManifestEntries: {
    path: { knowledgeBaseId, uploadSessionId: uploadSession.id },
    body: {
      entries: [{ relativePath: uploadSessionEntry.relativePath, declaredSize: 2048, checksumSha256: "0".repeat(64) }]
    }
  },
  sealUploadManifest: { path: { knowledgeBaseId, uploadSessionId: uploadSession.id } },
  uploadSessionContentBatch: {
    path: { knowledgeBaseId, uploadSessionId: uploadSession.id },
    body: { [uploadSessionEntry.id]: "guide.md" }
  },
  getUploadSession: { path: { knowledgeBaseId, uploadSessionId: uploadSession.id }, query: { limit: 50 } },
  reconcileUploadSession: { path: { knowledgeBaseId, uploadSessionId: uploadSession.id } },
  finalizeUploadSession: { path: { knowledgeBaseId, uploadSessionId: uploadSession.id } },
  cancelUploadSession: { path: { knowledgeBaseId, uploadSessionId: uploadSession.id } },
  moveSourceFile: { path: { knowledgeBaseId, sourceFileId }, body: { relativePath: "handbook/setup/install.md" } },
  deleteSourceFile: { path: { knowledgeBaseId, sourceFileId } },
  getSourceFileContent: { path: { knowledgeBaseId, sourceFileId } },
  replaceSourceFileContent: { path: { knowledgeBaseId, sourceFileId }, body: "# Installation\n\nCurrent installation guidance." },
  listSourceDirectories: { path: { knowledgeBaseId }, query: { parentDirectoryId: "source-directory-handbook", limit: 50 } },
  getSourceDirectory: { path: { knowledgeBaseId, directoryId: sourceDirectory.directoryId } },
  moveSourceDirectory: { path: { knowledgeBaseId, directoryId: sourceDirectory.directoryId }, body: { relativePath: "handbook/archive" } },
  deleteSourceDirectory: { path: { knowledgeBaseId, directoryId: sourceDirectory.directoryId } },
  listResourceOperations: { path: { knowledgeBaseId }, query: { limit: 50 } },
  getResourceOperation: { path: { knowledgeBaseId, operationId: sourceMoveOperation.operationId } },
  listKnowledgeBaseSourceFiles: {
    path: { knowledgeBaseId },
    query: {
      limit: 50,
      directoryId: "source-directory-handbook"
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
  listKnowledgeBaseTree: {
    path: { knowledgeBaseId },
    query: { parentPath: "pages", entryType: "file", limit: 50 }
  },
  getFileContentByPath: {
    path: { knowledgeBaseId },
    query: { path: "pages/guide.md" }
  },
  searchGeneratedFiles: {
    path: { knowledgeBaseId },
    query: {
      query: "guide",
      scope: "all",
      fileKind: "page",
      mode: "hybrid",
      graphDepth: 1,
      graphFanout: 10,
      limit: 10
    }
  },
  getFileById: {
    path: { knowledgeBaseId, fileId: bundleFileId }
  },
  listRelatedFiles: {
    path: { knowledgeBaseId, fileId: bundleFileId },
    query: { limit: 50 }
  },
  expandGraph: {
    path: { knowledgeBaseId },
    query: { fileId: bundleFileId, depth: 1, fanout: 10, limit: 10 }
  },
  getGraphInsights: {
    path: { knowledgeBaseId }
  },
  getFileContentById: {
    path: { knowledgeBaseId, fileId: bundleFileId }
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
        "/openapi/v2/knowledge-bases": {
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
    updateKnowledgeBase: {
      knowledgeBase: {
        ...knowledgeBase,
        name: "Product handbook",
        description: "Current product guidance.",
        resourceRevision: 2
      }
    },
    deleteKnowledgeBase: {
      deletion: {
        knowledgeBaseId,
        accepted: true,
        affectedDirectoryCount: 3,
        affectedFileCount: 20
      }
    },
    createUploadSession: {
      session: { ...uploadSession, state: "draft", completedAt: null },
      limits: uploadSessionLimits
    },
    addUploadManifestEntries: {
      session: { ...uploadSession, state: "manifest_building", completedAt: null },
      limits: uploadSessionLimits
    },
    sealUploadManifest: {
      session: { ...uploadSession, state: "manifest_sealed", completedAt: null },
      limits: uploadSessionLimits
    },
    uploadSessionContentBatch: { entries: [uploadSessionEntry] },
    getUploadSession: {
      session: uploadSession,
      entries: { items: [uploadSessionEntry], nextCursor: null }
    },
    reconcileUploadSession: {
      session: { ...uploadSession, state: "manifest_sealed", completedAt: null },
      limits: uploadSessionLimits
    },
    finalizeUploadSession: {
      session: {
        ...uploadSession,
        state: "finalizing",
        counts: { ...uploadSession.counts, finalized: 0 },
        completedAt: null
      },
      limits: uploadSessionLimits
    },
    cancelUploadSession: {
      session: { ...uploadSession, state: "cancelled", completedAt: exampleTimestamp },
      limits: uploadSessionLimits
    },
    moveSourceFile: { operation: sourceMoveOperation },
    deleteSourceFile: {
      operation: { ...sourceMoveOperation, kind: "source_file_delete" },
      deletion: { sourceFileId }
    },
    getSourceFileContent: "---\ntype: guide\ntitle: Guide\n---\n# Guide",
    replaceSourceFileContent: {
      operation: { ...sourceMoveOperation, kind: "source_file_replace" }
    },
    listSourceDirectories: { items: [sourceDirectory], nextCursor: null },
    getSourceDirectory: { directory: sourceDirectory },
    moveSourceDirectory: {
      operation: { ...sourceMoveOperation, kind: "source_directory_move" }
    },
    deleteSourceDirectory: {
      operation: { ...sourceMoveOperation, kind: "source_directory_delete" },
      deletion: {
        directoryId: sourceDirectory.directoryId,
        affectedDirectoryCount: 1,
        affectedFileCount: 1,
        visibility: "pending_processing"
      }
    },
    listResourceOperations: { items: [sourceMoveOperation], nextCursor: null },
    getResourceOperation: { operation: sourceMoveOperation },
    listKnowledgeBaseSourceFiles: {
      items: [sourceResourceFile],
      nextCursor: null
    },
    getKnowledgeBaseSourceFile: {
      sourceFile: sourceResourceFile
    },
    listKnowledgeBaseSourceFileEvents: {
      items: [sourceFileEvent],
      nextCursor: null
    },
    retryKnowledgeBaseSourceFile: {
      sourceFile: {
        ...sourceResourceFile,
        processingState: "queued",
        currentStage: "upload_storage"
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
    searchGeneratedFiles: {
      query: fileSearchQueryContext,
      items: [fileSearchResult],
      nextCursor: null,
      searchStatus: "ok",
      searchMode: "hybrid",
      graphStatus: "available",
      graphSummary: fileSearchGraphSummary,
      resultSummary: fileSearchResultSummary,
      nextRequestTemplates: fileSearchNextRequestTemplates
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
    expandGraph: graphExpansion,
    getGraphInsights: graphInsights,
    getFileContentById: {
      file: bundleFile,
      content: "---\ntype: page\ntitle: Guide\n---\n# Guide\n\nContent."
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
    requestId: "req-11111111-1111-4111-8111-111111111111"
  };
}

export function payloadTooLargeExample() {
  return errorExample("PAYLOAD_TOO_LARGE", 413, "Uploaded files exceed configured limits.");
}

export type DeveloperOpenApiOperationId = keyof typeof requestExamples &
  keyof ReturnType<typeof createDeveloperOpenApiResponseExamples>;
