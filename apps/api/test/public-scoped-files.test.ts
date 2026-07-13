import { describe, expect, it } from "vitest";
import { createPublicOpenApiApp } from "../src/server.js";
import type { RuntimeConfig } from "../src/config.js";
import { hashPublicOpenApiKey } from "../src/public-openapi/keys.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import {
  StorageObjectTooLargeError,
  type StorageAdapter,
  type StoredObject
} from "../src/storage/s3.js";

const publicKey = "fwok_test-public-secret";

const knowledgeBase = {
  id: "kb-001",
  name: "Developer docs",
  description: null,
  activeReleaseId: "release-001",
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z"
};

const publicSearchIndex = {
  generated_at: "2026-06-14T00:00:00.000Z",
  items: [
    {
      path: "pages/客户支持手册.md",
      type: "guide",
      title: "客户支持手册",
      description: "Public scoped metadata fixture",
      resource: "https://example.com/support-guide",
      timestamp: "2026-06-14T00:00:00.000Z",
      tags: ["support", "rule"],
      keywords: ["public", "scoped", "metadata"],
      metadata: {
        type: "guide",
        title: "客户支持手册",
        description: "Public scoped metadata fixture",
        resource: "https://example.com/support-guide",
        timestamp: "2026-06-14T00:00:00.000Z",
        tags: ["support", "rule"],
        externalId: "doc-001",
        status: "active"
      }
    }
  ]
};

function createConfig(publicApi?: Partial<RuntimeConfig["publicApi"]>): RuntimeConfig {
  return {
    admin: {
      username: "admin",
      password: "admin-secret",
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
      ...publicApi
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
      generationBatchSize: 50,
      fileProcessingConcurrency: 1,
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
    },
    model: {
      enabled: false
    },
    corsOrigins: []
  };
}

class MemoryStorage implements StorageAdapter {
  public readonly keyspace = createStorageKeyspace("tenant/demo");
  public textReads = 0;
  public bodyReads = 0;
  public readonly objects = new Map<string, string>([
    [
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/index.md",
      "# Developer docs"
    ],
    [
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/log.md",
      "# Directory Update Log\n\n## 2026-06-14\n\n* **Update**: Published 1 Markdown pages."
    ],
    [
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/_index/search.json",
      `${JSON.stringify(publicSearchIndex, null, 2)}\n`
    ],
    [
      "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/_index/search/000001.jsonl",
      `${JSON.stringify(publicSearchIndex.items[0])}\n`
    ]
  ]);

  public async putObject(object: StoredObject): Promise<void> {
    this.objects.set(
      object.key,
      typeof object.body === "string" ? object.body : new TextDecoder().decode(object.body)
    );
  }

  public async getObjectText(
    key: string,
    options: { maxBytes?: number } = {}
  ): Promise<string | null> {
    this.textReads += 1;
    const value = this.objects.get(key) ?? null;

    if (value !== null && options.maxBytes !== undefined && value.length > options.maxBytes) {
      throw new StorageObjectTooLargeError({
        key,
        sizeBytes: value.length,
        maxBytes: options.maxBytes
      });
    }

    return value;
  }

  public async getObjectBody(key: string): Promise<BodyInit | null> {
    this.bodyReads += 1;
    const value = this.objects.get(key);
    return value ? new Blob([value]) : null;
  }

}

