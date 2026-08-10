import { createHash } from "node:crypto";
import type {
  StorageVnextModelInvocationFact,
  StorageVnextSourceFileFact
} from "../catalog/ports.js";
import { createStorageVnextProcessResourceScope } from
  "../cleanup/process-resource-scope.js";
import type { StorageVnextBoundedResult, StorageVnextLiveWork } from
  "../workflow/ports.js";
import type { StorageVnextSourceProcessingPorts } from "./ports.js";
import type { WebhookDispatcher } from "../../webhooks/dispatcher.js";
import { dispatchWebhookSafely } from "../../webhooks/safe-dispatch.js";

type WorkerLimits = {
  maximumConcurrency: number;
  maximumSourceBytes: number;
  maximumAttempts: number;
  attemptDeadlineMilliseconds: number;
  retryDelayMilliseconds: number;
  resultRetentionMilliseconds: number;
};

type WorkOutcome = "completed" | "retried" | "terminal";

type FailureObserver = (failure: {
  operationPublicId: string;
  knowledgeBaseId: string;
  attempt: number;
  code: string;
  error: unknown;
}) => void;

export function createStorageVnextSourceProcessingWorker(
  input: StorageVnextSourceProcessingPorts & {
    modelInvocation: { modelName: string } | null;
    limits: WorkerLimits;
    clock: () => string;
    onFailure?: FailureObserver;
    webhooks?: Pick<WebhookDispatcher, "dispatch">;
    onWebhookError?: (error: unknown) => void;
  }
) {
  validateLimits(input.limits);
  return {
    async runOnce(request: {
      owner: string;
      limit: number;
      leaseExpiresAt: string;
      signal?: AbortSignal;
    }): Promise<{ claimed: number; completed: number; retried: number; terminal: number }> {
      assertClaim(request, input.limits.maximumConcurrency);
      if (request.signal?.aborted) {
        return { claimed: 0, completed: 0, retried: 0, terminal: 0 };
      }
      const work = await input.workflow.claim({
        kinds: ["source"],
        owner: request.owner,
        limit: request.limit,
        leaseExpiresAt: request.leaseExpiresAt
      });
      const outcomes = await Promise.all(work.map((item) =>
        processWork(input, item, request.owner, request.signal)));
      return {
        claimed: work.length,
        completed: outcomes.filter((outcome) => outcome === "completed").length,
        retried: outcomes.filter((outcome) => outcome === "retried").length,
        terminal: outcomes.filter((outcome) => outcome === "terminal").length
      };
    }
  };
}

