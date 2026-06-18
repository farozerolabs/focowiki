import { describe, expect, it } from "vitest";
import { createPublicOpenApiApp } from "../src/server.js";
import type {
  AdminRepositories,
  BundleFileRecord,
  BundleTreeEntryRecord,
  KnowledgeBaseRecord,
  SourceFileRecord,
  WebhookDeliveryRecord,
  WebhookSubscriptionRecord
} from "../src/db/admin-repositories.js";
import { hashPublicOpenApiKey } from "../src/public-openapi/keys.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter, StoredObject } from "../src/storage/s3.js";
import type { RuntimeConfig } from "../src/config.js";
import { createTestRedisCoordinator } from "./support/session.js";

const developerKey = "fwok_developer-openapi-test-key";
const now = "2026-06-16T00:00:00.000Z";

const expectedDeveloperOpenApiOperations = [
  { method: "get", path: "/openapi/v1/health", status: "200" },
  { method: "get", path: "/openapi/v1/version", status: "200" },
  { method: "get", path: "/openapi/v1/openapi.json", status: "200" },
  { method: "get", path: "/openapi/v1/knowledge-bases", status: "200" },
  { method: "post", path: "/openapi/v1/knowledge-bases", status: "201" },
  { method: "get", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}", status: "200" },
  { method: "delete", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}", status: "200" },
  { method: "post", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/uploads", status: "202" },
  { method: "get", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files", status: "200" },
  {
    method: "get",
    path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}",
    status: "200"
  },
  {
    method: "get",
    path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/events",
    status: "200"
  },
  {
    method: "post",
    path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/source-files/{sourceFileId}/retry",
    status: "202"
  },
  { method: "get", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/tree", status: "200" },
  { method: "get", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/content", status: "200" },
  { method: "get", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}", status: "200" },
  {
    method: "get",
    path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/content",
    status: "200"
  },
  {
    method: "get",
    path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}/related",
    status: "200"
  },
  { method: "delete", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files/{fileId}", status: "200" },
  { method: "delete", path: "/openapi/v1/knowledge-bases/{knowledgeBaseId}/files", status: "200" },
  { method: "post", path: "/openapi/v1/webhooks", status: "201" },
  { method: "get", path: "/openapi/v1/webhooks", status: "200" },
  { method: "delete", path: "/openapi/v1/webhooks/{webhookId}", status: "200" },
  { method: "get", path: "/openapi/v1/webhook-deliveries", status: "200" },
  { method: "post", path: "/openapi/v1/webhook-deliveries/{deliveryId}/redeliver", status: "202" }
] as const;

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
      baseUrl: "https://kb.example.com"
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

class MemoryStorage implements StorageAdapter {
  public readonly keyspace = createStorageKeyspace("tenant/demo");
  public readonly objects = new Map<string, string>([
    [
      "tenant/demo/knowledge-bases/kb-seeded/releases/release-seeded/bundle/index.md",
      "# Seeded KB"
    ],
    [
      "tenant/demo/knowledge-bases/kb-seeded/releases/release-seeded/bundle/pages/guide.md",
      "---\ntype: page\ntitle: Guide\n---\n# Guide"
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
    throw new Error("Not used by Developer OpenAPI tests");
  }

  public async readCurrentPointer(): Promise<null> {
    return null;
  }
}

function createRepositories(): AdminRepositories & {
  webhookDeliveries: Map<string, WebhookDeliveryRecord>;
} {
  const keyHash = hashPublicOpenApiKey(developerKey);
  const knowledgeBase: KnowledgeBaseRecord = {
    id: "kb-seeded",
    name: "Seeded KB",
    description: null,
    activeReleaseId: "release-seeded",
    createdAt: now,
    updatedAt: now
  };
  const sourceFile: SourceFileRecord = {
    id: "source-guide",
    knowledgeBaseId: "kb-seeded",
    originalName: "guide.md",
    objectKey: "tenant/demo/knowledge-bases/kb-seeded/sources/source-guide/guide.md",
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 41,
    checksumSha256: "checksum",
    metadata: {},
    modelSuggestions: null,
    processingStatus: "completed",
    processingStage: "release_activation",
    processingStartedAt: now,
    processingEndedAt: now,
    processingErrorCode: null,
    processingErrorMessage: null,
    retryCount: 0,
    createdAt: now,
    deletedAt: null
  };
  const bundleFile: BundleFileRecord = {
    id: "bundle-guide",
    knowledgeBaseId: "kb-seeded",
    releaseId: "release-seeded",
    sourceFileId: "source-guide",
    fileKind: "page",
    logicalPath: "pages/guide.md",
    objectKey: "tenant/demo/knowledge-bases/kb-seeded/releases/release-seeded/bundle/pages/guide.md",
    contentType: "text/markdown; charset=utf-8",
    sizeBytes: 41,
    checksumSha256: "checksum",
    okfType: "page",
    title: "Guide",
    description: null,
    tags: [],
    frontmatter: { type: "page", title: "Guide" }
  };
  const treeEntry: BundleTreeEntryRecord = {
    id: "tree-guide",
    knowledgeBaseId: "kb-seeded",
    releaseId: "release-seeded",
    parentPath: "pages",
    name: "guide.md",
    logicalPath: "pages/guide.md",
    entryType: "file",
    bundleFileId: "bundle-guide",
    sourceFileId: "source-guide",
    fileKind: "page"
  };
  const webhooks = new Map<string, WebhookSubscriptionRecord>();
  const webhookDeliveries = new Map<string, WebhookDeliveryRecord>();

  return {
    webhookDeliveries,
    publicApiKeys: {
      async countActivePublicOpenApiKeys() {
        return 1;
      },
      async listPublicOpenApiKeys() {
        return { items: [], nextCursor: null };
      },
      async createPublicOpenApiKey() {
        throw new Error("Not used by Developer OpenAPI tests");
      },
      async findActivePublicOpenApiKeyByHash(candidateHash: string) {
        return candidateHash === keyHash
          ? {
              id: "openapi-key-developer",
              name: "Developer key",
              keyHash,
              keyPrefix: developerKey.slice(0, 10),
              keySuffix: developerKey.slice(-6),
              status: "active",
              createdAt: now,
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
    },
    knowledgeBases: {
      async listKnowledgeBases() {
        return { items: [knowledgeBase], nextCursor: null };
      },
      async createKnowledgeBase(input) {
        return {
          id: "kb-created",
          name: input.name,
          description: input.description,
          activeReleaseId: null,
          createdAt: now,
          updatedAt: now
        };
      },
      async getKnowledgeBase(id) {
        return id === knowledgeBase.id ? knowledgeBase : null;
      },
      async softDeleteKnowledgeBase() {
        return true;
      }
    },
    files: {
      async createSourceFiles() {
        return undefined;
      },
      async createRelease() {
        return undefined;
      },
      async createBundleFiles() {
        return undefined;
      },
      async createBundleTreeEntries() {
        return undefined;
      },
      async activateRelease() {
        return undefined;
      },
      async listBundleTreeEntries({ parentPath }) {
        return {
          items: parentPath === "pages" ? [treeEntry] : [],
          nextCursor: null
        };
      },
      async getBundleFile({ logicalPath }) {
        return logicalPath === bundleFile.logicalPath ? bundleFile : null;
      },
      async getBundleFileById({ fileId }) {
        return fileId === bundleFile.id ? bundleFile : null;
      },
      async getSourceFile({ sourceFileId }) {
        return sourceFileId === sourceFile.id ? sourceFile : null;
      },
      async listSourceFiles() {
        return { items: [sourceFile], nextCursor: null };
      },
      async listReleases() {
        return { items: [], nextCursor: null };
      },
      async listBundleFiles() {
        return { items: [bundleFile], nextCursor: null };
      },
      async softDeleteSourceFile() {
        return true;
      }
    },
    graph: {
      async upsertGraphNode() {
        throw new Error("Not used by Developer OpenAPI tests");
      },
      async upsertGraphEdges() {
        throw new Error("Not used by Developer OpenAPI tests");
      },
      async listGraphNodes() {
        return { items: [], nextCursor: null };
      },
      async listGraphEdges() {
        return { items: [], nextCursor: null };
      },
      async listGraphNeighborhood({ sourceFileId }) {
        return {
          items:
            sourceFileId === "source-guide"
              ? [
                  {
                    fileId: "source-reference",
                    sourceFileId: "source-reference",
                    bundleFileId: "bundle-reference",
                    path: "pages/reference.md",
                    title: "Reference",
                    relationType: "shared_tag",
                    direction: "outgoing",
                    weight: 0.8,
                    reason: "Both files share a topic.",
                    source: "deterministic",
                    contentAvailable: true
                  }
                ]
              : [],
          nextCursor: null
        };
      },
      async deleteGraphForSourceFile() {
        throw new Error("Not used by Developer OpenAPI tests");
      }
    },
    webhooks: {
      async createWebhookSubscription(input) {
        const webhook = {
          id: input.id,
          name: input.name,
          url: input.url,
          signingSecret: input.signingSecret,
          events: input.events,
          enabled: true,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          lastDeliveryAt: null
        };
        webhooks.set(webhook.id, webhook);
        return webhook;
      },
      async getWebhookSubscription(id) {
        return webhooks.get(id) ?? null;
      },
      async listWebhookSubscriptions() {
        return { items: Array.from(webhooks.values()), nextCursor: null };
      },
      async deleteWebhookSubscription({ id }) {
        return webhooks.delete(id);
      },
      async createWebhookDelivery(input) {
        const delivery = {
          id: input.id,
          webhookId: input.webhookId,
          eventId: input.eventId,
          eventType: input.eventType,
          payload: input.payload,
          status: input.status,
          attemptCount: input.attemptCount,
          httpStatus: input.httpStatus,
          errorCode: input.errorCode,
          createdAt: input.createdAt,
          updatedAt: input.createdAt
        };
        webhookDeliveries.set(delivery.id, delivery);
        return delivery;
      },
      async updateWebhookDeliveryResult(input) {
        const delivery = webhookDeliveries.get(input.id);

        if (!delivery) {
          return null;
        }

        const updated = {
          ...delivery,
          status: input.status,
          attemptCount: input.attemptCount,
          httpStatus: input.httpStatus,
          errorCode: input.errorCode,
          updatedAt: input.updatedAt
        };
        webhookDeliveries.set(input.id, updated);
        return updated;
      },
      async listWebhookDeliveries() {
        return { items: Array.from(webhookDeliveries.values()), nextCursor: null };
      },
      async getWebhookDelivery(deliveryId) {
        return webhookDeliveries.get(deliveryId) ?? null;
      }
    }
  };
}

function createApp() {
  const config = createConfig();
  const repositories = createRepositories();
  const app = createPublicOpenApiApp({
    config,
    storage: new MemoryStorage(),
    redis: createTestRedisCoordinator(),
    repositories
  });

  return { app, repositories };
}

function authHeaders() {
  return {
    authorization: `Bearer ${developerKey}`
  };
}

describe("Developer OpenAPI", () => {
  it("returns only health status", async () => {
    const { app } = createApp();
    const response = await app.request("/openapi/v1/health", {
      headers: authHeaders()
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("requires a valid OpenAPI key", async () => {
    const { app } = createApp();
    const response = await app.request("/openapi/v1/knowledge-bases");

    expect(response.status).toBe(401);
  });

  it("exposes source file endpoints in the OpenAPI contract", async () => {
    const { app } = createApp();
    const response = await app.request("/openapi/v1/openapi.json", {
      headers: authHeaders()
    });
    const contract = (await response.json()) as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };

    for (const operation of expectedDeveloperOpenApiOperations) {
      expect(contract.paths[operation.path]?.[operation.method]?.responses[operation.status]).toBeDefined();
    }
    expect(contract.paths["/openapi/v1/knowledge-bases/{knowledgeBaseId}/tasks"]).toBeUndefined();
  });

  it("lists source files without task fields", async () => {
    const { app } = createApp();
    const response = await app.request("/openapi/v1/knowledge-bases/kb-seeded/source-files", {
      headers: authHeaders()
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<Record<string, unknown>>;
    };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      fileId: "source-guide",
      originalFilename: "guide.md",
      processingState: "completed"
    });
    expect(body.items[0]).not.toHaveProperty("taskId");
  });

  it("returns bounded related files for a generated source-backed file", async () => {
    const { app } = createApp();
    const response = await app.request(
      "/openapi/v1/knowledge-bases/kb-seeded/files/bundle-guide/related",
      {
        headers: authHeaders()
      }
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      fileId: string;
      sourceFileId: string;
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    };

    expect(body).toMatchObject({
      fileId: "bundle-guide",
      sourceFileId: "source-guide",
      nextCursor: null,
      items: [
        {
          fileId: "source-reference",
          path: "pages/reference.md",
          title: "Reference",
          relationType: "shared_tag",
          direction: "outgoing",
          weight: 0.8,
          reason: "Both files share a topic.",
          contentAvailable: true
        }
      ]
    });
  });
});
