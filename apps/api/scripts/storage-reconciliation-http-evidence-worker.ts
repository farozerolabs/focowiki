import { performance } from "node:perf_hooks";
import postgres from "postgres";
import { parseRuntimeConfig } from "../src/config.js";
import { createPostgresAdminRepositories } from "../src/db/admin-repositories.js";
import { createPostgresActiveGenerationReadRepository } from "../src/infrastructure/postgres/active-generation-read-repository.js";
import { hashPublicOpenApiKey } from "../src/public-openapi/keys.js";
import {
  createRedisClient,
  createRedisCoordinator,
  type RedisCommandClient
} from "../src/redis/coordination.js";
import { createAdminApiApp, createPublicOpenApiApp } from "../src/server.js";
import { createStorageKeyspace } from "../src/storage/keys.js";
import type { StorageAdapter } from "../src/storage/s3.js";

const KNOWLEDGE_BASE_ID = "kb-storage-reconciliation-evidence";
const READ_SOURCE_FILE_ID = "source-file-storage-reconciliation-read";
const READ_OBJECT_CHECKSUM = "0".repeat(64);
const READ_OPENAPI_KEY = `fwok_${"benchmark".repeat(6)}`;
const READ_CONTENT = "# Storage reconciliation benchmark\n\nRepresentative generated content.";

type HttpReadSample = {
  plane: "admin" | "developerOpenApi";
  operation: string;
  durationMs: number;
  ok: boolean;
};

type ParentMessage =
  | { type: "measure"; requestId: number }
  | { type: "close" };

const databaseUrl = readRequiredEnvironment("EVIDENCE_DATABASE_URL");
const redisUrl = readRequiredEnvironment("EVIDENCE_REDIS_URL");
const redisKeyPrefix = readRequiredEnvironment("EVIDENCE_REDIS_KEY_PREFIX");
const storagePrefix = readRequiredEnvironment("EVIDENCE_STORAGE_PREFIX");
const database = postgres(databaseUrl, { max: 10 });
const config = parseRuntimeConfig({
  APP_ENV: "development",
  ADMIN_USERNAME: "benchmark-admin",
  ADMIN_PASSWORD: "benchmark-admin-secret",
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  PUBLIC_BASE_URL: "https://benchmark.openapi.invalid",
  ADMIN_UI_PUBLIC_ORIGIN: "http://localhost:43100",
  ADMIN_API_PUBLIC_ORIGIN: "http://localhost:43000",
  PUBLIC_OPENAPI_PUBLIC_ORIGIN: "https://benchmark.openapi.invalid",
  ADMIN_TRUSTED_ORIGINS: "http://localhost:43100",
  ALLOWED_HOSTS: "localhost",
  S3_ENDPOINT: "https://benchmark.storage.invalid",
  S3_REGION: "us-east-1",
  S3_BUCKET: "benchmark",
  S3_ACCESS_KEY_ID: "benchmark-access",
  S3_SECRET_ACCESS_KEY: "benchmark-secret",
  S3_PREFIX: storagePrefix,
  S3_FORCE_PATH_STYLE: "true"
});
if (config.security) {
  config.security.rateLimits.adminApi.max = 100_000;
  config.security.rateLimits.publicOpenApi.max = 100_000;
}

const redisClient = createRedisClient(config, { disableReconnect: true });
redisClient.on("error", () => undefined);
await redisClient.connect();
const redis = createRedisCoordinator(
  redisClient as unknown as RedisCommandClient,
  { keyPrefix: redisKeyPrefix }
);
const repositories = createPostgresAdminRepositories(database);
const publicApiKeys = repositories.publicApiKeys;
if (!publicApiKeys) {
  throw new Error("Public OpenAPI key repository is unavailable");
}
await publicApiKeys.createPublicOpenApiKey({
  id: "openapi-key-storage-reconciliation-benchmark",
  name: "Storage reconciliation benchmark",
  keyHash: hashPublicOpenApiKey(READ_OPENAPI_KEY),
  keyPrefix: READ_OPENAPI_KEY.slice(0, 10),
  keySuffix: READ_OPENAPI_KEY.slice(-6),
  createdAt: new Date().toISOString()
});

const storage = createBenchmarkReadStorage(storagePrefix);
const services = {
  config,
  storage,
  redis,
  repositories,
  activeGenerationReads: createPostgresActiveGenerationReadRepository(database),
  logger: {
    error() {},
    warn() {},
    info() {},
    debug() {}
  }
};
const adminApp = createAdminApiApp(services);
const publicApp = createPublicOpenApiApp(services);
const login = await adminApp.request("http://localhost/admin/api/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username: "benchmark-admin",
    password: "benchmark-admin-secret"
  })
});
const sessionCookie = login.headers.get("set-cookie")?.split(";")[0];
if (login.status !== 200 || !sessionCookie) {
  throw new Error("Benchmark Admin session could not be created");
}