async function processWork(
  input: StorageVnextSourceProcessingPorts & {
    modelInvocation: { modelName: string } | null;
    limits: WorkerLimits;
    clock: () => string;
    onFailure?: FailureObserver;
    webhooks?: Pick<WebhookDispatcher, "dispatch">;
    onWebhookError?: (error: unknown) => void;
  },
  work: StorageVnextLiveWork,
  owner: string,
  roleSignal: AbortSignal | undefined
): Promise<WorkOutcome> {
  assertClaimedWork(work, owner);
  if (roleSignal?.aborted) {
    await input.workflow.releaseForRetry({
      publicId: work.publicId,
      owner,
      nextAttemptAt: addMilliseconds(input.clock(), input.limits.retryDelayMilliseconds),
      reasonCode: "SOURCE_MODEL_TIMEOUT"
    });
    return "retried";
  }
  const sourceRevisionPublicId = checkpointRevision(work);
  const current = await loadCurrentFacts(input, work, sourceRevisionPublicId);
  if (current.outcome !== "current") {
    await completeTerminal(input, work, owner, {
      state: current.outcome,
      resultCode: current.outcome === "deleted"
        ? "KNOWLEDGE_BASE_DELETED"
        : "SOURCE_REVISION_SUPERSEDED",
      sourceRevisionPublicId
    });
    return "terminal";
  }

  const acceptedAt = input.clock();
  const resumeFromStage = semanticResumeStage(work);
  let modelInvocation = resumeFromStage === "publication"
    ? reusableModelInvocation(current.sourceFile, sourceRevisionPublicId)
    : createInitialModelInvocation(
        input.modelInvocation,
        sourceRevisionPublicId,
        acceptedAt
      );
  await recordSourceEvent(input, {
    kind: "accepted",
    work,
    sourceFile: current.sourceFile,
    sourceRevisionPublicId,
    createdAt: acceptedAt
  });
  await dispatchSourceWebhook(input, {
    eventId: sourceEventIdentity("accepted", sourceRevisionPublicId),
    eventType: "source_file.accepted",
    payload: {
      knowledgeBaseId: work.knowledgeBaseId,
      sourceFileId: current.sourceFile.publicId,
      sourceRevisionId: sourceRevisionPublicId
    },
    createdAt: acceptedAt
  });

  let processingFile = await input.catalog.updateSourceFileState({
    knowledgeBaseId: work.knowledgeBaseId,
    publicId: current.sourceFile.publicId,
    metadata: current.sourceFile.metadata,
    status: "processing",
    safeErrorCode: null,
    safeErrorMessage: null,
    modelInvocation,
    revisionCheck: { expectedRevision: current.sourceFile.revision }
  });
  const progressAt = input.clock();
  await recordSourceEvent(input, {
    kind: resumeFromStage === "publication" ? "publication_progress" : "progress",
    work,
    sourceFile: current.sourceFile,
    sourceRevisionPublicId,
    createdAt: progressAt
  });
  await dispatchSourceWebhook(input, {
    eventId: sourceEventIdentity(
      resumeFromStage === "publication" ? "publication_progress" : "progress",
      `${work.publicId}:${resumeFromStage ?? "model_assistance"}`
    ),
    eventType: "source_file.progress",
    payload: {
      knowledgeBaseId: work.knowledgeBaseId,
      sourceFileId: current.sourceFile.publicId,
      sourceRevisionId: sourceRevisionPublicId,
      stage: resumeFromStage === "publication"
        ? "search_publication"
        : "model_assistance",
      status: "running"
    },
    createdAt: progressAt
  });
  const modelAttemptPublicId = createAttemptPublicId(work, sourceRevisionPublicId);
  const controller = new AbortController();
  const abortFromRole = () => controller.abort(
    roleSignal?.reason ?? new DOMException("Source role shutting down", "AbortError")
  );
  roleSignal?.addEventListener("abort", abortFromRole, { once: true });
  if (roleSignal?.aborted) abortFromRole();
  const resources = createStorageVnextProcessResourceScope({ maximumResources: 3 });
  resources.trackAbortController(`${modelAttemptPublicId}:request`, controller);
  const deadline = setTimeout(() => {
    const error = new Error("Storage vNext source model attempt timed out");
    error.name = "TimeoutError";
    controller.abort(error);
  }, input.limits.attemptDeadlineMilliseconds);
  deadline.unref?.();
  resources.trackTimer(`${modelAttemptPublicId}:deadline`, deadline);

  try {
    if (resumeFromStage === "publication") {
      if (!modelInvocation) throw workerError("invalid_checkpoint");
      if (!input.semanticHandoff) {
        throw semanticBlockedError("semantic_contract_not_adopted");
      }
      const semanticHandoff = await input.semanticHandoff.enqueue({
        operationPublicId: work.publicId,
        knowledgeBaseId: work.knowledgeBaseId,
        settingsRevisionPublicId: work.settingsRevisionPublicId,
        sourceFile: current.sourceFile,
        sourceRevision: current.sourceRevision,
        enqueuedAt: input.clock(),
        resumeFromStage
      });
      if (semanticHandoff.state !== "queued") {
        throw semanticBlockedError(semanticHandoff.safeCode);
      }
      await input.workflow.saveCheckpoint({
        publicId: work.publicId,
        owner,
        checkpoint: {
          phase: "semantic_publication_resume_enqueued",
          sourceRevisionPublicId,
          semanticGenerationPublicId: semanticHandoff.semanticGenerationPublicId,
          semanticStageCount: semanticHandoff.stageCount,
          ...modelInvocationSummary(modelInvocation)
        }
      });
      await input.workflow.complete({
        publicId: work.publicId,
        owner,
        result: result(input, work, {
          state: "completed",
          resultCode: "SOURCE_PUBLICATION_RETRY_QUEUED",
          correlationPublicId: sourceRevisionPublicId,
          summary: {
            sourceFilePublicId: current.sourceFile.publicId,
            sourceRevisionPublicId,
            semanticState: semanticHandoff.state,
            semanticGenerationPublicId: semanticHandoff.semanticGenerationPublicId,
            semanticStageCount: semanticHandoff.stageCount,
            semanticSafeCode: semanticHandoff.safeCode,
            ...modelInvocationSummary(modelInvocation)
          }
        })
      });
      return "completed";
    }
    const body = await input.bodyStore.readVerifiedStream({
      objectId: current.sourceRevision.objectId,
      checksum: current.sourceRevision.checksum,
      byteCount: current.sourceRevision.byteCount,
      contentType: current.sourceRevision.contentType,
      maxBytes: input.limits.maximumSourceBytes,
      signal: controller.signal
    });
    const trackedBody = trackBody(body);
    resources.trackClosable({
      publicId: `${modelAttemptPublicId}:body`,
      kind: "stream",
      close: trackedBody.close
    });
    const model = await input.model.extract({
      knowledgeBaseId: work.knowledgeBaseId,
      sourceFile: current.sourceFile,
      sourceRevision: current.sourceRevision,
      sourceRevisionPublicId,
      attemptPublicId: modelAttemptPublicId,
      body: trackedBody.body,
      signal: controller.signal,
      ...(input.modelInvocation
        ? {
            async onModelAssistanceStart() {
              if (modelInvocation !== null) {
                throw workerError("invalid_model_invocation");
              }
              modelInvocation = createRunningModelInvocation(
                input.modelInvocation!,
                sourceRevisionPublicId,
                input.clock()
              );
              processingFile = await input.catalog.updateSourceFileState({
                knowledgeBaseId: work.knowledgeBaseId,
                publicId: current.sourceFile.publicId,
                metadata: current.sourceFile.metadata,
                status: "processing",
                safeErrorCode: null,
                safeErrorMessage: null,
                modelInvocation,
                revisionCheck: { expectedRevision: processingFile.revision }
              });
            }
          }
        : {})
    });
    if (!trackedBody.completed) throw workerError("incomplete_source_stream");
    assertModelIdentity(current.sourceFile, sourceRevisionPublicId, model);
    if (model.modelAssistanceUsed) {
      if (modelInvocation === null || modelInvocation.status !== "running") {
        throw workerError("invalid_model_invocation");
      }
      modelInvocation = completeModelInvocation(
        modelInvocation,
        input.clock(),
        model.modelWarningCount ?? 0
      );
    } else {
      if (modelInvocation?.status === "running") {
        throw workerError("invalid_model_invocation");
      }
      modelInvocation = createInitialModelInvocation(
        null,
        sourceRevisionPublicId,
        input.clock()
      );
    }
    if (modelInvocation === null) throw workerError("invalid_model_invocation");
    const completedModelInvocation = modelInvocation;
    await input.workflow.saveCheckpoint({
      publicId: work.publicId,
      owner,
      checkpoint: {
        phase: "model_completed",
        sourceRevisionPublicId,
        modelAttemptPublicId,
        ...modelInvocationSummary(completedModelInvocation)
      }
    });
    const semanticHandoff = input.semanticHandoff
      ? await input.semanticHandoff.enqueue({
          operationPublicId: work.publicId,
          knowledgeBaseId: work.knowledgeBaseId,
          settingsRevisionPublicId: work.settingsRevisionPublicId,
          sourceFile: current.sourceFile,
          sourceRevision: current.sourceRevision,
          skeletonGraphSignals: summarizeSkeletonGraphSignals(
            model.node,
            model.edges
          ),
          enqueuedAt: input.clock()
        })
      : null;
    if (semanticHandoff?.state === "blocked") {
      throw semanticBlockedError(semanticHandoff.safeCode);
    }
    const handoff = await input.handoff.apply({
      operationPublicId: work.publicId,
      knowledgeBaseId: work.knowledgeBaseId,
      settingsRevisionPublicId: work.settingsRevisionPublicId,
      sourceFile: current.sourceFile,
      sourceRevisionPublicId,
      node: model.node,
      edges: model.edges,
      completedAt: input.clock(),
      publicationMode: semanticHandoff?.state === "queued"
        ? "semantic_final"
        : "immediate"
    });
    await input.workflow.saveCheckpoint({
      publicId: work.publicId,
      owner,
      checkpoint: {
        phase: "release_handoff_completed",
        sourceRevisionPublicId,
        candidatePublicId: handoff.candidatePublicId,
        releaseOperationPublicId: handoff.releaseOperationPublicId,
        ...(semanticHandoff ? {
          semanticState: semanticHandoff.state,
          semanticGenerationPublicId: semanticHandoff.semanticGenerationPublicId,
          semanticStageCount: semanticHandoff.stageCount,
          semanticSafeCode: semanticHandoff.safeCode
        } : {})
      }
    });
    await input.catalog.updateSourceFileState({
      knowledgeBaseId: work.knowledgeBaseId,
      publicId: current.sourceFile.publicId,
      metadata: model.metadata,
      status: "processing",
      safeErrorCode: null,
      safeErrorMessage: null,
      modelInvocation: completedModelInvocation,
      revisionCheck: { expectedRevision: processingFile.revision }
    });
    const completedAt = input.clock();
    const pendingStage = semanticHandoff?.state === "queued"
      ? "semantic_progress"
      : "publication_progress";
    await recordSourceEvent(input, {
      kind: pendingStage,
      work,
      sourceFile: current.sourceFile,
      sourceRevisionPublicId,
      createdAt: completedAt
    });
    await input.workflow.complete({
      publicId: work.publicId,
      owner,
      result: result(input, work, {
        state: "completed",
        resultCode: "SOURCE_PROCESSING_COMPLETED",
        correlationPublicId: sourceRevisionPublicId,
        summary: {
          sourceFilePublicId: current.sourceFile.publicId,
          sourceRevisionPublicId,
          candidatePublicId: handoff.candidatePublicId,
          releaseOperationPublicId: handoff.releaseOperationPublicId,
          ...(semanticHandoff ? {
            semanticState: semanticHandoff.state,
            semanticGenerationPublicId: semanticHandoff.semanticGenerationPublicId,
            semanticStageCount: semanticHandoff.stageCount,
            semanticSafeCode: semanticHandoff.safeCode
          } : {}),
          ...modelInvocationSummary(completedModelInvocation)
        }
      })
    });
    await dispatchSourceWebhook(input, {
      eventId: sourceEventIdentity(pendingStage, sourceRevisionPublicId),
      eventType: "source_file.progress",
      payload: {
        knowledgeBaseId: work.knowledgeBaseId,
        sourceFileId: current.sourceFile.publicId,
        sourceRevisionId: sourceRevisionPublicId,
        stage: pendingStage === "semantic_progress"
          ? "graphrag_processing"
          : "search_publication",
        status: "running"
      },
      createdAt: completedAt
    });
    return "completed";
  } catch (error) {
    const code = safeFailureCode(error, controller.signal);
    input.onFailure?.({
      operationPublicId: work.publicId,
      knowledgeBaseId: work.knowledgeBaseId,
      attempt: work.attempt,
      code,
      error
    });
    if (isStaleFailure(error)) {
      await completeTerminal(input, work, owner, {
        state: "superseded",
        resultCode: "SOURCE_REVISION_SUPERSEDED",
        sourceRevisionPublicId
      });
      return "terminal";
    }
    if (work.attempt < input.limits.maximumAttempts && isRetryableFailure(error)) {
      await input.workflow.releaseForRetry({
        publicId: work.publicId,
        owner,
        nextAttemptAt: addMilliseconds(input.clock(), input.limits.retryDelayMilliseconds),
        reasonCode: code
      });
      return "retried";
    }
    modelInvocation = failModelInvocation(modelInvocation, input.clock(), code);
    await input.catalog.updateSourceFileState({
      knowledgeBaseId: work.knowledgeBaseId,
      publicId: current.sourceFile.publicId,
      metadata: current.sourceFile.metadata,
      status: "failed",
      safeErrorCode: code,
      safeErrorMessage: null,
      modelInvocation,
      revisionCheck: { expectedRevision: processingFile.revision }
    });
    const failedAt = input.clock();
    await recordSourceEvent(input, {
      kind: resumeFromStage === "publication" ? "publication_failed" : "failed",
      work,
      sourceFile: current.sourceFile,
      sourceRevisionPublicId,
      createdAt: failedAt
    });
    await completeTerminal(input, work, owner, {
      state: "failed",
      resultCode: code,
      sourceRevisionPublicId,
      ...(modelInvocation ? { modelInvocation } : {})
    });
    await dispatchSourceWebhook(input, {
      eventId: sourceEventIdentity("failed", sourceRevisionPublicId),
      eventType: "source_file.failed",
      payload: {
        knowledgeBaseId: work.knowledgeBaseId,
        sourceFileId: current.sourceFile.publicId,
        sourceRevisionId: sourceRevisionPublicId,
        stage: resumeFromStage === "publication"
          ? "search_publication"
          : "model_assistance",
        errorCode: code
      },
      createdAt: failedAt
    });
    return "terminal";
  } finally {
    roleSignal?.removeEventListener("abort", abortFromRole);
    await resources.closeAll();
    resources.assertIdle();
  }
}

