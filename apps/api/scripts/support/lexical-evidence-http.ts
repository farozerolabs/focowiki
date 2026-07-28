import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { RuntimeConfig } from "../../src/config.js";
import type { DatabaseClient } from "../../src/db/client.js";
import { createPostgresAdminRepositories } from "../../src/db/admin-repositories.js";
import type {
  ActiveGenerationReadRepository
} from "../../src/application/ports/active-generation-read-repository.js";
import { hashPublicOpenApiKey } from "../../src/public-openapi/keys.js";
import {
  createRedisClient,
  createRedisCoordinator
} from "../../src/redis/coordination.js";
import { createApiApp } from "../../src/server.js";
import type { StorageAdapter } from "../../src/storage/s3.js";
import type { RuntimeLogger } from "../../src/logger.js";
import {
  summarizeDurations,
  type DurationSummary
} from "./lexical-evidence-duration-summary.js";

type SearchBody = {
  generationId?: string;
  items?: Array<{ fileId?: string; path?: string; generationId?: string }>;
  nextCursor?: string | null;
  error?: { code?: string; message?: string };
};

type ContentBody = {
  content?: string;
  error?: { code?: string; message?: string };
};

const READ_SAMPLE_MIN_INTERVAL_MS = 500;

type ReadMeasurements = {
  admin: DurationSummary;
  developerOpenApi: DurationSummary;
  content: DurationSummary;
  statusCounts: {
    admin: Record<string, number>;
    developerOpenApi: Record<string, number>;
    content: Record<string, number>;
  };
  errorCodeCounts: {
    developerOpenApi: Record<string, number>;
    content: Record<string, number>;
  };
  statusesOk: boolean;
  contentStable: boolean;
  activeGenerationConsistent: boolean;
};

export type LexicalHttpEvidence = {
  security: {
    adminLoginAuthenticated: boolean;
    openApiUnauthorizedStatus: number;
    openApiUnauthorizedErrorCode: string | null;
    invalidCursorStatus: number;
    invalidCursorErrorCode: string | null;
  };
  cursor: {
    available: boolean;
    continuous: boolean;
    generationConsistent: boolean;
  };
  idleBefore: ReadMeasurements;
  idleAfter: ReadMeasurements;
  loaded: ReadMeasurements;
  acceptance: {
    indexedP95BoundMs: number;
    contentP95BoundMs: number;
    contentDriftEnforced: boolean;
    passed: boolean;
    failures: string[];
  };
};

