import {
  addHandoffRecord,
  createHandoffLedger
} from "./interleaved-handoff-ledger.mjs";

const TERMINAL_STATES = new Set([
  "completed", "failed", "cancelled", "superseded", "timed_out", "deleted"
]);

export function buildHandoffLedgerFromEvidence(input) {
  if (!input?.postgres?.knowledgeBase || !input?.redactor || !input?.scenarioId) {
    throw new Error("Storage vNext handoff evidence is incomplete.");
  }
  const snapshot = input.postgres;
  const alias = (kind, id) => input.redactor.alias(kind, id);
  const knowledgeBaseId = alias("knowledge_base", snapshot.knowledgeBase.id);
  const ledger = createHandoffLedger({
    scenarioId: input.scenarioId,
    knowledgeBaseId,
    publicOutcome: input.publicOutcome ?? null,
    expectedKinds: expectedKinds(snapshot, input.expectedKinds),
    expectedTerminalKinds: input.expectedTerminalKinds ?? []
  });

  addHandoffRecord(ledger, {
    kind: "knowledge_base",
    id: knowledgeBaseId,
    knowledgeBaseId,
    resourceRevision: integer(snapshot.knowledgeBase.resourceRevision),
    state: snapshot.knowledgeBase.deletedAt ? "deleted" : "active",
    metadata: {
      activeRootId: optionalAlias(alias, "release_root", snapshot.knowledgeBase.activeRootPublicId),
      activeRevision: nullableInteger(snapshot.knowledgeBase.activeRevision)
    }
  });

  addPublicEvidence(ledger, input, alias, knowledgeBaseId);
  addOperations(ledger, snapshot, alias, knowledgeBaseId);
  addUploads(ledger, snapshot, alias, knowledgeBaseId);
  addSources(ledger, snapshot, alias, knowledgeBaseId);
  addGraph(ledger, snapshot, alias, knowledgeBaseId);
  addRelease(ledger, snapshot, alias, knowledgeBaseId);
  addObjects(ledger, snapshot, alias, knowledgeBaseId);
  addCleanup(ledger, snapshot, alias, knowledgeBaseId);

  return ledger;
}

function addPublicEvidence(ledger, input, alias, knowledgeBaseId) {
  if (input.publicRequest?.requestId) {
    addHandoffRecord(ledger, {
      kind: "public_request",
      id: alias("public_request", input.publicRequest.requestId),
      knowledgeBaseId,
      ownerKind: "knowledge_base",
      ownerId: knowledgeBaseId,
      terminal: true,
      metadata: { mutationKind: input.publicRequest.mutationKind ?? null }
    });
  }
  if (input.publicOperation?.operationId) {
    addHandoffRecord(ledger, {
      kind: "public_operation",
      id: alias("operation", input.publicOperation.operationId),
      knowledgeBaseId,
      ownerKind: "knowledge_base",
      ownerId: knowledgeBaseId,
      state: input.publicOperation.state ?? null,
      terminal: TERMINAL_STATES.has(input.publicOperation.state),
      metadata: {
        mutationKind: input.publicOperation.mutationKind ?? null,
        priorPath: input.publicOperation.priorPath ?? null,
        resultingPath: input.publicOperation.resultingPath ?? null,
        expectedResourceRevision: nullableInteger(
          input.publicOperation.expectedResourceRevision
        ),
        resultingResourceRevision: nullableInteger(
          input.publicOperation.resultingResourceRevision
        )
      }
    });
  }
}

