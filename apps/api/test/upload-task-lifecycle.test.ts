import { describe, expect, it } from "vitest";
import type {
  ModelSuggestionRequest,
  OpenAIResponsesClient,
  SourceMetadataDefaults
} from "@focowiki/okf";
import { createApiApp, createPublicOpenApiApp } from "../src/server.js";
import type { RuntimeConfig } from "../src/config.js";
import { createRedisCoordinator } from "../src/redis/coordination.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter, StoredObject } from "../src/storage/s3.js";
import {
  loginAndReadSessionCookie,
  MemoryRedisCommandClient
} from "./support/session.js";

const knowledgeBase = {
  id: "kb-001",
  name: "Developer docs",
  description: null,
  activeReleaseId: null,
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z"
};

function createConfig(): RuntimeConfig {
  return {
    admin: {
      username: "admin",
      password: "admin-secret",
      sessionSecret: "session-secret"
    },
    database: {
      url: "postgres://focowiki:focowiki@127.0.0.1:5432/focowiki"
    },
    redis: {
      url: "redis://127.0.0.1:6379/0"
    },
    ports: {
      adminApi: 43_000,
      adminUi: 43_100,
      publicOpenApi: 43_200
    },
    publicApi: {
      baseUrl: "https://kb.example.com",
      authRequired: true,
      apiKey: "public-secret"
    },
    storage: {
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "focowiki",
      accessKeyId: "s3-access",
      secretAccessKey: "s3-secret",
      prefix: "tenant/demo",
      forcePathStyle: true
    },
    upload: {
      maxBytes: 1_048_576,
      maxFiles: 8,
      generationBatchSize: 50,
      taskConcurrency: 1,
      fileProcessingConcurrency: 1
    },
    pagination: {
      defaultPageSize: 50,
      maxPageSize: 200,
      cursorTtlSeconds: 900
    },
    model: {
      enabled: false
    },
    corsOrigins: []
  };
}

function uploadForm(files: Array<{ fileName: string; content: string }>): FormData {
  const form = new FormData();

  for (const file of files) {
    form.append("files", new Blob([file.content], { type: "text/markdown" }), file.fileName);
  }

  return form;
}

async function waitForBackgroundUpload(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(await predicate()).toBe(true);
}

class MemoryStorage implements StorageAdapter {
  public readonly keyspace = createStorageKeyspace("tenant/demo");
  public readonly objects = new Map<string, string>();
  public failOnKeyPart: string | null = null;

  public async putObject(object: StoredObject): Promise<void> {
    if (this.failOnKeyPart && object.key.includes(this.failOnKeyPart)) {
      throw new Error(`storage failure for ${object.key}`);
    }

    this.objects.set(
      object.key,
      typeof object.body === "string" ? object.body : new TextDecoder().decode(object.body)
    );
  }

  public async getObjectText(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null;
  }

  public async writeCurrentPointer(): Promise<void> {
    throw new Error("Not used by upload task lifecycle tests");
  }

  public async readCurrentPointer(): Promise<null> {
    return null;
  }
}

