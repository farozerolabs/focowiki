import { randomBytes, randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../config.js";
import type {
  AdminRepositories,
  BundleFileRecord,
  CursorPage,
  SourceFileRecord
} from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import {
  createSourceFileId,
  createUploadProcessor,
  type LoadedUploadFile
} from "../admin/upload-processor.js";
import { createDeletionService } from "../admin/deletion-service.js";
import { createWebhookDispatcher, type WebhookEvent } from "../webhooks/dispatcher.js";
import type { OpenAIResponsesClient } from "@focowiki/okf";
import {
  conflict,
  notFound,
  payloadTooLarge,
  repositoryUnavailable,
  validationError
} from "./errors.js";
import {
  toDeveloperBundleFile,
  toDeveloperBundleTreeEntry,
  toDeveloperKnowledgeBase,
  toDeveloperSourceFile,
  toDeveloperSourceFileDetail,
  toDeveloperTask,
  toDeveloperWebhook,
  toDeveloperWebhookDelivery
} from "./serializers.js";

export type DeveloperOpenApiServices = {
  config: RuntimeConfig;
  repositories: AdminRepositories | null;
  redis: RedisCoordinator | null;
  storage: StorageAdapter;
  modelClient: OpenAIResponsesClient | null;
};

export function createDeveloperOpenApiService(services: DeveloperOpenApiServices) {
  const { config, repositories, redis, storage, modelClient } = services;

  function requireRepositories(): AdminRepositories {
    if (!repositories) {
      throw repositoryUnavailable();
    }

    return repositories;
  }

  function requireRedis(): RedisCoordinator {
    if (!redis) {
      throw repositoryUnavailable();
    }

    return redis;
  }

  return {
    async createKnowledgeBase(input: { name: string; description: string | null }) {
      const repo = requireRepositories();
      const normalizedName = input.name.trim();

      if (!normalizedName) {
        throw validationError("Knowledge base name is required.", { field: "name" });
      }

      const knowledgeBase = await repo.knowledgeBases.createKnowledgeBase({
        name: normalizedName,
        description: input.description?.trim() || null
      });

      return { knowledgeBase: toDeveloperKnowledgeBase(knowledgeBase) };
    },
    async listKnowledgeBases(input: { limit: number; cursor: string | null }) {
      const repo = requireRepositories();
      const page = await repo.knowledgeBases.listKnowledgeBases({
        limit: input.limit,
        cursor: await readCursor(requireRedis(), "developer-openapi:knowledge-bases", input.cursor)
      });

      return {
        items: page.items.map(toDeveloperKnowledgeBase),
        nextCursor: await writeCursor(
          requireRedis(),
          "developer-openapi:knowledge-bases",
          page.nextCursor,
          config.pagination.cursorTtlSeconds
        )
      };
    },
    async getKnowledgeBase(knowledgeBaseId: string) {
      const knowledgeBase = await requireRepositories().knowledgeBases.getKnowledgeBase(
        knowledgeBaseId
      );

      if (!knowledgeBase) {
        throw notFound();
      }

      return { knowledgeBase: toDeveloperKnowledgeBase(knowledgeBase) };
    },
    async deleteKnowledgeBase(knowledgeBaseId: string) {
      const repo = requireRepositories();
      const coordinator = requireRedis();
      const deletionService = createDeletionService(repo, storage, coordinator);

      if (!deletionService) {
        throw repositoryUnavailable();
      }

      const deleted = await deletionService.deleteKnowledgeBase({
        knowledgeBaseId,
        deletedAt: new Date().toISOString(),
        cursorTtlSeconds: config.pagination.cursorTtlSeconds
      });

      if (!deleted) {
        throw notFound();
      }

      await dispatchWebhookEvent({
        eventType: "knowledge_base.deleted",
        payload: { knowledgeBaseId }
      }).catch(() => undefined);

      return { deleted: true, knowledgeBaseId };
    },
    async uploadMarkdown(input: {
      knowledgeBaseId: string;
      files: File[];
      runTask: (work: () => Promise<unknown>) => void;
    }) {
      const repo = requireRepositories();
      const coordinator = requireRedis();

      if (!repo.tasks || !repo.files) {
        throw repositoryUnavailable();
      }

      const knowledgeBase = await repo.knowledgeBases.getKnowledgeBase(input.knowledgeBaseId);

      if (!knowledgeBase) {
        throw notFound();
      }

      if (input.files.length === 0) {
        throw validationError("At least one Markdown file is required.", { field: "files" });
      }

      if (input.files.length > config.upload.maxFiles) {
        throw payloadTooLarge("Too many files were uploaded.");
      }

      if (input.files.some((file) => !file.name.toLowerCase().endsWith(".md"))) {
        throw validationError("Only Markdown .md files are accepted.", { field: "files" });
      }

      const loadedFiles = await readLoadedFiles(input.files);
      const totalBytes = loadedFiles.reduce((sum, file) => sum + file.bytes.byteLength, 0);

      if (totalBytes > config.upload.maxBytes) {
        throw payloadTooLarge("Uploaded files exceed the byte limit.");
      }

      const task = await repo.tasks.createUploadTask({
        knowledgeBaseId: knowledgeBase.id,
        sourceCount: loadedFiles.length,
        operation: "upload"
      });
      const processor = createUploadProcessor(
        repo,
        storage,
        coordinator,
        modelClient && config.model.enabled
          ? {
              client: modelClient,
              modelName: config.model.modelName,
              contextWindowTokens: config.model.contextWindowTokens,
              receiveTimeouts: {
                maxMs: config.model.requestMaxTimeoutMs,
                idleMs: config.model.requestIdleTimeoutMs
              },
              suggestionConcurrency: config.model.suggestionConcurrency
            }
          : null
      );

      if (!processor) {
        throw repositoryUnavailable();
      }

      input.runTask(async () => {
        const generatedAt = new Date().toISOString();
        await dispatchWebhookEvent({
          eventType: "task.started",
          payload: {
            knowledgeBaseId: knowledgeBase.id,
            taskId: task.id,
            operation: task.operation,
            sourceCount: task.sourceCount
          },
          createdAt: generatedAt
        }).catch(() => undefined);

        try {
          const completedTask = await processor.process({
            knowledgeBaseId: knowledgeBase.id,
            knowledgeBaseName: knowledgeBase.name,
            task,
            files: loadedFiles,
            generatedAt,
            batchSize: config.upload.generationBatchSize,
            cursorTtlSeconds: config.pagination.cursorTtlSeconds,
            fileProcessingConcurrency: config.upload.fileProcessingConcurrency,
            okfLog: config.okf?.log,
            onProgress: (progress) =>
              dispatchWebhookEvent({
                eventType: "task.progress",
                payload: {
                  knowledgeBaseId: knowledgeBase.id,
                  taskId: task.id,
                  operation: task.operation,
                  sourceFileIds: progress.sourceFileIds,
                  status: progress.status,
                  stage: progress.stage,
                  startedAt: progress.startedAt,
                  endedAt: progress.endedAt,
                  errorCode: progress.errorCode
                }
              }).catch(() => undefined)
          });

          await dispatchTaskEnded(completedTask).catch(() => undefined);
          if (completedTask.resultReleaseId) {
            await dispatchWebhookEvent({
              eventType: "release.published",
              payload: {
                knowledgeBaseId: knowledgeBase.id,
                taskId: task.id,
                releaseId: completedTask.resultReleaseId
              }
            }).catch(() => undefined);
          }
        } catch (error) {
          await dispatchWebhookEvent({
            eventType: "task.ended",
            payload: {
              knowledgeBaseId: knowledgeBase.id,
              taskId: task.id,
              operation: task.operation,
              errorCode: error instanceof Error ? "TASK_FAILED" : "UNKNOWN_TASK_ERROR"
            }
          }).catch(() => undefined);
          throw error;
        }
      });

      return {
        knowledgeBaseId: knowledgeBase.id,
        taskId: task.id,
        files: loadedFiles.map((file) => ({
          fileId: file.sourceFileId,
          originalFilename: file.fileName,
          sizeBytes: file.bytes.byteLength
        }))
      };
    },
    async listTasks(input: { knowledgeBaseId: string; limit: number; cursor: string | null }) {
      const repo = requireRepositories();

      if (!repo.tasks?.listUploadTasks) {
        throw repositoryUnavailable();
      }

      await requireKnowledgeBase(repo, input.knowledgeBaseId);
      const scope = `developer-openapi:tasks:${input.knowledgeBaseId}`;
      const page = await repo.tasks.listUploadTasks({
        knowledgeBaseId: input.knowledgeBaseId,
        limit: input.limit,
        cursor: await readCursor(requireRedis(), scope, input.cursor)
      });

      return pageResponse(page, scope, config.pagination.cursorTtlSeconds, requireRedis(), toDeveloperTask);
    },
    async getTask(input: {
      knowledgeBaseId: string;
      taskId: string;
      limit: number;
      cursor: string | null;
    }) {
      const repo = requireRepositories();

      if (!repo.tasks?.getUploadTask || !repo.files?.listSourceFilesForTask) {
        throw repositoryUnavailable();
      }

      const task = await repo.tasks.getUploadTask(input);

      if (!task) {
        throw notFound();
      }

      const scope = `developer-openapi:task-files:${input.knowledgeBaseId}:${input.taskId}`;
      const files = await repo.files.listSourceFilesForTask({
        knowledgeBaseId: input.knowledgeBaseId,
        taskId: input.taskId,
        limit: input.limit,
        cursor: await readCursor(requireRedis(), scope, input.cursor)
      });

      return {
        task: toDeveloperTask(task),
        files: {
          items: files.items.map(toDeveloperSourceFile),
          nextCursor: await writeCursor(
            requireRedis(),
            scope,
            files.nextCursor,
            config.pagination.cursorTtlSeconds
          )
        }
      };
    },
    async listTree(input: {
      knowledgeBaseId: string;
      parentPath: string;
      limit: number;
      cursor: string | null;
    }) {
      const repo = requireRepositories();

      if (!repo.files?.listBundleTreeEntries) {
        throw repositoryUnavailable();
      }

      assertSafeLogicalPath(input.parentPath, true);
      const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);

      if (!knowledgeBase.activeReleaseId) {
        return { items: [], nextCursor: null };
      }

      const scope = `developer-openapi:tree:${knowledgeBase.id}:${knowledgeBase.activeReleaseId}:${input.parentPath || "root"}`;
      const page = await repo.files.listBundleTreeEntries({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        parentPath: input.parentPath,
        limit: input.limit,
        cursor: await readCursor(requireRedis(), scope, input.cursor)
      });

      return pageResponse(
        page,
        scope,
        config.pagination.cursorTtlSeconds,
        requireRedis(),
        toDeveloperBundleTreeEntry
      );
    },
    async getFileById(input: { knowledgeBaseId: string; fileId: string }) {
      const resolved = await resolveFileById(requireRepositories(), input);
      return {
        file:
          resolved.kind === "bundle"
            ? toDeveloperBundleFile(resolved.file, resolved.source)
            : toDeveloperSourceFileDetail(resolved.file)
      };
    },
    async getFileContentById(input: { knowledgeBaseId: string; fileId: string }) {
      const resolved = await resolveFileById(requireRepositories(), input);

      if (resolved.kind !== "bundle") {
        throw conflict("File content is not available until publication completes.");
      }

      const content = await storage.getObjectText(resolved.file.objectKey);

      if (content === null) {
        throw notFound();
      }

      return {
        file: toDeveloperBundleFile(resolved.file, resolved.source),
        content
      };
    },
    async getFileContentByPath(input: { knowledgeBaseId: string; path: string }) {
      const repo = requireRepositories();

      assertSafeLogicalPath(input.path, false);
      const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);

      if (!knowledgeBase.activeReleaseId || !repo.files?.getBundleFile) {
        throw notFound();
      }

      const file = await repo.files.getBundleFile({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        logicalPath: input.path
      });

      if (!file) {
        throw notFound();
      }

      const content = await storage.getObjectText(file.objectKey);

      if (content === null) {
        throw notFound();
      }

      return {
        file: toDeveloperBundleFile(file, await readSourceForBundle(repo, file)),
        content
      };
    },
    async deleteFileById(input: {
      knowledgeBaseId: string;
      fileId: string;
      runTask: (work: () => Promise<unknown>) => void;
    }) {
      const resolved = await resolveFileById(requireRepositories(), input);

      if (resolved.kind !== "bundle") {
        throw validationError("Only generated source-backed files can be deleted.");
      }

      return deleteBundleFile(resolved.file, input.runTask);
    },
    async deleteFileByPath(input: {
      knowledgeBaseId: string;
      path: string;
      runTask: (work: () => Promise<unknown>) => void;
    }) {
      const repo = requireRepositories();
      const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);

      assertSafeLogicalPath(input.path, false);

      if (!knowledgeBase.activeReleaseId || !repo.files?.getBundleFile) {
        throw notFound();
      }

      const file = await repo.files.getBundleFile({
        knowledgeBaseId: knowledgeBase.id,
        releaseId: knowledgeBase.activeReleaseId,
        logicalPath: input.path
      });

      if (!file) {
        throw notFound();
      }

      return deleteBundleFile(file, input.runTask);
    },
    async createWebhook(input: { name: string | null; url: string; events: string[] }) {
      const repo = requireRepositories();

      if (!repo.webhooks) {
        throw repositoryUnavailable();
      }

      const url = normalizeWebhookUrl(input.url);
      const rawSecret = `fwwh_${randomBytes(32).toString("base64url")}`;
      const createdAt = new Date().toISOString();
      const webhook = await repo.webhooks.createWebhookSubscription({
        id: `webhook-${randomUUID()}`,
        name: input.name?.trim() || "Webhook",
        url,
        signingSecret: rawSecret,
        events: input.events.filter((event) => typeof event === "string" && event.trim()),
        createdAt
      });

      return {
        webhook: toDeveloperWebhook(webhook),
        signingSecret: rawSecret
      };
    },
    async listWebhooks(input: { limit: number; cursor: string | null }) {
      const repo = requireRepositories();

      if (!repo.webhooks) {
        throw repositoryUnavailable();
      }

      const scope = "developer-openapi:webhooks";
      const page = await repo.webhooks.listWebhookSubscriptions({
        limit: input.limit,
        cursor: await readCursor(requireRedis(), scope, input.cursor)
      });

      return pageResponse(page, scope, config.pagination.cursorTtlSeconds, requireRedis(), toDeveloperWebhook);
    },
    async deleteWebhook(webhookId: string) {
      const repo = requireRepositories();

      if (!repo.webhooks) {
        throw repositoryUnavailable();
      }

      const deleted = await repo.webhooks.deleteWebhookSubscription({
        id: webhookId,
        updatedAt: new Date().toISOString()
      });

      if (!deleted) {
        throw notFound();
      }

      return { deleted: true, webhookId };
    },
    async listWebhookDeliveries(input: { limit: number; cursor: string | null }) {
      const repo = requireRepositories();

      if (!repo.webhooks) {
        throw repositoryUnavailable();
      }

      const scope = "developer-openapi:webhook-deliveries";
      const page = await repo.webhooks.listWebhookDeliveries({
        limit: input.limit,
        cursor: await readCursor(requireRedis(), scope, input.cursor)
      });

      return pageResponse(
        page,
        scope,
        config.pagination.cursorTtlSeconds,
        requireRedis(),
        toDeveloperWebhookDelivery
      );
    },
    async redeliverWebhook(deliveryId: string) {
      const repo = requireRepositories();

      if (!repo.webhooks?.getWebhookDelivery) {
        throw repositoryUnavailable();
      }

      const delivery = await repo.webhooks.getWebhookDelivery(deliveryId);

      if (!delivery) {
        throw notFound();
      }

      const dispatcher = createWebhookDispatcher({ repositories: repo, redis: requireRedis() });

      if (!dispatcher) {
        throw repositoryUnavailable();
      }

      return { delivery: toDeveloperWebhookDelivery(await dispatcher.redeliver(delivery)) };
    }
  };

  async function deleteBundleFile(
    file: BundleFileRecord,
    runTask: (work: () => Promise<unknown>) => void
  ) {
    const repo = requireRepositories();
    const coordinator = requireRedis();
    const deletionService = createDeletionService(repo, storage, coordinator);

    if (!deletionService || file.fileKind !== "page" || !file.sourceFileId) {
      throw validationError("Only generated source-backed files can be deleted.");
    }

    const started = await deletionService.createSourcePageDeletionTask({
      knowledgeBaseId: file.knowledgeBaseId,
      logicalPath: file.logicalPath
    });

    if (!started.ok) {
      throw started.reason === "not_deletable"
        ? validationError("File is not deletable.")
        : notFound();
    }

    const deletedAt = new Date().toISOString();
    runTask(async () => {
      await dispatchWebhookEvent({
        eventType: "task.started",
        payload: {
          knowledgeBaseId: file.knowledgeBaseId,
          taskId: started.task.id,
          operation: started.task.operation,
          sourceCount: started.task.sourceCount
        },
        createdAt: deletedAt
      }).catch(() => undefined);
      const completedTask = await deletionService.processSourcePageDeletion({
        knowledgeBase: started.knowledgeBase,
        file: started.file,
        task: started.task,
        deletedAt,
        generatedAt: deletedAt,
        batchSize: config.upload.generationBatchSize,
        cursorTtlSeconds: config.pagination.cursorTtlSeconds,
        fileProcessingConcurrency: config.upload.fileProcessingConcurrency,
        okfLog: config.okf?.log
      });

      await dispatchTaskEnded(completedTask).catch(() => undefined);
      await dispatchWebhookEvent({
        eventType: "file.deleted",
        payload: {
          knowledgeBaseId: file.knowledgeBaseId,
          taskId: started.task.id,
          fileId: file.id,
          sourceFileId: file.sourceFileId,
          path: file.logicalPath
        }
      }).catch(() => undefined);
      if (completedTask.resultReleaseId) {
        await dispatchWebhookEvent({
          eventType: "release.published",
          payload: {
            knowledgeBaseId: file.knowledgeBaseId,
            taskId: started.task.id,
            releaseId: completedTask.resultReleaseId
          }
        }).catch(() => undefined);
      }
    });

    return {
      knowledgeBaseId: file.knowledgeBaseId,
      taskId: started.task.id,
      file: toDeveloperBundleFile(file, await readSourceForBundle(repo, file))
    };
  }

  async function dispatchTaskEnded(task: { id: string; knowledgeBaseId: string; operation: string; resultReleaseId: string | null; internalErrorCode: string | null }) {
    await dispatchWebhookEvent({
      eventType: "task.ended",
      payload: {
        knowledgeBaseId: task.knowledgeBaseId,
        taskId: task.id,
        operation: task.operation,
        resultReleaseId: task.resultReleaseId,
        errorCode: task.internalErrorCode
      }
    });
  }

  async function dispatchWebhookEvent(event: WebhookEvent): Promise<void> {
    const dispatcher = createWebhookDispatcher({ repositories, redis });
    await dispatcher?.dispatch(event);
  }

  async function resolveFileById(
    repo: AdminRepositories,
    input: { knowledgeBaseId: string; fileId: string }
  ): Promise<
    | { kind: "bundle"; file: BundleFileRecord; source: SourceFileRecord | null }
    | { kind: "source"; file: SourceFileRecord }
  > {
    const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);

    if (knowledgeBase.activeReleaseId) {
      const bundleFile =
        (await repo.files?.getBundleFileById?.({
          knowledgeBaseId: knowledgeBase.id,
          releaseId: knowledgeBase.activeReleaseId,
          fileId: input.fileId
        })) ??
        (await findBundleFileById(repo, {
          knowledgeBaseId: knowledgeBase.id,
          releaseId: knowledgeBase.activeReleaseId,
          fileId: input.fileId
        }));

      if (bundleFile) {
        return {
          kind: "bundle",
          file: bundleFile,
          source: await readSourceForBundle(repo, bundleFile)
        };
      }
    }

    const source =
      (await repo.files?.getSourceFile?.({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.fileId
      })) ?? (await findSourceFileById(repo, input));

    if (!source) {
      throw notFound();
    }

    return { kind: "source", file: source };
  }
}

