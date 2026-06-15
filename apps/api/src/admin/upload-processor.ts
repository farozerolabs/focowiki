import { createHash, randomUUID } from "node:crypto";
import {
  MetadataValidationError,
  parseUploadedMarkdownSource,
  resolveSourceMetadata
} from "@focowiki/okf";
import type { AdminRepositories, UploadTaskRecord } from "../db/admin-repositories.js";
import { publishOkfRelease } from "../okf/publication.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import {
  readModelSuggestions,
  type ModelAssistanceOptions
} from "./model-suggestions.js";

export type UploadFile = {
  name: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export type LoadedUploadFile = {
  fileName: string;
  bytes: Uint8Array;
  content: string;
};

export type KnowledgeBaseUploadProcessor = {
  process: (input: {
    knowledgeBaseId: string;
    task: UploadTaskRecord;
    files: LoadedUploadFile[];
    generatedAt: string;
    batchSize: number;
    cursorTtlSeconds: number;
    fileProcessingConcurrency: number;
  }) => Promise<UploadTaskRecord>;
};

export function createUploadProcessor(
  repositories: AdminRepositories,
  storage: StorageAdapter,
  redis: RedisCoordinator,
  modelAssistance: ModelAssistanceOptions | null = null
): KnowledgeBaseUploadProcessor | null {
  const filesRepository = repositories.files;
  const taskRepository = repositories.tasks;

  if (
    !filesRepository?.createSourceFiles ||
    !filesRepository.createRelease ||
    !filesRepository.createBundleFiles ||
    !filesRepository.createBundleTreeEntries ||
    !filesRepository.activateRelease ||
    !filesRepository.listSourceFiles ||
    !taskRepository?.completeUploadTask ||
    !taskRepository.createUploadTaskEvent
  ) {
    return null;
  }

  const createSourceFiles = filesRepository.createSourceFiles;
  const createRelease = filesRepository.createRelease;
  const createBundleFiles = filesRepository.createBundleFiles;
  const createBundleTreeEntries = filesRepository.createBundleTreeEntries;
  const activateRelease = filesRepository.activateRelease;
  const listSourceFiles = filesRepository.listSourceFiles;
  const completeUploadTask = taskRepository.completeUploadTask;

  return {
    async process(input) {
      const ownerId = `admin-api-${randomUUID()}`;
      let lockAcquired = false;

      try {
        lockAcquired = await redis.acquireTaskLock(
          input.task.id,
          ownerId,
          input.cursorTtlSeconds
        );

        if (!lockAcquired) {
          throw new Error("Upload task lock is already held");
        }

        const sourceRecords = input.files.map((file) => {
          const sourceFileId = createSourceFileId();
          const parsed = parseUploadedMarkdownSource({
            fileName: file.fileName,
            content: file.content
          });
          const objectKey = storage.keyspace.sourceFileKey(
            input.knowledgeBaseId,
            input.task.id,
            sourceFileId,
            file.fileName
          );

          return {
            id: sourceFileId,
            knowledgeBaseId: input.knowledgeBaseId,
            taskId: input.task.id,
            originalName: file.fileName,
            objectKey,
            contentType: "text/markdown; charset=utf-8",
            sizeBytes: file.bytes.byteLength,
            checksumSha256: sha256Bytes(file.bytes),
            metadata: parsed.metadata,
            bytes: file.bytes,
            content: file.content
          };
        });

        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "upload_storage",
          startedAt: input.generatedAt,
          endedAt: null,
          severity: "info"
        });

        for (const source of sourceRecords) {
          await storage.putObject({
            key: source.objectKey,
            body: source.bytes,
            contentType: source.contentType
          });
        }

        await createSourceFiles(
          sourceRecords.map(({ bytes: _bytes, content: _content, ...source }) => source)
        );
        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "upload_storage",
          startedAt: input.generatedAt,
          endedAt: new Date().toISOString(),
          severity: "info"
        });
        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "metadata_resolution",
          startedAt: input.generatedAt,
          endedAt: null,
          severity: "info"
        });

        const modelResult = await readModelSuggestions({
          sources: sourceRecords.map((source) => {
            const resolved = resolveSourceMetadata({
              fileName: source.originalName,
              content: source.content,
              metadata: source.metadata
            });

            return {
              id: source.id,
              fileName: source.originalName,
              title: resolved.metadata.title,
              type: resolved.metadata.type,
              tags: Array.isArray(resolved.metadata.tags) ? resolved.metadata.tags : [],
              body: resolved.body
            };
          }),
          modelAssistance
        });

        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "metadata_resolution",
          startedAt: input.generatedAt,
          endedAt: new Date().toISOString(),
          severity: modelResult.warnings.length > 0 ? "warning" : "info"
        });

        const releaseId = createReleaseId();
        const bundleRootKey = storage.keyspace.releaseRootKey(input.knowledgeBaseId, releaseId);

        await createRelease({
          id: releaseId,
          knowledgeBaseId: input.knowledgeBaseId,
          taskId: input.task.id,
          bundleRootKey,
          generatedAt: input.generatedAt,
          publishedAt: null,
          fileCount: 0,
          manifestChecksumSha256: "pending"
        });

        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "bundle_generation",
          startedAt: input.generatedAt,
          endedAt: null,
          severity: "info"
        });

        const publication = await publishOkfRelease({
          knowledgeBaseId: input.knowledgeBaseId,
          releaseId,
          taskId: input.task.id,
          generatedAt: input.generatedAt,
          pageSize: input.batchSize,
          concurrency: input.fileProcessingConcurrency,
          storage,
          fetchSourcePage: ({ cursor, limit }) =>
            listSourceFiles({
              knowledgeBaseId: input.knowledgeBaseId,
              cursor,
              limit
            }).then((page) => ({
              ...page,
              items: page.items.map((source) => ({
                ...source,
                suggestions: modelResult.suggestionsBySourceId.get(source.id) ?? null
              }))
            })),
          persistBundleFiles: (files) => createBundleFiles(files),
          persistBundleTreeEntries: (entries) => createBundleTreeEntries(entries)
        });

        const publicationEndedAt = new Date().toISOString();
        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "okf_validation",
          startedAt: input.generatedAt,
          endedAt: publicationEndedAt,
          severity: "info"
        });
        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "bundle_generation",
          startedAt: input.generatedAt,
          endedAt: publicationEndedAt,
          severity: "info"
        });
        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "index_publication",
          startedAt: input.generatedAt,
          endedAt: publicationEndedAt,
          severity: "info"
        });

        await activateRelease({
          knowledgeBaseId: input.knowledgeBaseId,
          releaseId,
          taskId: input.task.id,
          publishedAt: publicationEndedAt,
          fileCount: publication.fileCount,
          manifestChecksumSha256: publication.manifestChecksumSha256
        });

        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: "release_activation",
          startedAt: input.generatedAt,
          endedAt: publicationEndedAt,
          severity: "info"
        });

        const completedTask = await completeUploadTask({
          knowledgeBaseId: input.knowledgeBaseId,
          taskId: input.task.id,
          endedAt: publicationEndedAt,
          resultReleaseId: releaseId
        });

        await redis.recordTaskEvent(
          input.task.id,
          {
            knowledgeBaseId: input.knowledgeBaseId,
            lifecycle: "ended"
          },
          input.cursorTtlSeconds
        );
        await invalidateKnowledgeBaseAdminPages({
          redis,
          knowledgeBaseId: input.knowledgeBaseId,
          releaseId,
          taskId: input.task.id,
          ttlSeconds: input.cursorTtlSeconds
        });

        return completedTask;
      } catch (error) {
        await recordTaskPhase({
          taskRepository,
          taskId: input.task.id,
          phaseKey: error instanceof MetadataValidationError ? "metadata_resolution" : "bundle_generation",
          startedAt: input.generatedAt,
          endedAt: new Date().toISOString(),
          severity: "error"
        }).catch(() => undefined);
        await completeUploadTask({
          knowledgeBaseId: input.knowledgeBaseId,
          taskId: input.task.id,
          endedAt: new Date().toISOString(),
          resultReleaseId: null,
          internalErrorCode:
            error instanceof MetadataValidationError
              ? "METADATA_VALIDATION_FAILED"
              : "UPLOAD_PROCESSING_FAILED",
          internalErrorMessage: error instanceof Error ? error.message : "Upload failed"
        }).catch(() => undefined);
        await redis
          .recordTaskEvent(
            input.task.id,
            {
              knowledgeBaseId: input.knowledgeBaseId,
              lifecycle: "ended"
            },
            input.cursorTtlSeconds
          )
          .catch(() => undefined);
        await invalidateKnowledgeBaseAdminPages({
          redis,
          knowledgeBaseId: input.knowledgeBaseId,
          releaseId: null,
          taskId: input.task.id,
          ttlSeconds: input.cursorTtlSeconds
        }).catch(() => undefined);
        throw error;
      } finally {
        if (lockAcquired) {
          await redis.releaseTaskLock(input.task.id, ownerId);
        }
      }
    }
  };
}

