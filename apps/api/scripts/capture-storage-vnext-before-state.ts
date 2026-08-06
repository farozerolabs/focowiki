import { execFile } from "node:child_process";
import {
  readdir,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";
import { promisify } from "node:util";
import {
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Meilisearch } from "meilisearch";
import postgres from "postgres";
import { createClient } from "redis";
import { validateStorageVnextOwnedScopeProof } from
  "../src/storage-vnext/bootstrap/owned-scope.js";

const execFileAsync = promisify(execFile);
const phase = (process.env.FOCOWIKI_STORAGE_VNEXT_STATE_PHASE ?? "before").trim();
if (phase !== "before" && phase !== "after") {
  throw new Error("FOCOWIKI_STORAGE_VNEXT_STATE_PHASE must be before or after");
}
const proofPath = requiredEnvironment("FOCOWIKI_STORAGE_VNEXT_PROOF_FILE");
const manifest = JSON.parse(await readFile(proofPath, "utf8")) as {
  version: number;
  proof: Parameters<typeof validateStorageVnextOwnedScopeProof>[0];
  immutableControls?: unknown;
};
if (manifest.version !== 1) throw new Error("Unsupported owned-scope proof version");
const proof = validateStorageVnextOwnedScopeProof(manifest.proof);
const databaseUrl = requiredEnvironment("DATABASE_URL");
assertExactRuntimeScope();

const sql = postgres(databaseUrl, { max: 2, prepare: false });
const redis = createClient({
  url: requiredEnvironment("REDIS_URL"),
  socket: { reconnectStrategy: false }
});
const s3 = new S3Client({
  endpoint: requiredEnvironment("S3_ENDPOINT"),
  region: requiredEnvironment("S3_REGION"),
  credentials: {
    accessKeyId: requiredEnvironment("S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnvironment("S3_SECRET_ACCESS_KEY")
  },
  forcePathStyle: parseBooleanEnvironment("S3_FORCE_PATH_STYLE")
});
const meilisearch = new Meilisearch({
  host: requiredEnvironment("MEILI_HOST"),
  apiKey: requiredEnvironment("MEILI_API_KEY"),
  timeout: 10_000
});

try {
  await redis.connect();
  const [postgresState, redisState, s3State, meilisearchState, logs, processes, services] =
    await Promise.all([
      capturePostgres(),
      captureRedis(),
      captureS3(),
      captureMeilisearch(),
      captureLogs(),
      captureProcesses(),
      captureServices()
    ]);
  const state = {
    kind: `focowiki-storage-vnext-${phase}-state`,
    version: 1,
    runId: proof.runId,
    capturedAt: new Date().toISOString(),
    scope: {
      postgres: proof.postgresScope,
      object: proof.objectScope,
      search: proof.searchScope,
      coordination: proof.coordinationScope
    },
    immutableControls: manifest.immutableControls ?? null,
    postgres: postgresState,
    redis: redisState,
    s3: s3State,
    meilisearch: meilisearchState,
    logs,
    processes,
    services
  };
  const outputPath = `${proof.filesystemScope}/${phase}-state.json`;
  await writeFile(outputPath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx"
  });
  process.stdout.write(`${JSON.stringify({
    outputPath,
    phase,
    runId: proof.runId,
    knowledgeBaseCount: postgresState.counts.knowledgeBases,
    postgresBytes: postgresState.databaseBytes,
    redisKeys: redisState.totalKeys,
    s3Versions: s3State.versionCount,
    s3Bytes: s3State.totalBytes,
    meilisearchIndexes: meilisearchState.indexCount,
    meilisearchTasks: meilisearchState.taskCount,
    logBytes: logs.totalBytes,
    processCount: processes.length,
    healthyServices: services.filter((service) => service.healthy).length
  }, null, 2)}\n`);
} finally {
  await Promise.allSettled([
    sql.end({ timeout: 5 }),
    redis.isOpen ? redis.quit() : Promise.resolve()
  ]);
  s3.destroy();
}

async function capturePostgres() {
  const [counts, databaseBytes, tableRows, connections, knowledgeBases, runtimeSettings] =
    await Promise.all([
      sql<Array<{
        knowledgeBases: number;
        sourceFiles: number;
        operations: number;
        workItems: number;
        objectRegistrations: number;
        releaseRoots: number;
        searchProjections: number;
      }>>`
        SELECT
          (SELECT count(*)::integer FROM focowiki.knowledge_bases) AS "knowledgeBases",
          (SELECT count(*)::integer FROM focowiki.source_files) AS "sourceFiles",
          (SELECT count(*)::integer FROM focowiki.operations) AS "operations",
          (SELECT count(*)::integer FROM focowiki.operation_work_items) AS "workItems",
          (SELECT count(*)::integer FROM focowiki.object_registrations) AS "objectRegistrations",
          (SELECT count(*)::integer FROM focowiki.release_roots) AS "releaseRoots",
          (SELECT count(*)::integer FROM focowiki.search_projections) AS "searchProjections"
      `,
      sql<Array<{ bytes: number }>>`
        SELECT pg_database_size(current_database())::float8 AS bytes
      `,
      sql<Array<{ table: string; estimatedRows: number; totalBytes: number }>>`
        SELECT relname AS table,
               n_live_tup::float8 AS "estimatedRows",
               pg_total_relation_size(relid)::float8 AS "totalBytes"
        FROM pg_stat_user_tables
        WHERE schemaname IN ('focowiki', 'focowiki_validation')
        ORDER BY schemaname, relname
      `,
      sql<Array<{ state: string; applicationName: string; count: number }>>`
        SELECT coalesce(state, 'background') AS state,
               coalesce(application_name, '') AS "applicationName",
               count(*)::integer AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
        GROUP BY state, application_name
        ORDER BY state, application_name
      `,
      sql<Array<{ id: string; revision: number; deletedAt: string | null }>>`
        SELECT public_id AS id, revision,
               deleted_at AS "deletedAt"
        FROM focowiki.knowledge_bases
        ORDER BY public_id
      `,
      sql<Array<{ id: string; checksumSha256: string; createdAt: string }>>`
        SELECT revision.public_id AS id,
               revision.checksum_sha256 AS "checksumSha256",
               revision.created_at AS "createdAt"
        FROM focowiki.runtime_setting_current current
        JOIN focowiki.runtime_setting_revisions revision
          ON revision.public_id = current.revision_public_id
        WHERE current.singleton = true
      `
    ]);
  return {
    counts: counts[0]!,
    databaseBytes: databaseBytes[0]?.bytes ?? 0,
    tableRows,
    connections,
    knowledgeBases,
    runtimeSettings
  };
}

async function captureRedis() {
  const keys: Array<{ key: string; type: string; ttlSeconds: number; bytes: number }> = [];
  for await (const result of redis.scanIterator({ MATCH: "*", COUNT: 500 })) {
    for (const key of Array.isArray(result) ? result : [result]) {
      const [type, ttlSeconds, bytes] = await Promise.all([
        redis.type(key),
        redis.ttl(key),
        redis.memoryUsage(key)
      ]);
      keys.push({ key, type, ttlSeconds, bytes: bytes ?? 0 });
    }
  }
  keys.sort((left, right) => left.key.localeCompare(right.key));
  const memoryInfo = await redis.info("memory");
  return {
    totalKeys: keys.length,
    totalKeyBytes: keys.reduce((total, entry) => total + entry.bytes, 0),
    usedMemoryBytes: parseRedisInfoNumber(memoryInfo, "used_memory"),
    keys
  };
}

async function captureS3() {
  const versions: Array<{
    key: string;
    versionId: string;
    size: number;
    isLatest: boolean;
    deleteMarker: boolean;
  }> = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({
      Bucket: requiredEnvironment("S3_BUCKET"),
      Prefix: proof.objectScope,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
      MaxKeys: 1_000
    }));
    for (const entry of page.Versions ?? []) {
      if (!entry.Key || !entry.VersionId) continue;
      versions.push({
        key: entry.Key,
        versionId: entry.VersionId,
        size: entry.Size ?? 0,
        isLatest: entry.IsLatest === true,
        deleteMarker: false
      });
    }
    for (const entry of page.DeleteMarkers ?? []) {
      if (!entry.Key || !entry.VersionId) continue;
      versions.push({
        key: entry.Key,
        versionId: entry.VersionId,
        size: 0,
        isLatest: entry.IsLatest === true,
        deleteMarker: true
      });
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker);

  const multipartUploads: Array<{ key: string; uploadId: string }> = [];
  let uploadKeyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  do {
    const page = await s3.send(new ListMultipartUploadsCommand({
      Bucket: requiredEnvironment("S3_BUCKET"),
      Prefix: proof.objectScope,
      KeyMarker: uploadKeyMarker,
      UploadIdMarker: uploadIdMarker,
      MaxUploads: 1_000
    }));
    for (const upload of page.Uploads ?? []) {
      if (upload.Key && upload.UploadId) {
        multipartUploads.push({ key: upload.Key, uploadId: upload.UploadId });
      }
    }
    uploadKeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (uploadKeyMarker);
  return {
    versionCount: versions.length,
    totalBytes: versions.reduce((total, version) => total + version.size, 0),
    deleteMarkerCount: versions.filter((version) => version.deleteMarker).length,
    multipartUploadCount: multipartUploads.length,
    versions,
    multipartUploads
  };
}

async function captureMeilisearch() {
  const indexes: string[] = [];
  let offset = 0;
  do {
    const page = await meilisearch.getRawIndexes({ offset, limit: 1_000 });
    indexes.push(...page.results.map((index) => index.uid));
    offset += page.results.length;
    if (offset >= page.total) break;
    if (page.results.length === 0) {
      throw new Error("Meilisearch index inventory pagination is incomplete");
    }
  } while (true);
  const [tasks, stats] = await Promise.all([
    meilisearch.tasks.getTasks({ limit: 1_000 }),
    meilisearch.getStats()
  ]);
  return {
    indexCount: indexes.length,
    indexes: indexes.sort(),
    taskCount: tasks.total,
    tasks: tasks.results.map((task) => ({
      uid: task.uid,
      status: task.status,
      type: task.type,
      indexUid: task.indexUid
    })),
    databaseBytes: stats.databaseSize,
    usedDatabaseBytes: stats.usedDatabaseSize
  };
}

async function captureLogs() {
  const directory = requiredEnvironment("LOG_FILE_DIR");
  const files = await listFiles(directory);
  return {
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    files
  };
}

async function captureProcesses() {
  const services = parseServicePids(
    requiredEnvironment("FOCOWIKI_STORAGE_VNEXT_SERVICE_PIDS")
  );
  const pids = services.map((service) => service.pid);
  const { stdout } = await execFileAsync("ps", [
    "-o",
    "pid=,ppid=,%cpu=,rss=,etime=",
    "-p",
    pids.join(",")
  ]);
  const metrics = new Map<number, {
    parentPid: number;
    cpuPercent: number;
    rssBytes: number;
    elapsed: string;
  }>();
  for (const line of stdout.trim().split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*$/u.exec(line);
    if (!match) continue;
    metrics.set(Number(match[1]), {
      parentPid: Number(match[2]),
      cpuPercent: Number(match[3]),
      rssBytes: Number(match[4]) * 1_024,
      elapsed: match[5]!
    });
  }
  return Promise.all(services.map(async (service) => {
    const metric = metrics.get(service.pid);
    if (!metric) throw new Error(`Validation service is not running: ${service.name}`);
    const { stdout: lsof } = await execFileAsync("lsof", ["-nP", "-p", String(service.pid)]);
    const lines = lsof.trim().split("\n").slice(1);
    return {
      name: service.name,
      pid: service.pid,
      ...metric,
      handleCount: lines.length,
      networkConnectionCount: lines.filter((line) => /\s(?:TCP|UDP)\s/u.test(line)).length
    };
  }));
}

async function captureServices() {
  const definitions = [
    ["admin-api", `http://127.0.0.1:${process.env.ADMIN_API_PORT ?? "43000"}/healthz`],
    ["developer-openapi", `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT ?? "43200"}/healthz`],
    ["admin-ui", `http://127.0.0.1:${process.env.ADMIN_UI_PORT ?? "43100"}/`],
    ["s3", `${requiredEnvironment("S3_ENDPOINT")}/minio/health/live`],
    ["meilisearch", `${requiredEnvironment("MEILI_HOST")}/health`]
  ] as const;
  return Promise.all(definitions.map(async ([name, url]) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return { name, healthy: response.ok, status: response.status };
    } catch {
      return { name, healthy: false, status: null };
    }
  }));
}

