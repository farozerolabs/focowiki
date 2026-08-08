import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

const RUNTIME_ENTRYPOINT = /\/apps\/api\/runtime\/(?:main|source-worker|publication-worker|maintenance-worker)\.mjs\b/u;

export function parseOkfV02ProcessResourceSnapshot(output) {
  let cpuPercent = 0;
  let rssBytes = 0;
  let processCount = 0;
  for (const line of String(output).split("\n")) {
    const match = line.match(/^\s*([0-9]+(?:\.[0-9]+)?)\s+(\d+)\s+(.+)$/u);
    if (!match || !RUNTIME_ENTRYPOINT.test(match[3])) continue;
    cpuPercent += Number(match[1]);
    rssBytes += Number(match[2]) * 1024;
    processCount += 1;
  }
  return Object.freeze({ cpuPercent, rssBytes, processCount });
}

export function parseOkfV02ContainerResourceSnapshot(output) {
  let cpuPercent = 0;
  let rssBytes = 0;
  let containerCount = 0;
  for (const line of String(output).split("\n")) {
    const match = line.match(/^\s*([0-9]+(?:\.[0-9]+)?)%\s+([^/]+)\//u);
    if (!match) continue;
    cpuPercent += Number(match[1]);
    rssBytes += parseByteSize(match[2].trim());
    containerCount += 1;
  }
  return Object.freeze({ cpuPercent, rssBytes, containerCount });
}

export function combineOkfV02ResourceSnapshots(processes, containers) {
  return Object.freeze({
    cpuPercent: processes.cpuPercent + containers.cpuPercent,
    rssBytes: processes.rssBytes + containers.rssBytes,
    processCount: processes.processCount + containers.containerCount
  });
}

export function createOkfV02ResourceSampler(input) {
  assert.equal(typeof input?.capture, "function", "OKF 0.2 resource capture is required.");
  assert(Number.isSafeInteger(input.intervalMs) && input.intervalMs > 0);
  const samples = [];
  let timer = null;
  let captureChain = Promise.resolve();
  let failure = null;
  let startedAt = null;

  function capture() {
    captureChain = captureChain.then(async () => {
      if (failure) return;
      try {
        samples.push(validateResourceSample(await input.capture()));
      } catch (error) {
        failure = error;
      }
    });
    return captureChain;
  }

  return {
    async start() {
      assert.equal(startedAt, null, "OKF 0.2 resource sampler already started.");
      startedAt = Date.now();
      await capture();
      if (failure) throw failure;
      timer = setInterval(() => void capture(), input.intervalMs);
      timer.unref();
    },
    async stop() {
      assert.notEqual(startedAt, null, "OKF 0.2 resource sampler was not started.");
      clearInterval(timer);
      await capture();
      if (failure) throw failure;
      assert(samples.length >= 2, "OKF 0.2 resource sampler needs two samples.");
      return Object.freeze({
        sampleCount: samples.length,
        maximumCpuPercent: Math.max(...samples.map((sample) => sample.cpuPercent)),
        maximumRssBytes: Math.max(...samples.map((sample) => sample.rssBytes)),
        maximumProcessCount: Math.max(...samples.map((sample) => sample.processCount)),
        elapsedMs: Math.max(0, Date.now() - startedAt)
      });
    }
  };
}

export function summarizeOkfV02NoopPublication(input) {
  const stableRelease = input.before.activeReleaseId === input.after.activeReleaseId
    && input.before.manifestChecksum === input.after.manifestChecksum;
  assert(stableRelease, "No-op publication created a redundant active release.");
  assert.equal(
    input.beforeGenerated,
    input.afterGenerated,
    "No-op publication changed generated timestamps or bytes."
  );
  const stableS3 = input.before.s3ObjectCount === input.after.s3ObjectCount
    && input.before.s3VersionCount === input.after.s3VersionCount
    && input.before.s3TotalBytes === input.after.s3TotalBytes
    && input.before.s3Fingerprint === input.after.s3Fingerprint;
  assert(stableS3, "No-op publication rewrote immutable S3 objects.");
  const stableSearch = input.before.searchDocumentChecksum
      === input.after.searchDocumentChecksum
    && input.before.searchDocumentCount === input.after.searchDocumentCount
    && input.before.searchLastBatchChecksum === input.after.searchLastBatchChecksum;
  assert(stableSearch, "No-op publication changed the active search projection.");
  assert(Number.isFinite(input.maximumCpuPercent) && input.maximumCpuPercent <= 400,
    "No-op publication caused an unexpected CPU spike.");
  assert(Number.isSafeInteger(input.elapsedMs) && input.elapsedMs >= 0);
  return Object.freeze({
    activeReleaseStable: true,
    generatedBytesStable: true,
    s3ObjectsStable: true,
    searchChecksumStable: true,
    elapsedMs: input.elapsedMs,
    maximumCpuPercent: input.maximumCpuPercent
  });
}

export function createOkfV02StoreObserver(input) {
  const apiRequire = input.apiRequire ?? createRequire(path.resolve("apps/api/package.json"));
  const postgres = apiRequire("postgres");
  const { createClient } = apiRequire("redis");
  const {
    ListObjectsV2Command,
    ListObjectVersionsCommand,
    S3Client
  } = apiRequire("@aws-sdk/client-s3");
  const sql = postgres(input.env.DATABASE_URL, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10
  });
  const redis = createClient({ url: input.env.REDIS_URL });
  redis.on("error", () => undefined);
  const s3 = new S3Client({
    endpoint: input.env.S3_ENDPOINT,
    region: input.env.S3_REGION,
    forcePathStyle: input.env.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: input.env.S3_ACCESS_KEY_ID,
      secretAccessKey: input.env.S3_SECRET_ACCESS_KEY
    }
  });
  let redisConnected = false;

  return {
    async capture(knowledgeBaseId) {
      assert.equal(typeof knowledgeBaseId, "string");
      if (!redisConnected) {
        await redis.connect();
        redisConnected = true;
      }
      const [database, databaseStats, redisStats, redisMemory, s3State] = await Promise.all([
        captureDatabase(sql, knowledgeBaseId),
        sql`
          SELECT (xact_commit + xact_rollback)::bigint AS transactions,
                 numbackends::bigint AS connections
          FROM pg_stat_database
          WHERE datname = current_database()
        `,
        redis.info("stats"),
        redis.info("memory"),
        captureS3({
          client: s3,
          bucket: input.env.S3_BUCKET,
          prefix: `${input.env.S3_PREFIX}/generated-objects/`,
          ListObjectsV2Command,
          ListObjectVersionsCommand
        })
      ]);
      const stats = databaseStats[0] ?? {};
      return Object.freeze({
        ...database,
        ...s3State,
        postgresTransactions: safeInteger(stats.transactions),
        postgresConnections: safeInteger(stats.connections),
        redisCommandsProcessed: readRedisInteger(redisStats, "total_commands_processed"),
        redisUsedMemoryBytes: readRedisInteger(redisMemory, "used_memory")
      });
    },
    async close() {
      await Promise.allSettled([
        sql.end({ timeout: 5 }),
        redisConnected ? redis.quit() : Promise.resolve(),
        Promise.resolve(s3.destroy())
      ]);
      redisConnected = false;
    }
  };
}