function addOperations(ledger, snapshot, alias, knowledgeBaseId) {
  for (const item of snapshot.operations ?? []) {
    addHandoffRecord(ledger, {
      kind: "operation",
      id: alias("operation", item.id),
      knowledgeBaseId,
      ownerKind: "knowledge_base",
      ownerId: knowledgeBaseId,
      state: item.state,
      terminal: TERMINAL_STATES.has(item.state),
      metadata: {
        operationKind: item.operationKind,
        expectedResourceRevision: nullableInteger(item.expectedResourceRevision),
        targetKind: item.targetKind ?? null,
        targetId: optionalAlias(alias, targetAliasKind(item.targetKind), item.targetId),
        candidateRelativePath: item.candidateRelativePath ?? null
      }
    });
  }
  for (const item of snapshot.workItems ?? []) {
    const maximum = Number(item.checkpoint?.maxAttempts);
    addHandoffRecord(ledger, {
      kind: "work_item",
      id: alias("operation", item.operationId),
      knowledgeBaseId,
      ownerKind: "operation",
      ownerId: alias("operation", item.operationId),
      resourceRevision: integer(item.operationRevision),
      state: item.state,
      metadata: {
        workKind: item.workKind,
        attemptCount: integer(item.attemptCount),
        maxAttempts: Number.isSafeInteger(maximum) ? maximum : null,
        safeErrorCode: item.safeErrorCode ?? null
      }
    });
  }
  for (const item of snapshot.operationResults ?? []) {
    addHandoffRecord(ledger, {
      kind: "operation_result",
      id: alias("operation_result", item.id),
      knowledgeBaseId,
      ownerKind: "operation",
      ownerId: alias("operation", item.id),
      state: item.state,
      terminal: true,
      metadata: {
        operationKind: item.operationKind,
        resultCode: item.resultCode
      }
    });
  }
  for (const item of snapshot.operationDependencies ?? []) {
    addHandoffRecord(ledger, {
      kind: "operation_dependency",
      id: alias("operation_dependency", `${item.operationId}:${item.dependencyOperationId}`),
      knowledgeBaseId,
      ownerKind: "operation",
      ownerId: alias("operation", item.operationId),
      terminal: true,
      metadata: {
        dependencyOperationId: alias("operation", item.dependencyOperationId)
      }
    });
  }
}

function addUploads(ledger, snapshot, alias, knowledgeBaseId) {
  for (const item of snapshot.uploadSessions ?? []) {
    addHandoffRecord(ledger, {
      kind: "upload_session",
      id: alias("upload_session", item.id),
      knowledgeBaseId,
      ownerKind: "operation",
      ownerId: alias("operation", item.operationId),
      state: item.state,
      metadata: {
        expectedEntryCount: integer(item.expectedEntryCount),
        receivedEntryCount: integer(item.receivedEntryCount)
      }
    });
  }
  for (const item of snapshot.uploadEntries ?? []) {
    addHandoffRecord(ledger, {
      kind: "upload_entry",
      id: alias("upload_entry", `${item.sessionId}:${item.id}`),
      knowledgeBaseId,
      ownerKind: "upload_session",
      ownerId: alias("upload_session", item.sessionId),
      state: item.state,
      metadata: {
        logicalPath: item.logicalPath,
        sourceFileId: alias("source_file", item.sourceFileId),
        objectId: optionalAlias(alias, "object_registration", item.objectId)
      }
    });
  }
}

function addSources(ledger, snapshot, alias, knowledgeBaseId) {
  for (const item of snapshot.sourceDirectories ?? []) {
    addHandoffRecord(ledger, {
      kind: "source_directory",
      id: alias("source_directory", item.id),
      knowledgeBaseId,
      ownerKind: item.parentId ? "source_directory" : "knowledge_base",
      ownerId: item.parentId
        ? alias("source_directory", item.parentId)
        : knowledgeBaseId,
      resourceRevision: integer(item.resourceRevision),
      state: item.deletedAt ? "deleted" : "active",
      durable: true,
      metadata: { logicalPath: item.logicalPath }
    });
  }
  for (const item of snapshot.sourceFiles ?? []) {
    addHandoffRecord(ledger, {
      kind: "source_file",
      id: alias("source_file", item.id),
      knowledgeBaseId,
      ownerKind: item.directoryId ? "source_directory" : "knowledge_base",
      ownerId: item.directoryId
        ? alias("source_directory", item.directoryId)
        : knowledgeBaseId,
      resourceRevision: integer(item.resourceRevision),
      state: item.deletedAt ? "deleted" : item.status,
      durable: true,
      terminal: item.status === "ready" || item.status === "failed" || Boolean(item.deletedAt),
      metadata: {
        logicalPath: item.logicalPath,
        currentRevisionId: optionalAlias(alias, "source_revision", item.currentRevisionId),
        safeErrorCode: item.safeErrorCode ?? null
      }
    });
  }
  for (const item of snapshot.sourceRevisions ?? []) {
    addHandoffRecord(ledger, {
      kind: "source_revision",
      id: alias("source_revision", item.id),
      knowledgeBaseId,
      ownerKind: "source_file",
      ownerId: alias("source_file", item.sourceFileId),
      state: item.revisionRole,
      durable: true,
      terminal: true,
      metadata: {
        revisionRole: item.revisionRole,
        objectId: alias("object_registration", item.objectId),
        checksumSha256: alias("checksum", item.checksumSha256)
      }
    });
  }
}

