import type {
  ProjectionRepairBuildRepository,
  ProjectionRepairWorkItem,
  ProjectionRepairWorkRepository
} from "../application/ports/projection-repair-work-repository.js";
import type {
  GenerationObjectReferenceRepository
} from "../application/ports/generation-object-reference-repository.js";
import type {
  PublicationGenerationRepository
} from "../application/ports/publication-generation-repository.js";
import type {
  PublicationValidationRepository
} from "../application/ports/publication-validation-repository.js";
import { createGeneratedFileId } from "../domain/generated-file-id.js";
import { RoleJobFailure } from "../domain/role-job.js";
import type { RuntimeLogger } from "../logger.js";
import {
  GENERATED_GRAPH_RESOURCES,
  GENERATED_ROOT_MANIFEST_PATHS
} from "../okf/generated-graph-resources.js";
import { renderBoundedRootFile } from "../publication/bounded-root-writer.js";
import {
  directoryLeafPath,
  directoryLeafRefKey,
  renderDirectoryLeafMarkdown,
  renderDirectoryRootMarkdown
} from "../publication/directory-navigation-writer.js";
import {
  ImmutableObjectWriteInProgressError,
  type ImmutableObjectWriteResult
} from "../publication/immutable-object-writer.js";
import type { JsonProjectionRecord } from "../publication/projection-shard-partitioning.js";
import { sanitizeDiagnosticText } from "../runtime/error-diagnostics.js";
import { createProjectionRepairDirectoryStream } from "./projection-repair-directory-builder.js";

const REPAIR_ROOT_PATHS = [
  "index.md",
  "schema.md",
  "log.md",
  "_index/index.md",
  GENERATED_GRAPH_RESOURCES.index.path
];

type ObjectMetrics = {
  writes: number;
  reuses: number;
};

type ProjectionRepairTaskResult = {
  status: "completed" | "retry" | "failed" | "superseded" | "deferred" | "lost";
  processedRecordCount: number;
};

export function createProjectionRepairTaskProcessor(input: {
  work: ProjectionRepairWorkRepository;
  builds: ProjectionRepairBuildRepository;
  shards: {
    applyBatch(request: {
      knowledgeBaseId: string;
      generationId: string;
      projectionKind: string;
      shardKey: string;
      logicalPath: string;
      changes: Array<{ recordId: string; record: JsonProjectionRecord | null }>;
    }): Promise<{
      recordCount: number;
      objectWriteCount?: number;
      objectReuseCount?: number;
    }>;
  };
  catalog: {
    finalize(request: {
      knowledgeBaseId: string;
      generationId: string;
    }): Promise<void>;
  };
  references: GenerationObjectReferenceRepository;
  immutableObjects: {
    write(object: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number;
    }): Promise<ImmutableObjectWriteResult>;
  };
  validation: PublicationValidationRepository;
  generations: Pick<
    PublicationGenerationRepository,
    "markGenerationState" | "activateGeneration" | "failGeneration"
  >;
  directoryLimits: {
    maxEntries: number;
    maxBytes: number;
  };
  validationIssueLimit: number;
  leaseTtlMs: number;
  retryDelayMs: number;
  logger: Pick<RuntimeLogger, "info" | "warn" | "error">;
  now?: () => Date;
}): (task: ProjectionRepairWorkItem) => Promise<ProjectionRepairTaskResult> {
  const now = input.now ?? (() => new Date());
  return async (task) => {
    const metrics: ObjectMetrics = { writes: 0, reuses: 0 };
    const startedAt = now();
    input.logger.info("Projection repair subtask started", safeTaskFields(task));
    try {
      const processedRecordCount = await withLeaseHeartbeat({
        task,
        work: input.work,
        leaseTtlMs: input.leaseTtlMs,
        now,
        operation: () => executeTask(input, task, metrics, now)
      });
      if (processedRecordCount === "superseded") {
        input.logger.info("Projection repair candidate superseded", safeTaskFields(task));
        return { status: "superseded", processedRecordCount: 0 };
      }
      if (processedRecordCount === "deferred") {
        input.logger.info("Projection repair catch-up scheduled", safeTaskFields(task));
        return { status: "deferred", processedRecordCount: 0 };
      }
      if (processedRecordCount === "lost") {
        input.logger.warn("Projection repair subtask ownership changed", safeTaskFields(task));
        return { status: "lost", processedRecordCount: 0 };
      }
      const completed = await input.work.completeTask({
        task,
        processedRecordCount,
        objectWriteCount: metrics.writes,
        objectReuseCount: metrics.reuses,
        durationMs: Math.max(1, now().getTime() - startedAt.getTime()),
        completedAt: now().toISOString()
      });
      if (!completed) return { status: "lost", processedRecordCount: 0 };
      if (task.kind === "finalize") {
        const repairCompleted = await input.work.completeRepair({
          task,
          activeGenerationId: task.targetGenerationId,
          completedAt: now().toISOString()
        });
        if (!repairCompleted) {
          input.logger.warn("Projection repair completion ownership changed", safeTaskFields(task));
          return { status: "lost", processedRecordCount: 0 };
        }
      }
      input.logger.info("Projection repair subtask completed", {
        ...safeTaskFields(task),
        processedRecordCount,
        objectWriteCount: metrics.writes,
        objectReuseCount: metrics.reuses,
        durationMs: Math.max(0, now().getTime() - startedAt.getTime())
      });
      return { status: "completed", processedRecordCount };
    } catch (error) {
      const failure = classifyFailure(error);
      const failedAt = now();
      const status = await input.work.retryTask({
        task,
        errorCode: failure.code,
        errorMessage: failure.message,
        retryable: failure.retryable,
        retryAt: new Date(failedAt.getTime() + input.retryDelayMs).toISOString(),
        failedAt: failedAt.toISOString()
      });
      input.logger[status === "failed" ? "error" : "warn"](
        status === "failed"
          ? "Projection repair subtask failed"
          : "Projection repair subtask scheduled for retry",
        {
          ...safeTaskFields(task),
          errorCode: failure.code,
          errorMessage: failure.message,
          retryable: failure.retryable
        }
      );
      return { status, processedRecordCount: 0 };
    }
  };
}

