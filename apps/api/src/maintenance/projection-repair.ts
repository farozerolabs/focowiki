import { randomUUID } from "node:crypto";
import type { GenerationObjectReferenceRepository } from "../application/ports/generation-object-reference-repository.js";
import type { ProjectionRepairRepository } from "../application/ports/projection-repair-repository.js";
import type { ProjectionRecordRepository } from "../application/ports/projection-record-repository.js";
import type { PublicationGenerationRepository } from "../application/ports/publication-generation-repository.js";
import type { PublicationValidationRepository } from "../application/ports/publication-validation-repository.js";
import { createGeneratedFileId } from "../domain/generated-file-id.js";
import {
  GENERATED_GRAPH_RESOURCES,
  GENERATED_ROOT_MANIFEST_PATHS
} from "../okf/generated-graph-resources.js";
import { renderBoundedRootFile } from "../publication/bounded-root-writer.js";
import type { ImmutableObjectWriteResult } from "../publication/immutable-object-writer.js";
import type { JsonProjectionRecord } from "../publication/projection-shard-partitioning.js";
import type { OrderedDirectoryEntry } from "../publication/ordered-directory-leaves.js";

const REPAIR_ROOT_PATHS = [
  "index.md",
  "schema.md",
  "log.md",
  "_index/index.md",
  GENERATED_GRAPH_RESOURCES.index.path
];

export const CURRENT_PROJECTION_REPAIR_VERSION = 3;