function createRepositories(options: { publicKeyStatus?: "active" | "revoked" | "missing" } = {}) {
  const calls = {
    fileLookups: 0,
    treeLists: 0,
    sourceLists: 0,
    releaseLists: 0,
    bundleLists: 0
  };
  const files = new Map([
    [
      "index.md",
      {
        id: "bundle-file-index",
        knowledgeBaseId: "kb-001",
        releaseId: "release-001",
        sourceFileId: null,
        fileKind: "index" as const,
        logicalPath: "index.md",
        objectKey: "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/index.md",
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: 24,
        checksumSha256: "checksum",
        okfType: null,
        title: null,
        description: null,
        tags: [],
        frontmatter: {}
      }
    ],
    [
      "log.md",
      {
        id: "bundle-file-log",
        knowledgeBaseId: "kb-001",
        releaseId: "release-001",
        sourceFileId: null,
        fileKind: "log" as const,
        logicalPath: "log.md",
        objectKey: "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/log.md",
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: 96,
        checksumSha256: "checksum",
        okfType: null,
        title: null,
        description: null,
        tags: [],
        frontmatter: {}
      }
    ],
    [
      "_index/search.json",
      {
        id: "bundle-file-search",
        knowledgeBaseId: "kb-001",
        releaseId: "release-001",
        sourceFileId: null,
        fileKind: "search_index" as const,
        logicalPath: "_index/search.json",
        objectKey: "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/_index/search.json",
        contentType: "application/json; charset=utf-8",
        sizeBytes: 18,
        checksumSha256: "checksum",
        okfType: null,
        title: null,
        description: null,
        tags: [],
        frontmatter: {}
      }
    ],
    [
      "_index/search/000001.jsonl",
      {
        id: "bundle-file-search-shard-1",
        knowledgeBaseId: "kb-001",
        releaseId: "release-001",
        sourceFileId: null,
        fileKind: "search_index_shard" as const,
        logicalPath: "_index/search/000001.jsonl",
        objectKey:
          "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/_index/search/000001.jsonl",
        contentType: "application/x-ndjson; charset=utf-8",
        sizeBytes: 32,
        checksumSha256: "checksum",
        okfType: null,
        title: null,
        description: null,
        tags: [],
        frontmatter: {}
      }
    ],
    [
      "pages/客户支持手册.md",
      {
        id: "bundle-file-original-name",
        knowledgeBaseId: "kb-001",
        releaseId: "release-001",
        sourceFileId: "source-001",
        fileKind: "page" as const,
        logicalPath: "pages/客户支持手册.md",
        objectKey:
          "tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/客户支持手册.md",
        contentType: "text/markdown; charset=utf-8",
        sizeBytes: 36,
        checksumSha256: "checksum",
        okfType: "page",
        title: "客户支持手册",
        description: null,
        tags: [],
        frontmatter: {}
      }
    ]
  ]);

  return {
    calls,
    publicApiKeys: createPublicApiKeyRepository(publicKey, options.publicKeyStatus ?? "active"),
    knowledgeBases: {
      async listKnowledgeBases() {
        return { items: [knowledgeBase], nextCursor: null };
      },
      async createKnowledgeBase() {
        return knowledgeBase;
      },
      async getKnowledgeBase(id: string) {
        return id === knowledgeBase.id ? knowledgeBase : null;
      }
    },
    files: {
      async listBundleTreeEntries() {
        calls.treeLists += 1;
        return { items: [], nextCursor: null };
      },
      async getBundleFile(input: { knowledgeBaseId: string; releaseId: string; logicalPath: string }) {
        calls.fileLookups += 1;
        return input.knowledgeBaseId === "kb-001" && input.releaseId === "release-001"
          ? files.get(input.logicalPath) ?? null
          : null;
      },
      async listSourceFiles() {
        calls.sourceLists += 1;
        return { items: [], nextCursor: null };
      },
      async listReleases() {
        calls.releaseLists += 1;
        return { items: [], nextCursor: null };
      },
      async listBundleFiles() {
        calls.bundleLists += 1;
        return { items: [], nextCursor: null };
      }
    }
  };
}

function createPublicApiKeyRepository(rawKey: string, status: "active" | "revoked" | "missing") {
  const keyHash = hashPublicOpenApiKey(rawKey);

  return {
    async countActivePublicOpenApiKeys() {
      return status === "active" ? 1 : 0;
    },
    async listPublicOpenApiKeys() {
      return { items: [], nextCursor: null };
    },
    async createPublicOpenApiKey() {
      throw new Error("Not used by public file tests");
    },
    async findActivePublicOpenApiKeyByHash(candidateHash: string) {
      return status === "active" && candidateHash === keyHash
        ? {
            id: "openapi-key-test",
            name: "Test key",
            keyHash,
            keyPrefix: rawKey.slice(0, 10),
            keySuffix: rawKey.slice(-6),
            status: "active" as const,
            createdAt: "2026-06-14T00:00:00.000Z",
            lastUsedAt: null,
            revokedAt: null
          }
        : null;
    },
    async revokePublicOpenApiKey() {
      return null;
    },
    async updatePublicOpenApiKeyLastUsed() {
      return undefined;
    }
  };
}