function addGraph(ledger, snapshot, alias, knowledgeBaseId) {
  for (const item of snapshot.graphNodes ?? []) {
    addHandoffRecord(ledger, {
      kind: "graph_node",
      id: alias("graph_node", item.id),
      knowledgeBaseId,
      ownerKind: "source_revision",
      ownerId: alias("source_revision", item.sourceRevisionId),
      resourceRevision: integer(item.resourceRevision),
      durable: true,
      terminal: true,
      metadata: {
        sourceFileId: alias("source_file", item.sourceFileId),
        logicalPath: item.logicalPath,
        nodeKind: item.nodeKind
      }
    });
  }
  for (const item of snapshot.graphEdges ?? []) {
    addHandoffRecord(ledger, {
      kind: "graph_edge",
      id: alias("graph_edge", item.id),
      knowledgeBaseId,
      ownerKind: "graph_node",
      ownerId: alias("graph_node", item.fromNodeId),
      resourceRevision: integer(item.resourceRevision),
      durable: true,
      terminal: true,
      metadata: {
        toNodeId: alias("graph_node", item.toNodeId),
        relation: item.relation,
        edgeSource: item.edgeSource
      }
    });
  }
  for (const item of snapshot.graphEvidenceRefs ?? []) {
    addHandoffRecord(ledger, {
      kind: "graph_evidence",
      id: alias("graph_evidence", item.id),
      knowledgeBaseId,
      ownerKind: item.nodeId ? "graph_node" : "graph_edge",
      ownerId: item.nodeId
        ? alias("graph_node", item.nodeId)
        : alias("graph_edge", item.edgeId),
      durable: true,
      terminal: true,
      metadata: {
        sourceFileId: alias("source_file", item.sourceFileId),
        sourceRevisionId: alias("source_revision", item.sourceRevisionId),
        logicalPath: item.logicalPath
      }
    });
  }
}