export async function createLexicalHttpEvidenceHarness(input: {
  config: RuntimeConfig;
  sql: DatabaseClient;
  storage: StorageAdapter;
  activeGenerationReads: ActiveGenerationReadRepository;
  knowledgeBaseId: string;
  query: string;
  generatedFileId: string;
  keyPrefix: string;
  enforceContentDrift: boolean;
}) {
  const redisClient = createRedisClient(input.config, {
    disableReconnect: true
  });
  await redisClient.connect();
  const redis = createRedisCoordinator(redisClient, {
    keyPrefix: input.keyPrefix
  });
  const repositories = createPostgresAdminRepositories(input.sql);
  const rawKey = `fwok_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  await repositories.publicApiKeys!.createPublicOpenApiKey({
    id: `openapi-key-${randomUUID()}`,
    name: "Lexical evidence",
    keyHash: hashPublicOpenApiKey(rawKey),
    keyPrefix: rawKey.slice(0, 10),
    keySuffix: rawKey.slice(-6),
    createdAt: new Date().toISOString()
  });
  const app = createApiApp({
    config: input.config,
    storage: input.storage,
    redis,
    repositories,
    activeGenerationReads: input.activeGenerationReads,
    logger: silentLogger
  });
  const login = await app.request("/admin/api/login", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      username: input.config.admin.username,
      password: input.config.admin.password
    })
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? null;
  if (login.status !== 200 || cookie === null) {
    redisClient.destroy();
    throw new Error("Lexical HTTP evidence could not establish an Admin session");
  }

  const authorization = `Bearer ${rawKey}`;
  const searchPath = `/openapi/v2/knowledge-bases/${input.knowledgeBaseId}`
    + `/files/search?query=${encodeURIComponent(input.query)}&mode=hybrid&limit=1`;
  const contentPath = `/openapi/v2/knowledge-bases/${input.knowledgeBaseId}`
    + `/files/${encodeURIComponent(input.generatedFileId)}/content`;
  const cursorPath = `/openapi/v2/knowledge-bases/${input.knowledgeBaseId}`
    + "/tree?parentPath=pages%2Fevidence&limit=1";
  const adminPath = "/admin/api/knowledge-bases?limit=20";
  const security = await readSecurityEvidence();
  const cursor = await readCursorEvidence();
  const idleBefore = await measureFixedLoad(4, 32);

  return {
    async measureLoaded(operation: Promise<unknown>): Promise<LexicalHttpEvidence> {
      const loaded = await measureWhileRunning(operation);
      const idleAfter = await measureFixedLoad(4, 32);
      const failures: string[] = [];
      const { indexedP95BoundMs, contentP95BoundMs } =
        calculateLexicalReadAcceptanceBounds({
          idleBefore: {
            adminP95Ms: idleBefore.admin.p95Ms,
            developerOpenApiP95Ms: idleBefore.developerOpenApi.p95Ms,
            contentP95Ms: idleBefore.content.p95Ms
          },
          idleAfter: {
            adminP95Ms: idleAfter.admin.p95Ms,
            developerOpenApiP95Ms: idleAfter.developerOpenApi.p95Ms,
            contentP95Ms: idleAfter.content.p95Ms
          }
        });
      if (!idleBefore.statusesOk || !idleAfter.statusesOk || !loaded.statusesOk) {
        failures.push("Admin, Developer OpenAPI, or content reads returned a non-success status");
      }
      if (
        !idleBefore.contentStable
        || !idleAfter.contentStable
        || !loaded.contentStable
      ) {
        failures.push("Content reads changed while lexical work was active");
      }
      if (
        !idleBefore.activeGenerationConsistent
        || !idleAfter.activeGenerationConsistent
        || !loaded.activeGenerationConsistent
      ) {
        failures.push("Developer OpenAPI reads mixed active generations");
      }
      if (
        loaded.admin.p95Ms > indexedP95BoundMs
        || loaded.developerOpenApi.p95Ms > indexedP95BoundMs
      ) {
        failures.push("Indexed read p95 exceeded the lexical-load acceptance bound");
      }
      if (input.enforceContentDrift && loaded.content.p95Ms > contentP95BoundMs) {
        failures.push("Content read p95 regressed by more than 20 percent");
      }
      if (
        !security.adminLoginAuthenticated
        || security.openApiUnauthorizedStatus !== 401
        || security.openApiUnauthorizedErrorCode === null
        || security.invalidCursorStatus < 400
        || security.invalidCursorStatus >= 500
        || security.invalidCursorErrorCode === null
      ) {
        failures.push("Authentication or stable error-envelope validation failed");
      }
      if (!cursor.available || !cursor.continuous || !cursor.generationConsistent) {
        failures.push("Developer OpenAPI cursor continuity validation failed");
      }
      return {
        security,
        cursor,
        idleBefore,
        idleAfter,
        loaded,
        acceptance: {
          indexedP95BoundMs: round(indexedP95BoundMs),
          contentP95BoundMs: round(contentP95BoundMs),
          contentDriftEnforced: input.enforceContentDrift,
          passed: failures.length === 0,
          failures
        }
      };
    },
    async close(): Promise<void> {
      for await (const page of redisClient.scanIterator({
        MATCH: `${input.keyPrefix}:*`,
        COUNT: 100
      })) {
        const keys = Array.isArray(page) ? page : [page];
        for (const key of keys) await redisClient.del(key);
      }
      redisClient.destroy();
    }
  };

  async function readSecurityEvidence() {
    const unauthorized = await app.request(searchPath);
    const unauthorizedBody = await readJson<SearchBody>(unauthorized);
    const invalidCursor = await app.request(`${searchPath}&cursor=invalid`, {
      headers: { authorization }
    });
    const invalidCursorBody = await readJson<SearchBody>(invalidCursor);
    return {
      adminLoginAuthenticated: login.status === 200,
      openApiUnauthorizedStatus: unauthorized.status,
      openApiUnauthorizedErrorCode: unauthorizedBody.error?.code ?? null,
      invalidCursorStatus: invalidCursor.status,
      invalidCursorErrorCode: invalidCursorBody.error?.code ?? null
    };
  }

  async function readCursorEvidence() {
    const firstResponse = await app.request(cursorPath, {
      headers: { authorization }
    });
    const first = await readJson<SearchBody>(firstResponse);
    const cursorValue = first.nextCursor ?? null;
    if (firstResponse.status !== 200 || !cursorValue) {
      return {
        available: false,
        continuous: false,
        generationConsistent: false
      };
    }
    const secondResponse = await app.request(
      `${cursorPath}&cursor=${encodeURIComponent(cursorValue)}`,
      { headers: { authorization } }
    );
    const second = await readJson<SearchBody>(secondResponse);
    const firstId = itemIdentity(first.items?.[0]);
    const secondId = itemIdentity(second.items?.[0]);
    return {
      available: true,
      continuous: secondResponse.status === 200
        && firstId !== null
        && secondId !== null
        && firstId !== secondId,
      generationConsistent: first.generationId !== undefined
        && first.generationId === second.generationId
    };
  }

  async function measureWhileRunning(operation: Promise<unknown>) {
    let complete = false;
    void operation.finally(() => {
      complete = true;
    });
    const lanes = await Promise.all(Array.from({ length: 4 }, async () => {
      const measurements: ReadSample[] = [];
      do {
        measurements.push(await readOneSample());
      } while (!complete);
      return measurements;
    }));
    return summarizeReadSamples(lanes.flat());
  }

  async function measureFixedLoad(lanes: number, samplesPerLane: number) {
    const samples = await Promise.all(
      Array.from({ length: lanes }, async () => {
        const laneSamples: ReadSample[] = [];
        for (let index = 0; index < samplesPerLane; index += 1) {
          laneSamples.push(await readOneSample());
        }
        return laneSamples;
      })
    );
    return summarizeReadSamples(samples.flat());
  }

  async function readOneSample(): Promise<ReadSample> {
    const sampleStartedAt = performance.now();
    let startedAt = performance.now();
    const adminResponse = await app.request(adminPath, {
      headers: { cookie: cookie! }
    });
    await adminResponse.arrayBuffer();
    const adminMs = performance.now() - startedAt;

    startedAt = performance.now();
    const openApiResponse = await app.request(searchPath, {
      headers: { authorization }
    });
    const openApiBody = await readJson<SearchBody>(openApiResponse);
    const developerOpenApiMs = performance.now() - startedAt;

    startedAt = performance.now();
    const contentResponse = await app.request(contentPath, {
      headers: { authorization }
    });
    const contentBody = await readJson<ContentBody>(contentResponse);
    const contentMs = performance.now() - startedAt;
    const sample = {
      adminMs,
      developerOpenApiMs,
      contentMs,
      statusesOk: adminResponse.status === 200
        && openApiResponse.status === 200
        && contentResponse.status === 200,
      statuses: {
        admin: adminResponse.status,
        developerOpenApi: openApiResponse.status,
        content: contentResponse.status
      },
      errorCodes: {
        developerOpenApi: openApiBody.error?.code ?? null,
        content: contentBody.error?.code ?? null
      },
      generationConsistent: isSearchResponseGenerationConsistent(openApiBody),
      contentChecksum: typeof contentBody.content === "string"
        ? createHash("sha256").update(contentBody.content).digest("hex")
        : null
    };
    const delayMs = calculateRemainingReadSampleDelay({
      startedAtMs: sampleStartedAt,
      completedAtMs: performance.now(),
      minimumIntervalMs: READ_SAMPLE_MIN_INTERVAL_MS
    });
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    return sample;
  }
}

export function calculateLexicalReadAcceptanceBounds(input: {
  idleBefore: {
    adminP95Ms: number;
    developerOpenApiP95Ms: number;
    contentP95Ms: number;
  };
  idleAfter: {
    adminP95Ms: number;
    developerOpenApiP95Ms: number;
    contentP95Ms: number;
  };
}): { indexedP95BoundMs: number; contentP95BoundMs: number } {
  return {
    indexedP95BoundMs: Math.max(
      250,
      input.idleBefore.adminP95Ms * 1.1,
      input.idleBefore.developerOpenApiP95Ms * 1.1,
      input.idleAfter.adminP95Ms * 1.1,
      input.idleAfter.developerOpenApiP95Ms * 1.1
    ),
    contentP95BoundMs: Math.max(
      input.idleBefore.contentP95Ms,
      input.idleAfter.contentP95Ms
    ) * 1.2
  };
}

const silentLogger: RuntimeLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {}
};

type ReadSample = {
  adminMs: number;
  developerOpenApiMs: number;
  contentMs: number;
  statusesOk: boolean;
  statuses: {
    admin: number;
    developerOpenApi: number;
    content: number;
  };
  errorCodes: {
    developerOpenApi: string | null;
    content: string | null;
  };
  generationConsistent: boolean;
  contentChecksum: string | null;
};

function summarizeReadSamples(samples: ReadSample[]): ReadMeasurements {
  const checksums = new Set(samples.map((sample) => sample.contentChecksum));
  return {
    admin: summarizeDurations(samples.map((sample) => sample.adminMs)),
    developerOpenApi: summarizeDurations(
      samples.map((sample) => sample.developerOpenApiMs)
    ),
    content: summarizeDurations(samples.map((sample) => sample.contentMs)),
    statusCounts: {
      admin: countValues(samples.map((sample) => String(sample.statuses.admin))),
      developerOpenApi: countValues(
        samples.map((sample) => String(sample.statuses.developerOpenApi))
      ),
      content: countValues(samples.map((sample) => String(sample.statuses.content)))
    },
    errorCodeCounts: {
      developerOpenApi: countValues(
        samples.flatMap((sample) =>
          sample.errorCodes.developerOpenApi
            ? [sample.errorCodes.developerOpenApi]
            : []
        )
      ),
      content: countValues(
        samples.flatMap((sample) =>
          sample.errorCodes.content ? [sample.errorCodes.content] : []
        )
      )
    },
    statusesOk: samples.length > 0 && samples.every((sample) => sample.statusesOk),
    contentStable: checksums.size === 1 && !checksums.has(null),
    activeGenerationConsistent: samples.length > 0
      && samples.every((sample) => sample.generationConsistent)
  };
}

export function isSearchResponseGenerationConsistent(input: {
  generationId?: string;
  items?: Array<{ generationId?: string; [key: string]: unknown }>;
}): boolean {
  if (!input.generationId) return false;
  return (input.items ?? []).every((item) =>
    item.generationId === undefined || item.generationId === input.generationId
  );
}

export function calculateRemainingReadSampleDelay(input: {
  startedAtMs: number;
  completedAtMs: number;
  minimumIntervalMs: number;
}): number {
  return Math.max(
    0,
    input.minimumIntervalMs - (input.completedAtMs - input.startedAtMs)
  );
}

function itemIdentity(
  item: { fileId?: string; path?: string } | undefined
): string | null {
  return item?.fileId ?? item?.path ?? null;
}

function countValues(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