async function listFiles(root: string) {
  const files: Array<{ name: string; bytes: number }> = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile()) {
        files.push({ name: relativePath, bytes: (await stat(absolutePath)).size });
      }
    }
  }
  await visit(root, "");
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

function parseServicePids(value: string): Array<{ name: string; pid: number }> {
  const services = value.split(",").map((entry) => {
    const [name, rawPid, ...rest] = entry.split("=");
    const pid = Number(rawPid);
    if (
      rest.length > 0
      || !name
      || !/^[a-z][a-z0-9-]*$/u.test(name)
      || !Number.isSafeInteger(pid)
      || pid < 1
    ) throw new Error("Service PID inventory is invalid");
    return { name, pid };
  });
  if (new Set(services.map((service) => service.name)).size !== services.length) {
    throw new Error("Service PID names must be unique");
  }
  return services;
}

function parseRedisInfoNumber(value: string, field: string): number {
  const match = new RegExp(`(?:^|\\r?\\n)${field}:(\\d+)(?:\\r?\\n|$)`, "u").exec(value);
  if (!match) throw new Error(`Redis INFO field is unavailable: ${field}`);
  return Number(match[1]);
}

function assertExactRuntimeScope(): void {
  const url = new URL(databaseUrl);
  if (
    decodeURIComponent(url.pathname.replace(/^\//u, "")) !== proof.postgresScope
    || `${requiredEnvironment("S3_PREFIX").replace(/^\/+|\/+$/gu, "")}/`
      !== proof.objectScope
    || requiredEnvironment("MEILI_INDEX_PREFIX") !== proof.searchScope
    || !proofPath.startsWith(`${proof.filesystemScope}/`)
  ) throw new Error("Runtime environment does not match the exact owned-scope proof");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseBooleanEnvironment(name: string): boolean {
  const value = requiredEnvironment(name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}
