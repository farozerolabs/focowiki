import { describe, expect, it } from "vitest";
import type { OkfGraphEdge, OkfGraphNode } from "@focowiki/okf";
import type {
  AdminRepositories,
  BundleFileRecord,
  BundleTreeEntryDraft,
  PublicationJobRecord,
  ReleaseDraft,
  SourceFileEventDraft,
  SourceFileRecord
} from "../src/db/admin-repositories.js";
import type {
  WorkerJobRecord,
  WorkerJobRepository
} from "../src/db/worker-job-repository.js";
import { createSourceFileQueueProcessor } from "../src/admin/source-file-processor.js";
import { createKnowledgeBasePublicationService } from "../src/admin/publication-scheduler.js";
import { createRedisCoordinator } from "../src/redis/coordination.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter, StoredObject } from "../src/storage/s3.js";
import { MemoryRedisCommandClient } from "./support/session.js";
import type { RuntimeConfig } from "../src/config.js";
import type {
  ReleaseMarkdownLinkRecord,
  ReleaseNavigationEntryRecord,
  ReleaseSourceFileRecord
} from "../src/application/ports/release-publication-repository.js";
import { createWorkerRuntime } from "../src/worker/runtime.js";
import { PublicationCatalogStaleError } from "../src/domain/publication.js";
import {
  seedSourceFileFixtures,
  type SourceFileFixtureDraft
} from "./support/source-file-fixture.js";

const now = "2026-06-18T00:00:00.000Z";

class MemoryStorage implements StorageAdapter {
  public readonly keyspace = createStorageKeyspace("tenant/demo");
  public readonly objects = new Map<string, string>();

  public async putObject(object: StoredObject): Promise<void> {
    this.objects.set(
      object.key,
      typeof object.body === "string" ? object.body : new TextDecoder().decode(object.body)
    );
  }

  public async getObjectText(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null;
  }

  public async copyObject(input: { sourceKey: string; destinationKey: string }): Promise<void> {
    const content = this.objects.get(input.sourceKey);
    if (content === undefined) throw new Error(`Missing copy source: ${input.sourceKey}`);
    this.objects.set(input.destinationKey, content);
  }

}

class DelayedStorage extends MemoryStorage {
  public activeWrites = 0;
  public maxActiveWrites = 0;

  public override async putObject(object: StoredObject): Promise<void> {
    this.activeWrites += 1;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    await new Promise((resolve) => setTimeout(resolve, 5));

    try {
      await super.putObject(object);
    } finally {
      this.activeWrites -= 1;
    }
  }
}