async function executeTask(
  input: Parameters<typeof createProjectionRepairTaskProcessor>[0],
  task: ProjectionRepairWorkItem,
  metrics: ObjectMetrics,
  now: () => Date
): Promise<number | "superseded" | "deferred" | "lost"> {
  if (task.kind === "tree_partition") {
    const staged = await stageBatches({
      task,
      work: input.work,
      now,
      stage: (cursor) => input.builds.stageTreeBatch({
        task,
        cursor,
        limit: task.settings.databaseBatchSize
      })
    });
    const records = await input.builds.listStagedTreePartition({
      task,
      limit: Math.max(
        task.settings.databaseBatchSize,
        task.expectedRecordCount,
        staged
      )
    });
    if (records.length !== staged) {
      throw terminalFailure(
        "PROJECTION_REPAIR_TREE_PARITY_FAILED",
        "Projection repair tree partition count does not match its plan"
      );
    }
    await acceptCountDriftAfterGenerationAdvance({
      input,
      task,
      actualCount: staged,
      errorCode: "PROJECTION_REPAIR_TREE_PARITY_FAILED",
      errorMessage: "Projection repair tree partition count does not match its plan"
    });
    if (records.length === 0) return 0;
    const result = await input.shards.applyBatch({
      knowledgeBaseId: task.knowledgeBaseId,
      generationId: task.targetGenerationId,
      projectionKind: "tree",
      shardKey: task.partitionKey,
      logicalPath: `_index/${task.partitionKey}.json`,
      changes: records.map((record) => ({
        recordId: record.recordId,
        record: record.payload as JsonProjectionRecord
      }))
    });
    metrics.writes += result.objectWriteCount ?? 0;
    metrics.reuses += result.objectReuseCount ?? 0;
    return records.length;
  }

  if (task.kind === "tree_rebase") {
    const partitionKey = decodeRebasePartitionKey(task.partitionKey);
    const effectiveTask = { ...task, partitionKey };
    const staged = await stageBatches({
      task,
      work: input.work,
      now,
      stage: (cursor) => input.builds.stageTreeRebaseBatch({
        task: effectiveTask,
        cursor,
        limit: task.settings.databaseBatchSize
      })
    });
    const changes = await input.builds.listStagedTreeRebaseChanges({
      task: effectiveTask,
      limit: Math.max(
        task.settings.databaseBatchSize,
        task.expectedRecordCount,
        staged
      )
    });
    if (changes.length !== staged) {
      throw terminalFailure(
        "PROJECTION_REPAIR_TREE_REBASE_PARITY_FAILED",
        "Projection repair tree catch-up count does not match its plan"
      );
    }
    await acceptCountDriftAfterGenerationAdvance({
      input,
      task,
      actualCount: staged,
      errorCode: "PROJECTION_REPAIR_TREE_REBASE_PARITY_FAILED",
      errorMessage: "Projection repair tree catch-up count does not match its plan"
    });
    if (changes.length === 0) return 0;
    const result = await input.shards.applyBatch({
      knowledgeBaseId: task.knowledgeBaseId,
      generationId: task.targetGenerationId,
      projectionKind: "tree",
      shardKey: partitionKey,
      logicalPath: `_index/${partitionKey}.json`,
      changes: changes.map((change) => ({
        recordId: change.recordId,
        record: change.record as JsonProjectionRecord | null
      }))
    });
    metrics.writes += result.objectWriteCount ?? 0;
    metrics.reuses += result.objectReuseCount ?? 0;
    return changes.length;
  }

  if (task.kind === "directory" || task.kind === "directory_rebase") {
    const effectiveTask = task.kind === "directory_rebase"
      ? { ...task, partitionKey: decodeRebasePartitionKey(task.partitionKey) }
      : task;
    const activeReferences = await input.builds.listActiveDirectoryReferences({
      task: effectiveTask
    });
    await input.builds.resetDirectorySnapshot({ task: effectiveTask });
    for (const reference of activeReferences) {
      await input.references.stageDelete({
        knowledgeBaseId: task.knowledgeBaseId,
        generationId: task.targetGenerationId,
        refKind: reference.refKind,
        refKey: reference.refKey,
        logicalPath: reference.logicalPath,
        sourceFileId: null
      });
    }
    if (
      task.kind === "directory_rebase"
      && !(await input.builds.directoryExists({ task: effectiveTask }))
    ) {
      return 0;
    }
    const stream = createProjectionRepairDirectoryStream({
      directoryPath: effectiveTask.partitionKey,
      limits: input.directoryLimits,
      writeLeaf: async (leaf) => {
        await input.builds.upsertDirectoryLeaf({ task: effectiveTask, leaf });
        const logicalPath = directoryLeafPath(effectiveTask.partitionKey, leaf.id);
        const object = await writeTracked(input.immutableObjects, metrics, {
          body: renderDirectoryLeafMarkdown({
            directoryPath: effectiveTask.partitionKey,
            leaf
          }),
          contentType: "text/markdown; charset=utf-8"
        });
        await input.references.stageUpsert({
          knowledgeBaseId: task.knowledgeBaseId,
          generationId: task.targetGenerationId,
          refKind: "directory_leaf",
          refKey: directoryLeafRefKey(effectiveTask.partitionKey, leaf.id),
          fileId: createGeneratedFileId({
            refKind: "directory_leaf",
            refKey: directoryLeafRefKey(effectiveTask.partitionKey, leaf.id),
            sourceFileId: null
          }),
          checksumSha256: object.checksumSha256,
          formatVersion: object.formatVersion,
          logicalPath,
          sourceFileId: null,
          projectionShardId: null
        });
      }
    });
    let cursor = null;
    do {
      const page = await input.builds.listDirectoryEntryPage({
        task: effectiveTask,
        cursor,
        limit: task.settings.databaseBatchSize
      });
      for (const entry of page.entries) await stream.add(entry);
      cursor = page.nextCursor;
    } while (cursor);
    const summary = await stream.finish();
    await acceptCountDriftAfterGenerationAdvance({
      input,
      task,
      actualCount: summary.entryCount,
      errorCode: "PROJECTION_REPAIR_DIRECTORY_PARITY_FAILED",
      errorMessage: "Projection repair directory count does not match its plan"
    });
    await input.builds.completeDirectorySnapshot({
      task: effectiveTask,
      entryCount: summary.entryCount,
      firstLeafId: summary.firstLeafId
    });
    const rootObject = await writeTracked(input.immutableObjects, metrics, {
      body: renderDirectoryRootMarkdown({
        directoryPath: effectiveTask.partitionKey,
        entryCount: summary.entryCount,
        firstLeafId: summary.firstLeafId
      }),
      contentType: "text/markdown; charset=utf-8"
    });
    const rootRefKey = `directory-root:${effectiveTask.partitionKey}`;
    await input.references.stageUpsert({
      knowledgeBaseId: task.knowledgeBaseId,
      generationId: task.targetGenerationId,
      refKind: "directory_root",
      refKey: rootRefKey,
      fileId: createGeneratedFileId({
        refKind: "directory_root",
        refKey: rootRefKey,
        sourceFileId: null
      }),
      checksumSha256: rootObject.checksumSha256,
      formatVersion: rootObject.formatVersion,
      logicalPath: `${effectiveTask.partitionKey}/index.md`,
      sourceFileId: null,
      projectionShardId: null
    });
    return summary.entryCount;
  }

  if (task.kind === "graph_partition") {
    const [projectionKind, shardKey] = task.partitionKey.split("\u001f", 2);
    if (
      (projectionKind !== "graph_node" && projectionKind !== "graph_edge")
      || !shardKey
    ) {
      throw terminalFailure(
        "PROJECTION_REPAIR_GRAPH_PARTITION_INVALID",
        "Projection repair graph partition is invalid"
      );
    }
    const staged = await stageBatches({
      task,
      work: input.work,
      now,
      stage: (cursor) => input.builds.stageGraphBatch({
        task,
        projectionKind,
        shardKey,
        cursor,
        limit: task.settings.databaseBatchSize
      })
    });
    const records = await input.builds.listStagedGraphPartition({
      task,
      projectionKind,
      shardKey,
      limit: Math.max(
        task.settings.databaseBatchSize,
        task.expectedRecordCount,
        staged
      )
    });
    if (records.length !== staged) {
      throw terminalFailure(
        "PROJECTION_REPAIR_GRAPH_PARTITION_PARITY_FAILED",
        "Projection repair graph partition count does not match its plan"
      );
    }
    await acceptCountDriftAfterGenerationAdvance({
      input,
      task,
      actualCount: staged,
      errorCode: "PROJECTION_REPAIR_GRAPH_PARTITION_PARITY_FAILED",
      errorMessage: "Projection repair graph partition count does not match its plan"
    });
    if (records.length === 0) return 0;
    const result = await input.shards.applyBatch({
      knowledgeBaseId: task.knowledgeBaseId,
      generationId: task.targetGenerationId,
      projectionKind,
      shardKey,
      logicalPath: `_graph/${shardKey}.json`,
      changes: records.map((record) => ({
        recordId: record.recordId,
        record: record.payload as JsonProjectionRecord
      }))
    });
    metrics.writes += result.objectWriteCount ?? 0;
    metrics.reuses += result.objectReuseCount ?? 0;
    return records.length;
  }

  if (task.kind === "graph_rebase") {
    const partitionKey = decodeRebasePartitionKey(task.partitionKey);
    const [projectionKind, shardKey] = partitionKey.split("\u001f", 2);
    if (
      (projectionKind !== "graph_node" && projectionKind !== "graph_edge")
      || !shardKey
    ) {
      throw terminalFailure(
        "PROJECTION_REPAIR_GRAPH_PARTITION_INVALID",
        "Projection repair graph catch-up partition is invalid"
      );
    }
    const effectiveTask = { ...task, partitionKey };
    const staged = await stageBatches({
      task,
      work: input.work,
      now,
      stage: (cursor) => input.builds.stageGraphRebaseBatch({
        task: effectiveTask,
        projectionKind,
        shardKey,
        cursor,
        limit: task.settings.databaseBatchSize
      })
    });
    const changes = await input.builds.listStagedGraphRebaseChanges({
      task: effectiveTask,
      projectionKind,
      shardKey,
      limit: Math.max(
        task.settings.databaseBatchSize,
        task.expectedRecordCount,
        staged
      )
    });
    if (changes.length !== staged) {
      throw terminalFailure(
        "PROJECTION_REPAIR_GRAPH_REBASE_PARITY_FAILED",
        "Projection repair graph catch-up count does not match its plan "
          + `(staged=${staged}, loaded=${changes.length})`
      );
    }
    await acceptCountDriftAfterGenerationAdvance({
      input,
      task,
      actualCount: staged,
      errorCode: "PROJECTION_REPAIR_GRAPH_REBASE_PARITY_FAILED",
      errorMessage: "Projection repair graph catch-up count does not match its plan"
    });
    if (changes.length === 0) return 0;
    const result = await input.shards.applyBatch({
      knowledgeBaseId: task.knowledgeBaseId,
      generationId: task.targetGenerationId,
      projectionKind,
      shardKey,
      logicalPath: `_graph/${shardKey}.json`,
      changes: changes.map((change) => ({
        recordId: change.recordId,
        record: change.record as JsonProjectionRecord | null
      }))
    });
    metrics.writes += result.objectWriteCount ?? 0;
    metrics.reuses += result.objectReuseCount ?? 0;
    return changes.length;
  }

  if (task.kind === "graph_finalize" || task.kind === "graph_rebase_finalize") {
    const result = await input.builds.aggregateGraph({
      task,
      updatedAt: now().toISOString()
    });
    const total = result.nodeCount + result.edgeCount;
    await acceptCountDriftAfterGenerationAdvance({
      input,
      task,
      actualCount: total,
      errorCode: "PROJECTION_REPAIR_GRAPH_PARITY_FAILED",
      errorMessage: "Projection repair graph count does not match its plan"
    });
    return 0;
  }

  const catchUp = await input.work.scheduleCatchUp({
    task,
    scheduledAt: now().toISOString()
  });
  if (catchUp === "scheduled") return "deferred";
  if (catchUp === "lost") return "lost";

  const descriptor = await input.builds.readRepairDescriptor({ task });
  if (!descriptor) {
    throw terminalFailure(
      "PROJECTION_REPAIR_KNOWLEDGE_BASE_MISSING",
      "Projection repair knowledge base is unavailable"
    );
  }
  if (descriptor.activeGenerationId === task.targetGenerationId) {
    return 0;
  }
  if (
    descriptor.activeGenerationId !== task.baseGenerationId
    || descriptor.resourceRevision !== task.sourceWatermark
  ) {
    const scheduled = await input.work.scheduleCatchUp({
      task,
      scheduledAt: now().toISOString()
    });
    if (scheduled === "scheduled") return "deferred";
    if (scheduled === "lost") return "lost";
  }
  await input.builds.inheritSearchProjectionReferences({ task });
  for (const path of REPAIR_ROOT_PATHS) {
    const rendered = renderBoundedRootFile({
      path,
      knowledgeBase: descriptor,
      rootEntryCount: descriptor.rootEntryCount,
      generationId: task.targetGenerationId
    });
    const object = await writeTracked(input.immutableObjects, metrics, rendered);
    await input.references.stageUpsert({
      knowledgeBaseId: task.knowledgeBaseId,
      generationId: task.targetGenerationId,
      refKind: "root",
      refKey: path,
      fileId: createGeneratedFileId({
        refKind: "root",
        refKey: path,
        sourceFileId: null
      }),
      checksumSha256: object.checksumSha256,
      formatVersion: object.formatVersion,
      logicalPath: path,
      sourceFileId: null,
      projectionShardId: null
    });
  }
  await input.catalog.finalize({
    knowledgeBaseId: task.knowledgeBaseId,
    generationId: task.targetGenerationId
  });
  await input.generations.markGenerationState({
    knowledgeBaseId: task.knowledgeBaseId,
    generationId: task.targetGenerationId,
    expectedState: "building",
    state: "validating",
    updatedAt: now().toISOString()
  });
  const issues = await input.validation.validateChangedClosure({
    knowledgeBaseId: task.knowledgeBaseId,
    generationId: task.targetGenerationId,
    issueLimit: input.validationIssueLimit
  });
  if (issues.length > 0) {
    throw terminalFailure(
      "PROJECTION_REPAIR_VALIDATION_FAILED",
      issues.map((issue) => issue.code).join(",")
    );
  }
  const roots = [];
  for (const path of GENERATED_ROOT_MANIFEST_PATHS) {
    const reference = await input.references.findStagedByRef({
      knowledgeBaseId: task.knowledgeBaseId,
      generationId: task.targetGenerationId,
      refKind: "root",
      refKey: path
    }) ?? await input.references.findActiveByRef({
      knowledgeBaseId: task.knowledgeBaseId,
      refKind: "root",
      refKey: path
    });
    if (!reference) {
      throw terminalFailure(
        "PROJECTION_REPAIR_ROOT_MISSING",
        "Projection repair root reference is unavailable"
      );
    }
    roots.push({
      path,
      checksumSha256: reference.checksumSha256,
      objectKey: reference.objectKey,
      contentType: reference.contentType,
      sizeBytes: reference.sizeBytes
    });
  }
  const manifest = await writeTracked(input.immutableObjects, metrics, {
    body: `${JSON.stringify({
      formatVersion: 1,
      knowledgeBaseId: task.knowledgeBaseId,
      generationId: task.targetGenerationId,
      predecessorGenerationId: task.baseGenerationId,
      roots
    })}\n`,
    contentType: "application/json; charset=utf-8"
  });
  await input.references.stageUpsert({
    knowledgeBaseId: task.knowledgeBaseId,
    generationId: task.targetGenerationId,
    refKind: "generation_manifest",
    refKey: "root",
    fileId: `generation-manifest-${task.targetGenerationId}`,
    checksumSha256: manifest.checksumSha256,
    formatVersion: manifest.formatVersion,
    logicalPath: null,
    sourceFileId: null,
    projectionShardId: null
  });
  const activated = await input.generations.activateGeneration({
    knowledgeBaseId: task.knowledgeBaseId,
    generationId: task.targetGenerationId,
    expectedPredecessorGenerationId: task.baseGenerationId,
    rootManifestChecksumSha256: manifest.checksumSha256,
    rootManifestObjectKey: manifest.objectKey,
    activatedAt: now().toISOString()
  });
  if (!activated) {
    const scheduled = await input.work.scheduleCatchUp({
      task,
      scheduledAt: now().toISOString()
    });
    if (scheduled === "scheduled") return "deferred";
    if (scheduled === "lost") return "lost";
    throw new RoleJobFailure({
      code: "PROJECTION_REPAIR_ACTIVATION_CONFLICT",
      message: "Projection repair activation precondition changed",
      retryable: true
    });
  }
  return 0;
}

