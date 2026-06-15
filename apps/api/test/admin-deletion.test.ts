import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/server.js";
import type { RuntimeConfig } from "../src/config.js";
import type {
  BundleFileRecord,
  BundleTreeEntryDraft,
  BundleTreeEntryRecord
} from "../src/db/admin-repositories.js";
import { createRedisCoordinator } from "../src/redis/coordination.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter, StoredObject } from "../src/storage/s3.js";
import {
  loginAndReadSessionCookie,
  MemoryRedisCommandClient
} from "./support/session.js";

const now = "2026-06-14T00:00:00.000Z";

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

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
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
  public failOnKeyPart: string | null = null;
  public readonly objects = new Map<string, string>([
    ["tenant/demo/source/intro.md", "---\ntype: page\ntitle: Intro\n---\n# Intro"],
    ["tenant/demo/source/setup.md", "---\ntype: page\ntitle: Setup\n---\n# Setup"],
    [
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/intro.md",
      "---\ntype: page\ntitle: Intro\n---\n# Intro"
    ],
    [
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/index.md",
      "# Focowiki knowledge base\n\n- [Intro](/pages/intro.md)"
    ]
  ]);

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
    throw new Error("Not used by admin deletion tests");
  }

  public async readCurrentPointer(): Promise<null> {
    return null;
  }
}