async function requireKnowledgeBase(repo: AdminRepositories, knowledgeBaseId: string) {
  const knowledgeBase = await repo.knowledgeBases.getKnowledgeBase(knowledgeBaseId);

  if (!knowledgeBase) {
    throw notFound();
  }

  return knowledgeBase;
}

async function readLoadedFiles(files: File[]): Promise<LoadedUploadFile[]> {
  return Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());

      return {
        sourceFileId: createSourceFileId(),
        fileName: file.name,
        bytes,
        content: new TextDecoder().decode(bytes)
      };
    })
  );
}

async function readCursor(
  redis: RedisCoordinator,
  scope: string,
  cursor: string | null
): Promise<string | null> {
  if (!cursor) {
    return null;
  }

  const value = await redis.getPaginationCursor<string>(scope, cursor);

  if (!value) {
    throw validationError("Pagination cursor is invalid or expired.", { field: "cursor" });
  }

  return value;
}

async function writeCursor(
  redis: RedisCoordinator,
  scope: string,
  cursor: string | null,
  ttlSeconds: number
): Promise<string | null> {
  if (!cursor) {
    return null;
  }

  const cursorId = `cursor-${randomUUID()}`;
  await redis.setPaginationCursor(scope, cursorId, cursor, ttlSeconds);
  return cursorId;
}