export async function runProjectionRepairSlice(input: {
  repair: ProjectionRepairRepository;
  records: Pick<ProjectionRecordRepository, "stageUpsert">;
  shards: {
    applyBatch: (input: {
      knowledgeBaseId: string;
      generationId: string;
      projectionKind: string;
      shardKey: string;
      logicalPath: string;
      changes: Array<{ recordId: string; record: JsonProjectionRecord | null }>;
    }) => Promise<{ deleted: boolean; recordCount: number; reused: boolean }>;
  };
  navigation: {
    writeEntries: (input: {
      knowledgeBaseId: string;
      generationId: string;
      directoryPath: string;
      entries: Array<{ entryId: string; desiredEntry: OrderedDirectoryEntry | null }>;
      writeRootWhenUnchanged?: boolean;
    }) => Promise<{ handled: true; touchedShardCount: number }>;
  };
  references: GenerationObjectReferenceRepository;
  immutableObjects: {
    write: (input: {
      body: string | Uint8Array;
      contentType: string;
      formatVersion?: number;
    }) => Promise<ImmutableObjectWriteResult>;
  };
  catalog: { finalize: (input: { knowledgeBaseId: string; generationId: string }) => Promise<void> };
  validation: PublicationValidationRepository;
  generations: Pick<
    PublicationGenerationRepository,
    "markGenerationState" | "activateGeneration" | "failGeneration"
  >;
  repairVersion: number;
  treePageSize: number;
  maxAttempts: number;
  retryDelayMs: number;
  validationIssueLimit: number;
  now?: () => Date;
  leaseToken?: string;
  targetGenerationId?: string;
}): Promise<{
  phase: "idle" | "tree" | "navigation" | "graph" | "completed" | "retry" | "failed";
  records: number;
}> {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const leaseToken = input.leaseToken ?? randomUUID();
  await input.repair.bootstrap({
    repairVersion: input.repairVersion,
    bootstrappedAt: startedAt.toISOString()
  });
  const job = await input.repair.claim({
    repairVersion: input.repairVersion,
    leaseToken,
    leaseExpiresAt: new Date(startedAt.getTime() + 5 * 60_000).toISOString(),
    targetGenerationId: input.targetGenerationId ?? `generation-repair-${randomUUID()}`,
    claimedAt: startedAt.toISOString()
  });
  if (!job) return { phase: "idle", records: 0 };

  try {
    if (!job.checkpoint.treeComplete) {
      const page = await input.repair.listTreePage({
        job,
        leaseToken,
        limit: input.treePageSize
      });
      if (page.length === 0) {
        await requireCheckpoint(input.repair.advanceTreeCheckpoint({
          job,
          leaseToken,
          treeCursor: job.checkpoint.treeCursor,
          treeComplete: true,
          updatedAt: now().toISOString()
        }));
        return { phase: "tree", records: 0 };
      }

      for (const records of groupByShard(page).values()) {
        for (const record of records) {
          await input.records.stageUpsert({
            knowledgeBaseId: record.knowledgeBaseId,
            generationId: job.targetGenerationId,
            projectionKind: record.projectionKind,
            recordId: record.recordId,
            shardKey: record.shardKey,
            sourceFileId: record.sourceFileId,
            relatedSourceFileId: record.relatedSourceFileId,
            logicalPath: record.logicalPath,
            parentPath: record.parentPath,
            sortKey: record.sortKey,
            title: record.title,
            summary: record.summary,
            searchableText: renderSearchableText(record.payload),
            payload: record.payload
          });
        }
        const first = records[0]!;
        await input.shards.applyBatch({
          knowledgeBaseId: job.knowledgeBaseId,
          generationId: job.targetGenerationId,
          projectionKind: "tree",
          shardKey: first.shardKey,
          logicalPath: `_index/${first.shardKey}.json`,
          changes: records.map((record) => ({
            recordId: record.recordId,
            record: record.payload as JsonProjectionRecord
          }))
        });
      }
      await requireCheckpoint(input.repair.advanceTreeCheckpoint({
        job,
        leaseToken,
        treeCursor: page.at(-1)!.recordId,
        treeComplete: false,
        updatedAt: now().toISOString()
      }));
      return { phase: "tree", records: page.length };
    }

    if (!job.checkpoint.navigationComplete) {
      const directory = await input.repair.listNextNavigationDirectory({
        job,
        leaseToken
      });
      if (!directory) {
        await requireCheckpoint(input.repair.advanceNavigationCheckpoint({
          job,
          leaseToken,
          navigationDirectoryCursor: job.checkpoint.navigationDirectoryCursor,
          navigationEntryCursor: null,
          navigationPhase: "entries",
          navigationComplete: true,
          updatedAt: now().toISOString()
        }));
        return { phase: "navigation", records: 0 };
      }

      if (job.checkpoint.navigationPhase === "entries") {
        const page = await input.repair.listNavigationEntryPage({
          job,
          leaseToken,
          directoryPath: directory.path,
          limit: input.treePageSize
        });
        if (page.entries.length > 0) {
          await input.navigation.writeEntries({
            knowledgeBaseId: job.knowledgeBaseId,
            generationId: job.targetGenerationId,
            directoryPath: directory.path,
            entries: page.entries
          });
        }
        await requireCheckpoint(input.repair.advanceNavigationCheckpoint({
          job,
          leaseToken,
          navigationDirectoryCursor: job.checkpoint.navigationDirectoryCursor,
          navigationEntryCursor: page.nextCursor,
          navigationPhase: page.nextCursor ? "entries" : "stale",
          navigationComplete: false,
          updatedAt: now().toISOString()
        }));
        return { phase: "navigation", records: page.entries.length };
      }

      const stalePage = await input.repair.listStaleNavigationEntryPage({
        job,
        leaseToken,
        directoryPath: directory.path,
        limit: input.treePageSize
      });
      if (stalePage.entries.length > 0) {
        await input.navigation.writeEntries({
          knowledgeBaseId: job.knowledgeBaseId,
          generationId: job.targetGenerationId,
          directoryPath: directory.path,
          entries: stalePage.entries
        });
      }
      if (stalePage.nextCursor) {
        await requireCheckpoint(input.repair.advanceNavigationCheckpoint({
          job,
          leaseToken,
          navigationDirectoryCursor: job.checkpoint.navigationDirectoryCursor,
          navigationEntryCursor: stalePage.nextCursor,
          navigationPhase: "stale",
          navigationComplete: false,
          updatedAt: now().toISOString()
        }));
      } else {
        await input.navigation.writeEntries({
          knowledgeBaseId: job.knowledgeBaseId,
          generationId: job.targetGenerationId,
          directoryPath: directory.path,
          entries: [],
          writeRootWhenUnchanged: true
        });
        await requireCheckpoint(input.repair.advanceNavigationCheckpoint({
          job,
          leaseToken,
          navigationDirectoryCursor: directory.recordId,
          navigationEntryCursor: null,
          navigationPhase: "entries",
          navigationComplete: false,
          updatedAt: now().toISOString()
        }));
      }
      return { phase: "navigation", records: stalePage.entries.length };
    }

    if (!job.checkpoint.graphComplete) {
      const page = await input.repair.listGraphPage({
        job,
        leaseToken,
        limit: input.treePageSize
      });
      const nodeCount = job.checkpoint.graphNodeCount
        + page.records.filter((record) => record.projectionKind === "graph_node").length;
      const edgeCount = job.checkpoint.graphEdgeCount
        + page.records.filter((record) => record.projectionKind === "graph_edge").length;
      if (!page.nextCursor) {
        await requireCheckpoint(input.repair.stageGraphSummary({
          job,
          leaseToken,
          nodeCount,
          edgeCount,
          updatedAt: now().toISOString()
        }));
      }
      await requireCheckpoint(input.repair.advanceGraphCheckpoint({
        job,
        leaseToken,
        graphCursor: page.nextCursor,
        graphNodeCount: nodeCount,
        graphEdgeCount: edgeCount,
        graphComplete: page.nextCursor === null,
        updatedAt: now().toISOString()
      }));
      return { phase: "graph", records: page.records.length };
    }

    for (const path of REPAIR_ROOT_PATHS) {
      const rendered = renderBoundedRootFile({
        path,
        knowledgeBase: job.descriptor,
        rootEntryCount: job.descriptor.rootEntryCount,
        generationId: job.targetGenerationId
      });
      const object = await input.immutableObjects.write(rendered);
      await input.references.stageUpsert({
        knowledgeBaseId: job.knowledgeBaseId,
        generationId: job.targetGenerationId,
        refKind: "root",
        refKey: path,
        fileId: createGeneratedFileId({ refKind: "root", refKey: path, sourceFileId: null }),
        checksumSha256: object.checksumSha256,
        formatVersion: object.formatVersion,
        logicalPath: path,
        sourceFileId: null,
        projectionShardId: null
      });
    }
    await input.catalog.finalize({
      knowledgeBaseId: job.knowledgeBaseId,
      generationId: job.targetGenerationId
    });
    await input.generations.markGenerationState({
      knowledgeBaseId: job.knowledgeBaseId,
      generationId: job.targetGenerationId,
      expectedState: "building",
      state: "validating",
      updatedAt: now().toISOString()
    });
    const issues = await input.validation.validateChangedClosure({
      knowledgeBaseId: job.knowledgeBaseId,
      generationId: job.targetGenerationId,
      issueLimit: input.validationIssueLimit
    });
    if (issues.length > 0) {
      await input.generations.failGeneration({
        knowledgeBaseId: job.knowledgeBaseId,
        generationId: job.targetGenerationId,
        code: "PROJECTION_REPAIR_VALIDATION_FAILED",
        message: issues.map((issue) => issue.code).join(","),
        failedAt: now().toISOString()
      });
      throw new Error("Projection repair candidate validation failed");
    }

    const roots = [];
    for (const path of GENERATED_ROOT_MANIFEST_PATHS) {
      const reference = await input.references.findStagedByRef({
        knowledgeBaseId: job.knowledgeBaseId,
        generationId: job.targetGenerationId,
        refKind: "root",
        refKey: path
      }) ?? await input.references.findActiveByRef({
        knowledgeBaseId: job.knowledgeBaseId,
        refKind: "root",
        refKey: path
      });
      if (!reference) throw new Error("Projection repair root reference is unavailable");
      roots.push({
        path,
        checksumSha256: reference.checksumSha256,
        objectKey: reference.objectKey,
        contentType: reference.contentType,
        sizeBytes: reference.sizeBytes
      });
    }
    const manifest = await input.immutableObjects.write({
      body: `${JSON.stringify({
        formatVersion: 1,
        knowledgeBaseId: job.knowledgeBaseId,
        generationId: job.targetGenerationId,
        predecessorGenerationId: job.baseGenerationId,
        roots
      })}\n`,
      contentType: "application/json; charset=utf-8"
    });
    await input.references.stageUpsert({
      knowledgeBaseId: job.knowledgeBaseId,
      generationId: job.targetGenerationId,
      refKind: "generation_manifest",
      refKey: "root",
      fileId: `generation-manifest-${job.targetGenerationId}`,
      checksumSha256: manifest.checksumSha256,
      formatVersion: manifest.formatVersion,
      logicalPath: null,
      sourceFileId: null,
      projectionShardId: null
    });
    const activated = await input.generations.activateGeneration({
      knowledgeBaseId: job.knowledgeBaseId,
      generationId: job.targetGenerationId,
      expectedPredecessorGenerationId: job.baseGenerationId,
      rootManifestChecksumSha256: manifest.checksumSha256,
      rootManifestObjectKey: manifest.objectKey,
      activatedAt: now().toISOString()
    });
    if (!activated) {
      await scheduleRetry(input, job, leaseToken, "PROJECTION_REPAIR_SUPERSEDED", now());
      return { phase: "retry", records: 0 };
    }
    await input.repair.complete({ job, leaseToken, completedAt: now().toISOString() });
    return { phase: "completed", records: 0 };
  } catch {
    await scheduleRetry(input, job, leaseToken, "PROJECTION_REPAIR_FAILED", now());
    return { phase: "failed", records: 0 };
  }
}

function groupByShard<T extends { shardKey: string }>(records: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const group = groups.get(record.shardKey) ?? [];
    group.push(record);
    groups.set(record.shardKey, group);
  }
  return groups;
}

function renderSearchableText(payload: unknown): string {
  return JSON.stringify(payload).replace(/[{}\[\]",:]+/gu, " ").replace(/\s+/gu, " ").trim();
}

async function requireCheckpoint(result: Promise<boolean>): Promise<void> {
  if (!await result) throw new Error("Projection repair lease is unavailable");
}

async function scheduleRetry(
  input: Parameters<typeof runProjectionRepairSlice>[0],
  job: Awaited<ReturnType<ProjectionRepairRepository["claim"]>> & object,
  leaseToken: string,
  errorCode: string,
  failedAt: Date
): Promise<void> {
  await input.repair.retryFromLatest({
    job,
    leaseToken,
    errorCode,
    retryAt: new Date(failedAt.getTime() + input.retryDelayMs).toISOString(),
    failedAt: failedAt.toISOString(),
    maxAttempts: input.maxAttempts
  });
}