function createRepositories() {
  const knowledgeBase = {
    id: "kb-001",
    name: "Developer docs",
    description: null,
    activeReleaseId: "release-001",
    createdAt: now,
    updatedAt: now,
    deletedAt: null as string | null
  };
  const sourceFiles = [
    {
      id: "source-001",
      knowledgeBaseId: "kb-001",
      taskId: "task-existing",
      originalName: "intro.md",
      objectKey: "tenant/demo/source/intro.md",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 42,
      checksumSha256: "checksum-intro",
      metadata: { type: "page", title: "Intro" },
      createdAt: now,
      deletedAt: null as string | null
    },
    {
      id: "source-002",
      knowledgeBaseId: "kb-001",
      taskId: "task-existing",
      originalName: "setup.md",
      objectKey: "tenant/demo/source/setup.md",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 42,
      checksumSha256: "checksum-setup",
      metadata: { type: "page", title: "Setup" },
      createdAt: now,
      deletedAt: null as string | null
    }
  ];
  const releases = [
    {
      id: "release-001",
      knowledgeBaseId: "kb-001",
      taskId: "task-existing",
      bundleRootKey: "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/",
      generatedAt: now,
      publishedAt: now as string | null,
      fileCount: 4,
      manifestChecksumSha256: "checksum",
      createdAt: now
    }
  ];
  const bundleFiles: BundleFileRecord[] = [
    {
      id: "bundle-file-page",
      knowledgeBaseId: "kb-001",
      releaseId: "release-001",
      sourceFileId: "source-001",
      fileKind: "page" as const,
      logicalPath: "pages/intro.md",
      objectKey: "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/intro.md",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 42,
      checksumSha256: "checksum",
      okfType: "page",
      title: "Intro",
      description: null,
      tags: [],
      frontmatter: { type: "page", title: "Intro" }
    },
    {
      id: "bundle-file-index",
      knowledgeBaseId: "kb-001",
      releaseId: "release-001",
      sourceFileId: null,
      fileKind: "index" as const,
      logicalPath: "index.md",
      objectKey: "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/index.md",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: 42,
      checksumSha256: "checksum",
      okfType: null,
      title: null,
      description: null,
      tags: [],
      frontmatter: {}
    }
  ];
  const treeEntries: BundleTreeEntryRecord[] = [];
  const tasks: Array<{
    id: string;
    knowledgeBaseId: string;
    operation: "upload" | "delete_source" | "delete_knowledge_base";
    startedAt: string;
    endedAt: string | null;
    sourceCount: number;
    resultReleaseId: string | null;
    internalErrorCode: string | null;
    internalErrorMessage: string | null;
    createdAt: string;
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

  return {
    records: {
      knowledgeBase,
      sourceFiles,
      releases,
      bundleFiles,
      treeEntries,
      tasks,
      taskEvents
    },
    repositories: {
      knowledgeBases: {
        async listKnowledgeBases() {
          return {
            items: knowledgeBase.deletedAt ? [] : [{ ...knowledgeBase }],
            nextCursor: null
          };
        },
        async createKnowledgeBase() {
          return { ...knowledgeBase };
        },
        async getKnowledgeBase(id: string) {
          return id === knowledgeBase.id && !knowledgeBase.deletedAt ? { ...knowledgeBase } : null;
        },
        async softDeleteKnowledgeBase(input: { id: string; deletedAt: string }) {
          if (input.id !== knowledgeBase.id || knowledgeBase.deletedAt) {
            return false;
          }

          knowledgeBase.deletedAt = input.deletedAt;
          return true;
        }
      },
      files: {
        async createRelease(release: Omit<(typeof releases)[number], "createdAt">) {
          releases.push({ ...release, createdAt: now });
        },
        async createBundleFiles(files: BundleFileRecord[]) {
          bundleFiles.push(...files);
        },
        async createBundleTreeEntries(entries: BundleTreeEntryDraft[]) {
          treeEntries.push(
            ...entries.map((entry) => {
              const bundleFile = bundleFiles.find((file) => file.id === entry.bundleFileId);

              return {
                ...entry,
                sourceFileId: bundleFile?.sourceFileId ?? null,
                fileKind: bundleFile?.fileKind ?? null
              };
            })
          );
        },
        async activateRelease(input: {
          knowledgeBaseId: string;
          releaseId: string;
          taskId: string;
          publishedAt: string;
          fileCount: number;
          manifestChecksumSha256: string;
        }) {
          knowledgeBase.activeReleaseId = input.releaseId;
          const release = releases.find((item) => item.id === input.releaseId);

          if (release) {
            release.publishedAt = input.publishedAt;
            release.fileCount = input.fileCount;
            release.manifestChecksumSha256 = input.manifestChecksumSha256;
          }
        },
        async listBundleTreeEntries() {
          return { items: treeEntries, nextCursor: null };
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
          const filtered = sourceFiles.filter(
            (file) => file.knowledgeBaseId === input.knowledgeBaseId && !file.deletedAt
          );
          const start = input.cursor ? Number(input.cursor) : 0;

          return {
            items: filtered.slice(start, start + input.limit),
            nextCursor: start + input.limit < filtered.length ? String(start + input.limit) : null
          };
        },
        async listSourceFilesForTask() {
          return { items: [], nextCursor: null };
        },
        async listReleases() {
          return { items: releases, nextCursor: null };
        },
        async listBundleFiles() {
          return { items: bundleFiles, nextCursor: null };
        },
        async softDeleteSourceFile(input: {
          knowledgeBaseId: string;
          sourceFileId: string;
          deletedAt: string;
        }) {
          const source = sourceFiles.find(
            (file) =>
              file.knowledgeBaseId === input.knowledgeBaseId &&
              file.id === input.sourceFileId &&
              !file.deletedAt
          );

          if (!source) {
            return false;
          }

          source.deletedAt = input.deletedAt;
          return true;
        }
      },
      tasks: {
        async createUploadTask(input: {
          knowledgeBaseId: string;
          sourceCount: number;
          operation?: "upload" | "delete_source" | "delete_knowledge_base";
        }) {
          const task = {
            id: `task-${String(tasks.length + 1).padStart(3, "0")}`,
            knowledgeBaseId: input.knowledgeBaseId,
            operation: input.operation ?? ("upload" as const),
            startedAt: now,
            endedAt: null,
            sourceCount: input.sourceCount,
            resultReleaseId: null,
            internalErrorCode: null,
            internalErrorMessage: null,
            createdAt: now
          };
          tasks.push(task);
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
          const task = tasks.find(
            (item) => item.knowledgeBaseId === input.knowledgeBaseId && item.id === input.taskId
          );

          if (!task) {
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
            createdAt: now
          };
          taskEvents.push(event);
          return event;
        },
        async getUploadTask(input: { knowledgeBaseId: string; taskId: string }) {
          return (
            tasks.find(
              (task) => task.knowledgeBaseId === input.knowledgeBaseId && task.id === input.taskId
            ) ?? null
          );
        },
        async getLatestUploadTask() {
          return tasks.find((task) => task.operation === "upload") ?? null;
        },
        async listUploadTasks() {
          return { items: tasks, nextCursor: null };
        },
        async listUploadTaskEvents() {
          return { items: taskEvents, nextCursor: null };
        }
      }
    }
  };
}

describe("Admin resource deletion API", () => {
  it("soft-deletes a knowledge base and invalidates admin cursors", async () => {
    const redisClient = new MemoryRedisCommandClient();
    const { repositories, records } = createRepositories();
    const app = createApiApp({
      config: createConfig(),
      storage: new MemoryStorage(),
      redis: createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const deleted = await app.request("/admin/api/knowledge-bases/kb-001", {
      method: "DELETE",
      headers: { cookie }
    });
    const detail = await app.request("/admin/api/knowledge-bases/kb-001", {
      headers: { cookie }
    });
    const publicIndex = await app.request("/kb/kb-001/index.md", {
      headers: { authorization: "Bearer public-secret" }
    });

    await expect(deleted.json()).resolves.toEqual({ deleted: true });
    expect(deleted.status).toBe(200);
    expect(detail.status).toBe(404);
    expect(publicIndex.status).toBe(404);
    expect(records.knowledgeBase.deletedAt).toEqual(expect.any(String));
    expect(
      Array.from(redisClient.values.keys()).some((key) =>
        key.startsWith("focowiki-test:pagination-invalid:knowledge-bases")
      )
    ).toBe(true);
  });

  it("marks source-backed pages as deletable but generated system files as non-deletable", async () => {
    const { repositories } = createRepositories();
    const app = createApiApp({
      config: createConfig(),
      storage: new MemoryStorage(),
      redis: createRedisCoordinator(new MemoryRedisCommandClient(), { keyPrefix: "focowiki-test" }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const page = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=pages/intro.md",
      { headers: { cookie } }
    );
    const index = await app.request("/admin/api/knowledge-bases/kb-001/files/detail?path=index.md", {
      headers: { cookie }
    });

    await expect(page.json()).resolves.toMatchObject({
      file: {
        logicalPath: "pages/intro.md",
        sourceFileId: "source-001",
        fileKind: "page",
        deletable: true
      }
    });
    await expect(index.json()).resolves.toMatchObject({
      file: {
        logicalPath: "index.md",
        sourceFileId: null,
        fileKind: "index",
        deletable: false
      }
    });
  });

  it("deletes one source-backed page through one deletion task and republishes indexes", async () => {
    const redisClient = new MemoryRedisCommandClient();
    const storage = new MemoryStorage();
    const { repositories, records } = createRepositories();
    const app = createApiApp({
      config: createConfig(),
      storage,
      redis: createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=pages/intro.md",
      {
        method: "DELETE",
        headers: { cookie }
      }
    );
    const body = (await response.json()) as { task: Record<string, unknown> };

    expect(response.status).toBe(202);
    expect(body.task).toMatchObject({
      operation: "delete_source",
      lifecycle: "running"
    });
    await waitFor(() => records.tasks[0]?.endedAt !== null);

    const latestRelease = records.releases.at(-1);
    expect(records.tasks).toHaveLength(1);
    expect(records.tasks[0]).toMatchObject({
      operation: "delete_source",
      resultReleaseId: latestRelease?.id
    });
    expect(records.sourceFiles.find((file) => file.id === "source-001")?.deletedAt).toEqual(
      expect.any(String)
    );
    expect(records.bundleFiles.filter((file) => file.releaseId === latestRelease?.id).map((file) => file.logicalPath).sort()).toEqual([
      "_index/links.json",
      "_index/manifest.json",
      "_index/search.json",
      "index.md",
      "pages/setup.md",
      "schema.md"
    ]);
    expect(
      records.treeEntries
        .filter((entry) => entry.releaseId === latestRelease?.id)
        .map((entry) => entry.logicalPath)
    ).not.toContain("pages/intro.md");
    expect(records.taskEvents.map((event) => event.phaseKey)).toContain("source_deletion");
    expect(
      Array.from(redisClient.values.keys()).some((key) =>
        key.startsWith("focowiki-test:pagination-invalid:file-tree:kb-001:")
      )
    ).toBe(true);
    expect(storage.objects.get(`${latestRelease?.bundleRootKey}index.md`)).not.toContain(
      "intro.md"
    );

    const removed = await app.request("/kb/kb-001/pages/intro.md", {
      headers: { authorization: "Bearer public-secret" }
    });
    const remaining = await app.request("/kb/kb-001/pages/setup.md", {
      headers: { authorization: "Bearer public-secret" }
    });
    const schema = await app.request("/kb/kb-001/schema.md", {
      headers: { authorization: "Bearer public-secret" }
    });
    const search = await app.request("/kb/kb-001/_index/search.json", {
      headers: { authorization: "Bearer public-secret" }
    });
    const manifest = await app.request("/kb/kb-001/_index/manifest.json", {
      headers: { authorization: "Bearer public-secret" }
    });

    expect(removed.status).toBe(404);
    expect(remaining.status).toBe(200);
    expect(schema.status).toBe(200);
    expect(search.status).toBe(200);
    expect(manifest.status).toBe(200);
    await expect(search.text()).resolves.not.toContain("intro.md");
    await expect(manifest.text()).resolves.not.toContain("intro.md");
  });

  it("rejects deletion for generated system files", async () => {
    const { repositories, records } = createRepositories();
    const app = createApiApp({
      config: createConfig(),
      storage: new MemoryStorage(),
      redis: createRedisCoordinator(new MemoryRedisCommandClient(), { keyPrefix: "focowiki-test" }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request("/admin/api/knowledge-bases/kb-001/files/detail?path=index.md", {
      method: "DELETE",
      headers: { cookie }
    });

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FILE_NOT_DELETABLE",
        messageKey: "errors.fileNotDeletable"
      }
    });
    expect(response.status).toBe(400);
    expect(records.tasks).toHaveLength(0);
  });

  it("keeps the previous active release and safe task errors when deletion republish fails", async () => {
    const redisClient = new MemoryRedisCommandClient();
    const storage = new MemoryStorage();
    storage.failOnKeyPart = "/releases/";
    const { repositories, records } = createRepositories();
    const app = createApiApp({
      config: createConfig(),
      storage,
      redis: createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=pages/intro.md",
      {
        method: "DELETE",
        headers: { cookie }
      }
    );

    expect(response.status).toBe(202);
    await waitFor(() => records.tasks[0]?.endedAt !== null);

    expect(records.knowledgeBase.activeReleaseId).toBe("release-001");
    expect(records.tasks[0]).toMatchObject({
      operation: "delete_source",
      resultReleaseId: null,
      internalErrorCode: "SOURCE_DELETION_FAILED",
      internalErrorMessage: "Deletion failed"
    });
    expect(JSON.stringify(records.tasks[0])).not.toContain("tenant/demo");
    expect(records.taskEvents).toContainEqual(
      expect.objectContaining({
        phaseKey: "bundle_generation",
        severity: "error"
      })
    );
    expect(storage.objects.has("tenant/demo/source/intro.md")).toBe(true);
    expect(
      storage.objects.has(
        "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/intro.md"
      )
    ).toBe(true);
  });
});
