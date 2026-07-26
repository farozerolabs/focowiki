import {
  addHandoffRecord,
  createHandoffLedger
} from "./interleaved-handoff-ledger.mjs";

const TERMINAL_STATES = new Set([
  "active",
  "cancelled",
  "completed",
  "dead_letter",
  "deleted",
  "expired",
  "failed",
  "published",
  "rejected",
  "skipped",
  "superseded",
  "succeeded"
]);

export function buildHandoffLedgerFromEvidence(input) {
  const snapshot = input?.postgres;
  const knowledgeBase = snapshot?.knowledgeBase;
  if (!knowledgeBase?.id || !input?.redactor || !input?.scenarioId) {
    throw new Error(
      "Handoff ledger evidence requires scenario, redactor, and knowledge base."
    );
  }

  const alias = createIdentityAlias(input.redactor);
  const knowledgeBaseId = alias("knowledge_base", knowledgeBase.id);
  const ledger = createHandoffLedger({
    scenarioId: input.scenarioId,
    knowledgeBaseId,
    expectedKinds: input.expectedKinds,
    expectedTerminalKinds: input.expectedTerminalKinds
  });
  ledger.publicOutcome = input.publicOutcome ?? "pending";

  add(ledger, alias, {
    kind: "knowledge_base",
    id: knowledgeBase.id,
    knowledgeBaseId,
    resourceRevision: knowledgeBase.resourceRevision,
    state: knowledgeBase.deletedAt ? "deleted" : "active",
    terminal: Boolean(knowledgeBase.deletedAt),
    metadata: {
      catalogGeneration: knowledgeBase.catalogGeneration,
      activeGenerationId: knowledgeBase.activeGenerationId
        ? alias("generation", knowledgeBase.activeGenerationId)
        : null
    }
  });

  if (input.priorActiveGenerationId) {
    add(ledger, alias, {
      kind: "active_generation",
      identityKind: "generation",
      id: input.priorActiveGenerationId,
      ownerKind: "knowledge_base",
      ownerId: knowledgeBase.id,
      knowledgeBaseId,
      state: "active",
      terminal: true
    });
  }

  addPublicRequest(ledger, alias, input.publicRequest, knowledgeBaseId);
  addPublicOperation(ledger, alias, input.publicOperation, knowledgeBaseId);

  for (const item of snapshot.uploadSessions ?? []) {
    add(ledger, alias, {
      kind: "upload_session",
      id: item.id,
      ownerKind: "knowledge_base",
      ownerId: knowledgeBase.id,
      knowledgeBaseId,
      state: item.state,
      durable: true,
      terminal: isTerminal(item.state),
      metadata: { errorCode: item.errorCode }
    });
  }
  for (const item of snapshot.uploadEntries ?? []) {
    add(ledger, alias, {
      kind: "upload_entry",
      id: item.id,
      ownerKind: "upload_session",
      ownerId: item.sessionId,
      knowledgeBaseId,
      state: item.transferState,
      durable: true,
      terminal: Boolean(item.finalizedAt || item.errorCode),
      metadata: {
        logicalPath: item.relativePath,
        transferState: item.transferState,
        disposition: item.disposition,
        expectedResourceRevision: item.existingResourceRevision,
        errorCode: item.errorCode
      }
    });
  }
  for (const item of snapshot.operations ?? []) {
    add(ledger, alias, {
      kind: "operation",
      id: item.id,
      ownerKind: "knowledge_base",
      ownerId: knowledgeBase.id,
      knowledgeBaseId,
      state: item.state,
      durable: true,
      terminal: isTerminal(item.state),
      metadata: {
        mutationKind: item.operationKind,
        expectedResourceRevision: item.expectedResourceRevision,
        candidateCatalogGeneration: item.candidateCatalogGeneration,
        errorCode: item.errorCode
      }
    });
  }
  for (const item of snapshot.operationTargets ?? []) {
    add(ledger, alias, {
      kind: "operation_target",
      id: `${item.operationId}:${item.sequenceNumber}`,
      ownerKind: "operation",
      ownerId: item.operationId,
      knowledgeBaseId,
      durable: true,
      metadata: {
        expectedResourceRevision: item.expectedResourceRevision
      }
    });
  }
  for (const item of snapshot.sourceDirectories ?? []) {
    add(ledger, alias, {
      kind: "directory",
      id: item.id,
      ownerKind: "knowledge_base",
      ownerId: knowledgeBase.id,
      knowledgeBaseId,
      resourceRevision: item.resourceRevision,
      state: item.deletedAt ? "deleted" : "active",
      durable: true,
      terminal: Boolean(item.deletedAt),
      metadata: {
        logicalPath: item.relativePath,
        resultingPath: item.candidateRelativePath,
        candidateOperationId: item.candidateOperationId
      }
    });
  }
  for (const item of snapshot.sourceFiles ?? []) {
    add(ledger, alias, {
      kind: "source",
      id: item.id,
      ownerKind: "knowledge_base",
      ownerId: knowledgeBase.id,
      knowledgeBaseId,
      resourceRevision: item.resourceRevision,
      state: item.deletedAt
        ? "deleted"
        : item.processingStatus,
      durable: true,
      terminal: Boolean(
        item.deletedAt ||
        item.terminalFailureCode ||
        ["completed", "failed"].includes(item.processingStatus)
      ),
      metadata: {
        logicalPath: item.relativePath,
        contentRevision: item.contentRevision,
        candidateOperationId: item.candidateOperationId,
        candidateRevisionId: item.candidateRevisionId,
        candidateRelativePath: item.candidateRelativePath,
        phase: item.processingStage,
        errorCode: item.terminalFailureCode,
        errorMessage: item.terminalFailureMessage
      }
    });
  }
  for (const item of snapshot.sourceRevisions ?? []) {
    add(ledger, alias, {
      kind: "source_revision",
      id: item.id,
      ownerKind: "source",
      ownerId: item.sourceFileId,
      knowledgeBaseId,
      resourceRevision: item.revision,
      state: item.processingStatus,
      durable: true,
      terminal: isTerminal(item.processingStatus)
    });
  }
  for (const item of snapshot.dispatchMarkers ?? []) {
    add(ledger, alias, {
      kind: "dispatch_marker",
      id: item.id,
      ownerKind: item.sourceRevisionId ? "source_revision" : "source",
      ownerId: item.sourceRevisionId || item.sourceFileId,
      knowledgeBaseId,
      state: item.status,
      durable: true,
      terminal: isTerminal(item.status),
      metadata: {
        retryAt: item.runAfter,
        errorCode: item.lastErrorCode
      }
    });
  }
  for (const item of snapshot.sourceEvents ?? []) {
    add(ledger, alias, {
      kind: "source_event",
      id: item.id,
      ownerKind: "source",
      ownerId: item.sourceFileId,
      knowledgeBaseId,
      state: item.endedAt ? "completed" : "running",
      durable: true,
      terminal: Boolean(item.endedAt),
      metadata: {
        phase: item.stageKey,
        result: item.messageKey
      }
    });
  }
  for (const item of snapshot.deletionIntents ?? []) {
    add(ledger, alias, {
      kind: "deletion_intent",
      id: item.id,
      ownerKind: ownerKindForDeletion(item.targetKind),
      ownerId: item.targetId,
      knowledgeBaseId,
      state: item.state,
      durable: true,
      terminal: isTerminal(item.state),
      metadata: {
        catalogGeneration: item.catalogGeneration,
        attemptCount: item.attemptCount,
        errorCode: item.errorCode
      }
    });
  }
  for (const item of snapshot.roleJobs ?? []) {
    const owner = roleJobOwner(item, knowledgeBase.id);
    add(ledger, alias, {
      kind: "role_job",
      id: item.id,
      ownerKind: owner.kind,
      ownerId: owner.id,
      knowledgeBaseId,
      state: item.status,
      durable: true,
      terminal: isTerminal(item.status),
      metadata: {
        role: item.role,
        taskKind: item.kind,
        attemptCount: item.attemptCount,
        maxAttempts: item.maxAttempts,
        retryAt: item.status === "retry" ? item.runAfter : undefined,
        errorCode: item.lastErrorCode,
        errorMessage: item.lastErrorMessage
      }
    });
  }
  for (const item of snapshot.generations ?? []) {
    add(ledger, alias, {
      kind: "generation",
      id: item.id,
      ownerKind: "knowledge_base",
      ownerId: knowledgeBase.id,
      knowledgeBaseId,
      predecessorId: item.predecessorGenerationId,
      state: item.state,
      durable: true,
      terminal: isTerminal(item.state),
      metadata: {
        formatVersion: item.formatVersion,
        errorCode: item.safeErrorCode,
        errorMessage: item.safeErrorMessage,
        candidateGeneration: item.id === input.candidateGenerationId
      }
    });
    if (item.id === knowledgeBase.activeGenerationId) {
      add(ledger, alias, {
        kind: "activation",
        identityKind: "generation",
        id: item.id,
        ownerKind: "generation",
        ownerId: item.id,
        knowledgeBaseId,
        state: "active",
        terminal: true
      });
    }
  }
  addGenerationChildren(ledger, alias, knowledgeBaseId, snapshot);
  addMaintenance(ledger, alias, knowledgeBaseId, knowledgeBase.id, snapshot);
  addProjectionAndStorage(
    ledger,
    alias,
    knowledgeBaseId,
    knowledgeBase,
    snapshot,
    input.redis
  );

  return ledger;
}