export async function readBoundedUploadFiles(files: UploadFile[]): Promise<LoadedUploadFile[]> {
  return Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());

      return {
        fileName: file.name,
        bytes,
        content: new TextDecoder().decode(bytes)
      };
    })
  );
}

async function recordTaskPhase(options: {
  taskRepository: NonNullable<AdminRepositories["tasks"]>;
  taskId: string;
  phaseKey:
    | "upload_storage"
    | "metadata_resolution"
    | "okf_validation"
    | "bundle_generation"
    | "index_publication"
    | "release_activation";
  startedAt: string | null;
  endedAt: string | null;
  severity: "info" | "warning" | "error";
}): Promise<void> {
  if (!options.taskRepository.createUploadTaskEvent) {
    return;
  }

  await options.taskRepository.createUploadTaskEvent({
    taskId: options.taskId,
    phaseKey: options.phaseKey,
    messageKey: phaseMessageKey(options.phaseKey),
    startedAt: options.startedAt,
    endedAt: options.endedAt,
    severity: options.severity
  });
}

function phaseMessageKey(phaseKey: Parameters<typeof recordTaskPhase>[0]["phaseKey"]): string {
  return `tasks.phase.${phaseKey.replace(/_([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase()
  )}`;
}

async function invalidateKnowledgeBaseAdminPages(options: {
  redis: RedisCoordinator;
  knowledgeBaseId: string;
  releaseId: string | null;
  taskId: string;
  ttlSeconds: number;
}): Promise<void> {
  const scopes = [
    "knowledge-bases",
    `source-files:${options.knowledgeBaseId}`,
    `releases:${options.knowledgeBaseId}`,
    `upload-tasks:${options.knowledgeBaseId}`,
    `upload-task-events:${options.knowledgeBaseId}:${options.taskId}`,
    ...(options.releaseId
      ? [
          `file-tree:${options.knowledgeBaseId}:${options.releaseId}:root`,
          `bundle-files:${options.knowledgeBaseId}:${options.releaseId}`
        ]
      : [])
  ];

  await Promise.all(
    scopes.map((scope) =>
      options.redis.markPaginationInvalid(scope, "changed", options.ttlSeconds)
    )
  );
}

function createSourceFileId(): string {
  return `source-file-${randomUUID()}`;
}

function createReleaseId(): string {
  return `release-${randomUUID()}`;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