function createRepositories() {
  const knowledgeBase = {
    id: "kb-001",
    name: "Knowledge Base",
    description: null,
    activeReleaseId: null as string | null,
    catalogGeneration: 0,
    createdAt: now,
    updatedAt: now
  };
  const sources = new Map<string, SourceFileRecord>();
  const releases = new Map<string, ReleaseDraft>();
  const publicationJobs = new Map<string, PublicationJobRecord>();
  const bundleFiles: BundleFileRecord[] = [];
  const events: SourceFileEventDraft[] = [];
  const graphNodes = new Map<string, OkfGraphNode>();
  const graphEdges: OkfGraphEdge[] = [];
  const workerJobs: WorkerJobRecord[] = [];
  const releaseSources = new Map<string, ReleaseSourceFileRecord[]>();
  const releaseMarkdownLinks = new Map<string, ReleaseMarkdownLinkRecord[]>();
  const releaseSearchIndexFinalizations: string[] = [];
  const workerJobRepository: WorkerJobRepository = {
    async enqueueWorkerJob(input) {
      const record = createWorkerJob(input);
      workerJobs.push(record);
      return record;
    },
    async enqueueSourceFileJob(input) {
      const record = createWorkerJob({
        kind: "source_file_processing",
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.sourceFileId,
        payload: { reason: input.reason },
        runAfter: input.runAfter,
        maxAttempts: input.maxAttempts
      });
      workerJobs.push(record);
      return record;
    },
    async enqueuePublicationJob(input) {
      const existing = workerJobs.find(
        (job) =>
          job.kind === "publication" &&
          job.knowledgeBaseId === input.knowledgeBaseId &&
          (job.status === "queued" || job.status === "running")
      );

      if (existing) {
        return existing;
      }

      const record = createWorkerJob({
        kind: "publication",
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: null,
        payload: {
          reason: input.reason,
          targetCatalogGeneration: input.targetCatalogGeneration
        },
        runAfter: input.runAfter,
        maxAttempts: input.maxAttempts
      });
      workerJobs.push(record);
      return record;
    },
    async claimWorkerJobs(input) {
      const candidates = workerJobs
        .filter((job) => {
          if (!input.kinds.includes(job.kind)) {
            return false;
          }
          if (job.runAfter > input.now) {
            return false;
          }
          if (job.status === "queued") {
            return true;
          }
          return (
            job.status === "running" &&
            job.lockedAt !== null &&
            (job.heartbeatAt ?? job.lockedAt) < input.staleBefore
          );
        })
        .sort((left, right) =>
          `${left.runAfter}\u0000${left.createdAt}\u0000${left.id}`.localeCompare(
            `${right.runAfter}\u0000${right.createdAt}\u0000${right.id}`
          )
        )
        .slice(0, input.limit);

      for (const job of candidates) {
        job.status = "running";
        job.lockedBy = input.workerId;
        job.lockedAt = input.now;
        job.heartbeatAt = input.now;
        job.startedAt = job.startedAt ?? input.now;
        job.attemptCount += 1;
        job.updatedAt = input.now;
      }

      return candidates;
    },
    async completeWorkerJob(input) {
      const job = workerJobs.find(
        (candidate) =>
          candidate.id === input.id &&
          candidate.lockedBy === input.workerId &&
          candidate.status === "running"
      );

      if (!job) {
        return null;
      }

      job.status = "completed";
      job.lockedBy = null;
      job.lockedAt = null;
      job.heartbeatAt = null;
      job.completedAt = input.completedAt;
      job.failedAt = null;
      job.lastErrorCode = null;
      job.lastErrorMessage = null;
      job.updatedAt = input.completedAt;
      return job;
    },
    async failWorkerJob(input) {
      const job = workerJobs.find(
        (candidate) =>
          candidate.id === input.id &&
          candidate.lockedBy === input.workerId &&
          candidate.status === "running"
      );

      if (!job) {
        return null;
      }

      job.status = input.retryAfter ? "queued" : "failed";
      job.lockedBy = null;
      job.lockedAt = null;
      job.heartbeatAt = null;
      job.runAfter = input.retryAfter ?? job.runAfter;
      job.failedAt = input.failedAt;
      job.lastErrorCode = input.errorCode;
      job.lastErrorMessage = input.errorMessage;
      job.updatedAt = input.failedAt;
      return job;
    },
    async deadLetterWorkerJob(input) {
      const job = workerJobs.find(
        (candidate) =>
          candidate.id === input.id &&
          candidate.lockedBy === input.workerId &&
          candidate.status === "running"
      );

      if (!job) {
        return null;
      }

      job.status = "dead_letter";
      job.lockedBy = null;
      job.lockedAt = null;
      job.heartbeatAt = null;
      job.failedAt = input.failedAt;
      job.lastErrorCode = input.errorCode;
      job.lastErrorMessage = input.errorMessage;
      job.updatedAt = input.failedAt;
      return job;
    },
    async releaseWorkerJob(input) {
      const job = workerJobs.find(
        (candidate) =>
          candidate.id === input.id &&
          candidate.lockedBy === input.workerId &&
          candidate.status === "running"
      );

      if (!job) {
        return null;
      }

      job.status = "queued";
      job.lockedBy = null;
      job.lockedAt = null;
      job.heartbeatAt = null;
      job.runAfter = input.runAfter ?? job.runAfter;
      job.updatedAt = input.releasedAt;
      return job;
    },
    async heartbeatWorkerJob(input) {
      const job = workerJobs.find(
        (candidate) =>
          candidate.id === input.id &&
          candidate.lockedBy === input.workerId &&
          candidate.status === "running"
      );

      if (!job) {
        return null;
      }

      job.heartbeatAt = input.heartbeatAt;
      job.updatedAt = input.heartbeatAt;
      return job;
    },
    async recordWorkerHeartbeat(input) {
      return {
        workerId: input.workerId,
        lastSeenAt: input.lastSeenAt,
        activeJobCount: input.activeJobCount,
        metadata: input.metadata ?? {},
        createdAt: input.lastSeenAt,
        updatedAt: input.lastSeenAt
      };
    },
    async listWorkerHeartbeats() {
      return [];
    },
    async getWorkerQueueSummary(input) {
      const jobs = workerJobs.filter((job) => {
        if (input?.kinds && !input.kinds.includes(job.kind)) {
          return false;
        }
        if (input?.knowledgeBaseId && job.knowledgeBaseId !== input.knowledgeBaseId) {
          return false;
        }
        return true;
      });

      return {
        queuedCount: jobs.filter((job) => job.status === "queued").length,
        runningCount: jobs.filter((job) => job.status === "running").length,
        completedCount: jobs.filter((job) => job.status === "completed").length,
        failedCount: jobs.filter((job) => job.status === "failed").length,
        deadLetterCount: jobs.filter((job) => job.status === "dead_letter").length,
        oldestQueuedAt: null,
        oldestQueuedAgeSeconds: null
      };
    },
    async cleanupWorkerJobs() {
      return 0;
    },
    async countActiveWorkerJobs(input) {
      return workerJobs.filter((job) => {
        if (job.status !== "queued" && job.status !== "running") {
          return false;
        }
        if (input?.kinds && !input.kinds.includes(job.kind)) {
          return false;
        }
        if (input?.knowledgeBaseId && job.knowledgeBaseId !== input.knowledgeBaseId) {
          return false;
        }
        return true;
      }).length;
    }
  };

  const persistSourceFileFixtures = async (files: SourceFileFixtureDraft[]) => {
    for (const file of files) {
      sources.set(file.id, {
        ...file,
        processingStatus: file.processingStatus ?? "queued",
        processingStage: file.processingStage ?? "upload_storage",
        processingStartedAt: file.processingStartedAt ?? null,
        processingEndedAt: file.processingEndedAt ?? null,
        processingErrorCode: file.processingErrorCode ?? null,
        processingErrorMessage: file.processingErrorMessage ?? null,
        generatedOutputStatus: file.generatedOutputStatus ?? "pending",
        publicationDirtyAt: file.publicationDirtyAt ?? null,
        publicationVisibleAt: file.publicationVisibleAt ?? null,
        publicationErrorCode: file.publicationErrorCode ?? null,
        publicationErrorMessage: file.publicationErrorMessage ?? null,
        retryCount: file.retryCount ?? 0,
        createdAt: now,
        deletedAt: null
      });
    }
  };

  const repositories: AdminRepositories = {
    knowledgeBases: {
      async listKnowledgeBases() {
        return { items: [knowledgeBase], nextCursor: null };
      },
      async createKnowledgeBase() {
        return knowledgeBase;
      },
      async getKnowledgeBase(id) {
        return id === knowledgeBase.id ? knowledgeBase : null;
      }
    },
    releasePublication: {
      async materializeSourceSnapshot(input) {
        const publicationTargets = new Set(input.publicationSourceFileIds);
        const snapshot = Array.from(sources.values())
          .filter((source) =>
            source.knowledgeBaseId === input.knowledgeBaseId
            && source.processingStatus === "completed"
            && !source.deletedAt
            && (source.generatedOutputStatus === "visible" || publicationTargets.has(source.id))
          )
          .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
          .map((source) => ({
            ...toReleaseSourceFile(source),
            publicationRequired: publicationTargets.has(source.id)
          }));
        releaseSources.set(input.releaseId, snapshot);
        return {
          directoryCount: new Set(snapshot.map((source) => parentSourcePath(source.relativePath)).filter(Boolean)).size,
          sourceFileCount: snapshot.length
        };
      },
      async countSourceFiles(input) {
        return releaseSources.get(input.releaseId)?.length ?? 0;
      },
      async listSourceFiles(input) {
        const snapshot = releaseSources.get(input.releaseId) ?? [];
        const start = input.cursor ? Number(input.cursor) : 0;
        const items = snapshot.slice(start, start + input.limit);
        return {
          items,
          nextCursor: start + input.limit < snapshot.length ? String(start + input.limit) : null
        };
      },
      async listNavigationEntries(input) {
        const entries = createReleaseNavigationEntries(releaseSources.get(input.releaseId) ?? []);
        const start = input.cursor ? Number(input.cursor) : 0;
        return {
          items: entries.slice(start, start + input.limit),
          nextCursor: start + input.limit < entries.length ? String(start + input.limit) : null
        };
      },
      async listReusablePages(input) {
        const requested = new Set(input.sourceFileIds);
        return bundleFiles
          .filter((file) =>
            file.releaseId === input.releaseId
            && file.fileKind === "page"
            && file.sourceFileId !== null
            && requested.has(file.sourceFileId)
          )
          .map((file) => ({
            sourceFileId: file.sourceFileId!,
            logicalPath: file.logicalPath,
            objectKey: file.objectKey,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes,
            checksumSha256: file.checksumSha256,
            okfType: file.okfType,
            title: file.title,
            description: file.description,
            tags: [...file.tags],
            frontmatter: { ...file.frontmatter }
          }));
      },
      async persistMarkdownLinks(input) {
        const current = releaseMarkdownLinks.get(input.releaseId) ?? [];
        current.push(...input.links);
        releaseMarkdownLinks.set(input.releaseId, current);
      },
      async copyReusableMarkdownLinks(input) {
        const requested = new Set(input.sourceFileIds);
        const copied = (releaseMarkdownLinks.get(input.previousReleaseId) ?? [])
          .filter((link) => link.sourceFileId !== null && requested.has(link.sourceFileId));
        const current = releaseMarkdownLinks.get(input.releaseId) ?? [];
        current.push(...copied);
        releaseMarkdownLinks.set(input.releaseId, current);
      },
      async pruneInvalidSourceMarkdownLinks(input) {
        const targetPaths = new Set([
          ...bundleFiles
            .filter((file) => file.releaseId === input.releaseId)
            .map((file) => file.logicalPath),
          ...input.plannedTargetPaths
        ]);
        const current = releaseMarkdownLinks.get(input.releaseId) ?? [];
        const retained = current.filter((link) => link.navigationOnly || targetPaths.has(link.to));
        releaseMarkdownLinks.set(input.releaseId, retained);
        return current.length - retained.length;
      },
      async listValidMarkdownLinks(input) {
        const targetPaths = new Set([
          ...bundleFiles
            .filter((file) => file.releaseId === input.releaseId)
            .map((file) => file.logicalPath),
          ...input.plannedTargetPaths
        ]);
        const links = (releaseMarkdownLinks.get(input.releaseId) ?? [])
          .filter((link) => targetPaths.has(link.to))
          .sort((left, right) =>
            `${left.from}\u0000${left.to}\u0000${left.label}`.localeCompare(
              `${right.from}\u0000${right.to}\u0000${right.label}`
            )
          );
        const start = input.cursor ? Number(input.cursor) : 0;
        return {
          items: links.slice(start, start + input.limit).map(({ from, to, label }) => ({
            from,
            to,
            label
          })),
          nextCursor: start + input.limit < links.length ? String(start + input.limit) : null
        };
      },
      async summarizeChanges(input) {
        return {
          created: releaseSources.get(input.releaseId)?.filter((source) => source.publicationRequired).length ?? 0,
          updated: 0,
          moved: 0,
          deleted: 0,
          affectedDirectories: []
        };
      },
      async listChanges() {
        return { items: [], nextCursor: null };
      },
      async listSourceGraphNeighborhood(input) {
        const snapshot = releaseSources.get(input.releaseId) ?? [];
        const byId = new Map(snapshot.map((source) => [source.sourceFileId, source]));
        return graphEdges.flatMap((edge) => {
          const outgoing = edge.fromFileId === input.sourceFileId;
          const incoming = edge.toFileId === input.sourceFileId;
          if (!outgoing && !incoming) return [];
          const relatedId = outgoing ? edge.toFileId : edge.fromFileId;
          const related = byId.get(relatedId);
          if (!related) return [];
          return [{
            fileId: relatedId,
            path: related.generatedPath,
            title: graphNodes.get(relatedId)?.title ?? related.name.replace(/\.md$/i, ""),
            relationType: edge.relationType,
            direction: outgoing ? "outgoing" as const : "incoming" as const,
            weight: edge.weight,
            reason: edge.reason,
            source: edge.source,
            ...(edge.evidence ? { evidence: edge.evidence } : {})
          }];
        }).slice(0, input.limit);
      },
      async materializeTree(input) {
        const files = bundleFiles.filter((file) => file.releaseId === input.releaseId);
        const directories = new Set(
          files.flatMap((file) => {
            const segments = file.logicalPath.split("/");
            return segments.slice(0, -1).map((_segment, index) =>
              segments.slice(0, index + 1).join("/")
            );
          })
        );
        return { entryCount: files.length + directories.size };
      },
      async validateRelease() {
        return { issues: [], truncated: false };
      }
    },
    files: {
      async createRelease(release) {
        releases.set(release.id, release);
      },
      async createBundleFiles(files) {
        bundleFiles.push(...files);
      },
      async createBundleTreeEntries(_entries: BundleTreeEntryDraft[]) {
        return undefined;
      },
      async activateRelease(input) {
        const release = releases.get(input.releaseId);

        if (release) {
          release.publishedAt = input.publishedAt;
          release.fileCount = input.fileCount;
          release.manifestChecksumSha256 = input.manifestChecksumSha256;
        }

        knowledgeBase.activeReleaseId = input.releaseId;

        const publicationTargets = new Set(
          (releaseSources.get(input.releaseId) ?? [])
            .filter((source) => source.publicationRequired)
            .map((source) => source.sourceFileId)
        );
        const visiblePages = bundleFiles.filter((file) =>
          file.releaseId === input.releaseId
          && file.fileKind === "page"
          && file.sourceFileId
          && publicationTargets.has(file.sourceFileId)
        );
        for (const file of visiblePages) {
          const source = sources.get(file.sourceFileId!);
          if (!source || !source.publicationDirtyAt) continue;
          source.processingStage = "release_activation";
          source.processingEndedAt = input.publishedAt;
          source.generatedOutputStatus = "visible";
          source.generatedBundleFileId = file.id;
          source.generatedBundleFilePath = file.logicalPath;
          source.publicationDirtyAt = null;
          source.publicationVisibleAt = input.publishedAt;
          source.publicationErrorCode = null;
          source.publicationErrorMessage = null;
        }
      },
      async updateSourceFileProcessingState(input) {
        for (const id of input.sourceFileIds) {
          const source = sources.get(id);

          if (source) {
            source.processingStatus = input.status;
            source.processingStage = input.stage;
            source.processingStartedAt = input.startedAt ?? source.processingStartedAt ?? null;
            source.processingEndedAt = input.endedAt ?? null;
            source.processingErrorCode = input.errorCode ?? null;
            source.processingErrorMessage = input.errorMessage ?? null;
          }
        }
      },
      async updateSourceFileMetadata(input) {
        const source = sources.get(input.sourceFileId);

        if (source) {
          source.metadata = input.metadata;
        }
      },
      async updateSourceFileModelSuggestions(input) {
        const source = sources.get(input.sourceFileId);

        if (source) {
          source.modelSuggestions = input.suggestions;
        }
      },
      async createSourceFileEvent(input) {
        events.push(input);
        return {
          id: `event-${events.length}`,
          ...input,
          createdAt: now
        };
      },
      async getSourceFile(input) {
        return sources.get(input.sourceFileId) ?? null;
      },
      async getSourceFileForProcessing(input) {
        return sources.get(input.sourceFileId) ?? null;
      },
      async listSourceFiles(input) {
        const items = Array.from(sources.values()).filter(
          (source) => source.knowledgeBaseId === input.knowledgeBaseId && !source.deletedAt
        );
        return {
          items: items.slice(0, input.limit),
          nextCursor: null
        };
      },
      async listBundleTreeEntries() {
        return { items: [], nextCursor: null };
      },
      async getBundleFile() {
        return null;
      },
      async listReleases() {
        return { items: [], nextCursor: null };
      },
      async listBundleFiles() {
        return { items: bundleFiles, nextCursor: null };
      },
      async listReusableBundleFiles() {
        return { items: bundleFiles, nextCursor: null };
      },
      async getReleaseReadSummary(input) {
        return {
          releaseId: input.releaseId,
          knowledgeBaseId: input.knowledgeBaseId,
          searchableFileCount: bundleFiles.filter((file) => file.releaseId === input.releaseId).length,
          treeNodeCount: 0,
          graphDocumentCount: graphNodes.size,
          graphRelationshipCount: graphEdges.length,
          graphNodeCount: graphNodes.size,
          graphEdgeCount: graphEdges.length
        };
      },
      async refreshReleaseReadSummary(input) {
        return {
          releaseId: input.releaseId,
          knowledgeBaseId: input.knowledgeBaseId,
          searchableFileCount: bundleFiles.filter((file) => file.releaseId === input.releaseId).length,
          treeNodeCount: 0,
          graphDocumentCount: graphNodes.size,
          graphRelationshipCount: graphEdges.length,
          graphNodeCount: graphNodes.size,
          graphEdgeCount: graphEdges.length
        };
      },
      async finalizeReleaseSearchIndexes(input) {
        releaseSearchIndexFinalizations.push(input.releaseId);
        return { indexCount: 10, pagesCleaned: 0 };
      },
      async searchBundleFiles() {
        return { items: [], nextCursor: null };
      },
      async rebuildBundleGraphSearchDocuments() {
        return {
          documentCount: graphNodes.size,
          relationshipCount: graphEdges.length
        };
      },
      async rebuildReleaseGraphProjection() {
        return { nodeCount: graphNodes.size, edgeCount: graphEdges.length };
      },
      async searchBundleGraphFiles() {
        return { items: [], nextCursor: null };
      },
      async listPublicationLogHistory() {
        return { entries: [], summaries: [] };
      },
      async markSourceFilesPublicationDirty(input) {
        for (const id of input.sourceFileIds) {
          const source = sources.get(id);

          if (source) {
            source.generatedOutputStatus = "pending";
            source.generatedBundleFileId = null;
            source.generatedBundleFilePath = null;
            source.publicationDirtyAt = input.dirtyAt;
            source.publicationErrorCode = null;
            source.publicationErrorMessage = null;
          }
        }
      },
      async countDirtySourceFiles(input) {
        const dirtySources = Array.from(sources.values())
          .filter(
            (source) =>
              source.knowledgeBaseId === input.knowledgeBaseId &&
              source.processingStatus === "completed" &&
              source.publicationDirtyAt &&
              !source.deletedAt
          )
          .sort((left, right) =>
            `${left.publicationDirtyAt}\u0000${left.id}`.localeCompare(
              `${right.publicationDirtyAt}\u0000${right.id}`
            )
          );

        return {
          count: dirtySources.length,
          oldestDirtyAt: dirtySources.at(0)?.publicationDirtyAt ?? null
        };
      },
      async listDirtySourceFiles(input) {
        const items = Array.from(sources.values())
          .filter(
            (source) =>
              source.knowledgeBaseId === input.knowledgeBaseId &&
              source.processingStatus === "completed" &&
              source.publicationDirtyAt &&
              !source.deletedAt
          )
          .sort((left, right) =>
            `${left.publicationDirtyAt}\u0000${left.id}`.localeCompare(
              `${right.publicationDirtyAt}\u0000${right.id}`
            )
          );
        return {
          items: items.slice(0, input.limit),
          nextCursor: null
        };
      },
      async markSourceFilesPublicationVisible(input) {
        const outputs = new Map(input.generatedOutputs.map((output) => [output.sourceFileId, output]));

        for (const id of input.sourceFileIds) {
          const source = sources.get(id);
          const output = outputs.get(id);

          if (source) {
            source.processingStage = "release_activation";
            source.processingEndedAt = input.visibleAt;
            source.generatedOutputStatus = "visible";
            source.generatedBundleFileId = output?.bundleFileId ?? null;
            source.generatedBundleFilePath = output?.logicalPath ?? null;
            source.publicationDirtyAt = null;
            source.publicationVisibleAt = input.visibleAt;
            source.publicationErrorCode = null;
            source.publicationErrorMessage = null;
          }
        }
      },
      async markSourceFilesPublicationFailed(input) {
        for (const id of input.sourceFileIds) {
          const source = sources.get(id);

          if (source) {
            source.generatedOutputStatus = "unavailable";
            source.generatedBundleFileId = null;
            source.generatedBundleFilePath = null;
            source.publicationErrorCode = input.errorCode;
            source.publicationErrorMessage = input.errorMessage;
          }
        }
      },
      async createPublicationJob(input) {
        const job: PublicationJobRecord = {
          id: input.id,
          knowledgeBaseId: input.knowledgeBaseId,
          mode: input.mode,
          reason: input.reason,
          status: "queued",
          dirtySourceCount: input.dirtySourceCount,
          releaseId: null,
          startedAt: null,
          endedAt: null,
          errorCode: null,
          errorMessage: null,
          createdAt: now,
          updatedAt: now
        };
        publicationJobs.set(job.id, job);
        return job;
      },
      async startPublicationJob(input) {
        const job = publicationJobs.get(input.id);

        if (!job || job.status !== "queued") {
          return null;
        }

        job.status = "running";
        job.startedAt = input.startedAt;
        job.updatedAt = input.startedAt;
        return job;
      },
      async completePublicationJob(input) {
        const job = publicationJobs.get(input.id);

        if (!job) {
          return null;
        }

        job.status = "completed";
        job.releaseId = input.releaseId;
        job.endedAt = input.endedAt;
        job.updatedAt = input.endedAt;
        return job;
      },
      async failPublicationJob(input) {
        const job = publicationJobs.get(input.id);

        if (!job) {
          return null;
        }

        job.status = "failed";
        job.endedAt = input.endedAt;
        job.errorCode = input.errorCode;
        job.errorMessage = input.errorMessage;
        job.updatedAt = input.endedAt;
        return job;
      }
    },
    graph: {
      async upsertGraphNode(input) {
        graphNodes.set(input.node.fileId, input.node);
      },
      async upsertGraphEdges(input) {
        graphEdges.push(...input.edges);
      },
      async listGraphNodes(input) {
        return {
          items: Array.from(graphNodes.values()).slice(0, input.limit),
          nextCursor: null
        };
      },
      async listGraphEdges(input) {
        return {
          items: graphEdges.slice(0, input.limit),
          nextCursor: null
        };
      },
      async listGraphNeighborhood() {
        return { items: [], nextCursor: null };
      },
      async listActiveGraphNodes(input) {
        return {
          items: Array.from(graphNodes.values()).slice(0, input.limit),
          nextCursor: null
        };
      },
      async listActiveGraphEdges(input) {
        return { items: graphEdges.slice(0, input.limit), nextCursor: null };
      },
      async listActiveGraphNeighborhood() {
        return { items: [], nextCursor: null };
      },
      async deleteGraphForSourceFile(input) {
        graphNodes.delete(input.sourceFileId);
      }
    },
    workerJobs: workerJobRepository
  };

  return {
    repositories,
    knowledgeBase,
    sources,
    releases,
    publicationJobs,
    bundleFiles,
    events,
    graphNodes,
    graphEdges,
    workerJobs,
    releaseSearchIndexFinalizations,
    persistSourceFileFixtures
  };
}

