import { describe, expect, it } from "vitest";
import type { OkfGraphEdge, OkfGraphNode } from "@focowiki/okf";
import type {
  AdminRepositories,
  BundleFileRecord,
  BundleTreeEntryDraft,
  ReleaseDraft,
  SourceFileDraft,
  SourceFileEventDraft,
  SourceFileRecord
} from "../src/db/admin-repositories.js";
import { createSourceFileQueueProcessor } from "../src/admin/source-file-processor.js";
import { acceptUploadSourceFiles } from "../src/admin/source-file-upload.js";
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

  return { repositories, knowledgeBase, sources, bundleFiles, events, graphNodes, graphEdges };
}

describe("source file queue", () => {
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
      fileProcessingConcurrency: 1,
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
    expect(records.knowledgeBase.activeReleaseId).toMatch(/^release-/u);
    expect(records.bundleFiles.some((file) => file.logicalPath === "pages/guide.md")).toBe(true);
    expect(records.bundleFiles.some((file) => file.logicalPath === "_graph/manifest.json")).toBe(true);
    expect(records.events.some((event) => event.stageKey === "llm_suggestion")).toBe(true);
    expect(records.events.some((event) => event.stageKey === "graph_generation")).toBe(true);
    expect(records.graphNodes.has(sourceFileId)).toBe(true);
  });
});