describe("Scoped public file OpenAPI", () => {
  it("serves knowledge base scoped Markdown and JSON content through Developer OpenAPI", async () => {
    const storage = new MemoryStorage();
    const repositories = createRepositories();
    const app = createPublicOpenApiApp({
      config: createConfig(),
      storage,
      repositories
    });
    const markdown = await app.request(
      "/openapi/v2/knowledge-bases/kb-001/files/content?path=index.md",
      {
        headers: {
          authorization: `Bearer ${publicKey}`
        }
      }
    );
    const log = await app.request(
      "/openapi/v2/knowledge-bases/kb-001/files/content?path=log.md",
      {
        headers: {
          authorization: `Bearer ${publicKey}`
        }
      }
    );
    const json = await app.request(
      "/openapi/v2/knowledge-bases/kb-001/files/content?path=_index%2Fsearch.json",
      {
        headers: {
          authorization: `Bearer ${publicKey}`
        }
      }
    );

    expect(markdown.status).toBe(200);
    await expect(markdown.json()).resolves.toMatchObject({
      file: { path: "index.md", fileId: "bundle-file-index" },
      content: "# Developer docs"
    });
    expect(log.status).toBe(200);
    await expect(log.json()).resolves.toMatchObject({
      file: { path: "log.md", fileId: "bundle-file-log" },
      content: expect.stringContaining("# Directory Update Log")
    });
    expect(json.status).toBe(200);
    const jsonBody = (await json.json()) as {
      file: Record<string, unknown>;
      content: string;
    };
    const searchIndex = JSON.parse(jsonBody.content) as typeof publicSearchIndex;

    expect(jsonBody.file).toMatchObject({ path: "_index/search.json" });
    expect(searchIndex).toEqual(publicSearchIndex);
    expect(searchIndex.items[0]?.metadata).not.toHaveProperty("objectKey");
    expect(searchIndex.items[0]?.metadata).not.toHaveProperty("releaseId");
    expect(searchIndex.items[0]?.metadata).not.toHaveProperty("taskId");
    expect(searchIndex.items[0]?.metadata).not.toHaveProperty("localPath");
    expect(storage.textReads).toBe(3);
    expect(storage.bodyReads).toBe(0);
    expect(repositories.calls).toMatchObject({
      fileLookups: 3,
      treeLists: 0,
      sourceLists: 0,
      releaseLists: 0,
      bundleLists: 0
    });
  });

  it("rejects generated content reads above the configured byte limit", async () => {
    const baseConfig = createConfig();
    const app = createPublicOpenApiApp({
      config: {
        ...baseConfig,
        pagination: {
          ...baseConfig.pagination,
          generatedContentMaxBytes: 4
        }
      },
      storage: new MemoryStorage(),
      repositories: createRepositories()
    });
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-001/files/content?path=index.md",
      {
        headers: {
          authorization: `Bearer ${publicKey}`
        }
      }
    );

    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "PAYLOAD_TOO_LARGE"
      }
    });
    expect(response.status).toBe(413);
  });

  it("serves generated index shard content through Developer OpenAPI", async () => {
    const app = createPublicOpenApiApp({
      config: createConfig(),
      storage: new MemoryStorage(),
      repositories: createRepositories()
    });
    const response = await app.request(
      "/openapi/v2/knowledge-bases/kb-001/files/content?path=_index%2Fsearch%2F000001.jsonl",
      {
        headers: {
          authorization: `Bearer ${publicKey}`
        }
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      file: {
        path: "_index/search/000001.jsonl",
        fileKind: "search_index_shard"
      },
      content: expect.stringContaining("\"客户支持手册\"")
    });
  });

  it("serves public files by encoded original Markdown file name", async () => {
    const storage = new MemoryStorage();
    const repositories = createRepositories();
    const app = createPublicOpenApiApp({
      config: createConfig(),
      storage,
      repositories
    });
    const fileName = "客户支持手册.md";
    storage.objects.set(
      `tenant/demo/knowledge-bases/kb-001/releases/release-001/bundle/pages/${fileName}`,
      "---\ntype: page\ntitle: 客户支持手册\n---\n# 外国企业"
    );

    const response = await app.request(
      `/openapi/v2/knowledge-bases/kb-001/files/content?path=${encodeURIComponent(
        `pages/${fileName}`
      )}`,
      {
        headers: {
          authorization: `Bearer ${publicKey}`
        }
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      file: {
        path: `pages/${fileName}`,
        title: "客户支持手册"
      },
      content: expect.stringContaining("# 外国企业")
    });
  });

  it("requires the public bearer key before scoped lookup in private mode", async () => {
    const app = createPublicOpenApiApp({
      config: createConfig(),
      storage: new MemoryStorage(),
      repositories: createRepositories()
    });
    const path = "/openapi/v2/knowledge-bases/kb-001/files/content?path=index.md";
    const missing = await app.request(path);
    const wrong = await app.request(path, {
      headers: {
        authorization: "Bearer wrong"
      }
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
  });

  it("rejects revoked and deleted managed public bearer keys", async () => {
    const revokedApp = createPublicOpenApiApp({
      config: createConfig(),
      storage: new MemoryStorage(),
      repositories: createRepositories({ publicKeyStatus: "revoked" })
    });
    const deletedApp = createPublicOpenApiApp({
      config: createConfig(),
      storage: new MemoryStorage(),
      repositories: createRepositories({ publicKeyStatus: "missing" })
    });
    const path = "/openapi/v2/knowledge-bases/kb-001/files/content?path=index.md";
    const revoked = await revokedApp.request(path, {
      headers: {
        authorization: `Bearer ${publicKey}`
      }
    });
    const deleted = await deletedApp.request(path, {
      headers: {
        authorization: `Bearer ${publicKey}`
      }
    });

    await expect(revoked.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED", httpStatus: 401 }
    });
    await expect(deleted.json()).resolves.toMatchObject({
      error: { code: "UNAUTHORIZED", httpStatus: 401 }
    });
    expect(revoked.status).toBe(401);
    expect(deleted.status).toBe(401);
  });

  it("returns JSON errors for missing scoped resources and unsafe paths", async () => {
    const app = createPublicOpenApiApp({
      config: createConfig(),
      storage: new MemoryStorage(),
      repositories: createRepositories()
    });
    const missingKnowledgeBase = await app.request(
      "/openapi/v2/knowledge-bases/kb-missing/files/content?path=index.md",
      {
        headers: {
          authorization: `Bearer ${publicKey}`
        }
      }
    );
    const missingFile = await app.request(
      "/openapi/v2/knowledge-bases/kb-001/files/content?path=pages%2Fmissing.md",
      {
        headers: {
          authorization: `Bearer ${publicKey}`
        }
      }
    );
    const unsupported = await app.request(
      "/openapi/v2/knowledge-bases/kb-001/files/content?path=unsupported.txt",
      {
        headers: {
          authorization: `Bearer ${publicKey}`
        }
      }
    );
    const sourceFile = await app.request(
      "/openapi/v2/knowledge-bases/kb-001/files/content?path=sources%2Fintro.md",
      {
        headers: {
          authorization: `Bearer ${publicKey}`
        }
      }
    );
    const traversal = await app.request("/openapi/v2/knowledge-bases/kb-001/pages/%252e%252e", {
      headers: {
        authorization: `Bearer ${publicKey}`
      }
    });

    await expect(missingKnowledgeBase.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND", httpStatus: 404 }
    });
    await expect(missingFile.json()).resolves.toMatchObject({
      error: { code: "NOT_FOUND", httpStatus: 404 }
    });
    await expect(unsupported.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR", httpStatus: 422 }
    });
    await expect(sourceFile.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR", httpStatus: 422 }
    });
    await expect(traversal.json()).resolves.toEqual({
      error: { code: "INVALID_PATH" }
    });
    expect(missingKnowledgeBase.status).toBe(404);
    expect(missingFile.status).toBe(404);
    expect(unsupported.status).toBe(422);
    expect(sourceFile.status).toBe(422);
    expect(traversal.status).toBe(400);
  });

  it("does not serve old /kb public routes", async () => {
    const app = createPublicOpenApiApp({
      config: createConfig(),
      storage: new MemoryStorage(),
      repositories: createRepositories()
    });
    const response = await app.request("/kb/kb-001/index.md", {
      headers: {
        authorization: `Bearer ${publicKey}`
      }
    });

    await expect(response.json()).resolves.toMatchObject({
      error: { code: "UNSUPPORTED_ROUTE", httpStatus: 404 }
    });
    expect(response.status).toBe(404);
  });
});
