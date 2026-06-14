import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/server.js";
import type { RuntimeConfig } from "../src/config.js";
import { createRedisCoordinator } from "../src/redis/coordination.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter, StoredObject } from "../src/storage/s3.js";
import {
  createTestRedisCoordinator,
  loginAndReadSessionCookie,
  MemoryRedisCommandClient
} from "./support/session.js";

const knowledgeBase = {
  id: "kb-001",
  name: "Developer docs",
  description: null,
  activeReleaseId: "release-001",
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
      generationBatchSize: 50
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

class MemoryStorage implements StorageAdapter {
  public readonly keyspace = createStorageKeyspace("tenant/demo");
  public readonly objects = new Map<string, string>([
    [
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/intro.md",
      "---\ntype: page\ntitle: Intro\n---\n# Intro"
    ]
  ]);

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
    throw new Error("Not used by knowledge base file tests");
  }

  public async readCurrentPointer(): Promise<null> {
    return null;
  }
}

function createRepositories() {
  const treeCalls: Array<{ limit: number; cursor: string | null; parentPath: string }> = [];
  const sourceCalls: Array<{ limit: number; cursor: string | null }> = [];
  const releaseCalls: Array<{ limit: number; cursor: string | null }> = [];
  const bundleCalls: Array<{ limit: number; cursor: string | null }> = [];
  const bundleFile = {
    id: "bundle-file-001",
    knowledgeBaseId: "kb-001",
    releaseId: "release-001",
    logicalPath: "pages/intro.md",
    objectKey: "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/intro.md",
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 42,
    checksumSha256: "checksum",
    okfType: "page",
    title: "Intro",
    description: null,
    tags: ["docs"],
    frontmatter: {
      type: "page",
      title: "Intro"
    }
  };

  return {
    records: {
      bundleFile,
      treeCalls,
      sourceCalls,
      releaseCalls,
      bundleCalls
    },
    repositories: {
      knowledgeBases: {
        async listKnowledgeBases() {
          return { items: [knowledgeBase], nextCursor: null };
        },
        async createKnowledgeBase() {
          return knowledgeBase;
        },
        async getKnowledgeBase(id: string) {
          return id === "kb-001" ? knowledgeBase : null;
        }
      },
      files: {
        async listBundleTreeEntries(request: { limit: number; cursor: string | null; parentPath: string }) {
          treeCalls.push(request);
          const entries = [
            {
              id: "tree-pages",
              knowledgeBaseId: "kb-001",
              releaseId: "release-001",
              parentPath: "",
              name: "pages",
              logicalPath: "pages",
              entryType: "directory" as const,
              bundleFileId: null
            },
            {
              id: "tree-index",
              knowledgeBaseId: "kb-001",
              releaseId: "release-001",
              parentPath: "",
              name: "index.md",
              logicalPath: "index.md",
              entryType: "file" as const,
              bundleFileId: "bundle-file-index"
            }
          ];
          const start = request.cursor ? Number(request.cursor) : 0;

          return {
            items: entries.slice(start, start + request.limit),
            nextCursor: start + request.limit < entries.length ? String(start + request.limit) : null
          };
        },
        async getBundleFile(input: { knowledgeBaseId: string; releaseId: string; logicalPath: string }) {
          return input.knowledgeBaseId === "kb-001" &&
            input.releaseId === "release-001" &&
            input.logicalPath === "pages/intro.md"
            ? bundleFile
            : null;
        },
        async listSourceFiles(request: { limit: number; cursor: string | null }) {
          sourceCalls.push(request);
          return {
            items: [
              {
                id: "source-001",
                knowledgeBaseId: "kb-001",
                taskId: "task-001",
                originalName: "intro.md",
                objectKey: "tenant/demo/source/intro.md",
                contentType: "text/markdown; charset=utf-8",
                sizeBytes: 42,
                checksumSha256: "checksum",
                metadata: { type: "page", title: "Intro" },
                createdAt: "2026-06-14T00:00:00.000Z"
              }
            ].slice(request.cursor ? Number(request.cursor) : 0, (request.cursor ? Number(request.cursor) : 0) + request.limit),
            nextCursor: null
          };
        },
        async listReleases(request: { limit: number; cursor: string | null }) {
          releaseCalls.push(request);
          return {
            items: [
              {
                id: "release-001",
                knowledgeBaseId: "kb-001",
                taskId: "task-001",
                bundleRootKey: "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/",
                generatedAt: "2026-06-14T00:00:00.000Z",
                publishedAt: "2026-06-14T00:00:00.000Z",
                fileCount: 7,
                manifestChecksumSha256: "checksum",
                createdAt: "2026-06-14T00:00:00.000Z"
              }
            ].slice(request.cursor ? Number(request.cursor) : 0, (request.cursor ? Number(request.cursor) : 0) + request.limit),
            nextCursor: null
          };
        },
        async listBundleFiles(request: { limit: number; cursor: string | null }) {
          bundleCalls.push(request);
          return {
            items: [bundleFile].slice(request.cursor ? Number(request.cursor) : 0, (request.cursor ? Number(request.cursor) : 0) + request.limit),
            nextCursor: null
          };
        }
      }
    }
  };
}

async function createAuthenticatedFileApp() {
  const { repositories, records } = createRepositories();
  const app = createApiApp({
    config: createConfig(),
    storage: new MemoryStorage(),
    redis: createTestRedisCoordinator(),
    repositories
  });
  const cookie = await loginAndReadSessionCookie(app);
  return { app, cookie, records };
}