const requests = [
  {
    plane: "admin" as const,
    operation: "knowledge_base_list",
    path: "/admin/api/knowledge-bases?limit=10"
  },
  {
    plane: "admin" as const,
    operation: "source_file_list",
    path: `/admin/api/knowledge-bases/${KNOWLEDGE_BASE_ID}/source-files?limit=10`
  },
  {
    plane: "admin" as const,
    operation: "file_tree",
    path:
      `/admin/api/knowledge-bases/${KNOWLEDGE_BASE_ID}/files/tree`
      + "?parentPath=pages&limit=10"
  },
  {
    plane: "developerOpenApi" as const,
    operation: "knowledge_base_list",
    path: "/openapi/v2/knowledge-bases?limit=10"
  },
  {
    plane: "developerOpenApi" as const,
    operation: "source_file_list",
    path: `/openapi/v2/knowledge-bases/${KNOWLEDGE_BASE_ID}/source-files?limit=10`
  },
  {
    plane: "developerOpenApi" as const,
    operation: "file_tree",
    path:
      `/openapi/v2/knowledge-bases/${KNOWLEDGE_BASE_ID}/tree`
      + "?parentPath=pages&limit=10"
  },
  {
    plane: "developerOpenApi" as const,
    operation: "file_search",
    path:
      `/openapi/v2/knowledge-bases/${KNOWLEDGE_BASE_ID}/files/search`
      + "?query=benchmark&mode=hybrid&limit=10"
  },
  {
    plane: "developerOpenApi" as const,
    operation: "graph_overview",
    path: `/openapi/v2/knowledge-bases/${KNOWLEDGE_BASE_ID}/graph/overview`
  },
  {
    plane: "developerOpenApi" as const,
    operation: "file_metadata",
    path: `/openapi/v2/knowledge-bases/${KNOWLEDGE_BASE_ID}/files/${READ_SOURCE_FILE_ID}`
  },
  {
    plane: "developerOpenApi" as const,
    operation: "file_content",
    path:
      `/openapi/v2/knowledge-bases/${KNOWLEDGE_BASE_ID}/files`
      + `/${READ_SOURCE_FILE_ID}/content`
  }
];
const reportedReadFailures = new Set<string>();

process.on("message", (message: ParentMessage) => {
  void handleMessage(message);
});
process.send?.({ type: "ready" });

async function handleMessage(message: ParentMessage): Promise<void> {
  if (message.type === "close") {
    await close();
    process.exit(0);
  }
  if (message.type !== "measure") return;

  try {
    const samples = await Promise.all(
      requests.map(async (request): Promise<HttpReadSample> => {
        const startedAt = performance.now();
        const response = request.plane === "admin"
          ? await adminApp.request(`http://localhost${request.path}`, {
              headers: { cookie: sessionCookie }
            })
          : await publicApp.request(`http://localhost${request.path}`, {
              headers: { authorization: `Bearer ${READ_OPENAPI_KEY}` }
            });
        await response.arrayBuffer();
        if (response.status < 200 || response.status >= 300) {
          const failureKey = `${request.operation}:${response.status}`;
          if (!reportedReadFailures.has(failureKey)) {
            reportedReadFailures.add(failureKey);
            console.error(
              `HTTP evidence request failed: ${request.operation} (${response.status})`
            );
          }
        }
        return {
          plane: request.plane,
          operation: request.operation,
          durationMs: performance.now() - startedAt,
          ok: response.status >= 200 && response.status < 300
        };
      })
    );
    process.send?.({ type: "round", requestId: message.requestId, samples });
  } catch (error) {
    process.send?.({
      type: "error",
      requestId: message.requestId,
      message: error instanceof Error ? error.message : "HTTP evidence worker failed"
    });
  }
}

async function close(): Promise<void> {
  for await (const entry of redisClient.scanIterator({
    MATCH: `${redisKeyPrefix}:*`,
    COUNT: 100
  })) {
    const keys = Array.isArray(entry) ? entry : [entry];
    if (keys.length > 0) await redisClient.del(keys);
  }
  await redisClient.quit();
  await database.end({ timeout: 5 });
}

function createBenchmarkReadStorage(prefix: string): StorageAdapter {
  const keyspace = createStorageKeyspace(prefix);
  const readObjectKey =
    `${keyspace.prefix}/generated/v1/objects/00/${READ_OBJECT_CHECKSUM}`;
  return {
    keyspace,
    async putObject() {
      throw new Error("Benchmark storage is read-only");
    },
    async getObjectText(key) {
      return key === readObjectKey ? READ_CONTENT : null;
    }
  };
}

function readRequiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