function addRelease(ledger, snapshot, alias, knowledgeBaseId) {
  for (const item of snapshot.releaseRoots ?? []) {
    addHandoffRecord(ledger, {
      kind: "release_root",
      id: alias("release_root", item.id),
      knowledgeBaseId,
      ownerKind: item.baseRootId ? "release_root" : "knowledge_base",
      ownerId: item.baseRootId ? alias("release_root", item.baseRootId) : knowledgeBaseId,
      resourceRevision: integer(item.resourceRevision),
      state: item.rootRole,
      durable: true,
      terminal: item.rootRole !== "candidate",
      metadata: {
        rootRole: item.rootRole,
        manifestChecksumSha256: optionalAlias(
          alias,
          "checksum",
          item.manifestChecksumSha256
        )
      }
    });
  }
  for (const item of snapshot.releaseShards ?? []) {
    addHandoffRecord(ledger, {
      kind: "release_shard",
      id: alias("release_shard", item.id),
      knowledgeBaseId,
      ownerKind: "knowledge_base",
      ownerId: knowledgeBaseId,
      durable: true,
      terminal: true,
      metadata: {
        logicalKind: item.logicalKind,
        firstLogicalPath: item.firstLogicalPath,
        lastLogicalPath: item.lastLogicalPath,
        objectId: alias("object_registration", item.objectId)
      }
    });
  }
  for (const item of snapshot.releaseRootShards ?? []) {
    addHandoffRecord(ledger, {
      kind: "release_root_shard",
      id: alias("release_root_shard", `${item.releaseRootId}:${item.releaseShardId}`),
      knowledgeBaseId,
      ownerKind: "release_root",
      ownerId: alias("release_root", item.releaseRootId),
      durable: true,
      terminal: true,
      metadata: {
        releaseShardId: alias("release_shard", item.releaseShardId),
        ordinal: integer(item.ordinal)
      }
    });
  }
  for (const item of snapshot.releaseCatalogEntries ?? []) {
    addHandoffRecord(ledger, {
      kind: "release_catalog_entry",
      id: alias("release_catalog_entry", `${item.releaseRootId}:${item.logicalPath}`),
      knowledgeBaseId,
      ownerKind: "release_root",
      ownerId: alias("release_root", item.releaseRootId),
      durable: true,
      terminal: true,
      metadata: {
        logicalPath: item.logicalPath,
        entryKind: item.entryKind,
        sourceFileId: optionalAlias(alias, "source_file", item.sourceFileId),
        objectId: alias("object_registration", item.objectId)
      }
    });
  }
  for (const item of snapshot.releaseCatalogTombstones ?? []) {
    addHandoffRecord(ledger, {
      kind: "release_catalog_tombstone",
      id: alias("release_catalog_tombstone", `${item.releaseRootId}:${item.logicalPath}`),
      knowledgeBaseId,
      ownerKind: "release_root",
      ownerId: alias("release_root", item.releaseRootId),
      durable: true,
      terminal: true,
      metadata: { logicalPath: item.logicalPath }
    });
  }
  for (const item of snapshot.searchProjections ?? []) {
    addHandoffRecord(ledger, {
      kind: "search_projection",
      id: alias("search_projection", item.id),
      knowledgeBaseId,
      ownerKind: "knowledge_base",
      ownerId: knowledgeBaseId,
      resourceRevision: integer(item.resourceRevision),
      state: item.state,
      durable: true,
      terminal: item.state === "ready" || item.state === "failed",
      metadata: {
        role: item.role,
        documentCount: integer(item.documentCount),
        safeErrorCode: item.safeErrorCode ?? null
      }
    });
  }
  for (const item of snapshot.activeSnapshots ?? []) {
    addHandoffRecord(ledger, {
      kind: "active_snapshot",
      id: alias("active_snapshot", snapshot.knowledgeBase.id),
      knowledgeBaseId,
      ownerKind: "knowledge_base",
      ownerId: knowledgeBaseId,
      resourceRevision: integer(item.resourceRevision),
      state: "active",
      durable: true,
      terminal: true,
      metadata: {
        releaseRootId: alias("release_root", item.releaseRootId),
        searchProjectionId: alias("search_projection", item.searchProjectionId),
        operationId: alias("operation", item.operationId)
      }
    });
  }
  for (const item of snapshot.releaseCandidates ?? []) {
    addHandoffRecord(ledger, {
      kind: "release_candidate",
      id: alias("release_candidate", item.id),
      knowledgeBaseId,
      ownerKind: "operation",
      ownerId: alias("operation", item.operationId),
      state: item.state,
      durable: true,
      terminal: new Set(["failed", "cancelled", "superseded", "timed_out"]).has(item.state),
      metadata: {
        candidateRootId: alias("release_root", item.candidateRootId),
        expectedActiveRootId: optionalAlias(
          alias,
          "release_root",
          item.expectedActiveRootId
        ),
        expectedActiveRevision: integer(item.expectedActiveRevision),
        reasonCode: item.reasonCode ?? null
      }
    });
  }
  for (const item of snapshot.releaseCandidateValidations ?? []) {
    addHandoffRecord(ledger, {
      kind: "release_candidate_validation",
      id: alias("release_candidate_validation", item.candidateId),
      knowledgeBaseId,
      ownerKind: "release_candidate",
      ownerId: alias("release_candidate", item.candidateId),
      terminal: true,
      metadata: {
        searchProjectionId: alias("search_projection", item.searchProjectionId),
        objectOwnerCount: integer(item.objectOwnerCount),
        generatedEntryCount: integer(item.generatedEntryCount)
      }
    });
  }
  for (const item of snapshot.releaseEventSummaries ?? []) {
    addHandoffRecord(ledger, {
      kind: "release_event",
      id: alias("release_event", item.id),
      knowledgeBaseId,
      ownerKind: "operation",
      ownerId: alias("operation", item.operationId),
      state: item.outcome,
      resourceRevision: integer(item.resourceRevision),
      terminal: true,
      metadata: {
        candidateId: alias("release_candidate", item.candidateId),
        releaseRootId: optionalAlias(alias, "release_root", item.releaseRootId),
        resultCode: item.resultCode
      }
    });
  }
}