function toReleaseSourceFile(source: SourceFileRecord): ReleaseSourceFileRecord {
  const relativePath = source.relativePath;
  return {
    sourceFileId: source.id,
    sourceRevisionId: `revision-${source.id}`,
    sourceDirectoryId: parentSourcePath(relativePath) || null,
    name: relativePath.split("/").at(-1) ?? relativePath,
    relativePath,
    generatedPath: `pages/${relativePath}`,
    objectKey: source.objectKey,
    contentType: source.contentType,
    sizeBytes: source.sizeBytes,
    checksumSha256: source.checksumSha256,
    metadata: source.metadata,
    suggestions: source.modelSuggestions ?? null,
    publicationRequired: false
  };
}

function createReleaseNavigationEntries(
  sources: ReleaseSourceFileRecord[]
): ReleaseNavigationEntryRecord[] {
  const children = new Map<string, ReleaseNavigationEntryRecord[]>();
  const ensure = (path: string) => {
    const current = children.get(path) ?? [];
    children.set(path, current);
    return current;
  };
  ensure("pages");
  for (const source of sources) {
    const segments = source.generatedPath.split("/");
    const parentPath = segments.slice(0, -1).join("/");
    ensure(parentPath).push({
      id: `file:${source.sourceFileId}`,
      parentPath,
      kind: "file",
      name: source.name,
      targetPath: source.name,
      label: source.name.replace(/\.md$/i, ""),
      entryCount: null
    });
    for (let index = 1; index < segments.length - 1; index += 1) {
      const directoryPath = segments.slice(0, index + 1).join("/");
      const ownerPath = segments.slice(0, index).join("/");
      const name = segments[index] ?? "";
      ensure(directoryPath);
      const owner = ensure(ownerPath);
      if (!owner.some((entry) => entry.kind === "directory" && entry.name === name)) {
        owner.push({
          id: `directory:${directoryPath}`,
          parentPath: ownerPath,
          kind: "directory",
          name,
          targetPath: `${name}/index.md`,
          label: name,
          entryCount: null
        });
      }
    }
  }
  return [...children.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([parentPath, entries]) => [
      {
        id: `start:${parentPath}`,
        parentPath,
        kind: "directory_start" as const,
        name: "",
        targetPath: "",
        label: "",
        entryCount: entries.length
      },
      ...entries.sort((left, right) =>
        `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)
      )
    ]);
}

function parentSourcePath(relativePath: string): string {
  return relativePath.split("/").slice(0, -1).join("/");
}

function createWorkerJob(input: {
  kind: WorkerJobRecord["kind"];
  knowledgeBaseId: string;
  sourceFileId?: string | null;
  payload: Record<string, unknown>;
  runAfter: string;
  maxAttempts: number;
}): WorkerJobRecord {
  return {
    id: `worker-job-${randomUUIDForTest()}`,
    kind: input.kind,
    status: "queued",
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.sourceFileId ?? null,
    payload: input.payload,
    runAfter: input.runAfter,
    attemptCount: 0,
    maxAttempts: input.maxAttempts,
    lockedBy: null,
    lockedAt: null,
    heartbeatAt: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: now,
    updatedAt: now
  };
}

let nextTestId = 1;

function randomUUIDForTest(): string {
  const value = String(nextTestId).padStart(4, "0");
  nextTestId += 1;
  return value;
}

describe("source file queue", () => {
  it("uses bounded storage concurrency when accepting uploaded source files", async () => {
    const storage = new DelayedStorage();
    const records = createRepositories();
    const files = Array.from({ length: 4 }, (_item, index) => ({
      fileName: `file-${index + 1}.md`,
      bytes: new TextEncoder().encode(`---\ntitle: File ${index + 1}\ntype: page\n---\n# File ${index + 1}`),
      content: `---\ntitle: File ${index + 1}\ntype: page\n---\n# File ${index + 1}`
    }));

    const sourceFileIds = await seedSourceFileFixtures({
      files,
      storageConcurrency: 2,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });

    expect(sourceFileIds).toHaveLength(4);
    expect(storage.maxActiveWrites).toBe(2);
  });

  it("stores uploaded Markdown as queued source files and processes one file to completion", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "guide.md",
          bytes: new TextEncoder().encode("---\ntitle: Guide\ntype: page\n---\n# Guide"),
          content: "---\ntitle: Guide\ntype: page\n---\n# Guide"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const processor = createSourceFileQueueProcessor(records.repositories, storage, redis, null);
    const sourceFileId = sourceFileIds[0];

    expect(sourceFileIds).toHaveLength(1);
    expect(sourceFileId).toBeDefined();
    if (!sourceFileId) {
      throw new Error("Source file was not created");
    }

    expect(records.sources.get(sourceFileId)?.processingStatus).toBe("queued");
    await processor?.processFile({
      knowledgeBaseId: records.knowledgeBase.id,
      knowledgeBaseName: records.knowledgeBase.name,
      sourceFileId,
      generatedAt: now,
      batchSize: 20,
      cursorTtlSeconds: 900,
      fileProcessingConcurrency: 1
    });

    expect(records.sources.get(sourceFileId)?.processingStatus).toBe("completed");
    expect(records.sources.get(sourceFileId)?.processingStage).toBe("index_publication");
    expect(records.sources.get(sourceFileId)?.generatedOutputStatus).toBe("pending");
    expect(records.knowledgeBase.activeReleaseId).toBeNull();
    expect(records.workerJobs.filter((job) => job.kind === "publication")).toHaveLength(1);
    expect(records.events.some((event) => event.stageKey === "llm_suggestion")).toBe(true);
    expect(records.events.some((event) => event.stageKey === "graph_generation")).toBe(true);
    expect(records.graphNodes.has(sourceFileId)).toBe(true);

    const publicationService = createKnowledgeBasePublicationService(records.repositories, storage, redis);
    await publicationService?.publishNow({
      knowledgeBaseId: records.knowledgeBase.id,
      knowledgeBaseName: records.knowledgeBase.name,
      generatedAt: now,
      pageSize: 100,
      cursorTtlSeconds: 900,
      fileProcessingConcurrency: 1,
      options: {
        mode: "batch",
        batchSize: 20,
        intervalSeconds: 300,
        indexShardSize: 1_000,
        linkIndexShardSize: 1_000,
        manifestShardSize: 1_000,
        graphEdgeShardSize: 5_000,
        graphCandidateLimit: 200,
        graphMaintenanceBatchSize: 500,
        rootSummaryLimit: 500
      },
      reason: "bootstrap",
      targetCatalogGeneration: 0
    });

    expect(records.sources.get(sourceFileId)?.processingStage).toBe("release_activation");
    expect(records.sources.get(sourceFileId)?.generatedOutputStatus).toBe("visible");
    expect(records.knowledgeBase.activeReleaseId).toMatch(/^release-/u);
    expect(Array.from(records.releases.values()).at(-1)?.catalogGeneration).toBe(0);
    expect(records.bundleFiles.some((file) => file.logicalPath === "pages/guide.md")).toBe(true);
    expect(records.bundleFiles.some((file) => file.logicalPath === "_graph/manifest.json")).toBe(true);
    expect(records.events.some((event) => event.stageKey === "release_activation")).toBe(true);
    expect(records.releaseSearchIndexFinalizations).toEqual([
      records.knowledgeBase.activeReleaseId
    ]);
  });

  it("uses persisted model descriptions when source descriptions repeat titles", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const suggestedDescription =
      "Guide explains the practical setup flow, validation steps, and release checks for operators.";
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "guide.md",
          bytes: new TextEncoder().encode(
            "---\ntitle: Guide\ndescription: Guide\ntype: page\n---\n# Guide\n\nSetup flow."
          ),
          content:
            "---\ntitle: Guide\ndescription: Guide\ntype: page\n---\n# Guide\n\nSetup flow."
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];

    if (!sourceFileId) {
      throw new Error("Source file was not created");
    }

    const processor = createSourceFileQueueProcessor(records.repositories, storage, redis, {
      apiMode: "responses",
      client: {
        responses: {
          create: async () => ({
            status: "completed",
            output_text: JSON.stringify({
              description: suggestedDescription,
              title: "",
              type: "",
              tags: ["operations"],
              related_links: [],
              keywords: ["setup", "validation"]
            })
          })
        }
      },
      modelName: "gpt-test",
      contextWindowTokens: 200_000,
      receiveTimeouts: {
        maxMs: 5_000,
        idleMs: 5_000
      },
      suggestionConcurrency: 1,
      transientRetryDelayMs: 1
    });

    await processor?.processFile({
      knowledgeBaseId: records.knowledgeBase.id,
      knowledgeBaseName: records.knowledgeBase.name,
      sourceFileId,
      generatedAt: now,
      batchSize: 20,
      cursorTtlSeconds: 900,
      fileProcessingConcurrency: 1
    });

    const publicationService = createKnowledgeBasePublicationService(records.repositories, storage, redis);
    await publicationService?.publishNow({
      knowledgeBaseId: records.knowledgeBase.id,
      knowledgeBaseName: records.knowledgeBase.name,
      generatedAt: now,
      pageSize: 100,
      cursorTtlSeconds: 900,
      fileProcessingConcurrency: 1,
      options: {
        mode: "batch",
        batchSize: 20,
        intervalSeconds: 300,
        indexShardSize: 1_000,
        linkIndexShardSize: 1_000,
        manifestShardSize: 1_000,
        graphEdgeShardSize: 5_000,
        graphCandidateLimit: 200,
        graphMaintenanceBatchSize: 500,
        rootSummaryLimit: 500
      },
      reason: "bootstrap",
      targetCatalogGeneration: 0
    });

    const page = records.bundleFiles.find((file) => file.logicalPath === "pages/guide.md");

    expect(records.sources.get(sourceFileId)?.modelSuggestions?.description).toBe(
      suggestedDescription
    );
    expect(page?.description).toBe(suggestedDescription);
    expect(page?.frontmatter.description).toBe(suggestedDescription);
  });

  it("continues a reclaimed running source file after worker restart", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "reclaimed.md",
          bytes: new TextEncoder().encode("---\ntitle: Reclaimed\ntype: page\n---\n# Reclaimed"),
          content: "---\ntitle: Reclaimed\ntype: page\n---\n# Reclaimed"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];

    if (!sourceFileId) {
      throw new Error("Source file was not created");
    }

    const source = records.sources.get(sourceFileId);

    if (!source) {
      throw new Error("Source file record was not created");
    }

    source.processingStatus = "running";
    source.processingStage = "metadata_resolution";
    source.processingStartedAt = now;
    source.processingEndedAt = null;
    const processor = createSourceFileQueueProcessor(records.repositories, storage, redis, null);

    await processor?.processFile({
      knowledgeBaseId: records.knowledgeBase.id,
      knowledgeBaseName: records.knowledgeBase.name,
      sourceFileId,
      generatedAt: now,
      batchSize: 20,
      cursorTtlSeconds: 900,
      fileProcessingConcurrency: 1
    });

    expect(records.sources.get(sourceFileId)?.processingStatus).toBe("completed");
    expect(records.sources.get(sourceFileId)?.processingStage).toBe("index_publication");
    expect(records.sources.get(sourceFileId)?.generatedOutputStatus).toBe("pending");
    expect(records.graphNodes.has(sourceFileId)).toBe(true);
    expect(records.workerJobs.filter((job) => job.kind === "publication")).toHaveLength(1);
  });

  it("continues source file processing when enabled model suggestions are invalid", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "model-warning.md",
          bytes: new TextEncoder().encode("---\ntitle: Model warning\ntype: page\n---\n# Model warning"),
          content: "---\ntitle: Model warning\ntype: page\n---\n# Model warning"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];

    if (!sourceFileId) {
      throw new Error("Source file was not created");
    }

    const processor = createSourceFileQueueProcessor(records.repositories, storage, redis, {
      apiMode: "responses",
      client: {
        responses: {
          create: async () => ({
            status: "completed",
            output_text: "not json"
          })
        }
      },
      modelName: "gpt-test",
      contextWindowTokens: 200_000,
      receiveTimeouts: {
        maxMs: 5_000,
        idleMs: 5_000
      },
      suggestionConcurrency: 1,
      transientRetryDelayMs: 1
    });

    await expect(
      processor?.processFile({
        knowledgeBaseId: records.knowledgeBase.id,
        knowledgeBaseName: records.knowledgeBase.name,
        sourceFileId,
        generatedAt: now,
        batchSize: 20,
        cursorTtlSeconds: 900,
        fileProcessingConcurrency: 1
      })
    ).resolves.toMatchObject({
      id: sourceFileId,
      processingStatus: "completed"
    });

    expect(records.sources.get(sourceFileId)?.processingStatus).toBe("completed");
    expect(records.sources.get(sourceFileId)?.processingErrorCode).toBeNull();
    expect(records.sources.get(sourceFileId)?.modelSuggestions).toBeNull();
    expect(
      records.events.some(
        (event) => event.stageKey === "llm_suggestion" && event.severity === "warning"
      )
    ).toBe(true);
    expect(records.graphNodes.has(sourceFileId)).toBe(true);
    expect(records.workerJobs.filter((job) => job.kind === "publication")).toHaveLength(1);
  });

  it("keeps processing each source file when model assistance returns warnings", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "model-failure.md",
          bytes: new TextEncoder().encode(
            "---\ntitle: Failing model\ntype: page\n---\n# Failing model"
          ),
          content: "---\ntitle: Failing model\ntype: page\n---\n# Failing model"
        },
        {
          fileName: "model-success.md",
          bytes: new TextEncoder().encode(
            "---\ntitle: Successful model\ntype: page\n---\n# Successful model"
          ),
          content: "---\ntitle: Successful model\ntype: page\n---\n# Successful model"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const [failedSourceFileId, successfulSourceFileId] = sourceFileIds;

    if (!failedSourceFileId || !successfulSourceFileId) {
      throw new Error("Source files were not created");
    }

    let modelCallCount = 0;
    const processor = createSourceFileQueueProcessor(records.repositories, storage, redis, {
      apiMode: "responses",
      client: {
        responses: {
          create: async () => {
            modelCallCount += 1;
            if (modelCallCount <= 3) {
              throw new Error("Model service unavailable");
            }

            return {
              status: "completed",
              output_text: JSON.stringify({
                description: "Suggested",
                title: "",
                type: "",
                tags: [],
                related_links: [],
                keywords: []
              })
            };
          }
        }
      },
      modelName: "gpt-test",
      contextWindowTokens: 200_000,
      receiveTimeouts: {
        maxMs: 5_000,
        idleMs: 5_000
      },
      suggestionConcurrency: 1,
      transientRetryDelayMs: 1
    });

    await expect(
      processor?.processFile({
        knowledgeBaseId: records.knowledgeBase.id,
        knowledgeBaseName: records.knowledgeBase.name,
        sourceFileId: failedSourceFileId,
        generatedAt: now,
        batchSize: 20,
        cursorTtlSeconds: 900,
        fileProcessingConcurrency: 1
      })
    ).resolves.toMatchObject({
      id: failedSourceFileId,
      processingStatus: "completed"
    });
    await expect(
      processor?.processFile({
        knowledgeBaseId: records.knowledgeBase.id,
        knowledgeBaseName: records.knowledgeBase.name,
        sourceFileId: successfulSourceFileId,
        generatedAt: now,
        batchSize: 20,
        cursorTtlSeconds: 900,
        fileProcessingConcurrency: 1
      })
    ).resolves.toMatchObject({
      id: successfulSourceFileId,
      processingStatus: "completed"
    });

    expect(records.sources.get(failedSourceFileId)?.processingStatus).toBe("completed");
    expect(records.sources.get(failedSourceFileId)?.processingErrorCode).toBeNull();
    expect(records.sources.get(failedSourceFileId)?.generatedOutputStatus).toBe("pending");
    expect(records.sources.get(successfulSourceFileId)?.processingStatus).toBe("completed");
    expect(records.graphNodes.has(failedSourceFileId)).toBe(true);
    expect(records.graphNodes.has(successfulSourceFileId)).toBe(true);
  });

  it("drains dirty source files during a batch publication", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "alpha.md",
          bytes: new TextEncoder().encode("---\ntitle: Alpha\ntype: page\n---\n# Alpha"),
          content: "---\ntitle: Alpha\ntype: page\n---\n# Alpha"
        },
        {
          fileName: "beta.md",
          bytes: new TextEncoder().encode("---\ntitle: Beta\ntype: page\n---\n# Beta"),
          content: "---\ntitle: Beta\ntype: page\n---\n# Beta"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const processor = createSourceFileQueueProcessor(records.repositories, storage, redis, null);
    const [firstSourceFileId, secondSourceFileId] = sourceFileIds;

    if (!firstSourceFileId || !secondSourceFileId) {
      throw new Error("Source files were not created");
    }

    await processor?.processFile({
      knowledgeBaseId: records.knowledgeBase.id,
      knowledgeBaseName: records.knowledgeBase.name,
      sourceFileId: firstSourceFileId,
      generatedAt: now,
      batchSize: 2,
      cursorTtlSeconds: 900,
      fileProcessingConcurrency: 1
    });

    expect(records.sources.get(firstSourceFileId)?.processingStatus).toBe("completed");
    expect(records.sources.get(firstSourceFileId)?.processingStage).toBe("index_publication");
    expect(records.sources.get(firstSourceFileId)?.generatedOutputStatus).toBe("pending");
    expect(records.releases.size).toBe(0);
    expect(records.workerJobs.filter((job) => job.kind === "publication")).toHaveLength(1);

    await processor?.processFile({
      knowledgeBaseId: records.knowledgeBase.id,
      knowledgeBaseName: records.knowledgeBase.name,
      sourceFileId: secondSourceFileId,
      generatedAt: now,
      batchSize: 2,
      cursorTtlSeconds: 900,
      fileProcessingConcurrency: 1
    });

    expect(records.sources.get(secondSourceFileId)?.processingStatus).toBe("completed");
    expect(records.sources.get(secondSourceFileId)?.processingStage).toBe("index_publication");
    expect(records.sources.get(secondSourceFileId)?.generatedOutputStatus).toBe("pending");
    expect(records.releases.size).toBe(0);

    const publicationService = createKnowledgeBasePublicationService(records.repositories, storage, redis);
    await publicationService?.publishNow({
      knowledgeBaseId: records.knowledgeBase.id,
      knowledgeBaseName: records.knowledgeBase.name,
      generatedAt: now,
      pageSize: 100,
      cursorTtlSeconds: 900,
      fileProcessingConcurrency: 1,
      options: {
        mode: "batch",
        batchSize: 2,
        intervalSeconds: 300,
        indexShardSize: 1_000,
        linkIndexShardSize: 1_000,
        manifestShardSize: 1_000,
        graphEdgeShardSize: 5_000,
        graphCandidateLimit: 200,
        graphMaintenanceBatchSize: 500,
        rootSummaryLimit: 500
      },
      reason: "bootstrap",
      targetCatalogGeneration: 0
    });

    expect(records.sources.get(secondSourceFileId)?.processingStage).toBe("release_activation");
    expect(records.sources.get(secondSourceFileId)?.generatedOutputStatus).toBe("visible");
    expect(records.releases.size).toBe(1);
    expect(records.knowledgeBase.activeReleaseId).toMatch(/^release-/u);
    expect(records.bundleFiles.filter((file) => file.fileKind === "page")).toHaveLength(2);
  });

  it("marks existing files dirty when a new graph relationship changes their published page", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "current.md",
          bytes: new TextEncoder().encode("---\ntitle: Current\ntype: page\n---\n# Current"),
          content: "---\ntitle: Current\ntype: page\n---\n# Current"
        },
        {
          fileName: "related.md",
          bytes: new TextEncoder().encode("---\ntitle: Related\ntype: page\n---\n# Related"),
          content: "---\ntitle: Related\ntype: page\n---\n# Related"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const [currentSourceFileId, relatedSourceFileId] = sourceFileIds;

    if (!currentSourceFileId || !relatedSourceFileId) {
      throw new Error("Source files were not created");
    }

    for (const sourceFileId of sourceFileIds) {
      const source = records.sources.get(sourceFileId);
      if (source) {
        source.processingStatus = "completed";
        source.generatedOutputStatus = "visible";
      }
    }

    const publicationService = createKnowledgeBasePublicationService(
      records.repositories,
      storage,
      redis
    );
    await publicationService?.markSourceFileReady({
      knowledgeBaseId: records.knowledgeBase.id,
      knowledgeBaseName: records.knowledgeBase.name,
      sourceFileId: currentSourceFileId,
      relatedSourceFileIds: [relatedSourceFileId],
      generatedAt: now,
      pageSize: 100,
      cursorTtlSeconds: 900,
      fileProcessingConcurrency: 1,
      eligibility: "import",
      options: {
        mode: "batch",
        batchSize: 20,
        intervalSeconds: 300,
        indexShardSize: 1_000,
        linkIndexShardSize: 1_000,
        manifestShardSize: 1_000,
        graphEdgeShardSize: 5_000,
        graphCandidateLimit: 200,
        graphMaintenanceBatchSize: 500,
        rootSummaryLimit: 500
      }
    });

    expect(records.sources.get(currentSourceFileId)?.publicationDirtyAt).toBe(now);
    expect(records.sources.get(relatedSourceFileId)?.publicationDirtyAt).toBe(now);
    expect(records.sources.get(relatedSourceFileId)?.generatedOutputStatus).toBe("pending");
  });

  it("schedules interactive source completion immediately under batch publication policy", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "interactive.md",
          bytes: new TextEncoder().encode("---\ntitle: Interactive\ntype: page\n---\n# Interactive"),
          content: "---\ntitle: Interactive\ntype: page\n---\n# Interactive"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];

    if (!sourceFileId) {
      throw new Error("Interactive source file was not created");
    }

    const source = records.sources.get(sourceFileId);
    if (source) {
      source.processingStatus = "completed";
      source.processingStage = "index_publication";
      source.generatedOutputStatus = "pending";
    }
    records.knowledgeBase.catalogGeneration = 1;

    const publicationService = createKnowledgeBasePublicationService(
      records.repositories,
      storage,
      redis
    );
    await publicationService?.markSourceFileReady({
      knowledgeBaseId: records.knowledgeBase.id,
      knowledgeBaseName: records.knowledgeBase.name,
      sourceFileId,
      generatedAt: now,
      pageSize: 100,
      cursorTtlSeconds: 900,
      fileProcessingConcurrency: 1,
      eligibility: "interactive",
      options: {
        mode: "batch",
        batchSize: 20,
        intervalSeconds: 300,
        indexShardSize: 1_000,
        linkIndexShardSize: 1_000,
        manifestShardSize: 1_000,
        graphEdgeShardSize: 5_000,
        graphCandidateLimit: 200,
        graphMaintenanceBatchSize: 500,
        rootSummaryLimit: 500
      }
    });

    const publicationJob = records.workerJobs.find((job) => job.kind === "publication");
    expect(publicationJob?.payload).toEqual({
      reason: "manual",
      targetCatalogGeneration: 1
    });
    expect(publicationJob?.runAfter).toBe(now);
  });

  it("limits each publication job to the configured dirty source batch size", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: ["alpha", "beta", "gamma"].map((name) => ({
        fileName: `${name}.md`,
        bytes: new TextEncoder().encode(`---\ntitle: ${name}\ntype: page\n---\n# ${name}`),
        content: `---\ntitle: ${name}\ntype: page\n---\n# ${name}`
      })),
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });

    for (const sourceFileId of sourceFileIds) {
      const source = records.sources.get(sourceFileId);

      if (source) {
        source.processingStatus = "completed";
        source.processingStage = "index_publication";
        source.generatedOutputStatus = "pending";
        source.publicationDirtyAt = now;
      }
    }

    const publicationService = createKnowledgeBasePublicationService(records.repositories, storage, redis);
    await publicationService?.publishNow({
      knowledgeBaseId: records.knowledgeBase.id,
      knowledgeBaseName: records.knowledgeBase.name,
      generatedAt: now,
      pageSize: 100,
      cursorTtlSeconds: 900,
      fileProcessingConcurrency: 1,
      options: {
        mode: "batch",
        batchSize: 2,
        intervalSeconds: 300,
        indexShardSize: 1_000,
        linkIndexShardSize: 1_000,
        manifestShardSize: 1_000,
        graphEdgeShardSize: 5_000,
        graphCandidateLimit: 200,
        graphMaintenanceBatchSize: 500,
        rootSummaryLimit: 500
      },
      reason: "batch_threshold",
      targetCatalogGeneration: 0
    });

    const visibleSources = sourceFileIds.filter(
      (sourceFileId) => records.sources.get(sourceFileId)?.generatedOutputStatus === "visible"
    );
    const pendingSources = sourceFileIds.filter(
      (sourceFileId) => records.sources.get(sourceFileId)?.generatedOutputStatus === "pending"
    );

    expect(visibleSources).toHaveLength(2);
    expect(pendingSources).toHaveLength(1);
    expect(records.bundleFiles.filter((file) => file.fileKind === "page")).toHaveLength(2);
    expect(records.workerJobs.some((job) => job.kind === "publication")).toBe(true);
    expect(records.workerJobs.at(-1)?.payload.reason).toBe("batch_interval");
  });

  it("schedules remaining dirty files after a successful release leaves a tail batch", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "alpha.md",
          bytes: new TextEncoder().encode("---\ntitle: Alpha\ntype: page\n---\n# Alpha"),
          content: "---\ntitle: Alpha\ntype: page\n---\n# Alpha"
        },
        {
          fileName: "beta.md",
          bytes: new TextEncoder().encode("---\ntitle: Beta\ntype: page\n---\n# Beta"),
          content: "---\ntitle: Beta\ntype: page\n---\n# Beta"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const [firstSourceFileId, secondSourceFileId] = sourceFileIds;

    if (!firstSourceFileId || !secondSourceFileId) {
      throw new Error("Source files were not created");
    }

    for (const sourceFileId of sourceFileIds) {
      const source = records.sources.get(sourceFileId);

      if (source) {
        source.processingStatus = "completed";
        source.processingStage = "index_publication";
        source.generatedOutputStatus = "pending";
        source.publicationDirtyAt = null;
      }
    }

    const firstSource = records.sources.get(firstSourceFileId);

    if (!firstSource) {
      throw new Error("First source file was not created");
    }

    firstSource.publicationDirtyAt = now;
    const originalCreateBundleFiles = records.repositories.files!.createBundleFiles!;
    let injectedTailDirtyFile = false;
    records.repositories.files!.createBundleFiles = async (files) => {
      if (!injectedTailDirtyFile) {
        injectedTailDirtyFile = true;
        const secondSource = records.sources.get(secondSourceFileId);

        if (secondSource) {
          secondSource.publicationDirtyAt = new Date().toISOString();
          secondSource.generatedOutputStatus = "pending";
        }
      }

      await originalCreateBundleFiles(files);
    };
    const publicationService = createKnowledgeBasePublicationService(records.repositories, storage, redis);

    await publicationService?.publishNow({
      knowledgeBaseId: records.knowledgeBase.id,
      knowledgeBaseName: records.knowledgeBase.name,
      generatedAt: now,
      pageSize: 100,
      cursorTtlSeconds: 900,
      fileProcessingConcurrency: 1,
      options: {
        mode: "batch",
        batchSize: 20,
        intervalSeconds: 0.01,
        indexShardSize: 1_000,
        linkIndexShardSize: 1_000,
        manifestShardSize: 1_000,
        graphEdgeShardSize: 5_000,
        graphCandidateLimit: 200,
        graphMaintenanceBatchSize: 500,
        rootSummaryLimit: 500
      },
      reason: "batch_threshold",
      targetCatalogGeneration: 0
    });

    expect(records.sources.get(secondSourceFileId)?.generatedOutputStatus).toBe("pending");
    expect(records.workerJobs.some((job) => job.kind === "publication")).toBe(true);
    expect(records.workerJobs.at(-1)?.payload.reason).toBe("batch_interval");
    expect(records.releases.size).toBe(1);
  });

  it("keeps a claimed publication bounded to its target catalog generation", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: ["head", "successor"].map((name) => ({
        fileName: `${name}.md`,
        bytes: new TextEncoder().encode(`---\ntitle: ${name}\ntype: page\n---\n# ${name}`),
        content: `---\ntitle: ${name}\ntype: page\n---\n# ${name}`
      })),
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const [headSourceFileId, successorSourceFileId] = sourceFileIds;

    if (!headSourceFileId || !successorSourceFileId) {
      throw new Error("Publication generation fixtures were not created");
    }

    for (const sourceFileId of sourceFileIds) {
      const source = records.sources.get(sourceFileId);
      if (source) {
        source.processingStatus = "completed";
        source.processingStage = "index_publication";
        source.generatedOutputStatus = "pending";
        source.publicationDirtyAt = null;
      }
    }
    const headSource = records.sources.get(headSourceFileId);
    if (!headSource) {
      throw new Error("Head publication fixture was not created");
    }
    headSource.publicationDirtyAt = now;

    const originalCreateBundleFiles = records.repositories.files!.createBundleFiles!;
    let successorInjected = false;
    records.repositories.files!.createBundleFiles = async (files) => {
      if (!successorInjected) {
        successorInjected = true;
        records.knowledgeBase.catalogGeneration = 1;
        const successorSource = records.sources.get(successorSourceFileId);
        if (successorSource) {
          successorSource.publicationDirtyAt = now;
        }
      }
      await originalCreateBundleFiles(files);
    };

    const publicationService = createKnowledgeBasePublicationService(
      records.repositories,
      storage,
      redis
    );
    await publicationService?.publishNow({
      knowledgeBaseId: records.knowledgeBase.id,
      knowledgeBaseName: records.knowledgeBase.name,
      generatedAt: now,
      pageSize: 100,
      cursorTtlSeconds: 900,
      fileProcessingConcurrency: 1,
      options: {
        mode: "batch",
        batchSize: 1,
        intervalSeconds: 300,
        indexShardSize: 1_000,
        linkIndexShardSize: 1_000,
        manifestShardSize: 1_000,
        graphEdgeShardSize: 5_000,
        graphCandidateLimit: 200,
        graphMaintenanceBatchSize: 500,
        rootSummaryLimit: 500
      },
      reason: "batch_threshold",
      targetCatalogGeneration: 0
    });

    expect(records.releases.size).toBe(1);
    expect(records.sources.get(headSourceFileId)?.generatedOutputStatus).toBe("visible");
    expect(records.sources.get(successorSourceFileId)?.generatedOutputStatus).toBe("pending");
    expect(records.workerJobs.at(-1)).toMatchObject({
      kind: "publication",
      status: "queued",
      payload: {
        reason: "batch_threshold",
        targetCatalogGeneration: 1
      }
    });
  });

  it("keeps manual publication mode pending without enqueueing publication work", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "manual.md",
          bytes: new TextEncoder().encode("---\ntitle: Manual\ntype: page\n---\n# Manual"),
          content: "---\ntitle: Manual\ntype: page\n---\n# Manual"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];

    if (!sourceFileId) {
      throw new Error("Source file was not created");
    }

    const processor = createSourceFileQueueProcessor(records.repositories, storage, redis, null);

    await processor?.processFile({
      knowledgeBaseId: records.knowledgeBase.id,
      knowledgeBaseName: records.knowledgeBase.name,
      sourceFileId,
      generatedAt: now,
      batchSize: 20,
      cursorTtlSeconds: 900,
      fileProcessingConcurrency: 1,
      publication: {
        mode: "manual",
        batchSize: 20,
        intervalSeconds: 300,
        indexShardSize: 1_000,
        linkIndexShardSize: 1_000,
        manifestShardSize: 1_000,
        graphEdgeShardSize: 5_000,
        graphCandidateLimit: 200,
        graphMaintenanceBatchSize: 500,
        rootSummaryLimit: 500
      }
    });

    expect(records.sources.get(sourceFileId)?.processingStatus).toBe("completed");
    expect(records.sources.get(sourceFileId)?.processingStage).toBe("index_publication");
    expect(records.sources.get(sourceFileId)?.generatedOutputStatus).toBe("pending");
    expect(records.sources.get(sourceFileId)?.publicationDirtyAt).toBe(now);
    expect(records.workerJobs.filter((job) => job.kind === "publication")).toHaveLength(0);
    expect(records.releases.size).toBe(0);
  });

  it("keeps dirty markers retryable when publication fails before activation", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "publication-failure.md",
          bytes: new TextEncoder().encode(
            "---\ntitle: Publication Failure\ntype: page\n---\n# Publication"
          ),
          content: "---\ntitle: Publication Failure\ntype: page\n---\n# Publication"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];

    if (!sourceFileId) {
      throw new Error("Source file was not created");
    }

    const source = records.sources.get(sourceFileId);

    if (!source) {
      throw new Error("Source file record was not created");
    }

    source.processingStatus = "completed";
    source.processingStage = "index_publication";
    source.generatedOutputStatus = "pending";
    source.publicationDirtyAt = now;
    records.repositories.files!.createBundleFiles = async () => {
      throw new Error("Bundle persistence failed");
    };
    const publicationService = createKnowledgeBasePublicationService(records.repositories, storage, redis);

    await expect(
      publicationService?.publishNow({
        knowledgeBaseId: records.knowledgeBase.id,
        knowledgeBaseName: records.knowledgeBase.name,
        generatedAt: now,
        pageSize: 100,
        cursorTtlSeconds: 900,
        fileProcessingConcurrency: 1,
        options: {
          mode: "batch",
          batchSize: 20,
          intervalSeconds: 300,
          indexShardSize: 1_000,
          linkIndexShardSize: 1_000,
          manifestShardSize: 1_000,
          graphEdgeShardSize: 5_000,
          graphCandidateLimit: 200,
          graphMaintenanceBatchSize: 500,
          rootSummaryLimit: 500
        },
      reason: "bootstrap",
      targetCatalogGeneration: 0
      })
    ).rejects.toThrow("Bundle persistence failed");

    expect(records.sources.get(sourceFileId)?.publicationDirtyAt).toBe(now);
    expect(records.sources.get(sourceFileId)?.generatedOutputStatus).toBe("unavailable");
    expect(records.sources.get(sourceFileId)?.publicationErrorCode).toBe("PUBLICATION_FAILED");
    expect(records.knowledgeBase.activeReleaseId).toBeNull();
    expect(Array.from(records.publicationJobs.values()).at(-1)?.status).toBe("failed");
  });

  it("rejects release activation when OKF validation reports an issue", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "conformance-rejection.md",
          bytes: new TextEncoder().encode(
            "---\ntitle: Conformance Rejection\ntype: page\n---\n# Conformance"
          ),
          content: "---\ntitle: Conformance Rejection\ntype: page\n---\n# Conformance"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];
    if (!sourceFileId) throw new Error("Source file was not created");
    const source = records.sources.get(sourceFileId);
    if (!sourceFileId || !source) throw new Error("Source file record was not created");
    records.knowledgeBase.activeReleaseId = "release-previous";
    source.processingStatus = "completed";
    source.processingStage = "index_publication";
    source.generatedOutputStatus = "pending";
    source.publicationDirtyAt = now;

    let activationAttempts = 0;
    records.repositories.releasePublication!.validateRelease = async () => ({
      issues: [
        {
          ruleId: "OKF-0.1-CONCEPT-TYPE",
          path: "pages/conformance-rejection.md",
          message: "Concept frontmatter must contain a non-empty type field."
        }
      ],
      truncated: false
    });
    records.repositories.files!.activateRelease = async () => {
      activationAttempts += 1;
    };
    const publicationService = createKnowledgeBasePublicationService(
      records.repositories,
      storage,
      redis
    );

    await expect(
      publicationService?.publishNow({
        knowledgeBaseId: records.knowledgeBase.id,
        knowledgeBaseName: records.knowledgeBase.name,
        generatedAt: now,
        pageSize: 100,
        cursorTtlSeconds: 900,
        fileProcessingConcurrency: 1,
        options: {
          mode: "batch",
          batchSize: 20,
          intervalSeconds: 300,
          indexShardSize: 1_000,
          linkIndexShardSize: 1_000,
          manifestShardSize: 1_000,
          graphEdgeShardSize: 5_000,
          graphCandidateLimit: 200,
          graphMaintenanceBatchSize: 500,
          rootSummaryLimit: 500
        },
      reason: "bootstrap",
      targetCatalogGeneration: 0
      })
    ).rejects.toThrow(
      "Release validation failed: OKF-0.1-CONCEPT-TYPE pages/conformance-rejection.md"
    );

    expect(activationAttempts).toBe(0);
    expect(records.knowledgeBase.activeReleaseId).toBe("release-previous");
    expect(records.sources.get(sourceFileId)?.publicationDirtyAt).toBe(now);
    expect(records.sources.get(sourceFileId)?.generatedOutputStatus).toBe("unavailable");
  });

  it("does not activate a release when graph search publication fails after bundle writes", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "graph-publication-failure.md",
          bytes: new TextEncoder().encode(
            "---\ntitle: Graph Publication Failure\ntype: page\n---\n# Graph"
          ),
          content: "---\ntitle: Graph Publication Failure\ntype: page\n---\n# Graph"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];

    if (!sourceFileId) {
      throw new Error("Source file was not created");
    }

    const source = records.sources.get(sourceFileId);

    if (!source) {
      throw new Error("Source file record was not created");
    }

    source.processingStatus = "completed";
    source.processingStage = "index_publication";
    source.generatedOutputStatus = "pending";
    source.publicationDirtyAt = now;
    records.repositories.files!.rebuildBundleGraphSearchDocuments = async () => {
      throw new Error("Graph search publication failed");
    };
    const publicationService = createKnowledgeBasePublicationService(records.repositories, storage, redis);

    await expect(
      publicationService?.publishNow({
        knowledgeBaseId: records.knowledgeBase.id,
        knowledgeBaseName: records.knowledgeBase.name,
        generatedAt: now,
        pageSize: 100,
        cursorTtlSeconds: 900,
        fileProcessingConcurrency: 1,
        options: {
          mode: "batch",
          batchSize: 20,
          intervalSeconds: 300,
          indexShardSize: 1_000,
          linkIndexShardSize: 1_000,
          manifestShardSize: 1_000,
          graphEdgeShardSize: 5_000,
          graphCandidateLimit: 200,
          graphMaintenanceBatchSize: 500,
          rootSummaryLimit: 500
        },
      reason: "bootstrap",
      targetCatalogGeneration: 0
      })
    ).rejects.toThrow("Graph search publication failed");

    const release = Array.from(records.releases.values()).at(-1);

    expect(records.bundleFiles.length).toBeGreaterThan(0);
    expect(release?.publishedAt).toBeNull();
    expect(records.knowledgeBase.activeReleaseId).toBeNull();
    expect(records.sources.get(sourceFileId)?.publicationDirtyAt).toBe(now);
    expect(records.sources.get(sourceFileId)?.generatedOutputStatus).toBe("unavailable");
    expect(records.sources.get(sourceFileId)?.publicationErrorCode).toBe("PUBLICATION_FAILED");
    expect(Array.from(records.publicationJobs.values()).at(-1)?.status).toBe("failed");
  });

  it("retries failed publication worker jobs without clearing dirty files", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "publication-worker-retry.md",
          bytes: new TextEncoder().encode(
            "---\ntitle: Publication Worker Retry\ntype: page\n---\n# Retry"
          ),
          content: "---\ntitle: Publication Worker Retry\ntype: page\n---\n# Retry"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];

    if (!sourceFileId) {
      throw new Error("Source file was not created");
    }

    const source = records.sources.get(sourceFileId);

    if (!source) {
      throw new Error("Source file record was not created");
    }

    source.processingStatus = "completed";
    source.processingStage = "index_publication";
    source.generatedOutputStatus = "pending";
    source.publicationDirtyAt = now;
    records.workerJobs.push(
      createWorkerJob({
        kind: "publication",
        knowledgeBaseId: records.knowledgeBase.id,
        sourceFileId: null,
        payload: { reason: "bootstrap", targetCatalogGeneration: 0 },
        runAfter: now,
        maxAttempts: 2
      })
    );
    records.repositories.files!.createBundleFiles = async () => {
      throw new Error("Publication worker failed");
    };
    const runtime = createWorkerRuntime({
      config: createMinimalWorkerConfig(),
      repositories: records.repositories,
      storage,
      redis,
      modelClient: null,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await expect(runtime.tick()).resolves.toBe(1);
    expect(records.workerJobs[0]?.status).toBe("queued");
    expect(records.workerJobs[0]?.attemptCount).toBe(1);
    expect(records.workerJobs[0]?.lastErrorCode).toBe("PUBLICATION_JOB_FAILED");
    expect(records.sources.get(sourceFileId)?.publicationDirtyAt).toBe(now);
    expect(records.sources.get(sourceFileId)?.generatedOutputStatus).toBe("unavailable");
  });

  it("defers stale publication snapshots without consuming a retry attempt", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "publication-catalog-stale.md",
          bytes: new TextEncoder().encode(
            "---\ntitle: Publication Catalog Stale\ntype: page\n---\n# Stale"
          ),
          content: "---\ntitle: Publication Catalog Stale\ntype: page\n---\n# Stale"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];
    const source = sourceFileId ? records.sources.get(sourceFileId) : null;
    if (!sourceFileId || !source) throw new Error("Source file record was not created");
    source.processingStatus = "completed";
    source.processingStage = "index_publication";
    source.generatedOutputStatus = "pending";
    source.publicationDirtyAt = now;
    records.workerJobs.push(
      createWorkerJob({
        kind: "publication",
        knowledgeBaseId: records.knowledgeBase.id,
        sourceFileId: null,
        payload: { reason: "bootstrap", targetCatalogGeneration: 0 },
        runAfter: now,
        maxAttempts: 2
      })
    );
    records.repositories.files!.activateRelease = async () => {
      throw new PublicationCatalogStaleError();
    };
    const runtime = createWorkerRuntime({
      config: createMinimalWorkerConfig(),
      repositories: records.repositories,
      storage,
      redis,
      modelClient: null,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await expect(runtime.tick()).resolves.toBe(1);
    expect(records.workerJobs[0]?.status).toBe("queued");
    expect(records.workerJobs[0]?.attemptCount).toBe(1);
    expect(records.workerJobs[0]?.lastErrorCode).toBeNull();
    expect(records.sources.get(sourceFileId)?.publicationDirtyAt).toBe(now);
  });

  it("queues another publication job when a running publication leaves new dirty files", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "worker-publication-head.md",
          bytes: new TextEncoder().encode("---\ntitle: Head\ntype: page\n---\n# Head"),
          content: "---\ntitle: Head\ntype: page\n---\n# Head"
        },
        {
          fileName: "worker-publication-tail.md",
          bytes: new TextEncoder().encode("---\ntitle: Tail\ntype: page\n---\n# Tail"),
          content: "---\ntitle: Tail\ntype: page\n---\n# Tail"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const [headSourceFileId, tailSourceFileId] = sourceFileIds;

    if (!headSourceFileId || !tailSourceFileId) {
      throw new Error("Source files were not created");
    }

    for (const sourceFileId of sourceFileIds) {
      const source = records.sources.get(sourceFileId);

      if (source) {
        source.processingStatus = "completed";
        source.processingStage = "index_publication";
        source.generatedOutputStatus = "pending";
        source.publicationDirtyAt = null;
      }
    }

    const headSource = records.sources.get(headSourceFileId);

    if (!headSource) {
      throw new Error("Head source file was not created");
    }

    headSource.publicationDirtyAt = now;
    records.workerJobs.push(
      createWorkerJob({
        kind: "publication",
        knowledgeBaseId: records.knowledgeBase.id,
        sourceFileId: null,
        payload: { reason: "batch_threshold", targetCatalogGeneration: 0 },
        runAfter: now,
        maxAttempts: 2
      })
    );
    let activateReleaseCalls = 0;
    const originalActivateRelease = records.repositories.files!.activateRelease!;
    records.repositories.files!.activateRelease = async (input) => {
      activateReleaseCalls += 1;
      await originalActivateRelease(input);
    };
    const originalCreateBundleFiles = records.repositories.files!.createBundleFiles!;
    let injectedTailDirtyFile = false;
    records.repositories.files!.createBundleFiles = async (files) => {
      if (!injectedTailDirtyFile) {
        injectedTailDirtyFile = true;
        const tailSource = records.sources.get(tailSourceFileId);

        if (tailSource) {
          tailSource.publicationDirtyAt = "2099-01-01T00:00:00.000Z";
          tailSource.generatedOutputStatus = "pending";
        }
      }

      await originalCreateBundleFiles(files);
    };
    const runtime = createWorkerRuntime({
      config: createMinimalWorkerConfig(),
      repositories: records.repositories,
      storage,
      redis,
      modelClient: null,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await expect(runtime.tick()).resolves.toBe(1);
    expect(activateReleaseCalls).toBe(1);
    expect(records.workerJobs[0]?.status).toBe("completed");
    expect(records.sources.get(headSourceFileId)?.generatedOutputStatus).toBe("visible");
    expect(records.sources.get(tailSourceFileId)?.generatedOutputStatus).toBe("pending");
    expect(records.workerJobs.filter((job) => job.kind === "publication")).toHaveLength(2);
    expect(records.workerJobs.at(-1)).toMatchObject({
      kind: "publication",
      status: "queued",
      payload: { reason: "batch_interval" }
    });
  });

  it("claims due publication work before older source-file backlog", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "publication-priority.md",
          bytes: new TextEncoder().encode("---\ntitle: Priority\ntype: page\n---\n# Priority"),
          content: "---\ntitle: Priority\ntype: page\n---\n# Priority"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];

    if (!sourceFileId) {
      throw new Error("Source file was not created");
    }

    const source = records.sources.get(sourceFileId);

    if (!source) {
      throw new Error("Source file record was not created");
    }

    source.processingStatus = "completed";
    source.processingStage = "index_publication";
    source.generatedOutputStatus = "pending";
    source.publicationDirtyAt = now;
    records.workerJobs.push(
      createWorkerJob({
        kind: "source_file_processing",
        knowledgeBaseId: records.knowledgeBase.id,
        sourceFileId: "source-file-backlog-001",
        payload: { reason: "upload" },
        runAfter: "2026-06-17T00:00:00.000Z",
        maxAttempts: 2
      }),
      createWorkerJob({
        kind: "source_file_processing",
        knowledgeBaseId: records.knowledgeBase.id,
        sourceFileId: "source-file-backlog-002",
        payload: { reason: "upload" },
        runAfter: "2026-06-17T00:00:01.000Z",
        maxAttempts: 2
      }),
      createWorkerJob({
        kind: "publication",
        knowledgeBaseId: records.knowledgeBase.id,
        sourceFileId: null,
        payload: { reason: "batch_interval", targetCatalogGeneration: 0 },
        runAfter: now,
        maxAttempts: 2
      })
    );
    const runtime = createWorkerRuntime({
      config: createMinimalWorkerConfig(),
      repositories: records.repositories,
      storage,
      redis,
      modelClient: null,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await expect(runtime.tick()).resolves.toBeGreaterThan(0);
    expect(records.workerJobs.find((job) => job.kind === "publication")?.status).toBe(
      "completed"
    );
    expect(records.sources.get(sourceFileId)?.generatedOutputStatus).toBe("visible");
  });

  it("does not create a processor when publication scheduling dependencies are unavailable", () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const files = records.repositories.files;

    if (!files) {
      throw new Error("Files repository was not created");
    }

    delete (files as Partial<NonNullable<AdminRepositories["files"]>>).createPublicationJob;

    expect(createSourceFileQueueProcessor(records.repositories, storage, redis, null)).toBeNull();
  });

  it("propagates interactive publication eligibility from a resource-operation worker job", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "resource-operation.md",
          bytes: new TextEncoder().encode(
            "---\ntitle: Resource operation\ntype: page\n---\n# Resource operation"
          ),
          content: "---\ntitle: Resource operation\ntype: page\n---\n# Resource operation"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];
    if (!sourceFileId) {
      throw new Error("Resource-operation source file was not created");
    }

    records.knowledgeBase.catalogGeneration = 3;
    records.workerJobs.push(
      createWorkerJob({
        kind: "source_file_processing",
        knowledgeBaseId: records.knowledgeBase.id,
        sourceFileId,
        payload: { reason: "resource_operation" },
        runAfter: now,
        maxAttempts: 2
      })
    );
    const runtime = createWorkerRuntime({
      config: createMinimalWorkerConfig(),
      repositories: records.repositories,
      storage,
      redis,
      modelClient: null,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await expect(runtime.tick()).resolves.toBeGreaterThan(0);

    const publicationJob = records.workerJobs.find((job) => job.kind === "publication");
    expect(publicationJob?.payload).toEqual({
      reason: "manual",
      targetCatalogGeneration: 3
    });
    expect(publicationJob?.status).toBe("queued");
  });

  it("marks only the missing stored source file as failed", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "missing-object.md",
          bytes: new TextEncoder().encode("---\ntitle: Missing object\ntype: page\n---\n# Missing"),
          content: "---\ntitle: Missing object\ntype: page\n---\n# Missing"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];

    if (!sourceFileId) {
      throw new Error("Source file was not created");
    }

    const processor = createSourceFileQueueProcessor(records.repositories, storage, redis, null);
    storage.objects.clear();
    await expect(
      processor?.processFile({
        knowledgeBaseId: records.knowledgeBase.id,
        knowledgeBaseName: records.knowledgeBase.name,
        sourceFileId,
        generatedAt: now,
        batchSize: 20,
        cursorTtlSeconds: 900,
        fileProcessingConcurrency: 1
      })
    ).rejects.toThrow();
    expect(records.sources.get(sourceFileId)?.processingStatus).toBe("failed");
    expect(records.sources.get(sourceFileId)?.processingErrorCode).toBe(
      "SOURCE_FILE_PROCESSING_FAILED"
    );
    expect(records.knowledgeBase.activeReleaseId).toBeNull();
  });

  it("completes a claimed source-file worker job after processing", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "worker-success.md",
          bytes: new TextEncoder().encode("---\ntitle: Worker Success\ntype: page\n---\n# Worker"),
          content: "---\ntitle: Worker Success\ntype: page\n---\n# Worker"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];

    if (!sourceFileId) {
      throw new Error("Source file was not created");
    }

    records.workerJobs.push(
      createWorkerJob({
        kind: "source_file_processing",
        knowledgeBaseId: records.knowledgeBase.id,
        sourceFileId,
        payload: { reason: "upload" },
        runAfter: now,
        maxAttempts: 2
      })
    );
    const runtime = createWorkerRuntime({
      config: createMinimalWorkerConfig(),
      repositories: records.repositories,
      storage,
      redis,
      modelClient: null,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await expect(runtime.tick()).resolves.toBe(1);
    expect(records.workerJobs[0]?.status).toBe("completed");
    expect(records.workerJobs[0]?.attemptCount).toBe(1);
    expect(records.sources.get(sourceFileId)?.processingStatus).toBe("completed");
  });

  it("retries transient source-file worker failures without stopping other jobs", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "worker-retry.md",
          bytes: new TextEncoder().encode("---\ntitle: Worker Retry\ntype: page\n---\n# Retry"),
          content: "---\ntitle: Worker Retry\ntype: page\n---\n# Retry"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];

    if (!sourceFileId) {
      throw new Error("Source file was not created");
    }

    storage.objects.clear();
    records.workerJobs.push(
      createWorkerJob({
        kind: "source_file_processing",
        knowledgeBaseId: records.knowledgeBase.id,
        sourceFileId,
        payload: { reason: "upload" },
        runAfter: now,
        maxAttempts: 2
      })
    );
    const runtime = createWorkerRuntime({
      config: createMinimalWorkerConfig(),
      repositories: records.repositories,
      storage,
      redis,
      modelClient: null,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await expect(runtime.tick()).resolves.toBe(1);
    expect(records.workerJobs[0]?.status).toBe("queued");
    expect(records.workerJobs[0]?.attemptCount).toBe(1);
    expect(records.workerJobs[0]?.lastErrorCode).toBe("WORKER_JOB_FAILED");
    expect(records.sources.get(sourceFileId)?.processingStatus).toBe("failed");
  });

  it("moves exhausted source-file worker failures to dead letter", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "worker-dead-letter.md",
          bytes: new TextEncoder().encode("---\ntitle: Worker Dead Letter\ntype: page\n---\n# Dead"),
          content: "---\ntitle: Worker Dead Letter\ntype: page\n---\n# Dead"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];

    if (!sourceFileId) {
      throw new Error("Source file was not created");
    }

    storage.objects.clear();
    records.workerJobs.push(
      createWorkerJob({
        kind: "source_file_processing",
        knowledgeBaseId: records.knowledgeBase.id,
        sourceFileId,
        payload: { reason: "upload" },
        runAfter: now,
        maxAttempts: 1
      })
    );
    const runtime = createWorkerRuntime({
      config: createMinimalWorkerConfig(),
      repositories: records.repositories,
      storage,
      redis,
      modelClient: null,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await expect(runtime.tick()).resolves.toBe(1);
    expect(records.workerJobs[0]?.status).toBe("dead_letter");
    expect(records.workerJobs[0]?.lastErrorCode).toBe("WORKER_JOB_FAILED");
  });

  it("does not duplicate-claim a fresh running source-file worker job", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const job = createWorkerJob({
      kind: "source_file_processing",
      knowledgeBaseId: records.knowledgeBase.id,
      sourceFileId: "source-file-running",
      payload: { reason: "upload" },
      runAfter: now,
      maxAttempts: 2
    });
    const lockedAt = new Date().toISOString();
    job.status = "running";
    job.lockedBy = "other-worker";
    job.lockedAt = lockedAt;
    job.heartbeatAt = lockedAt;
    records.workerJobs.push(job);
    const runtime = createWorkerRuntime({
      config: createMinimalWorkerConfig(),
      repositories: records.repositories,
      storage,
      redis,
      modelClient: null,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await expect(runtime.tick()).resolves.toBe(0);
    expect(records.workerJobs[0]?.status).toBe("running");
    expect(records.workerJobs[0]?.lockedBy).toBe("other-worker");
  });

  it("does not claim queued jobs when shutdown is already requested", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    records.workerJobs.push(
      createWorkerJob({
        kind: "source_file_processing",
        knowledgeBaseId: records.knowledgeBase.id,
        sourceFileId: "source-file-queued",
        payload: { reason: "upload" },
        runAfter: now,
        maxAttempts: 2
      })
    );
    const runtime = createWorkerRuntime({
      config: createMinimalWorkerConfig(),
      repositories: records.repositories,
      storage,
      redis,
      modelClient: null,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });
    const abortController = new AbortController();
    abortController.abort();

    await expect(runtime.tick(abortController.signal)).resolves.toBe(0);
    expect(records.workerJobs[0]?.status).toBe("queued");
    expect(records.workerJobs[0]?.lockedBy).toBeNull();
    expect(records.workerJobs[0]?.attemptCount).toBe(0);
  });

  it("releases claimed source-file and publication jobs that have not started during shutdown", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    records.workerJobs.push(
      createWorkerJob({
        kind: "source_file_processing",
        knowledgeBaseId: records.knowledgeBase.id,
        sourceFileId: "source-file-released",
        payload: { reason: "upload" },
        runAfter: now,
        maxAttempts: 2
      }),
      createWorkerJob({
        kind: "publication",
        knowledgeBaseId: records.knowledgeBase.id,
        sourceFileId: null,
        payload: { reason: "batch_threshold", targetCatalogGeneration: 0 },
        runAfter: now,
        maxAttempts: 2
      })
    );
    const workerJobs = records.repositories.workerJobs;

    if (!workerJobs) {
      throw new Error("Worker job repository was not created");
    }

    const originalClaim = workerJobs.claimWorkerJobs;
    const abortController = new AbortController();
    workerJobs.claimWorkerJobs = async (input) => {
      const claimed = await originalClaim(input);
      abortController.abort();
      return claimed;
    };
    const runtime = createWorkerRuntime({
      config: createMinimalWorkerConfig(),
      repositories: records.repositories,
      storage,
      redis,
      modelClient: null,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await expect(runtime.tick(abortController.signal)).resolves.toBe(0);
    expect(records.workerJobs.map((job) => job.status)).toEqual(["queued", "queued"]);
    expect(records.workerJobs.map((job) => job.lockedBy)).toEqual([null, null]);
    expect(records.workerJobs.map((job) => job.heartbeatAt)).toEqual([null, null]);
    expect(records.workerJobs.map((job) => job.attemptCount)).toEqual([1, 1]);
  });

  it("recovers a stale running source-file worker job", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await seedSourceFileFixtures({
      files: [
        {
          fileName: "worker-restart.md",
          bytes: new TextEncoder().encode("---\ntitle: Worker Restart\ntype: page\n---\n# Restart"),
          content: "---\ntitle: Worker Restart\ntype: page\n---\n# Restart"
        }
      ],
      storageConcurrency: 1,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      persist: records.persistSourceFileFixtures
    });
    const sourceFileId = sourceFileIds[0];

    if (!sourceFileId) {
      throw new Error("Source file was not created");
    }

    const job = createWorkerJob({
      kind: "source_file_processing",
      knowledgeBaseId: records.knowledgeBase.id,
      sourceFileId,
      payload: { reason: "upload" },
      runAfter: now,
      maxAttempts: 2
    });
    job.status = "running";
    job.lockedBy = "stopped-worker";
    job.lockedAt = "2026-06-18T00:00:00.000Z";
    job.heartbeatAt = "2026-06-18T00:00:00.000Z";
    records.workerJobs.push(job);
    const runtime = createWorkerRuntime({
      config: createMinimalWorkerConfig(),
      repositories: records.repositories,
      storage,
      redis,
      modelClient: null,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await expect(runtime.tick()).resolves.toBe(1);
    expect(records.workerJobs[0]?.status).toBe("completed");
    expect(records.workerJobs[0]?.attemptCount).toBe(1);
    expect(records.sources.get(sourceFileId)?.processingStatus).toBe("completed");
  });

  it("completes orphaned worker jobs when the knowledge base was deleted", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    records.repositories.knowledgeBases.getKnowledgeBase = async () => null;
    records.workerJobs.push(
      createWorkerJob({
        kind: "publication",
        knowledgeBaseId: records.knowledgeBase.id,
        sourceFileId: null,
        payload: { reason: "deletion", targetCatalogGeneration: 0 },
        runAfter: now,
        maxAttempts: 2
      }),
      createWorkerJob({
        kind: "source_file_processing",
        knowledgeBaseId: records.knowledgeBase.id,
        sourceFileId: "source-file-deleted-kb",
        payload: { reason: "upload" },
        runAfter: now,
        maxAttempts: 2
      })
    );
    const runtime = createWorkerRuntime({
      config: createMinimalWorkerConfig(),
      repositories: records.repositories,
      storage,
      redis,
      modelClient: null,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    await expect(runtime.tick()).resolves.toBe(2);
    expect(records.workerJobs.map((job) => job.status)).toEqual(["completed", "completed"]);
    expect(records.workerJobs.map((job) => job.lastErrorCode)).toEqual([null, null]);
    expect(records.workerJobs.map((job) => job.attemptCount)).toEqual([1, 1]);
  });

  it("runs bounded worker job retention cleanup during worker ticks", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const cleanupCalls: Array<{
      completedBefore: string;
      failedBefore: string;
      deadLetterBefore: string;
      limit: number;
    }> = [];

    records.repositories.workerJobs!.cleanupWorkerJobs = async (input) => {
      cleanupCalls.push(input);
      return input.limit;
    };

    const runtime = createWorkerRuntime({
      config: createMinimalWorkerConfig(),
      repositories: records.repositories,
      storage,
      redis,
      modelClient: null,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined
      }
    });

    const processedCount = await runtime.tick();

    expect(processedCount).toBe(0);
    expect(cleanupCalls).toHaveLength(1);
    expect(cleanupCalls[0]?.limit).toBe(17);
    expect(Date.parse(cleanupCalls[0]?.completedBefore ?? "")).toBeLessThan(Date.now());
    expect(Date.parse(cleanupCalls[0]?.failedBefore ?? "")).toBeLessThan(Date.now());
    expect(Date.parse(cleanupCalls[0]?.deadLetterBefore ?? "")).toBeLessThan(Date.now());
  });
});