function addGenerationChildren(ledger, alias, knowledgeBaseId, snapshot) {
  const families = [
    ["publication_progress", snapshot.publicationProgress, "generationId"],
    ["publication_impact", snapshot.publicationImpacts, "generationId"],
    ["publication_subtask", snapshot.publicationSubtasks, "generationId"],
    ["projection_input", snapshot.projectionInputs, "generationId"],
    ["projection_record", snapshot.generationProjections, "generationId"],
    ["object_reference", snapshot.generationObjectRefs, "generationId"]
  ];
  for (const [kind, items, generationKey] of families) {
    for (const [index, item] of (items ?? []).entries()) {
      add(ledger, alias, {
        kind,
        id: item.id ?? item.recordId ?? item.refKey ?? item.inputKey ??
          `${item[generationKey]}:${kind}:${index}`,
        ownerKind: "generation",
        ownerId: item[generationKey],
        knowledgeBaseId,
        state: item.state ?? item.status ?? item.action ?? null,
        durable: true,
        terminal: isTerminal(item.state ?? item.status),
        metadata: {
          phase: item.stage,
          projectionKind: item.projectionKind,
          logicalPath: item.logicalPath,
          action: item.action,
          attemptCount: item.attemptCount,
          maxAttempts: item.maxAttempts,
          retryAt: item.state === "retry" ? item.updatedAt : undefined,
          errorCode: item.lastErrorCode ?? item.safeErrorCode,
          errorMessage: item.lastErrorMessage ?? item.safeErrorMessage
        }
      });
    }
  }
}

