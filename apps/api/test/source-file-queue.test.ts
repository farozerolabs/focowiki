import { describe, expect, it } from "vitest";
import type { OkfGraphEdge, OkfGraphNode } from "@focowiki/okf";
import type {
  AdminRepositories,
  BundleFileRecord,
  BundleTreeEntryDraft,
  PublicationJobRecord,
  ReleaseDraft,
  SourceFileDraft,
  SourceFileEventDraft,
  SourceFileRecord
} from "../src/db/admin-repositories.js";
import { createSourceFileQueueProcessor } from "../src/admin/source-file-processor.js";
import { acceptUploadSourceFiles } from "../src/admin/source-file-upload.js";
import { createKnowledgeBasePublicationService } from "../src/admin/publication-scheduler.js";
import { createRedisCoordinator } from "../src/redis/coordination.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter, StoredObject } from "../src/storage/s3.js";
import { MemoryRedisCommandClient } from "./support/session.js";

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

  public async writeCurrentPointer(): Promise<void> {
    throw new Error("Not used by source file queue tests");
  }

  public async readCurrentPointer(): Promise<null> {
    return null;
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
    files: {
      async createSourceFiles(files: SourceFileDraft[]) {
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
      },
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
      async listPublicationLogHistory() {
        return { entries: [], summaries: [] };
      },
      async markSourceFilesPublicationDirty(input) {
        for (const id of input.sourceFileIds) {
          const source = sources.get(id);

          if (source) {
            source.generatedOutputStatus = "pending";
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
        for (const id of input.sourceFileIds) {
          const source = sources.get(id);

          if (source) {
            source.processingStage = "release_activation";
            source.processingEndedAt = input.visibleAt;
            source.generatedOutputStatus = "visible";
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
      async deleteGraphForSourceFile(input) {
        graphNodes.delete(input.sourceFileId);
      }
    }
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
    graphEdges
  };
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

    const sourceFileIds = await acceptUploadSourceFiles({
      files,
      storageConcurrency: 2,
      knowledgeBaseId: records.knowledgeBase.id,
      storage,
      createSourceFiles: records.repositories.files!.createSourceFiles!
    });

    expect(sourceFileIds).toHaveLength(4);
    expect(storage.maxActiveWrites).toBe(2);
  });

  it("stores uploaded Markdown as queued source files and processes one file to completion", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await acceptUploadSourceFiles({
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
      createSourceFiles: records.repositories.files!.createSourceFiles!
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
    expect(records.sources.get(sourceFileId)?.processingStage).toBe("release_activation");
    expect(records.sources.get(sourceFileId)?.generatedOutputStatus).toBe("visible");
    expect(records.knowledgeBase.activeReleaseId).toMatch(/^release-/u);
    expect(records.bundleFiles.some((file) => file.logicalPath === "pages/guide.md")).toBe(true);
    expect(records.bundleFiles.some((file) => file.logicalPath === "_graph/manifest.json")).toBe(true);
    expect(records.events.some((event) => event.stageKey === "llm_suggestion")).toBe(true);
    expect(records.events.some((event) => event.stageKey === "graph_generation")).toBe(true);
    expect(records.events.some((event) => event.stageKey === "release_activation")).toBe(true);
    expect(records.graphNodes.has(sourceFileId)).toBe(true);
  });

  it("keeps processing when optional model suggestions are invalid", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await acceptUploadSourceFiles({
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
      createSourceFiles: records.repositories.files!.createSourceFiles!
    });
    const sourceFileId = sourceFileIds[0];

    if (!sourceFileId) {
      throw new Error("Source file was not created");
    }

    const processor = createSourceFileQueueProcessor(records.repositories, storage, redis, {
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
    expect(records.sources.get(sourceFileId)?.modelSuggestions).toBeNull();
    expect(
      records.events.some(
        (event) => event.stageKey === "llm_suggestion" && event.severity === "warning"
      )
    ).toBe(true);
    expect(records.graphNodes.has(sourceFileId)).toBe(true);
  });

  it("drains dirty source files during a batch publication", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await acceptUploadSourceFiles({
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
      createSourceFiles: records.repositories.files!.createSourceFiles!
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
    expect(records.releases.size).toBe(1);
    expect(records.knowledgeBase.activeReleaseId).toMatch(/^release-/u);

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
    expect(records.sources.get(secondSourceFileId)?.processingStage).toBe("release_activation");
    expect(records.sources.get(secondSourceFileId)?.generatedOutputStatus).toBe("visible");
    expect(records.releases.size).toBe(2);
    expect(records.knowledgeBase.activeReleaseId).toMatch(/^release-/u);
    expect(records.bundleFiles.filter((file) => file.fileKind === "page")).toHaveLength(3);
  });

  it("schedules remaining dirty files after a successful release leaves a tail batch", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await acceptUploadSourceFiles({
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
      createSourceFiles: records.repositories.files!.createSourceFiles!
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
        graphEdgeShardSize: 5_000
      },
      reason: "batch_threshold"
    });

    expect(records.sources.get(secondSourceFileId)?.generatedOutputStatus).toBe("pending");
    await waitFor(
      () => records.sources.get(secondSourceFileId)?.generatedOutputStatus === "visible",
      500
    );
    expect(records.sources.get(secondSourceFileId)?.processingStage).toBe("release_activation");
    expect(
      records.events.some(
        (event) =>
          event.sourceFileId === secondSourceFileId && event.stageKey === "release_activation"
      )
    ).toBe(true);
    expect(records.releases.size).toBe(2);
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

  it("marks only the missing stored source file as failed", async () => {
    const storage = new MemoryStorage();
    const redis = createRedisCoordinator(new MemoryRedisCommandClient());
    const records = createRepositories();
    const sourceFileIds = await acceptUploadSourceFiles({
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
      createSourceFiles: records.repositories.files!.createSourceFiles!
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
});

async function waitFor(predicate: () => boolean, timeoutMs = 100) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("Timed out waiting for condition");
}