function summarizeSkeletonGraphSignals(
  sourceNode: {
    publicId: string;
    metadata: Readonly<Record<string, unknown>>;
  },
  edges: readonly {
    fromNodePublicId: string;
    toNodePublicId: string;
    relation: string;
  }[]
) {
  const bounded = edges.slice(0, 64);
  const neighbors = new Set<string>();
  const relations = new Set<string>();
  let inboundEdgeCount = 0;
  let outboundEdgeCount = 0;
  for (const edge of bounded) {
    if (edge.fromNodePublicId === sourceNode.publicId) {
      outboundEdgeCount += 1;
      neighbors.add(edge.toNodePublicId);
    }
    if (edge.toNodePublicId === sourceNode.publicId) {
      inboundEdgeCount += 1;
      neighbors.add(edge.fromNodePublicId);
    }
    relations.add(edge.relation);
  }
  const contentProfile = readObject(sourceNode.metadata.contentProfile);
  return {
    acceptedEdgeCount: bounded.length,
    inboundEdgeCount,
    outboundEdgeCount,
    distinctNeighborCount: neighbors.size,
    relationKindCount: relations.size,
    contentProfileHeadingCount: boundedStringArrayLength(
      contentProfile?.headingOutline
    ),
    contentProfileDefinitionCount: boundedStringArrayLength(
      contentProfile?.definitions
    ),
    contentProfileExplicitReferenceCount: boundedStringArrayLength(
      contentProfile?.explicitReferences
    )
  };
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedStringArrayLength(value: unknown): number {
  return Array.isArray(value)
    ? Math.min(64, value.filter((item) => typeof item === "string").length)
    : 0;
}

async function dispatchSourceWebhook(
  input: {
    webhooks?: Pick<WebhookDispatcher, "dispatch">;
    onWebhookError?: (error: unknown) => void;
  },
  event: Parameters<WebhookDispatcher["dispatch"]>[0]
): Promise<void> {
  await dispatchWebhookSafely({
    webhooks: input.webhooks,
    event,
    onError: input.onWebhookError
  });
}

function sourceEventIdentity(kind: string, identity: string): string {
  return `event-source-${kind}-${createHash("sha256").update(identity).digest("hex")}`;
}

type SourceEventKind =
  | "accepted"
  | "progress"
  | "semantic_progress"
  | "publication_progress"
  | "publication_failed"
  | "failed";

const SOURCE_EVENT_PRESENTATION = {
  accepted: {
    sequence: 10,
    stageKey: "upload_storage",
    messageKey: "sourceFiles.phase.uploadStorage",
    severity: "info",
    terminal: false
  },
  progress: {
    sequence: 20,
    stageKey: "metadata_resolution",
    messageKey: "sourceFiles.phase.metadataResolution",
    severity: "info",
    terminal: false
  },
  semantic_progress: {
    sequence: 30,
    stageKey: "graphrag_processing",
    messageKey: "sourceFiles.phase.graphragProcessing",
    severity: "info",
    terminal: false
  },
  publication_progress: {
    sequence: 30,
    stageKey: "search_publication",
    messageKey: "sourceFiles.phase.searchPublication",
    severity: "info",
    terminal: false
  },
  publication_failed: {
    sequence: 30,
    stageKey: "search_publication",
    messageKey: "sourceFiles.phase.searchPublication",
    severity: "error",
    terminal: true
  },
  failed: {
    sequence: 30,
    stageKey: "llm_suggestion",
    messageKey: "sourceFiles.phase.llmSuggestion",
    severity: "error",
    terminal: true
  }
} as const;

async function recordSourceEvent(
  input: StorageVnextSourceProcessingPorts & { limits: WorkerLimits },
  event: {
    kind: SourceEventKind;
    work: StorageVnextLiveWork;
    sourceFile: StorageVnextSourceFileFact;
    sourceRevisionPublicId: string;
    createdAt: string;
  }
): Promise<void> {
  const presentation = SOURCE_EVENT_PRESENTATION[event.kind];
  await input.events.record({
    publicId: `source-event-${event.kind}-${createHash("sha256")
      .update(`${event.work.publicId}:${event.sourceRevisionPublicId}:${event.work.attempt}`)
      .digest("hex")}`,
    knowledgeBaseId: event.work.knowledgeBaseId,
    sourceFilePublicId: event.sourceFile.publicId,
    sourceRevisionPublicId: event.sourceRevisionPublicId,
    sequence: presentation.sequence,
    stageKey: presentation.stageKey,
    messageKey: presentation.messageKey,
    startedAt: event.createdAt,
    endedAt: presentation.terminal ? event.createdAt : null,
    severity: presentation.severity,
    createdAt: event.createdAt,
    expiresAt: addMilliseconds(
      event.createdAt,
      input.limits.resultRetentionMilliseconds
    )
  });
}

function trackBody(body: AsyncIterable<Uint8Array>): {
  body: AsyncIterable<Uint8Array>;
  close: () => Promise<void>;
  readonly completed: boolean;
} {
  const iterator = body[Symbol.asyncIterator]();
  let closed = false;
  const tracked: AsyncIterator<Uint8Array> = {
    async next() {
      const value = await iterator.next();
      if (value.done) closed = true;
      return value;
    },
    async return() {
      if (!closed && iterator.return) await iterator.return();
      closed = true;
      return { done: true, value: undefined };
    },
    async throw(error?: unknown) {
      if (iterator.throw) return iterator.throw(error);
      if (!closed && iterator.return) await iterator.return();
      closed = true;
      throw error;
    }
  };
  return {
    body: { [Symbol.asyncIterator]: () => tracked },
    get completed() {
      return closed;
    },
    async close() {
      if (!closed && tracked.return) await tracked.return();
    }
  };
}

async function loadCurrentFacts(
  input: StorageVnextSourceProcessingPorts,
  work: StorageVnextLiveWork,
  sourceRevisionPublicId: string
): Promise<
  | { outcome: "deleted" | "superseded" }
  | {
      outcome: "current";
      sourceFile: NonNullable<Awaited<ReturnType<typeof input.catalog.getSourceFile>>>;
      sourceRevision: NonNullable<Awaited<ReturnType<typeof input.catalog.getSourceRevision>>>;
    }
> {
  const knowledgeBase = await input.catalog.getKnowledgeBase({
    knowledgeBaseId: work.knowledgeBaseId,
    visibility: "all"
  });
  if (!knowledgeBase || knowledgeBase.visibility === "deleted") return { outcome: "deleted" };
  const sourceRevision = await input.catalog.getSourceRevision({
    knowledgeBaseId: work.knowledgeBaseId,
    publicId: sourceRevisionPublicId
  });
  if (!sourceRevision) return { outcome: "superseded" };
  const sourceFile = await input.catalog.getSourceFile({
    knowledgeBaseId: work.knowledgeBaseId,
    publicId: sourceRevision.sourceFilePublicId,
    visibility: "all"
  });
  if (!sourceFile || sourceFile.visibility === "deleted") return { outcome: "superseded" };
  const currentRevision = await input.catalog.getCurrentSourceRevision({
    knowledgeBaseId: work.knowledgeBaseId,
    sourceFilePublicId: sourceFile.publicId
  });
  if (
    !currentRevision
    || currentRevision.publicId !== sourceRevisionPublicId
    || sourceFile.currentRevisionPublicId !== sourceRevisionPublicId
  ) return { outcome: "superseded" };
  return { outcome: "current", sourceFile, sourceRevision };
}

async function completeTerminal(
  input: StorageVnextSourceProcessingPorts & { limits: WorkerLimits; clock: () => string },
  work: StorageVnextLiveWork,
  owner: string,
  terminal: {
    state: "failed" | "superseded" | "deleted";
    resultCode: string;
    sourceRevisionPublicId: string;
    modelInvocation?: StorageVnextModelInvocationFact;
  }
): Promise<void> {
  await input.workflow.complete({
    publicId: work.publicId,
    owner,
    result: result(input, work, {
      state: terminal.state,
      resultCode: terminal.resultCode,
      correlationPublicId: terminal.sourceRevisionPublicId,
      summary: {
        sourceRevisionPublicId: terminal.sourceRevisionPublicId,
        ...(terminal.modelInvocation
          ? modelInvocationSummary(terminal.modelInvocation)
          : {})
      }
    })
  });
}

function createInitialModelInvocation(
  configured: { modelName: string } | null,
  sourceRevisionPublicId: string,
  skippedAt: string
): StorageVnextModelInvocationFact | null {
  if (configured) return null;
  return {
    sourceRevisionPublicId,
    status: "skipped",
    modelName: null,
    startedAt: null,
    endedAt: skippedAt,
    warningCount: 0,
    errorCode: null
  };
}

function createRunningModelInvocation(
  configured: { modelName: string },
  sourceRevisionPublicId: string,
  startedAt: string
): StorageVnextModelInvocationFact {
  return {
    sourceRevisionPublicId,
    status: "running",
    modelName: configured.modelName,
    startedAt,
    endedAt: null,
    warningCount: 0,
    errorCode: null
  };
}

function completeModelInvocation(
  invocation: StorageVnextModelInvocationFact,
  endedAt: string,
  warningCount: number
): StorageVnextModelInvocationFact {
  if (invocation.status === "skipped") return invocation;
  if (!Number.isSafeInteger(warningCount) || warningCount < 0 || warningCount > 1_000) {
    throw workerError("invalid_model_result");
  }
  return { ...invocation, status: "completed", endedAt, warningCount };
}

function failModelInvocation(
  invocation: StorageVnextModelInvocationFact | null,
  endedAt: string,
  errorCode: string
): StorageVnextModelInvocationFact | null {
  if (!invocation) return null;
  if (invocation.status === "skipped" || invocation.status === "completed") return invocation;
  return { ...invocation, status: "failed", endedAt, errorCode };
}

function modelInvocationSummary(invocation: StorageVnextModelInvocationFact) {
  return {
    modelInvocationStatus: invocation.status,
    modelInvocationModelName: invocation.modelName,
    modelInvocationStartedAt: invocation.startedAt,
    modelInvocationEndedAt: invocation.endedAt,
    modelInvocationWarningCount: invocation.warningCount,
    modelInvocationErrorCode: invocation.errorCode
  };
}

function result(
  input: { limits: WorkerLimits; clock: () => string },
  work: StorageVnextLiveWork,
  value: Pick<
    StorageVnextBoundedResult,
    "state" | "resultCode" | "correlationPublicId" | "summary"
  >
): StorageVnextBoundedResult {
  const completedAt = input.clock();
  return {
    publicId: work.publicId,
    knowledgeBaseId: work.knowledgeBaseId,
    kind: "source",
    ...value,
    safeMessage: null,
    completedAt,
    expiresAt: addMilliseconds(completedAt, input.limits.resultRetentionMilliseconds)
  };
}

function assertModelIdentity(
  sourceFile: StorageVnextSourceFileFact,
  sourceRevisionPublicId: string,
  model: {
    node: { knowledgeBaseId: string; sourceFilePublicId: string; sourceRevisionPublicId: string };
    edges: readonly unknown[];
    modelAssistanceUsed: boolean;
  }
): void {
  if (
    model.node.knowledgeBaseId !== sourceFile.knowledgeBaseId
    || model.node.sourceFilePublicId !== sourceFile.publicId
    || model.node.sourceRevisionPublicId !== sourceRevisionPublicId
    || typeof model.modelAssistanceUsed !== "boolean"
    || model.edges.length > 1_000
  ) throw workerError("invalid_model_result");
}

function checkpointRevision(work: StorageVnextLiveWork): string {
  const value = work.checkpoint.sourceRevisionPublicId;
  if (typeof value !== "string" || value.length === 0) {
    throw workerError("invalid_checkpoint");
  }
  return value;
}

function semanticResumeStage(work: StorageVnextLiveWork): "publication" | null {
  const value = work.checkpoint.semanticResumeStage;
  if (value === undefined) return null;
  if (value !== "publication") throw workerError("invalid_checkpoint");
  return value;
}

function reusableModelInvocation(
  sourceFile: StorageVnextSourceFileFact,
  sourceRevisionPublicId: string
): StorageVnextModelInvocationFact {
  const invocation = sourceFile.modelInvocation;
  if (
    invocation?.sourceRevisionPublicId !== sourceRevisionPublicId
    || !["completed", "skipped"].includes(invocation.status)
  ) throw workerError("invalid_checkpoint");
  return invocation;
}

function createAttemptPublicId(work: StorageVnextLiveWork, revisionPublicId: string): string {
  const digest = createHash("sha256")
    .update("storage-vnext-source-model-attempt-v1\0")
    .update(work.publicId)
    .update("\0")
    .update(String(work.attempt))
    .update("\0")
    .update(revisionPublicId)
    .digest("hex");
  return `source-model-attempt-${digest}`;
}

function safeFailureCode(error: unknown, signal: AbortSignal): string {
  const reason = signal.aborted ? signal.reason : error;
  if (reason instanceof Error && ["AbortError", "TimeoutError"].includes(reason.name)) {
    return "SOURCE_MODEL_TIMEOUT";
  }
  if (reason instanceof Error && "code" in reason) {
    const code = String(reason.code);
    if (/^semantic_[a-z0-9_]+$/u.test(code) && code.length <= 128) {
      return code;
    }
  }
  return "SOURCE_MODEL_FAILED";
}

function isRetryableFailure(error: unknown): boolean {
  return !(error instanceof Error
    && "retryable" in error
    && error.retryable === false);
}

function isStaleFailure(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return ["revision_conflict", "stale_source_revision"].includes(String(error.code));
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function assertClaimedWork(work: StorageVnextLiveWork, owner: string): void {
  if (
    work.kind !== "source"
    || work.state !== "running"
    || work.leaseOwner !== owner
  ) throw workerError("invalid_claim");
}

function assertClaim(
  request: { owner: string; limit: number; leaseExpiresAt: string },
  maximumConcurrency: number
): void {
  if (
    request.owner.length === 0
    || !Number.isSafeInteger(request.limit)
    || request.limit < 1
    || request.limit > maximumConcurrency
    || !Number.isFinite(Date.parse(request.leaseExpiresAt))
  ) throw workerError("invalid_limit");
}

function validateLimits(limits: WorkerLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw workerError("invalid_limits");
  }
}

function workerError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Storage vNext source processing error: ${code}`), { code });
}

function semanticBlockedError(code: string | null): Error & {
  code: string;
  retryable: false;
} {
  return Object.assign(
    new Error(`Storage vNext semantic source processing blocked: ${code ?? "unknown"}`),
    { code: code ?? "semantic_processing_blocked", retryable: false as const }
  );
}