function addMaintenance(
  ledger,
  alias,
  knowledgeBaseId,
  rawKnowledgeBaseId,
  snapshot
) {
  for (const item of snapshot.projectionRepairs ?? []) {
    add(ledger, alias, {
      kind: "projection_repair",
      id: item.targetGenerationId,
      ownerKind: "knowledge_base",
      ownerId: rawKnowledgeBaseId,
      knowledgeBaseId,
      state: item.state,
      durable: true,
      terminal: isTerminal(item.state),
      metadata: {
        attemptCount: item.attemptCount,
        retryAt: item.nextAttemptAt,
        errorCode: item.lastErrorCode
      }
    });
  }
  for (const item of snapshot.projectionRepairSubtasks ?? []) {
    add(ledger, alias, {
      kind: "projection_repair_subtask",
      id: `${item.targetGenerationId}:${item.taskKind}:${item.partitionKey}`,
      ownerKind: "projection_repair",
      ownerId: item.targetGenerationId,
      knowledgeBaseId,
      state: item.state,
      durable: true,
      terminal: isTerminal(item.state),
      metadata: {
        taskKind: item.taskKind,
        attemptCount: item.attemptCount,
        maxAttempts: item.maxAttempts,
        retryAt: item.state === "retry" ? item.updatedAt : undefined,
        errorCode: item.lastErrorCode
      }
    });
  }
  for (const item of snapshot.lexicalRebuilds ?? []) {
    add(ledger, alias, {
      kind: "lexical_rebuild",
      id: item.targetGenerationId,
      ownerKind: "knowledge_base",
      ownerId: rawKnowledgeBaseId,
      knowledgeBaseId,
      state: item.state,
      durable: true,
      terminal: isTerminal(item.state),
      metadata: {
        phase: item.phase,
        attemptCount: item.attemptCount,
        maxAttempts: item.maxAttempts,
        errorCode: item.lastErrorCode
      }
    });
  }
  for (const item of snapshot.lexicalWorkItems ?? []) {
    add(ledger, alias, {
      kind: "lexical_work_item",
      id: `${item.targetGenerationId}:${item.sourceFileId}`,
      ownerKind: "lexical_rebuild",
      ownerId: item.targetGenerationId,
      knowledgeBaseId,
      state: item.state,
      durable: true,
      terminal: isTerminal(item.state),
      metadata: {
        logicalPath: item.logicalPath,
        phase: item.lastErrorStage,
        attemptCount: item.attemptCount,
        maxAttempts: item.maxAttempts,
        retryAt: item.state === "retry" ? item.updatedAt : undefined,
        errorCode: item.lastErrorCode
      }
    });
  }
  for (const item of snapshot.compactionJobs ?? []) {
    add(ledger, alias, {
      kind: "compaction_job",
      id: item.id,
      ownerKind: "knowledge_base",
      ownerId: rawKnowledgeBaseId,
      knowledgeBaseId,
      state: item.state,
      durable: true,
      terminal: isTerminal(item.state),
      metadata: {
        projectionKind: item.projectionKind,
        attemptCount: item.attemptCount,
        maxAttempts: item.maxAttempts,
        retryAt: item.state === "retry" ? item.updatedAt : undefined,
        errorCode: item.lastErrorCode
      }
    });
  }
}

