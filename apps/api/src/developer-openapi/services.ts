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
import { createSourceFileQueueProcessor } from "../admin/source-file-processor.js";
import { acceptUploadSourceFiles } from "../admin/source-file-upload.js";
import type { LoadedUploadFile } from "../admin/upload-processor-utils.js";
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
  toDeveloperSourceFileEvent,
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

      if (!repo.files?.createSourceFiles || !repo.files.getSourceFile) {
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

      const processor = createSourceFileQueueProcessor(
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

      const sourceFileIds = await acceptUploadSourceFiles({
        files: loadedFiles,
        fileProcessingConcurrency: config.upload.fileProcessingConcurrency,
        knowledgeBaseId: knowledgeBase.id,
        storage,
        createSourceFiles: repo.files.createSourceFiles
      });
      const sourceFiles = (
        await Promise.all(
          sourceFileIds.map((sourceFileId) =>
            repo.files?.getSourceFile?.({
              knowledgeBaseId: knowledgeBase.id,
              sourceFileId
            })
          )
        )
      ).filter(isDefined);

      for (const sourceFileId of sourceFileIds) {
        const generatedAt = new Date().toISOString();
        await dispatchWebhookEvent({
          eventType: "source_file.accepted",
          payload: {
            knowledgeBaseId: knowledgeBase.id,
            sourceFileId
          },
          createdAt: generatedAt
        }).catch(() => undefined);

        input.runTask(async () => {
          try {
            await dispatchWebhookEvent({
              eventType: "source_file.progress",
              payload: {
                knowledgeBaseId: knowledgeBase.id,
                sourceFileId
              }
            }).catch(() => undefined);
            const completedSource = await processor.processFile({
              knowledgeBaseId: knowledgeBase.id,
              knowledgeBaseName: knowledgeBase.name,
              sourceFileId,
              generatedAt,
              batchSize: config.upload.generationBatchSize,
              cursorTtlSeconds: config.pagination.cursorTtlSeconds,
              fileProcessingConcurrency: config.upload.fileProcessingConcurrency,
              okfLog: config.okf?.log
            });
            await dispatchWebhookEvent({
              eventType: "source_file.completed",
              payload: {
                knowledgeBaseId: knowledgeBase.id,
                sourceFileId: completedSource.id
              }
            }).catch(() => undefined);
            if (completedSource.processingStatus === "completed") {
              await dispatchWebhookEvent({
                eventType: "release.published",
                payload: {
                  knowledgeBaseId: knowledgeBase.id,
                  sourceFileId: completedSource.id
                }
              }).catch(() => undefined);
            }
          } catch (error) {
            await dispatchWebhookEvent({
              eventType: "source_file.failed",
              payload: {
                knowledgeBaseId: knowledgeBase.id,
                sourceFileId,
                errorCode: error instanceof Error ? "SOURCE_FILE_FAILED" : "UNKNOWN_FILE_ERROR"
              }
            }).catch(() => undefined);
            throw error;
          }
        });
      }

      return {
        knowledgeBaseId: knowledgeBase.id,
        files: sourceFiles.map(toDeveloperSourceFile)
      };
    },
    async listSourceFiles(input: { knowledgeBaseId: string; limit: number; cursor: string | null }) {
      const repo = requireRepositories();

      if (!repo.files?.listSourceFiles) {
        throw repositoryUnavailable();
      }

      await requireKnowledgeBase(repo, input.knowledgeBaseId);
      const scope = `developer-openapi:source-files:${input.knowledgeBaseId}`;
      const page = await repo.files.listSourceFiles({
        knowledgeBaseId: input.knowledgeBaseId,
        limit: input.limit,
        cursor: await readCursor(requireRedis(), scope, input.cursor)
      });

      return pageResponse(
        page,
        scope,
        config.pagination.cursorTtlSeconds,
        requireRedis(),
        toDeveloperSourceFile
      );
    },
    async getSourceFile(input: {
      knowledgeBaseId: string;
      sourceFileId: string;
    }) {
      const repo = requireRepositories();

      if (!repo.files?.getSourceFile) {
        throw repositoryUnavailable();
      }

      const sourceFile = await repo.files.getSourceFile({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.sourceFileId
      });

      if (!sourceFile) {
        throw notFound();
      }

      return {
        file: toDeveloperSourceFile(sourceFile)
      };
    },
    async listSourceFileEvents(input: {
      knowledgeBaseId: string;
      sourceFileId: string;
      limit: number;
      cursor: string | null;
    }) {
      const repo = requireRepositories();

      if (!repo.files?.getSourceFile || !repo.files.listSourceFileEvents) {
        throw repositoryUnavailable();
      }

      const sourceFile = await repo.files.getSourceFile({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.sourceFileId
      });

      if (!sourceFile) {
        throw notFound();
      }

      const scope = `developer-openapi:source-file-events:${input.knowledgeBaseId}:${input.sourceFileId}`;
      const page = await repo.files.listSourceFileEvents({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.sourceFileId,
        limit: input.limit,
        cursor: await readCursor(requireRedis(), scope, input.cursor)
      });

      return pageResponse(
        page,
        scope,
        config.pagination.cursorTtlSeconds,
        requireRedis(),
        toDeveloperSourceFileEvent
      );
    },
    async retrySourceFile(input: {
      knowledgeBaseId: string;
      sourceFileId: string;
      runTask: (work: () => Promise<unknown>) => void;
    }) {
      const repo = requireRepositories();
      const coordinator = requireRedis();

      if (
        !repo.files?.getSourceFile ||
        !repo.files.createSourceFileRetryAttempt
      ) {
        throw repositoryUnavailable();
      }

      const knowledgeBase = await requireKnowledgeBase(repo, input.knowledgeBaseId);
      const sourceFile = await repo.files.getSourceFile({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileId: input.sourceFileId
      });

      if (!sourceFile) {
        throw notFound();
      }

      if (sourceFile.processingStatus !== "failed") {
        throw conflict("Only failed source files can be retried.");
      }

      const processor = createSourceFileQueueProcessor(
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

      const startedAt = new Date().toISOString();
      await repo.files.createSourceFileRetryAttempt({
        knowledgeBaseId: knowledgeBase.id,
        sourceFileId: sourceFile.id,
        status: "running",
        startedAt,
        endedAt: null,
        errorCode: null
      });
      const queuedFile =
        (await repo.files.getSourceFile({
          knowledgeBaseId: knowledgeBase.id,
          sourceFileId: sourceFile.id
        })) ?? sourceFile;

      input.runTask(async () => {
        try {
          await dispatchWebhookEvent({
            eventType: "source_file.progress",
            payload: {
              knowledgeBaseId: knowledgeBase.id,
              sourceFileId: sourceFile.id
            }
          }).catch(() => undefined);
          const completedSource = await processor.processFile({
            knowledgeBaseId: knowledgeBase.id,
            knowledgeBaseName: knowledgeBase.name,
            sourceFileId: sourceFile.id,
            generatedAt: startedAt,
            batchSize: config.upload.generationBatchSize,
            cursorTtlSeconds: config.pagination.cursorTtlSeconds,
            fileProcessingConcurrency: config.upload.fileProcessingConcurrency,
            okfLog: config.okf?.log
          });
          await dispatchWebhookEvent({
            eventType:
              completedSource.processingStatus === "completed"
                ? "source_file.completed"
                : "source_file.failed",
            payload: {
              knowledgeBaseId: knowledgeBase.id,
              sourceFileId: completedSource.id,
              errorCode: completedSource.processingErrorCode ?? null
            }
          }).catch(() => undefined);
        } catch (error) {
          await dispatchWebhookEvent({
            eventType: "source_file.failed",
            payload: {
              knowledgeBaseId: knowledgeBase.id,
              sourceFileId: sourceFile.id,
              errorCode: error instanceof Error ? "SOURCE_FILE_FAILED" : "UNKNOWN_FILE_ERROR"
            }
          }).catch(() => undefined);
          throw error;
        }
      });

      return {
        file: toDeveloperSourceFile(queuedFile)
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
    }) {
      const resolved = await resolveFileById(requireRepositories(), input);

      if (resolved.kind !== "bundle") {
        throw validationError("Only generated source-backed files can be deleted.");
      }

      return deleteBundleFile(resolved.file);
    },
    async deleteFileByPath(input: {
      knowledgeBaseId: string;
      path: string;
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

      return deleteBundleFile(file);
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

  async function deleteBundleFile(file: BundleFileRecord) {
    const repo = requireRepositories();
    const coordinator = requireRedis();
    const deletionService = createDeletionService(repo, storage, coordinator);

    if (!deletionService || file.fileKind !== "page" || !file.sourceFileId) {
      throw validationError("Only generated source-backed files can be deleted.");
    }

    const deletedAt = new Date().toISOString();
    const result = await deletionService.deleteSourcePage({
      knowledgeBaseId: file.knowledgeBaseId,
      logicalPath: file.logicalPath,
      deletedAt,
      generatedAt: deletedAt,
      batchSize: config.upload.generationBatchSize,
      cursorTtlSeconds: config.pagination.cursorTtlSeconds,
      fileProcessingConcurrency: config.upload.fileProcessingConcurrency,
      okfLog: config.okf?.log
    });

    if (!result.ok) {
      throw result.reason === "not_deletable"
        ? validationError("File is not deletable.")
        : notFound();
    }

    await dispatchWebhookEvent({
      eventType: "file.deleted",
      payload: {
        knowledgeBaseId: file.knowledgeBaseId,
        fileId: file.id,
        sourceFileId: file.sourceFileId,
        path: file.logicalPath,
        releaseId: result.releaseId
      }
    }).catch(() => undefined);
    await dispatchWebhookEvent({
      eventType: "release.published",
      payload: {
        knowledgeBaseId: file.knowledgeBaseId,
        sourceFileId: file.sourceFileId,
        releaseId: result.releaseId
      }
    }).catch(() => undefined);

    return {
      knowledgeBaseId: file.knowledgeBaseId,
      deleted: true,
      releaseId: result.releaseId,
      file: toDeveloperBundleFile(file, await readSourceForBundle(repo, file))
    };
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

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