async function acceptCountDriftAfterGenerationAdvance(input: {
  input: Parameters<typeof createProjectionRepairTaskProcessor>[0];
  task: ProjectionRepairWorkItem;
  actualCount: number;
  errorCode: string;
  errorMessage: string;
}): Promise<void> {
  if (input.actualCount === input.task.expectedRecordCount) return;
  const descriptor = await input.input.builds.readRepairDescriptor({
    task: input.task
  });
  if (
    descriptor
    && descriptor.activeGenerationId !== input.task.baseGenerationId
  ) {
    return;
  }
  throw terminalFailure(
    input.errorCode,
    `${input.errorMessage} `
      + `(expected=${input.task.expectedRecordCount}, actual=${input.actualCount})`
  );
}

async function stageBatches(input: {
  task: ProjectionRepairWorkItem;
  work: ProjectionRepairWorkRepository;
  now: () => Date;
  stage: (cursor: string | null) => Promise<{
    processedRecordCount: number;
    nextCursor: string | null;
    complete: boolean;
  }>;
}): Promise<number> {
  let cursor = readCheckpointCursor(input.task.checkpoint);
  let processedRecordCount = input.task.processedRecordCount;
  while (true) {
    const batchStartedAt = input.now();
    const batch = await input.stage(cursor);
    if (batch.processedRecordCount === 0 && !batch.complete) {
      throw terminalFailure(
        "PROJECTION_REPAIR_BATCH_STALLED",
        "Projection repair batch did not advance"
      );
    }
    processedRecordCount += batch.processedRecordCount;
    cursor = batch.nextCursor;
    const checkpointedAt = input.now().toISOString();
    const checkpointed = await input.work.checkpointTask({
      task: input.task,
      checkpoint: { cursor },
      processedRecordCount,
      batchDurationMs: Math.max(1, input.now().getTime() - batchStartedAt.getTime()),
      checkpointedAt
    });
    if (!checkpointed) {
      throw new RoleJobFailure({
        code: "PROJECTION_REPAIR_LEASE_LOST",
        message: "Projection repair subtask lease was lost",
        retryable: true
      });
    }
    if (batch.complete) return processedRecordCount;
  }
}