function createMinimalWorkerConfig(): RuntimeConfig {
  return {
    model: {
      enabled: false,
      baseUrl: "https://example.invalid/v1",
      apiKey: "",
      modelName: "test-model",
      contextWindowTokens: 200_000,
      requestMaxTimeoutMs: 1_000,
      requestIdleTimeoutMs: 1_000,
      suggestionConcurrency: 1,
      transientRetryDelayMs: 1,
      requestMinIntervalMs: 0
    },
    worker: {
      sourceFileConcurrency: 1,
      claimBatchSize: 2,
      pollIntervalMs: 1_000,
      lockTtlSeconds: 900,
      heartbeatIntervalMs: 1_000,
      jobMaxAttempts: 2,
      jobRetryDelayMs: 1_000,
      queueBackpressureLimit: 100,
      shutdownGraceMs: 1_000,
      completedJobRetentionDays: 1,
      failedJobRetentionDays: 2,
      deadLetterJobRetentionDays: 3,
      retentionCleanupBatchSize: 17
    },
    upload: {
      maxBytes: 1_048_576,
      maxFiles: 8,
      generationBatchSize: 50,
      fileProcessingConcurrency: 1,
      storageConcurrency: 1
    },
    publication: {
      mode: "batch",
      batchSize: 300,
      intervalSeconds: 300,
      indexShardSize: 1_000,
      linkIndexShardSize: 1_000,
      manifestShardSize: 1_000,
      graphEdgeShardSize: 5_000,
      graphCandidateLimit: 200,
      graphMaintenanceBatchSize: 500,
      rootSummaryLimit: 500
    },
    pagination: {
      defaultPageSize: 50,
      maxPageSize: 200,
      treeDefaultPageSize: 100,
      treeMaxPageSize: 500,
      cursorTtlSeconds: 900,
      generatedContentMaxBytes: 10_485_760
    }
  } as unknown as RuntimeConfig;
}