async function pageResponse<T, U>(
  page: CursorPage<T>,
  scope: string,
  ttlSeconds: number,
  redis: RedisCoordinator,
  map: (value: T) => U
): Promise<{ items: U[]; nextCursor: string | null }> {
  return {
    items: page.items.map(map),
    nextCursor: await writeCursor(redis, scope, page.nextCursor, ttlSeconds)
  };
}

function assertSafeLogicalPath(path: string, allowDirectory: boolean): void {
  if (
    (allowDirectory && path === "") ||
    isAllowedGeneratedPath(path) ||
    (allowDirectory && isSafeGeneratedDirectoryPath(path))
  ) {
    return;
  }

  throw validationError("Logical path is not supported.", { field: "path" });
}

function isAllowedGeneratedPath(path: string): boolean {
  return (
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").includes("..") &&
    !path.includes("//") &&
    !path.startsWith("sources/") &&
    (path === "index.md" ||
      path === "log.md" ||
      path === "schema.md" ||
      /^pages\/[^/].*\.md$/u.test(path) ||
      /^_index\/[^/]+\.json$/u.test(path))
  );
}

function isSafeGeneratedDirectoryPath(path: string): boolean {
  const parts = path.split("/");

  return (
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("//") &&
    !path.startsWith("sources/") &&
    parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.includes(".."))
  );
}