function readCheckpointCursor(checkpoint: ProjectionRepairWorkItem["checkpoint"]): string | null {
  if (
    !checkpoint
    || typeof checkpoint !== "object"
    || checkpoint instanceof Date
    || Array.isArray(checkpoint)
  ) return null;
  const cursor = (checkpoint as { readonly cursor?: unknown }).cursor;
  return typeof cursor === "string" ? cursor : null;
}

function decodeRebasePartitionKey(value: string): string {
  const separator = value.indexOf("\u001e");
  if (separator < 1 || separator === value.length - 1) {
    throw terminalFailure(
      "PROJECTION_REPAIR_REBASE_PARTITION_INVALID",
      "Projection repair catch-up partition is invalid"
    );
  }
  return value.slice(separator + 1);
}

async function writeTracked(
  writer: Parameters<typeof createProjectionRepairTaskProcessor>[0]["immutableObjects"],
  metrics: ObjectMetrics,
  object: { body: string | Uint8Array; contentType: string; formatVersion?: number }
): Promise<ImmutableObjectWriteResult> {
  const result = await writer.write(object);
  if (result.reused) metrics.reuses += 1;
  else metrics.writes += 1;
  return result;
}

async function withLeaseHeartbeat<T>(input: {
  task: ProjectionRepairWorkItem;
  work: ProjectionRepairWorkRepository;
  leaseTtlMs: number;
  now: () => Date;
  operation: () => Promise<T>;
}): Promise<T> {
  const intervalMs = Math.max(1_000, Math.floor(input.leaseTtlMs / 3));
  let stopped = false;
  let lost = false;
  const timer = setInterval(() => {
    if (stopped) return;
    const heartbeatAt = input.now();
    void input.work.heartbeat({
      task: input.task,
      heartbeatAt: heartbeatAt.toISOString(),
      leaseExpiresAt: new Date(heartbeatAt.getTime() + input.leaseTtlMs).toISOString()
    }).then((owned) => {
      if (!owned) lost = true;
    });
  }, intervalMs);
  timer.unref();
  try {
    const result = await input.operation();
    if (lost) {
      throw new RoleJobFailure({
        code: "PROJECTION_REPAIR_LEASE_LOST",
        message: "Projection repair subtask lease was lost",
        retryable: true
      });
    }
    return result;
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}

function classifyFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof RoleJobFailure) {
    return {
      code: error.code,
      message: sanitizeDiagnosticText(error.message),
      retryable: error.retryable
    };
  }
  if (error instanceof ImmutableObjectWriteInProgressError) {
    return {
      code: "PROJECTION_REPAIR_WRITE_CONTENDED",
      message: "Projection repair object write is temporarily busy",
      retryable: true
    };
  }
  return {
    code: "PROJECTION_REPAIR_TASK_FAILED",
    message: sanitizeDiagnosticText(
      error instanceof Error ? error.message : "Projection repair subtask failed"
    ),
    retryable: true
  };
}

function terminalFailure(code: string, message: string): RoleJobFailure {
  return new RoleJobFailure({ code, message, retryable: false });
}

function safeTaskFields(task: ProjectionRepairWorkItem) {
  return {
    taskId: task.id,
    knowledgeBaseId: task.knowledgeBaseId,
    repairVersion: task.repairVersion,
    targetGenerationId: task.targetGenerationId,
    taskKind: task.kind,
    partitionKey: task.partitionKey,
    attemptCount: task.attemptCount
  };
}