function validateResourceSample(sample) {
  assert(Number.isFinite(sample?.cpuPercent) && sample.cpuPercent >= 0);
  assert(Number.isSafeInteger(sample?.rssBytes) && sample.rssBytes >= 0);
  assert(Number.isSafeInteger(sample?.processCount) && sample.processCount >= 0);
  return sample;
}

async function captureDatabase(sql, knowledgeBaseId) {
  const rows = await sql`
    SELECT snapshot.release_root_public_id AS active_release_id,
           snapshot.manifest_checksum_sha256 AS manifest_checksum,
           projection.document_checksum_sha256 AS search_document_checksum,
           projection.document_count AS search_document_count,
           projection.last_batch_checksum_sha256 AS search_last_batch_checksum
    FROM focowiki.active_snapshots snapshot
    JOIN focowiki.search_projections projection
      ON projection.knowledge_base_id = snapshot.knowledge_base_id
     AND projection.public_id = snapshot.search_projection_public_id
    WHERE snapshot.knowledge_base_id = ${knowledgeBaseId}
    LIMIT 1
  `;
  const row = rows[0];
  assert(row, "The OKF 0.2 active release observation is unavailable.");
  return {
    activeReleaseId: row.active_release_id,
    manifestChecksum: row.manifest_checksum,
    searchDocumentChecksum: row.search_document_checksum,
    searchDocumentCount: safeInteger(row.search_document_count),
    searchLastBatchChecksum: row.search_last_batch_checksum
  };
}

async function captureS3(input) {
  const current = [];
  let continuationToken;
  do {
    const page = await input.client.send(new input.ListObjectsV2Command({
      Bucket: input.bucket,
      Prefix: input.prefix,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {})
    }));
    for (const object of page.Contents ?? []) {
      current.push({
        keyHash: digest(String(object.Key)),
        etag: String(object.ETag ?? ""),
        size: safeInteger(object.Size ?? 0),
        modifiedAt: object.LastModified?.toISOString() ?? null
      });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  let versionCount = 0;
  let keyMarker;
  let versionIdMarker;
  do {
    const page = await input.client.send(new input.ListObjectVersionsCommand({
      Bucket: input.bucket,
      Prefix: input.prefix,
      ...(keyMarker ? { KeyMarker: keyMarker } : {}),
      ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {})
    }));
    versionCount += (page.Versions?.length ?? 0) + (page.DeleteMarkers?.length ?? 0);
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker);
  current.sort((left, right) => left.keyHash.localeCompare(right.keyHash));
  return {
    s3ObjectCount: current.length,
    s3VersionCount: versionCount,
    s3TotalBytes: current.reduce((total, object) => total + object.size, 0),
    s3Fingerprint: digest(JSON.stringify(current))
  };
}

function readRedisInteger(info, key) {
  const match = String(info).match(new RegExp(`(?:^|\\r?\\n)${key}:(\\d+)`, "u"));
  return safeInteger(match?.[1] ?? 0);
}

function safeInteger(value) {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  assert(Number.isSafeInteger(parsed) && parsed >= 0, "Runtime observation is not bounded.");
  return parsed;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseByteSize(value) {
  const match = String(value).match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|KiB|MiB|GiB)$/iu);
  assert(match, "Container memory observation is invalid.");
  const unit = match[2].toLocaleLowerCase("en-US");
  const multiplier = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 }[unit];
  return Math.round(Number(match[1]) * multiplier);
}