function createRepositories(options: { activeReleaseId?: string | null } = {}) {
  const createdTasks: Array<{ knowledgeBaseId: string; sourceCount: number }> = [];
  const sourcePageCalls: Array<{ limit: number; cursor: string | null }> = [];
  const sourceFiles: Array<{
    id: string;
    knowledgeBaseId: string;
    taskId: string;
    originalName: string;
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    checksumSha256: string;
    metadata: SourceMetadataDefaults;
    createdAt: string;
  }> = [];
  const releases: Array<{
    id: string;
    knowledgeBaseId: string;
    taskId: string;
    bundleRootKey: string;
    generatedAt: string;
    publishedAt: string | null;
    fileCount: number;
    manifestChecksumSha256: string;
    createdAt: string;
  }> = [];
  const bundleFiles: Array<{
    id: string;
    knowledgeBaseId: string;
    releaseId: string;
    logicalPath: string;
    objectKey: string;
    contentType: string;
    sizeBytes: number;
    checksumSha256: string;
    okfType: string | null;
    title: string | null;
    description: string | null;
    tags: string[];
    frontmatter: Record<string, unknown>;
  }> = [];
  const bundleTreeEntries: Array<{
    id: string;
    knowledgeBaseId: string;
    releaseId: string;
    parentPath: string;
    name: string;
    logicalPath: string;
    entryType: "directory" | "file";
    bundleFileId: string | null;
  }> = [];
  const taskEvents: Array<{
    id: string;
    taskId: string;
    phaseKey: string;
    messageKey: string;
    startedAt: string | null;
    endedAt: string | null;
    severity: "info" | "warning" | "error";
    createdAt: string;
  }> = [];
  const taskRecords = new Map<string, {
    id: string;
    knowledgeBaseId: string;
    startedAt: string;
    endedAt: string | null;
    sourceCount: number;
    resultReleaseId: string | null;
    internalErrorCode: string | null;
    internalErrorMessage: string | null;
    createdAt: string;
  }>();
  const currentKnowledgeBase: {
    id: string;
    name: string;
    description: string | null;
    activeReleaseId: string | null;
    createdAt: string;
    updatedAt: string;
  } = { ...knowledgeBase, activeReleaseId: options.activeReleaseId ?? null };

  return {
    records: {
      sourceFiles,
      sourcePageCalls,
      releases,
      bundleFiles,
      bundleTreeEntries,
      taskEvents
    },
    createdTasks,
    repositories: {
      knowledgeBases: {
        async listKnowledgeBases() {
          return { items: [currentKnowledgeBase], nextCursor: null };
        },
        async createKnowledgeBase() {
          return currentKnowledgeBase;
        },
        async getKnowledgeBase(id: string) {
          return id === currentKnowledgeBase.id ? currentKnowledgeBase : null;
        }
      },
      files: {
        async createSourceFiles(files: Array<Omit<(typeof sourceFiles)[number], "createdAt">>) {
          sourceFiles.push(
            ...files.map((file, index) => ({
              ...file,
              createdAt: `2026-06-14T00:00:${String(index).padStart(2, "0")}.000Z`
            }))
          );
        },
        async createRelease(release: Omit<(typeof releases)[number], "createdAt">) {
          releases.push({ ...release, createdAt: "2026-06-14T00:00:00.000Z" });
        },
        async createBundleFiles(files: typeof bundleFiles) {
          bundleFiles.push(...files);
        },
        async createBundleTreeEntries(entries: typeof bundleTreeEntries) {
          bundleTreeEntries.push(...entries);
        },
        async activateRelease(input: {
          knowledgeBaseId: string;
          releaseId: string;
          taskId: string;
          publishedAt: string;
          fileCount: number;
          manifestChecksumSha256: string;
        }) {
          currentKnowledgeBase.activeReleaseId = input.releaseId;
          const release = releases.find((item) => item.id === input.releaseId);

          if (release) {
            release.publishedAt = input.publishedAt;
            release.fileCount = input.fileCount;
            release.manifestChecksumSha256 = input.manifestChecksumSha256;
          }
        },
        async listSourceFilesForTask(input: {
          knowledgeBaseId: string;
          taskId: string;
          limit: number;
          cursor: string | null;
        }) {
          sourcePageCalls.push({ limit: input.limit, cursor: input.cursor });
          const filtered = sourceFiles.filter(
            (file) =>
              file.knowledgeBaseId === input.knowledgeBaseId && file.taskId === input.taskId
          );
          const start = input.cursor ? Number(input.cursor) : 0;

          return {
            items: filtered.slice(start, start + input.limit),
            nextCursor: start + input.limit < filtered.length ? String(start + input.limit) : null
          };
        },
        async listBundleTreeEntries() {
          return { items: bundleTreeEntries, nextCursor: null };
        },
        async getBundleFile(input: {
          knowledgeBaseId: string;
          releaseId: string;
          logicalPath: string;
        }) {
          return (
            bundleFiles.find(
              (file) =>
                file.knowledgeBaseId === input.knowledgeBaseId &&
                file.releaseId === input.releaseId &&
                file.logicalPath === input.logicalPath
            ) ?? null
          );
        },
        async listSourceFiles(input: {
          knowledgeBaseId: string;
          limit: number;
          cursor: string | null;
        }) {
          sourcePageCalls.push({ limit: input.limit, cursor: input.cursor });
          const filtered = sourceFiles.filter(
            (file) => file.knowledgeBaseId === input.knowledgeBaseId
          );
          const start = input.cursor ? Number(input.cursor) : 0;

          return {
            items: filtered.slice(start, start + input.limit),
            nextCursor: start + input.limit < filtered.length ? String(start + input.limit) : null
          };
        },
        async listReleases() {
          return { items: releases, nextCursor: null };
        },
        async listBundleFiles() {
          return { items: bundleFiles, nextCursor: null };
        }
      },
      tasks: {
        async createUploadTask(input: { knowledgeBaseId: string; sourceCount: number }) {
          createdTasks.push(input);
          const task = {
            id: "task-001",
            knowledgeBaseId: input.knowledgeBaseId,
            startedAt: "2026-06-14T00:00:00.000Z",
            endedAt: null,
            sourceCount: input.sourceCount,
            resultReleaseId: null,
            internalErrorCode: null,
            internalErrorMessage: null,
            createdAt: "2026-06-14T00:00:00.000Z"
          };
          taskRecords.set(task.id, task);
          return task;
        },
        async completeUploadTask(input: {
          knowledgeBaseId: string;
          taskId: string;
          endedAt: string;
          resultReleaseId: string | null;
          internalErrorCode?: string | null;
          internalErrorMessage?: string | null;
        }) {
          const task = taskRecords.get(input.taskId);

          if (!task || task.knowledgeBaseId !== input.knowledgeBaseId) {
            throw new Error("Missing task");
          }

          task.endedAt = input.endedAt;
          task.resultReleaseId = input.resultReleaseId;
          task.internalErrorCode = input.internalErrorCode ?? null;
          task.internalErrorMessage = input.internalErrorMessage ?? null;
          return task;
        },
        async createUploadTaskEvent(input: {
          taskId: string;
          phaseKey: string;
          messageKey: string;
          startedAt: string | null;
          endedAt: string | null;
          severity: "info" | "warning" | "error";
        }) {
          const existing = taskEvents.find(
            (event) => event.taskId === input.taskId && event.phaseKey === input.phaseKey
          );

          if (existing) {
            existing.endedAt = input.endedAt;
            existing.severity = input.severity;
            return existing;
          }

          const event = {
            id: `event-${String(taskEvents.length + 1).padStart(3, "0")}`,
            ...input,
            createdAt: `2026-06-14T00:00:${String(taskEvents.length + 1).padStart(2, "0")}.000Z`
          };
          taskEvents.push(event);
          return event;
        },
        async getUploadTask(input: { knowledgeBaseId: string; taskId: string }) {
          const persisted = taskRecords.get(input.taskId);

          if (persisted && persisted.knowledgeBaseId === input.knowledgeBaseId) {
            return persisted;
          }

          if (input.knowledgeBaseId !== knowledgeBase.id || input.taskId !== "task-001") {
            return null;
          }

          return {
            id: "task-001",
            knowledgeBaseId: input.knowledgeBaseId,
            startedAt: "2026-06-14T00:00:00.000Z",
            endedAt: null,
            sourceCount: 2,
            resultReleaseId: null,
            internalErrorCode: null,
            internalErrorMessage: null,
            createdAt: "2026-06-14T00:00:00.000Z"
          };
        },
        async getLatestUploadTask(knowledgeBaseId: string) {
          return (
            Array.from(taskRecords.values())
              .filter((task) => task.knowledgeBaseId === knowledgeBaseId)
              .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ?? null
          );
        },
        async listUploadTasks(input: {
          knowledgeBaseId: string;
          limit: number;
          cursor: string | null;
        }) {
          return {
            items: [
              {
                id: input.cursor ? "task-002" : "task-001",
                knowledgeBaseId: input.knowledgeBaseId,
                startedAt: input.cursor
                  ? "2026-06-13T00:00:00.000Z"
                  : "2026-06-14T00:00:00.000Z",
                endedAt: null,
                sourceCount: 2,
                resultReleaseId: null,
                internalErrorCode: null,
                internalErrorMessage: null,
                createdAt: input.cursor
                  ? "2026-06-13T00:00:00.000Z"
                  : "2026-06-14T00:00:00.000Z"
              }
            ],
            nextCursor: input.cursor ? null : "task-cursor-001"
          };
        },
        async listUploadTaskEvents(input: {
          knowledgeBaseId: string;
          taskId: string;
          limit: number;
          cursor: string | null;
        }) {
          const persisted = taskEvents.filter((event) => event.taskId === input.taskId);

          if (persisted.length > 0) {
            const start = input.cursor ? Number(input.cursor) : 0;
            return {
              items: persisted.slice(start, start + input.limit),
              nextCursor:
                start + input.limit < persisted.length ? String(start + input.limit) : null
            };
          }

          if (input.knowledgeBaseId !== knowledgeBase.id || input.taskId !== "task-001") {
            return { items: [], nextCursor: null };
          }

          return {
            items: [
              {
                id: input.cursor ? "event-002" : "event-001",
                taskId: input.taskId,
                phaseKey: input.cursor ? "okf_validation" : "upload_storage",
                messageKey: input.cursor ? "tasks.phase.okfValidation" : "tasks.phase.uploadStorage",
                startedAt: "2026-06-14T00:00:00.000Z",
                endedAt: input.cursor ? "2026-06-14T00:00:02.000Z" : null,
                severity: "info" as const,
                createdAt: input.cursor
                  ? "2026-06-14T00:00:02.000Z"
                  : "2026-06-14T00:00:01.000Z"
              }
            ],
            nextCursor: input.cursor ? null : "event-cursor-001"
          };
        }
      }
    }
  };
}