function addProjectionAndStorage(
  ledger,
  alias,
  knowledgeBaseId,
  knowledgeBase,
  snapshot,
  redis
) {
  for (const item of snapshot.activeProjections ?? []) {
    if (!knowledgeBase.activeGenerationId) continue;
    add(ledger, alias, {
      kind: "active_projection",
      id: `${item.projectionKind}:${item.recordId}`,
      ownerKind: "generation",
      ownerId: knowledgeBase.activeGenerationId,
      knowledgeBaseId,
      state: "active",
      durable: true,
      terminal: true,
      metadata: {
        projectionKind: item.projectionKind,
        logicalPath: item.logicalPath
      }
    });
  }
  const objectOwners = new Map();
  for (const item of snapshot.generationObjectRefs ?? []) {
    if (item.action === "upsert") {
      objectOwners.set(
        `${item.checksumSha256}:${item.formatVersion}`,
        item.generationId
      );
    }
  }
  for (const item of snapshot.immutableObjects ?? []) {
    const owner = objectOwners.get(
      `${item.checksumSha256}:${item.formatVersion}`
    );
    if (!owner) continue;
    add(ledger, alias, {
      kind: "immutable_object",
      id: `${item.checksumSha256}:${item.formatVersion}`,
      ownerKind: "generation",
      ownerId: owner,
      knowledgeBaseId,
      state: item.lifecycleState,
      durable: true,
      terminal: isTerminal(item.lifecycleState),
      metadata: {
        lifecycleState: item.lifecycleState,
        formatVersion: item.formatVersion,
        attemptCount: item.writeAttemptCount,
        errorCode: item.lastWriteErrorCode ?? item.integrityErrorCode
      }
    });
  }
  for (const item of redis?.keys ?? []) {
    addHandoffRecord(ledger, {
      kind: "redis_observation",
      id: item.alias,
      knowledgeBaseId,
      state: item.type,
      metadata: {}
    });
  }
  for (const item of snapshot.cleanupObjectDeletions ?? []) {
    add(ledger, alias, {
      kind: "cleanup_candidate",
      id: item.jobId,
      ownerKind: "knowledge_base",
      ownerId: knowledgeBase.id,
      knowledgeBaseId,
      state: item.status,
      durable: true,
      terminal: isTerminal(item.status)
    });
  }
}

function addPublicRequest(ledger, alias, request, knowledgeBaseId) {
  if (!request?.requestId) return;
  add(ledger, alias, {
    kind: "request",
    id: request.requestId,
    knowledgeBaseId,
    state: request.state ?? "accepted",
    terminal: request.terminal === true,
    metadata: {
      mutationKind: request.mutationKind
    }
  });
  if (request.idempotencyKey) {
    add(ledger, alias, {
      kind: "idempotency",
      id: request.idempotencyKey,
      ownerKind: "request",
      ownerId: request.requestId,
      knowledgeBaseId,
      terminal: true
    });
  }
}

function addPublicOperation(ledger, alias, operation, knowledgeBaseId) {
  if (!operation?.operationId) return;
  const ownerKind = operation.requestId ? "request" : null;
  add(ledger, alias, {
    kind: "public_operation",
    id: operation.operationId,
    ownerKind,
    ownerId: operation.requestId,
    knowledgeBaseId,
    resourceRevision: operation.resultingResourceRevision,
    state: operation.state,
    terminal: isTerminal(operation.state),
    metadata: {
      mutationKind: operation.mutationKind,
      priorPath: operation.priorPath,
      resultingPath: operation.resultingPath,
      expectedResourceRevision: operation.expectedResourceRevision,
      resultingResourceRevision: operation.resultingResourceRevision,
      errorCode: operation.errorCode
    }
  });
}

function add(ledger, alias, input) {
  const kind = input.kind;
  const knowledgeBaseId = input.knowledgeBaseId;
  return addHandoffRecord(ledger, {
    ...input,
    id: alias(input.identityKind ?? kind, input.id),
    knowledgeBaseId,
    ownerId: input.ownerId == null
      ? null
      : alias(input.ownerKind, input.ownerId),
    predecessorId: input.predecessorId == null
      ? null
      : alias("generation", input.predecessorId)
  });
}

function createIdentityAlias(redactor) {
  return (kind, value) => redactor.alias(kind, String(value));
}

function ownerKindForDeletion(targetKind) {
  if (targetKind === "source_file") return "source";
  if (targetKind === "source_directory") return "directory";
  return "knowledge_base";
}

function roleJobOwner(item, knowledgeBaseId) {
  if (item.sourceRevisionId) {
    return { kind: "source_revision", id: item.sourceRevisionId };
  }
  if (item.sourceFileId) return { kind: "source", id: item.sourceFileId };
  if (item.generationId) return { kind: "generation", id: item.generationId };
  return { kind: "knowledge_base", id: knowledgeBaseId };
}

function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}
