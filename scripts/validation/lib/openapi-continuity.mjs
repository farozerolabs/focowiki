const transitions = [
  edge("getDeveloperOpenApiHealth", "getDeveloperOpenApiVersion"),
  edge("getDeveloperOpenApiVersion", "getDeveloperOpenApiContract"),
  edge("getDeveloperOpenApiContract", "listKnowledgeBases"),
  edge("listKnowledgeBases", "getKnowledgeBase", "items.0.knowledgeBaseId", "path.knowledgeBaseId"),
  edge("createKnowledgeBase", "getKnowledgeBase", "knowledgeBase.knowledgeBaseId", "path.knowledgeBaseId"),
  edge("getKnowledgeBase", "createUploadSession", "knowledgeBase.knowledgeBaseId", "path.knowledgeBaseId"),
  edge("updateKnowledgeBase", "getKnowledgeBase", "knowledgeBase.knowledgeBaseId", "path.knowledgeBaseId"),
  terminal("deleteKnowledgeBase", "Knowledge base deletion is terminal."),
  edge("createUploadSession", "addUploadManifestEntries", "session.id", "path.uploadSessionId"),
  edge("addUploadManifestEntries", "sealUploadManifest", "@request.path.uploadSessionId", "path.uploadSessionId"),
  edge("sealUploadManifest", "getUploadSession", "session.id", "path.uploadSessionId"),
  edge("getUploadSession", "uploadSessionEntryContent", "entries.items.0.id", "path.entryId"),
  edge("uploadSessionEntryContent", "finalizeUploadSession", "@request.path.uploadSessionId", "path.uploadSessionId"),
  terminal("cancelUploadSession", "Cancelled upload sessions are terminal."),
  edge("reconcileUploadSession", "getUploadSession", "session.id", "path.uploadSessionId"),
  edge("finalizeUploadSession", "listKnowledgeBaseSourceFiles", "session.knowledgeBaseId", "path.knowledgeBaseId"),
  edge("listKnowledgeBaseSourceFiles", "getKnowledgeBaseSourceFile", "items.0.sourceFileId", "path.sourceFileId"),
  edge("getKnowledgeBaseSourceFile", "getSourceFileContent", "sourceFile.sourceFileId", "path.sourceFileId"),
  edge("moveSourceFile", "getResourceOperation", "operation.operationId", "path.operationId"),
  edge("deleteSourceFile", "getResourceOperation", "operation.operationId", "path.operationId"),
  edge("getSourceFileContent", "replaceSourceFileContent", "@request.path.sourceFileId", "path.sourceFileId"),
  edge("replaceSourceFileContent", "getResourceOperation", "operation.operationId", "path.operationId"),
  edge("listSourceDirectories", "getSourceDirectory", "items.0.directoryId", "path.directoryId"),
  edge("getSourceDirectory", "listSourceDirectories", "directory.directoryId", "query.parentDirectoryId"),
  edge("moveSourceDirectory", "getResourceOperation", "operation.operationId", "path.operationId"),
  edge("deleteSourceDirectory", "getResourceOperation", "operation.operationId", "path.operationId"),
  edge("listResourceOperations", "getResourceOperation", "items.0.operationId", "path.operationId"),
  terminal("getResourceOperation", "A terminal operation result completes asynchronous observation."),
  edge("listKnowledgeBaseSourceFileEvents", "getKnowledgeBaseSourceFile", "@request.path.sourceFileId", "path.sourceFileId"),
  edge("retryKnowledgeBaseSourceFile", "getKnowledgeBaseSourceFile", "sourceFile.sourceFileId", "path.sourceFileId"),
  edge("listKnowledgeBaseTree", "getFileById", "items.0.fileId", "path.fileId"),
  terminal("getFileContentByPath", "Full Markdown content is terminal evidence."),
  edge("searchGeneratedFiles", "getFileById", "items.0.generatedFileId", "path.fileId"),
  edge("expandGraph", "getFileById", "relationships.0.fileId", "path.fileId"),
  edge("getGraphInsights", "getFileContentByPath", "contentPath", "query.path"),
  edge("getFileById", "getFileContentById", "file.fileId", "path.fileId"),
  terminal("getFileContentById", "Full Markdown content is terminal evidence."),
  edge("listRelatedFiles", "getFileContentById", "items.0.fileId", "path.fileId"),
  edge("createWebhook", "deleteWebhook", "webhook.webhookId", "path.webhookId"),
  edge("listWebhooks", "deleteWebhook", "items.0.webhookId", "path.webhookId"),
  terminal("deleteWebhook", "Webhook deletion is terminal."),
  edge("listWebhookDeliveries", "redeliverWebhook", "items.0.deliveryId", "path.deliveryId"),
  edge("redeliverWebhook", "listWebhookDeliveries")
];

export function validateOpenApiContinuity(document) {
  const operations = collectOperations(document);
  const operationIds = new Set(operations.keys());
  const covered = new Set(transitions.map((item) => item.from));
  const missing = [...operationIds].filter((operationId) => !covered.has(operationId));
  const stale = [...covered].filter((operationId) => !operationIds.has(operationId));
  const failures = [];

  if (missing.length > 0) failures.push(`Unclassified operations: ${missing.join(", ")}`);
  if (stale.length > 0) failures.push(`Stale operations: ${stale.join(", ")}`);

  for (const transition of transitions) {
    const from = operations.get(transition.from);
    if (!from || transition.terminal) continue;
    const to = operations.get(transition.to);
    if (!to) {
      failures.push(`${transition.from} points to missing ${transition.to}`);
      continue;
    }
    if (transition.sourceField) {
      const sourceRoot = transition.sourceField.startsWith("@request.")
        ? from.operation["x-request-example"]
        : successExample(from.operation);
      const sourcePath = transition.sourceField.replace(/^@request\./u, "");
      if (readPath(sourceRoot, sourcePath) === undefined) {
        failures.push(`${transition.from} does not expose ${transition.sourceField}`);
      }
    }
    if (transition.targetParameter) {
      const targetExample = to.operation["x-request-example"];
      if (readPath(targetExample, transition.targetParameter) === undefined) {
        failures.push(`${transition.to} example does not accept ${transition.targetParameter}`);
      }
    }
  }

  return {
    ok: failures.length === 0,
    operationCount: operationIds.size,
    classifiedOperationCount: covered.size,
    transitionCount: transitions.filter((item) => !item.terminal).length,
    terminalCount: transitions.filter((item) => item.terminal).length,
    failures,
    transitions
  };
}

function collectOperations(document) {
  const operations = new Map();
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (operation && typeof operation.operationId === "string") {
        operations.set(operation.operationId, { method: method.toUpperCase(), path, operation });
      }
    }
  }
  return operations;
}

function successExample(operation) {
  const status = Object.keys(operation.responses ?? {}).find((value) => /^2\d\d$/u.test(value));
  return status
    ? operation.responses[status]?.content?.["application/json"]?.example
    : undefined;
}

function readPath(value, path) {
  return path.split(".").reduce((current, segment) => {
    if (current === null || current === undefined) return undefined;
    const key = /^\d+$/u.test(segment) ? Number(segment) : segment;
    return current[key];
  }, value);
}

function edge(from, to, sourceField = null, targetParameter = null) {
  return { from, to, sourceField, targetParameter, terminal: false };
}

function terminal(from, reason) {
  return { from, to: null, sourceField: null, targetParameter: null, terminal: true, reason };
}