describe("Upload parsing task lifecycle", () => {
  it("creates exactly one knowledge base-scoped upload task and coordinates through Redis", async () => {
    const { repositories, createdTasks, records } = createRepositories();
    const redisClient = new MemoryRedisCommandClient();
    const storage = new MemoryStorage();
    const app = createApiApp({
      config: createConfig(),
      storage,
      redis: createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request("/admin/api/knowledge-bases/kb-001/uploads", {
      method: "POST",
      headers: {
        cookie
      },
      body: uploadForm([
        { fileName: "intro.md", content: "# Intro\n\nNo frontmatter." },
        { fileName: "setup.md", content: "---\ntype: page\ntitle: Setup\n---\n# Setup" }
      ])
    });
    const body = (await response.json()) as {
      task: {
        id: string;
        knowledgeBaseId: string;
        startedAt: string;
        endedAt: string | null;
        lifecycle: "running" | "ended";
        resultReleaseId: string | null;
      };
    };

    expect(response.status).toBe(202);
    expect(createdTasks).toEqual([{ knowledgeBaseId: "kb-001", sourceCount: 2 }]);
    expect(body.task).toMatchObject({
      id: "task-001",
      knowledgeBaseId: "kb-001",
      startedAt: "2026-06-14T00:00:00.000Z",
      endedAt: null,
      lifecycle: "running",
      resultReleaseId: null
    });

    await waitForBackgroundUpload(() => records.releases.length === 1);

    expect(records.sourceFiles).toHaveLength(2);
    expect(records.sourcePageCalls).toEqual([
      { limit: 200, cursor: null },
      { limit: 50, cursor: null }
    ]);
    expect(records.sourceFiles[0]?.objectKey).toMatch(
      /^tenant\/demo\/knowledge-bases\/kb-001\/uploads\/task-001\/sources\/source-file-.*\/intro\.md$/
    );
    expect(records.sourceFiles[0]?.metadata).toEqual({});
    expect(storage.objects.get(records.sourceFiles[0]?.objectKey ?? "")).toContain("# Intro");
    expect(records.releases).toHaveLength(1);
    expect(records.releases[0]).toMatchObject({
      knowledgeBaseId: "kb-001",
      taskId: "task-001",
      publishedAt: expect.any(String),
      fileCount: 7
    });
    expect(records.bundleFiles.map((file) => file.logicalPath).sort()).toEqual([
      "_index/links.json",
      "_index/manifest.json",
      "_index/search.json",
      "index.md",
      "pages/intro.md",
      "pages/setup.md",
      "schema.md"
    ]);
    expect(records.bundleFiles.find((file) => file.logicalPath === "pages/intro.md")).toMatchObject({
      okfType: "document",
      title: "Intro",
      frontmatter: {
        type: "document",
        title: "Intro"
      }
    });
    expect(records.bundleTreeEntries).toContainEqual(
      expect.objectContaining({
        parentPath: "pages",
        name: "intro.md",
        logicalPath: "pages/intro.md",
        entryType: "file"
      })
    );
    expect(records.taskEvents.map((event) => event.phaseKey).sort()).toEqual([
      "bundle_generation",
      "index_publication",
      "metadata_resolution",
      "okf_validation",
      "release_activation",
      "upload_storage"
    ]);
    expect(
      Array.from(redisClient.values.keys()).some((key) =>
        key.startsWith("focowiki-test:task-events:task-001")
      )
    ).toBe(true);
    expect(
      Array.from(redisClient.values.keys()).some((key) =>
        key.startsWith("focowiki-test:pagination-invalid:upload-tasks:kb-001")
      )
    ).toBe(true);
  });

  it("stores uploaded sources and published paths with the original Markdown file name", async () => {
    const { repositories, records } = createRepositories();
    const redisClient = new MemoryRedisCommandClient();
    const storage = new MemoryStorage();
    const app = createApiApp({
      config: createConfig(),
      storage,
      redis: createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const fileName = "外国企业常驻代表机构登记管理条例.md";
    const response = await app.request("/admin/api/knowledge-bases/kb-001/uploads", {
      method: "POST",
      headers: {
        cookie
      },
      body: uploadForm([
        {
          fileName,
          content: "---\ntype: page\ntitle: 外国企业常驻代表机构登记管理条例\n---\n# 外国企业"
        }
      ])
    });

    expect(response.status).toBe(202);
    await waitForBackgroundUpload(() => records.bundleFiles.length > 0);

    expect(records.sourceFiles[0]).toMatchObject({
      originalName: fileName
    });
    expect(records.sourceFiles[0]?.objectKey).toMatch(
      /^tenant\/demo\/knowledge-bases\/kb-001\/uploads\/task-001\/sources\/source-file-.*\/外国企业常驻代表机构登记管理条例\.md$/
    );
    expect(records.bundleFiles.map((file) => file.logicalPath)).toEqual(
      expect.arrayContaining([`pages/${fileName}`])
    );
    expect(records.bundleFiles.map((file) => file.logicalPath)).not.toContain(
      `sources/${fileName}`
    );
  });

  it("publishes every source file in the knowledge base when a later upload is added", async () => {
    const { repositories, records } = createRepositories();
    const storage = new MemoryStorage();
    const existingObjectKey =
      "tenant/demo/knowledge-bases/kb-001/uploads/task-existing/sources/source-existing/existing.md";
    records.sourceFiles.push({
      id: "source-existing",
      knowledgeBaseId: "kb-001",
      taskId: "task-existing",
      originalName: "existing.md",
      objectKey: existingObjectKey,
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 48,
      checksumSha256: "existing-checksum",
      metadata: {
        type: "page",
        title: "Existing"
      },
      createdAt: "2026-06-13T00:00:00.000Z"
    });
    storage.objects.set(
      existingObjectKey,
      "# Existing"
    );
    const app = createApiApp({
      config: createConfig(),
      storage,
      redis: createRedisCoordinator(new MemoryRedisCommandClient(), {
        keyPrefix: "focowiki-test"
      }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request("/admin/api/knowledge-bases/kb-001/uploads", {
      method: "POST",
      headers: {
        cookie
      },
      body: uploadForm([
        { fileName: "new.md", content: "---\ntype: page\ntitle: New\n---\n# New" }
      ])
    });

    expect(response.status).toBe(202);
    await waitForBackgroundUpload(() => records.bundleFiles.length > 0);

    expect(records.bundleFiles.map((file) => file.logicalPath).sort()).toEqual([
      "_index/links.json",
      "_index/manifest.json",
      "_index/search.json",
      "index.md",
      "pages/existing.md",
      "pages/new.md",
      "schema.md"
    ]);
  });

  it("rejects duplicate original Markdown file names before creating an upload task", async () => {
    const { repositories, createdTasks } = createRepositories();
    const redisClient = new MemoryRedisCommandClient();
    const storage = new MemoryStorage();
    const app = createApiApp({
      config: createConfig(),
      storage,
      redis: createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request("/admin/api/knowledge-bases/kb-001/uploads", {
      method: "POST",
      headers: {
        cookie
      },
      body: uploadForm([
        {
          fileName: "intro.md",
          content: "---\ntype: page\ntitle: Intro\n---\n# Intro"
        },
        {
          fileName: "intro.md",
          content: "---\ntype: page\ntitle: Duplicate\n---\n# Duplicate"
        }
      ])
    });

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "DUPLICATE_UPLOAD_FILE_NAME",
        messageKey: "errors.duplicateUploadFileName"
      }
    });
    expect(response.status).toBe(400);
    expect(createdTasks).toEqual([]);
  });

  it("rejects non-Markdown source files before creating an upload task", async () => {
    const { repositories, createdTasks } = createRepositories();
    const app = createApiApp({
      config: createConfig(),
      storage: new MemoryStorage(),
      redis: createRedisCoordinator(new MemoryRedisCommandClient(), {
        keyPrefix: "focowiki-test"
      }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request("/admin/api/knowledge-bases/kb-001/uploads", {
      method: "POST",
      headers: {
        cookie
      },
      body: uploadForm([{ fileName: "notes.txt", content: "# Notes" }])
    });

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_FILE_TYPE",
        messageKey: "errors.uploadMarkdownOnly"
      }
    });
    expect(response.status).toBe(400);
    expect(createdTasks).toEqual([]);
  });

  it("rejects original Markdown file names that already exist in the knowledge base", async () => {
    const { repositories, createdTasks, records } = createRepositories();
    records.sourceFiles.push({
      id: "source-existing",
      knowledgeBaseId: "kb-001",
      taskId: "task-existing",
      originalName: "intro.md",
      objectKey:
        "tenant/demo/knowledge-bases/kb-001/uploads/task-existing/sources/source-existing/intro.md",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 48,
      checksumSha256: "existing-checksum",
      metadata: {
        type: "page",
        title: "Intro"
      },
      createdAt: "2026-06-13T00:00:00.000Z"
    });
    const app = createApiApp({
      config: createConfig(),
      storage: new MemoryStorage(),
      redis: createRedisCoordinator(new MemoryRedisCommandClient(), {
        keyPrefix: "focowiki-test"
      }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request("/admin/api/knowledge-bases/kb-001/uploads", {
      method: "POST",
      headers: {
        cookie
      },
      body: uploadForm([{ fileName: "INTRO.md", content: "# Intro duplicate" }])
    });

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "DUPLICATE_UPLOAD_FILE_NAME",
        messageKey: "errors.duplicateUploadFileName"
      }
    });
    expect(response.status).toBe(400);
    expect(createdTasks).toEqual([]);
  });

  it("returns a running upload task before background parsing finishes", async () => {
    const { repositories, records } = createRepositories();
    const storage = new MemoryStorage();
    let resolveModelRequest!: (value: unknown) => void;
    const delayedModelClient: OpenAIResponsesClient = {
      responses: {
        create: async () =>
          new Promise((resolve) => {
            resolveModelRequest = resolve;
          })
      }
    };
    const delayedApp = createApiApp({
      config: {
        ...createConfig(),
        model: {
          enabled: true,
          apiKey: "model-secret",
          modelName: "gpt-test",
          baseUrl: "https://api.openai.com/v1",
          contextWindowTokens: 200_000,
          requestMaxTimeoutMs: 120_000,
          requestIdleTimeoutMs: 30_000,
          suggestionConcurrency: 2
        }
      },
      storage,
      redis: createRedisCoordinator(new MemoryRedisCommandClient(), {
        keyPrefix: "focowiki-test-immediate"
      }),
      repositories,
      modelClient: delayedModelClient
    });
    const delayedCookie = await loginAndReadSessionCookie(delayedApp);
    const response = await delayedApp.request("/admin/api/knowledge-bases/kb-001/uploads", {
      method: "POST",
      headers: {
        cookie: delayedCookie
      },
      body: uploadForm([
        { fileName: "intro.md", content: "---\ntype: page\ntitle: Intro\n---\n# Intro" }
      ])
    });
    const body = (await response.json()) as {
      task: {
        id: string;
        lifecycle: "running" | "ended";
        endedAt: string | null;
      };
    };

    expect(response.status).toBe(202);
    expect(body.task).toMatchObject({
      id: "task-001",
      lifecycle: "running",
      endedAt: null
    });
    await waitForBackgroundUpload(
      () =>
        records.sourceFiles.length === 1 &&
        records.taskEvents.some(
          (event) => event.phaseKey === "metadata_resolution" && event.endedAt === null
        )
    );
    expect(records.taskEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phaseKey: "upload_storage",
          endedAt: expect.any(String),
          severity: "info"
        }),
        expect.objectContaining({
          phaseKey: "metadata_resolution",
          endedAt: null,
          severity: "info"
        })
      ])
    );

    resolveModelRequest({
      status: "completed",
      output_text: JSON.stringify({
        description: "Suggested model description",
        title: "",
        type: "",
        tags: [],
        related_links: [],
        keywords: ["model", "suggestion"]
      })
    });
    await waitForBackgroundUpload(() => records.releases.length === 1);
  });

  it("uses configured Structured Outputs model suggestions during knowledge base upload", async () => {
    const { repositories, records } = createRepositories();
    const storage = new MemoryStorage();
    const requests: ModelSuggestionRequest[] = [];
    const modelClient: OpenAIResponsesClient = {
      responses: {
        create: async (request) => {
          requests.push(request);
          return {
            status: "completed",
            output_text: JSON.stringify({
              description: "Suggested model description",
              title: "",
              type: "",
              tags: [],
              related_links: [],
              keywords: ["model", "suggestion"]
            })
          };
        }
      }
    };
    const app = createApiApp({
      config: {
        ...createConfig(),
        model: {
          enabled: true,
          apiKey: "model-secret",
          modelName: "gpt-test",
          baseUrl: "https://api.openai.com/v1",
          contextWindowTokens: 200_000,
          requestMaxTimeoutMs: 120_000,
          requestIdleTimeoutMs: 30_000,
          suggestionConcurrency: 2
        }
      },
      storage,
      redis: createRedisCoordinator(new MemoryRedisCommandClient(), {
        keyPrefix: "focowiki-test"
      }),
      repositories,
      modelClient
    });
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request("/admin/api/knowledge-bases/kb-001/uploads", {
      method: "POST",
      headers: {
        cookie
      },
      body: uploadForm([
        { fileName: "intro.md", content: "---\ntype: page\ntitle: Intro\n---\n# Intro" }
      ])
    });

    expect(response.status).toBe(202);
    await waitForBackgroundUpload(() => records.bundleFiles.length > 0);

    const generatedPage = records.bundleFiles.find((file) => file.logicalPath === "pages/intro.md");

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      model: "gpt-test",
      text: {
        format: {
          type: "json_schema",
          strict: true
        }
      },
      store: false
    });
    expect(requests[0]?.input).toContain("Candidate related bundle paths:");
    expect(requests[0]?.input).not.toContain("- /pages/intro.md");
    expect(storage.objects.get(generatedPage?.objectKey ?? "")).toContain(
      "Suggested model description"
    );
  });

  it("continues deterministic upload publication when model suggestions fail local validation", async () => {
    const { repositories, records } = createRepositories();
    const storage = new MemoryStorage();
    const modelClient: OpenAIResponsesClient = {
      responses: {
        create: async () => ({
          status: "completed",
          output_text: JSON.stringify({
            description: 42,
            title: "",
            type: "",
            tags: [],
            related_links: [],
            keywords: []
          })
        })
      }
    };
    const app = createApiApp({
      config: {
        ...createConfig(),
        model: {
          enabled: true,
          apiKey: "model-secret",
          modelName: "gpt-test",
          baseUrl: "https://api.openai.com/v1",
          contextWindowTokens: 200_000,
          requestMaxTimeoutMs: 120_000,
          requestIdleTimeoutMs: 30_000,
          suggestionConcurrency: 2
        }
      },
      storage,
      redis: createRedisCoordinator(new MemoryRedisCommandClient(), {
        keyPrefix: "focowiki-test"
      }),
      repositories,
      modelClient
    });
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request("/admin/api/knowledge-bases/kb-001/uploads", {
      method: "POST",
      headers: {
        cookie
      },
      body: uploadForm([
        { fileName: "intro.md", content: "---\ntype: page\ntitle: Intro\n---\n# Intro" }
      ])
    });

    expect(response.status).toBe(202);
    await waitForBackgroundUpload(() => records.bundleFiles.length > 0);

    const metadataEvent = records.taskEvents.find(
      (event) => event.phaseKey === "metadata_resolution"
    );
    const generatedPage = records.bundleFiles.find((file) => file.logicalPath === "pages/intro.md");

    expect(metadataEvent).toMatchObject({
      severity: "warning"
    });
    expect(storage.objects.get(generatedPage?.objectKey ?? "")).toContain('title: "Intro"');
  });

  it("reads completed lifecycle from durable repositories after Redis state is not reused", async () => {
    const { repositories } = createRepositories();
    const storage = new MemoryStorage();
    const adminApp = createApiApp({
      config: createConfig(),
      storage,
      redis: createRedisCoordinator(new MemoryRedisCommandClient(), {
        keyPrefix: "focowiki-test-admin"
      }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(adminApp);
    const upload = await adminApp.request("/admin/api/knowledge-bases/kb-001/uploads", {
      method: "POST",
      headers: {
        cookie
      },
      body: uploadForm([
        { fileName: "intro.md", content: "---\ntype: page\ntitle: Intro\n---\n# Intro" }
      ])
    });

    expect(upload.status).toBe(202);
    await waitForBackgroundUpload(async () => {
      const task = await repositories.tasks?.getUploadTask?.({
        knowledgeBaseId: "kb-001",
        taskId: "task-001"
      });

      return Boolean(task?.endedAt);
    });

    const publicApp = createPublicOpenApiApp({
      config: createConfig(),
      storage,
      repositories
    });
    const response = await publicApp.request("/kb/kb-001/tasks/latest", {
      headers: {
        authorization: "Bearer public-secret"
      }
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      knowledgeBaseId: "kb-001",
      taskId: "task-001",
      startedAt: "2026-06-14T00:00:00.000Z",
      endedAt: expect.any(String),
      lifecycle: "ended"
    });
    expect(body).not.toHaveProperty("phaseKey");
    expect(body).not.toHaveProperty("phaseDetails");
  });

  it("keeps the previous active release when upload parsing publication fails", async () => {
    const { repositories, records } = createRepositories({ activeReleaseId: "release-existing" });
    const storage = new MemoryStorage();
    storage.failOnKeyPart = "/releases/";
    const app = createApiApp({
      config: createConfig(),
      storage,
      redis: createRedisCoordinator(new MemoryRedisCommandClient(), {
        keyPrefix: "focowiki-test"
      }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request("/admin/api/knowledge-bases/kb-001/uploads", {
      method: "POST",
      headers: {
        cookie
      },
      body: uploadForm([
        { fileName: "intro.md", content: "---\ntype: page\ntitle: Intro\n---\n# Intro" }
      ])
    });
    const detail = await repositories.knowledgeBases.getKnowledgeBase("kb-001");

    expect(response.status).toBe(202);
    await waitForBackgroundUpload(() =>
      records.taskEvents.some(
        (event) => event.phaseKey === "bundle_generation" && event.severity === "error"
      )
    );

    expect(detail?.activeReleaseId).toBe("release-existing");
    expect(records.releases[0]).toMatchObject({
      publishedAt: null,
      fileCount: 0
    });
    expect(records.taskEvents).toContainEqual(
      expect.objectContaining({
        phaseKey: "bundle_generation",
        severity: "error"
      })
    );
  });

  it("rejects knowledge base uploads that exceed count or byte limits before creating tasks", async () => {
    const countLimited = createRepositories();
    const countApp = createApiApp({
      config: {
        ...createConfig(),
        upload: {
          ...createConfig().upload,
          maxFiles: 1
        }
      },
      storage: new MemoryStorage(),
      redis: createRedisCoordinator(new MemoryRedisCommandClient(), {
        keyPrefix: "focowiki-test-count"
      }),
      repositories: countLimited.repositories
    });
    const countCookie = await loginAndReadSessionCookie(countApp);
    const tooMany = await countApp.request("/admin/api/knowledge-bases/kb-001/uploads", {
      method: "POST",
      headers: {
        cookie: countCookie
      },
      body: uploadForm([
        { fileName: "one.md", content: "---\ntype: page\ntitle: One\n---\n# One" },
        { fileName: "two.md", content: "---\ntype: page\ntitle: Two\n---\n# Two" }
      ])
    });
    const sizeLimited = createRepositories();
    const sizeApp = createApiApp({
      config: {
        ...createConfig(),
        upload: {
          ...createConfig().upload,
          maxBytes: 10
        }
      },
      storage: new MemoryStorage(),
      redis: createRedisCoordinator(new MemoryRedisCommandClient(), {
        keyPrefix: "focowiki-test-size"
      }),
      repositories: sizeLimited.repositories
    });
    const sizeCookie = await loginAndReadSessionCookie(sizeApp);
    const tooLarge = await sizeApp.request("/admin/api/knowledge-bases/kb-001/uploads", {
      method: "POST",
      headers: {
        cookie: sizeCookie
      },
      body: uploadForm([
        { fileName: "large.md", content: "---\ntype: page\ntitle: Large\n---\n# Large" }
      ])
    });

    expect(tooMany.status).toBe(413);
    expect(tooLarge.status).toBe(413);
    expect(countLimited.createdTasks).toEqual([]);
    expect(sizeLimited.createdTasks).toEqual([]);
  });

  it("returns paginated admin task menu lifecycles with Redis cursor state", async () => {
    const { repositories } = createRepositories();
    const redisClient = new MemoryRedisCommandClient();
    const app = createApiApp({
      config: createConfig(),
      redis: createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const first = await app.request("/admin/api/knowledge-bases/kb-001/tasks?limit=1", {
      headers: {
        cookie
      }
    });
    const firstBody = (await first.json()) as {
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };

    expect(first.status).toBe(200);
    expect(firstBody.items).toEqual([
      expect.objectContaining({
        id: "task-001",
        knowledgeBaseId: "kb-001",
        lifecycle: "running",
        startedAt: "2026-06-14T00:00:00.000Z",
        endedAt: null
      })
    ]);
    expect(firstBody.items[0]).not.toHaveProperty("phases");
    expect(firstBody.nextCursor).toEqual(expect.stringMatching(/^cursor-/));
    expect(
      Array.from(redisClient.values.keys()).some((key) =>
        key.startsWith("focowiki-test:pagination-cursors:upload-tasks:kb-001")
      )
    ).toBe(true);

    const second = await app.request(
      `/admin/api/knowledge-bases/kb-001/tasks?limit=1&cursor=${firstBody.nextCursor}`,
      {
        headers: {
          cookie
        }
      }
    );

    expect(second.status).toBe(200);
  });

  it("returns bounded admin-only phase details inside one task lifecycle detail", async () => {
    const { repositories, records } = createRepositories();
    records.sourceFiles.push({
      id: "source-001",
      knowledgeBaseId: "kb-001",
      taskId: "task-001",
      originalName: "intro.md",
      objectKey: "tenant/demo/knowledge-bases/kb-001/uploads/task-001/sources/source-001-intro.md",
      contentType: "text/markdown",
      sizeBytes: 32,
      checksumSha256: "checksum-001",
      metadata: {
        type: "page",
        title: "Intro"
      },
      createdAt: "2026-06-14T00:00:00.000Z"
    });
    const redisClient = new MemoryRedisCommandClient();
    const app = createApiApp({
      config: createConfig(),
      redis: createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request("/admin/api/knowledge-bases/kb-001/tasks/task-001?limit=1", {
      headers: {
        cookie
      }
    });
    const body = (await response.json()) as {
      task: Record<string, unknown>;
      phaseDetails: {
        items: Array<Record<string, unknown>>;
        nextCursor: string | null;
      };
      sourceFiles: {
        items: Array<Record<string, unknown>>;
        nextCursor: string | null;
      };
    };

    expect(response.status).toBe(200);
    expect(body.task).toMatchObject({
      id: "task-001",
      lifecycle: "running"
    });
    expect(body.phaseDetails.items).toEqual([
      {
        id: "event-001",
        taskId: "task-001",
        phaseKey: "upload_storage",
        messageKey: "tasks.phase.uploadStorage",
        startedAt: "2026-06-14T00:00:00.000Z",
        endedAt: null,
        severity: "info",
        createdAt: "2026-06-14T00:00:01.000Z"
      }
    ]);
    expect(body.phaseDetails.nextCursor).toEqual(expect.stringMatching(/^cursor-/));
    expect(body.sourceFiles.items).toEqual([
      expect.objectContaining({
        id: "source-001",
        taskId: "task-001",
        originalName: "intro.md"
      })
    ]);
    expect(body.sourceFiles.nextCursor).toBeNull();
    expect(
      Array.from(redisClient.values.keys()).some((key) =>
        key.startsWith("focowiki-test:pagination-cursors:upload-task-events:kb-001:task-001")
      )
    ).toBe(true);
  });
});
