import type { RuntimeConfig } from "../config.js";
import { closeDatabaseClient, createDatabaseClient } from "../db/client.js";
import { assertRuntimeSchemaGeneration } from "../db/migrations.js";
import {
  createRuntimeMeilisearchTransport
} from "../infrastructure/meilisearch/runtime-meilisearch-transport.js";
import { createRedisClient } from "../redis/coordination.js";
import { assertDeploymentSecret } from "../security/runtime-secrets.js";
import { createS3StorageAdapter } from "../storage/s3.js";

type DeploymentHealthcheckRole =
  | "api"
  | "source-worker"
  | "publication-worker"
  | "maintenance-worker";

type DeploymentDependencyHealthcheck = {
  assertDeploymentSecret: () => void;
  assertTokenizer?: (() => void) | undefined;
  database: {
    check: () => Promise<void>;
    close: () => Promise<void>;
  };
  redis: {
    connect: () => Promise<unknown>;
    ping: () => Promise<unknown>;
    close: () => Promise<unknown>;
  };
  checkStorage: () => Promise<void>;
  checkSearch: () => Promise<void>;
  checkRole?: (() => Promise<void>) | undefined;
};

export async function runDeploymentDependencyHealthcheck(
  dependencies: DeploymentDependencyHealthcheck
): Promise<void> {
  let redisConnected = false;
  try {
    dependencies.assertDeploymentSecret();
    dependencies.assertTokenizer?.();
    await dependencies.database.check();
    await dependencies.redis.connect();
    redisConnected = true;
    await dependencies.redis.ping();
    await dependencies.checkStorage();
    await dependencies.checkSearch();
    await dependencies.checkRole?.();
  } finally {
    try {
      if (redisConnected) await dependencies.redis.close();
    } finally {
      await dependencies.database.close();
    }
  }
}

export async function runRuntimeDeploymentHealthcheck(
  config: RuntimeConfig,
  options: {
    role: DeploymentHealthcheckRole;
    assertTokenizer?: (() => void) | undefined;
    httpPorts?: readonly number[] | undefined;
    fetch?: typeof globalThis.fetch | undefined;
  }
): Promise<void> {
  const sql = createDatabaseClient(config, { role: options.role });
  const redis = createRedisClient(config, { disableReconnect: true });
  const storage = createS3StorageAdapter(config.storage);
  const searchConfig = config.search;

  await runDeploymentDependencyHealthcheck({
    assertDeploymentSecret,
    assertTokenizer: options.assertTokenizer,
    database: {
      async check() {
        await assertRuntimeSchemaGeneration(sql);
        await sql`SELECT 1 AS ready`;
      },
      async close() {
        await closeDatabaseClient(sql);
      }
    },
    redis: {
      connect: () => redis.connect(),
      ping: () => redis.ping(),
      close: () => redis.close()
    },
    async checkStorage() {
      if (!storage.checkHealth) {
        throw new Error("Object storage health check is unavailable");
      }
      await storage.checkHealth();
    },
    async checkSearch() {
      if (!searchConfig) {
        throw new Error("Search service configuration is unavailable");
      }
      const search = createRuntimeMeilisearchTransport(searchConfig, {
        timeoutMs: 5_000,
        maxAttempts: 1,
        retryDelayMs: 0
      });
      if (!(await search.health()).available) {
        throw new Error("Search service health check failed");
      }
    },
    ...(options.httpPorts
      ? {
          checkRole: () => checkHttpHealthEndpoints(
            options.httpPorts!,
            options.fetch ?? globalThis.fetch
          )
        }
      : {})
  });
}

async function checkHttpHealthEndpoints(
  ports: readonly number[],
  fetchImpl: typeof globalThis.fetch
): Promise<void> {
  for (const port of ports) {
    const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(5_000)
    });
    const body = await response.json().catch(() => null) as {
      status?: unknown;
    } | null;
    if (!response.ok || body?.status !== "ok") {
      throw new Error(`Runtime HTTP health check failed for port ${port}`);
    }
  }
}