function addObjects(ledger, snapshot, alias, knowledgeBaseId) {
  const ownersByObject = new Map();
  for (const item of snapshot.objectOwners ?? []) {
    const owner = objectOwnerTarget(item, alias);
    const id = alias("object_owner", item.id);
    addHandoffRecord(ledger, {
      kind: "object_owner",
      id,
      knowledgeBaseId,
      ownerKind: owner.kind,
      ownerId: owner.id,
      durable: true,
      terminal: true,
      metadata: {
        objectId: alias("object_registration", item.objectId),
        ownerKind: item.ownerKind
      }
    });
    const current = ownersByObject.get(item.objectId) ?? [];
    current.push(id);
    ownersByObject.set(item.objectId, current);
  }
  for (const item of snapshot.objectRegistrations ?? []) {
    const ownerId = ownersByObject.get(item.id)?.[0];
    addHandoffRecord(ledger, {
      kind: "object_registration",
      id: alias("object_registration", item.id),
      knowledgeBaseId,
      ownerKind: ownerId ? "object_owner" : "knowledge_base",
      ownerId: ownerId ?? knowledgeBaseId,
      state: item.state,
      durable: item.state !== "deleted",
      terminal: item.state === "verified" || item.state === "deleted",
      metadata: {
        checksumSha256: alias("checksum", item.checksumSha256),
        objectFormat: item.objectFormat,
        byteCount: integer(item.byteCount)
      }
    });
  }
}

function addCleanup(ledger, snapshot, alias, knowledgeBaseId) {
  for (const item of snapshot.cleanupActions ?? []) {
    addHandoffRecord(ledger, {
      kind: "cleanup_action",
      id: alias("cleanup_action", item.id),
      knowledgeBaseId,
      ownerKind: "operation",
      ownerId: alias("operation", item.operationId),
      state: item.state,
      metadata: {
        actionKind: item.actionKind,
        cleanupPlane: item.cleanupPlane,
        resourceKind: item.resourceKind,
        resourceId: alias(item.resourceKind || "resource", item.resourceId),
        required: item.required === true,
        attemptCount: integer(item.attemptCount),
        safeErrorCode: item.safeErrorCode ?? null
      }
    });
  }
}

function objectOwnerTarget(item, alias) {
  if (item.sourceRevisionId) {
    return { kind: "source_revision", id: alias("source_revision", item.sourceRevisionId) };
  }
  if (item.releaseRootId) {
    return { kind: "release_root", id: alias("release_root", item.releaseRootId) };
  }
  if (item.releaseShardId) {
    return { kind: "release_shard", id: alias("release_shard", item.releaseShardId) };
  }
  if (item.operationId) {
    return { kind: "operation", id: alias("operation", item.operationId) };
  }
  throw new Error("Object owner evidence has no owning identity.");
}

function expectedKinds(snapshot, configured) {
  if (configured) return configured;
  const kinds = ["knowledge_base"];
  if ((snapshot.sourceFiles ?? []).length > 0) kinds.push("source_file", "source_revision");
  if ((snapshot.activeSnapshots ?? []).length > 0) {
    kinds.push("operation", "release_root", "search_projection", "active_snapshot");
  }
  if ((snapshot.objectRegistrations ?? []).length > 0) {
    kinds.push("object_owner", "object_registration");
  }
  return kinds;
}

function targetAliasKind(targetKind) {
  if (targetKind === "source_file") return "source_file";
  if (targetKind === "source_directory") return "source_directory";
  return "knowledge_base";
}

function optionalAlias(alias, kind, value) {
  return value === null || value === undefined ? null : alias(kind, value);
}

function integer(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`Invalid bounded evidence integer: ${value}.`);
  }
  return result;
}

function nullableInteger(value) {
  return value === null || value === undefined ? null : integer(value);
}