async function findBundleFileById(
  repo: AdminRepositories,
  input: { knowledgeBaseId: string; releaseId: string; fileId: string }
): Promise<BundleFileRecord | null> {
  if (!repo.files?.listBundleFiles) {
    return null;
  }

  let cursor: string | null = null;

  do {
    const page = await repo.files.listBundleFiles({
      knowledgeBaseId: input.knowledgeBaseId,
      releaseId: input.releaseId,
      limit: 200,
      cursor
    });
    const found = page.items.find((file) => file.id === input.fileId);

    if (found) {
      return found;
    }

    cursor = page.nextCursor;
  } while (cursor);

  return null;
}

async function findSourceFileById(
  repo: AdminRepositories,
  input: { knowledgeBaseId: string; fileId: string }
): Promise<SourceFileRecord | null> {
  if (!repo.files?.listSourceFiles) {
    return null;
  }

  let cursor: string | null = null;

  do {
    const page = await repo.files.listSourceFiles({
      knowledgeBaseId: input.knowledgeBaseId,
      limit: 200,
      cursor
    });
    const found = page.items.find((file) => file.id === input.fileId);

    if (found) {
      return found;
    }

    cursor = page.nextCursor;
  } while (cursor);

  return null;
}

async function readSourceForBundle(
  repo: AdminRepositories,
  file: BundleFileRecord
): Promise<SourceFileRecord | null> {
  if (!file.sourceFileId) {
    return null;
  }

  return (
    (await repo.files?.getSourceFile?.({
      knowledgeBaseId: file.knowledgeBaseId,
      sourceFileId: file.sourceFileId
    })) ??
    (await findSourceFileById(repo, {
      knowledgeBaseId: file.knowledgeBaseId,
      fileId: file.sourceFileId
    }))
  );
}

function normalizeWebhookUrl(value: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw validationError("Webhook URL is invalid.", { field: "url" });
  }

  if (parsed.protocol !== "https:") {
    throw validationError("Webhook URL must use HTTPS.", { field: "url" });
  }

  return parsed.toString();
}