describe("Knowledge base file Admin API", () => {
  it("returns a knowledge base scoped generated file tree page", async () => {
    const { app, cookie } = await createAuthenticatedFileApp();
    const response = await app.request("/admin/api/knowledge-bases/kb-001/files/tree", {
      headers: {
        cookie
      }
    });

    await expect(response.json()).resolves.toEqual({
      items: [
        {
          id: "tree-pages",
          parentPath: "",
          name: "pages",
          logicalPath: "pages",
          entryType: "directory",
          bundleFileId: null
        },
        {
          id: "tree-index",
          parentPath: "",
          name: "index.md",
          logicalPath: "index.md",
          entryType: "file",
          bundleFileId: "bundle-file-index"
        }
      ],
      nextCursor: null
    });
    expect(response.status).toBe(200);
  });

  it("returns generated file detail by resolving DB metadata and reading S3 body", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const response = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=pages/intro.md",
      {
        headers: {
          cookie
        }
      }
    );
    const body = (await response.json()) as {
      file: Record<string, unknown>;
      content: string;
      readOnly: boolean;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      file: {
        id: "bundle-file-001",
        logicalPath: "pages/intro.md",
        contentType: "text/markdown; charset=utf-8",
        okfType: "page",
        title: "Intro",
        tags: ["docs"]
      },
      content: "---\ntype: page\ntitle: Intro\n---\n# Intro",
      readOnly: true
    });
    expect(body.file).not.toHaveProperty("objectKey");
    expect(records.bundleFile).not.toHaveProperty("content");
  });

  it("returns not found when the knowledge base or file record is missing", async () => {
    const { app, cookie } = await createAuthenticatedFileApp();
    const missingKnowledgeBase = await app.request(
      "/admin/api/knowledge-bases/kb-missing/files/tree",
      {
        headers: {
          cookie
        }
      }
    );
    const missingFile = await app.request(
      "/admin/api/knowledge-bases/kb-001/files/detail?path=pages/missing.md",
      {
        headers: {
          cookie
        }
      }
    );

    expect(missingKnowledgeBase.status).toBe(404);
    expect(missingFile.status).toBe(404);
  });

  it("paginates file tree directories with Redis cursor and page cache state", async () => {
    const { repositories, records } = createRepositories();
    const redisClient = new MemoryRedisCommandClient();
    const app = createApiApp({
      config: createConfig(),
      storage: new MemoryStorage(),
      redis: createRedisCoordinator(redisClient, { keyPrefix: "focowiki-test" }),
      repositories
    });
    const cookie = await loginAndReadSessionCookie(app);
    const first = await app.request("/admin/api/knowledge-bases/kb-001/files/tree?limit=1", {
      headers: {
        cookie
      }
    });
    const firstBody = (await first.json()) as { nextCursor: string | null };

    expect(first.status).toBe(200);
    expect(firstBody.nextCursor).toEqual(expect.stringMatching(/^cursor-/));
    expect(
      Array.from(redisClient.values.keys()).some((key) =>
        key.startsWith("focowiki-test:pagination-cursors:file-tree:kb-001:release-001:")
      )
    ).toBe(true);

    const second = await app.request(
      `/admin/api/knowledge-bases/kb-001/files/tree?limit=1&cursor=${firstBody.nextCursor}`,
      {
        headers: {
          cookie
        }
      }
    );

    expect(second.status).toBe(200);
    expect(records.treeCalls).toEqual([
      expect.objectContaining({ limit: 1, cursor: null, parentPath: "" }),
      expect.objectContaining({ limit: 1, cursor: "1", parentPath: "" })
    ]);
  });

  it("returns paginated source, release, and bundle file lists without exposing S3 object keys", async () => {
    const { app, cookie, records } = await createAuthenticatedFileApp();
    const sourceFiles = await app.request("/admin/api/knowledge-bases/kb-001/source-files?limit=1", {
      headers: {
        cookie
      }
    });
    const releases = await app.request("/admin/api/knowledge-bases/kb-001/releases?limit=1", {
      headers: {
        cookie
      }
    });
    const bundleFiles = await app.request("/admin/api/knowledge-bases/kb-001/bundle-files?limit=1", {
      headers: {
        cookie
      }
    });
    const sourceBody = (await sourceFiles.json()) as { items: Array<Record<string, unknown>> };
    const releaseBody = (await releases.json()) as { items: Array<Record<string, unknown>> };
    const bundleBody = (await bundleFiles.json()) as { items: Array<Record<string, unknown>> };

    expect(sourceFiles.status).toBe(200);
    expect(releases.status).toBe(200);
    expect(bundleFiles.status).toBe(200);
    expect(sourceBody.items[0]).not.toHaveProperty("objectKey");
    expect(releaseBody.items[0]).not.toHaveProperty("bundleRootKey");
    expect(bundleBody.items[0]).not.toHaveProperty("objectKey");
    expect(records.sourceCalls).toEqual([expect.objectContaining({ limit: 1, cursor: null })]);
    expect(records.releaseCalls).toEqual([expect.objectContaining({ limit: 1, cursor: null })]);
    expect(records.bundleCalls).toEqual([expect.objectContaining({ limit: 1, cursor: null })]);
  });

  it("returns knowledge base public URLs without storage details", async () => {
    const { app, cookie } = await createAuthenticatedFileApp();
    const response = await app.request("/admin/api/knowledge-bases/kb-001/public-urls", {
      headers: {
        cookie
      }
    });

    await expect(response.json()).resolves.toEqual({
      publicUrls: {
        index: "https://kb.example.com/kb/kb-001/index.md",
        search: "https://kb.example.com/kb/kb-001/_index/search.json",
        links: "https://kb.example.com/kb/kb-001/_index/links.json"
      }
    });
    expect(response.status).toBe(200);
  });
});
