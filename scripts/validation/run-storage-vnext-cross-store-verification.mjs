import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadEnvFile } from "node:process";
import {
  createLifecycleHttpClient
} from "./lib/interleaved-lifecycle-api.mjs";
import {
  createEvidenceRedactor
} from "./lib/interleaved-evidence-redaction.mjs";
import {
  assertHandoffLedger
} from "./lib/interleaved-handoff-ledger.mjs";
import {
  buildHandoffLedgerFromEvidence
} from "./lib/interleaved-handoff-ledger-builder.mjs";
import {
  createInterleavedPostgresEvidence
} from "./lib/interleaved-postgres-evidence.mjs";
import {
  assertStorageVnextCrossStoreTerminal
} from "./lib/storage-vnext-cross-store-terminal.mjs";

const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const {
  HeadObjectCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  S3Client
} = require("@aws-sdk/client-s3");
const postgres = require("postgres");
const { createClient: createRedisClient } = require("redis");

loadLocalEnv();

const proofPath = path.resolve(requiredEnv("FOCOWIKI_STORAGE_VNEXT_PROOF_FILE"));
const targetPath = path.resolve(requiredEnv("FOCOWIKI_STORAGE_VNEXT_TARGET_FILE"));
const proofManifest = readJson(proofPath);
const target = readJson(targetPath);
const proof = proofManifest.proof;
const runId = proof?.runId;
const knowledgeBaseId = target?.knowledgeBase?.id;
const filesystemScope = proof?.filesystemScope;
const reportPath = path.join(filesystemScope, "cross-store-verification.json");
const logRoot = path.resolve(requiredEnv("LOG_FILE_DIR"));
const databaseUrl = requiredEnv("DATABASE_URL");
const redactor = createEvidenceRedactor(runId);

assertRunInputs();

const sql = postgres(databaseUrl, { max: 2, prepare: false });
const postgresEvidence = createInterleavedPostgresEvidence({ sql });
const s3 = new S3Client({
  endpoint: requiredEnv("S3_ENDPOINT"),
  region: requiredEnv("S3_REGION"),
  forcePathStyle: requiredBooleanEnv("S3_FORCE_PATH_STYLE"),
  credentials: {
    accessKeyId: requiredEnv("S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("S3_SECRET_ACCESS_KEY")
  }
});
const redis = createRedisClient({ url: requiredEnv("REDIS_URL") });
const developer = createLifecycleHttpClient({
  baseUrl: requiredEnv("PUBLIC_BASE_URL"),
  authorization: `Bearer ${target.openApiCredential.rawKey}`
});
const startedAt = new Date().toISOString();

try {
  const snapshot = await postgresEvidence.snapshotKnowledgeBase(knowledgeBaseId);
  const physical = await readPhysicalPostgres();
  const [publicOutcome, s3Evidence, meilisearch, redisEvidence, logs] = await Promise.all([
    readPublicOutcome(),
    readS3Evidence(physical.registrations),
    readMeilisearchEvidence(),
    readRedisEvidence(),
    readLogEvidence()
  ]);
  const evidence = {
    runId,
    knowledgeBaseId,
    proof: {
      objectScope: proof.objectScope,
      searchScope: proof.searchScope,
      coordinationScope: proof.coordinationScope
    },
    postgres: { snapshot, physical },
    public: publicOutcome,
    s3: s3Evidence,
    meilisearch,
    redis: redisEvidence,
    logs
  };
  const terminal = assertStorageVnextCrossStoreTerminal(evidence);
  const ledger = buildHandoffLedgerFromEvidence({
    postgres: snapshot,
    redactor,
    scenarioId: "cross-store-terminal",
    publicOutcome: "succeeded",
    expectedKinds: [
      "knowledge_base",
      "operation",
      "source_file",
      "source_revision",
      "graph_node",
      "release_root",
      "search_projection",
      "active_snapshot",
      "object_owner",
      "object_registration"
    ],
    expectedTerminalKinds: ["source_file"]
  });
  assertHandoffLedger(ledger);

  const report = {
    kind: "focowiki-storage-vnext-cross-store-verification",
    version: 1,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: true,
    knowledgeBaseAlias: redactor.alias("knowledge_base", knowledgeBaseId),
    terminal,
    postgres: {
      operationStates: countBy(snapshot.operations, (item) => item.state),
      sourceStates: countBy(snapshot.sourceFiles, (item) =>
        item.deletedAt ? "deleted" : item.status
      ),
      objectStates: countBy(physical.registrations, (item) => item.state),
      zeroOwnerObjectCount: terminal.zeroOwnerObjectCount,
      handoffRecordCount: ledger.records.length,
      handoffLedgerDigest: digestJson(ledger)
    },
    s3: {
      currentObjectCount: s3Evidence.currentObjects.length,
      currentByteCount: sum(s3Evidence.currentObjects, (item) => item.byteCount),
      versionCount: s3Evidence.versionCount,
      versionByteCount: s3Evidence.versionByteCount,
      deleteMarkerCount: s3Evidence.deleteMarkers.length,
      multipartUploadCount: s3Evidence.multipartUploads.length,
      ownerMarkerCount: s3Evidence.ownerMarkerCount
    },
    meilisearch: {
      indexCount: meilisearch.indexes.length,
      documentCount: sum(meilisearch.indexes, (item) => item.numberOfDocuments),
      taskStates: countBy(meilisearch.tasks, (item) => item.status)
    },
    redis: {
      keyCount: redisEvidence.keys.length,
      keyTypes: countBy(redisEvidence.keys, (item) => item.type),
      ownerMarkerCount: terminal.redisOwnerMarkerCount,
      unexpectedPersistentKeyCount: terminal.redisUnexpectedPersistentKeyCount,
      minimumBoundedTtlSeconds: minimumBoundedTtl(redisEvidence.keys)
    },
    logs: {
      fileCount: logs.files.length,
      byteCount: sum(logs.files, (item) => item.byteCount),
      structuredLineCount: logs.structuredLineCount,
      nonStructuredLineCount: logs.nonStructuredLineCount,
      targetEventCount: logs.targetEvents.length,
      targetEvents: countBy(logs.targetEvents, (item) => item.event)
    }
  };
  writeJson(reportPath, report);
  process.stdout.write(`${JSON.stringify({
    runId,
    reportPath,
    ok: report.ok,
    terminal: report.terminal,
    s3: report.s3,
    meilisearch: report.meilisearch,
    redis: report.redis,
    logs: report.logs,
    handoffRecordCount: report.postgres.handoffRecordCount
  }, null, 2)}\n`);
} catch (error) {
  writeJson(reportPath, {
    kind: "focowiki-storage-vnext-cross-store-verification",
    version: 1,
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: false,
    failure: {
      name: error instanceof Error ? error.name : "Error",
      message: redactFailureMessage(error)
    }
  });
  throw error;
} finally {
  if (redis.isOpen) {
    if (redis.isReady) await redis.quit().catch(() => redis.destroy());
    else redis.destroy();
  }
  s3.destroy();
  await postgresEvidence.close().catch(() => undefined);
}

async function readPhysicalPostgres() {
  const registrations = await sql`
    SELECT registration.object_id AS "objectId",
           registration.storage_key AS "storageKey",
           registration.checksum_sha256 AS checksum,
           registration.byte_count AS "byteCount",
           registration.content_type AS "contentType",
           registration.object_format AS "objectFormat",
           registration.state,
           registration.zero_owner_since AS "zeroOwnerSince",
           count(owner.public_id) AS "ownerCount",
           count(owner.public_id) FILTER (
             WHERE owner.knowledge_base_id = ${knowledgeBaseId}
           ) AS "targetOwnerCount"
    FROM focowiki.object_registrations registration
    LEFT JOIN focowiki.object_owners owner
      ON owner.object_id = registration.object_id
    WHERE starts_with(registration.storage_key, ${proof.objectScope})
    GROUP BY registration.object_id, registration.storage_key,
             registration.checksum_sha256, registration.byte_count,
             registration.content_type, registration.object_format,
             registration.state, registration.zero_owner_since
    ORDER BY registration.storage_key COLLATE "C", registration.object_id
  `;
  const searchProjections = await sql`
    SELECT public_id AS "publicId", projection_role AS role, state,
           provider_index_uid AS "providerIndexUid",
           document_count AS "documentCount"
    FROM focowiki.search_projections
    WHERE knowledge_base_id = ${knowledgeBaseId}
    ORDER BY projection_role, public_id
  `;
  return {
    registrations: registrations.map((item) => ({
      ...item,
      byteCount: Number(item.byteCount),
      ownerCount: Number(item.ownerCount),
      targetOwnerCount: Number(item.targetOwnerCount),
      zeroOwnerSince: item.zeroOwnerSince?.toISOString?.() ?? item.zeroOwnerSince ?? null
    })),
    searchProjections: searchProjections.map((item) => ({
      ...item,
      documentCount: Number(item.documentCount)
    }))
  };
}

async function readPublicOutcome() {
  const encodedKnowledgeBaseId = encodeURIComponent(knowledgeBaseId);
  const knowledgeBase = await developer.json(
    `/openapi/v2/knowledge-bases/${encodedKnowledgeBaseId}`
  );
  const sourceFiles = await listAllPublic(
    `/openapi/v2/knowledge-bases/${encodedKnowledgeBaseId}/source-files?limit=200`
  );
  const rootIndex = await developer.text(
    `/openapi/v2/knowledge-bases/${encodedKnowledgeBaseId}/files/content?path=index.md`
  );
  const positive = readJson(path.join(filesystemScope, "positive-e2e.json"));
  const searchQuery = positive?.search?.query;
  if (!searchQuery) throw new Error("Positive public search evidence is missing.");
  const search = await developer.json(
    `/openapi/v2/knowledge-bases/${encodedKnowledgeBaseId}/files/search?query=${
      encodeURIComponent(searchQuery)
    }&mode=hybrid&limit=50`
  );
  const treeItemCount = await countPublicTree(encodedKnowledgeBaseId);
  return {
    knowledgeBaseId: knowledgeBase.knowledgeBase?.knowledgeBaseId,
    sourceFiles,
    searchResultCount: search.items?.length ?? 0,
    rootIndexByteCount: Buffer.byteLength(rootIndex),
    treeItemCount
  };
}

async function listAllPublic(pathname) {
  const items = [];
  let cursor = null;
  do {
    const separator = pathname.includes("?") ? "&" : "?";
    const page = await developer.json(
      `${pathname}${cursor ? `${separator}cursor=${encodeURIComponent(cursor)}` : ""}`
    );
    items.push(...(page.items ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return items;
}

async function countPublicTree(encodedKnowledgeBaseId) {
  const queue = ["pages"];
  const visited = new Set();
  let itemCount = 0;
  while (queue.length > 0) {
    const parentPath = queue.shift();
    if (!parentPath || visited.has(parentPath)) continue;
    visited.add(parentPath);
    let cursor = null;
    do {
      const page = await developer.json(
        `/openapi/v2/knowledge-bases/${encodedKnowledgeBaseId}/tree?parentPath=${
          encodeURIComponent(parentPath)
        }&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      );
      for (const item of page.items ?? []) {
        itemCount += 1;
        if (item.entryType === "directory") queue.push(item.path ?? item.logicalPath);
      }
      cursor = page.nextCursor ?? null;
    } while (cursor);
  }
  return itemCount;
}

async function readS3Evidence(registrations) {
  const currentObjects = [];
  const markerKey = `${proof.objectScope}_run-owner.json`;
  let ownerMarkerCount = 0;
  let continuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: requiredEnv("S3_BUCKET"),
      Prefix: proof.objectScope,
      MaxKeys: 1_000,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {})
    }));
    for (const item of page.Contents ?? []) {
      if (!item.Key?.startsWith(proof.objectScope)) {
        throw new Error("S3 inventory crossed the run-owned scope.");
      }
      if (item.Key === markerKey) {
        ownerMarkerCount += 1;
      } else {
        currentObjects.push({ storageKey: item.Key, listedByteCount: Number(item.Size) });
      }
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuationToken) {
      throw new Error("S3 current-object pagination was incomplete.");
    }
  } while (continuationToken);

  const ownerMarkerValid = ownerMarkerCount === 1
    && await readAndValidateS3OwnerMarker(markerKey);

  const registrationKeys = new Set(registrations.map((item) => item.storageKey));
  if (currentObjects.some((item) => !registrationKeys.has(item.storageKey))) {
    throw new Error("S3 current scope contains an unregistered object.");
  }
  await mapConcurrent(currentObjects, 16, async (item) => {
    const head = await s3.send(new HeadObjectCommand({
      Bucket: requiredEnv("S3_BUCKET"),
      Key: item.storageKey
    }));
    item.byteCount = Number(head.ContentLength);
    item.checksum = head.Metadata?.["checksum-sha256"] ?? null;
    item.contentType = head.ContentType ?? null;
    item.objectFormat = head.Metadata?.["object-format"] ?? null;
    if (item.byteCount !== item.listedByteCount) {
      throw new Error("S3 HEAD and current inventory byte counts differ.");
    }
    delete item.listedByteCount;
  });

  let versionCount = 0;
  let versionByteCount = 0;
  const deleteMarkers = [];
  let keyMarker;
  let versionIdMarker;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({
      Bucket: requiredEnv("S3_BUCKET"),
      Prefix: proof.objectScope,
      MaxKeys: 1_000,
      ...(keyMarker ? { KeyMarker: keyMarker } : {}),
      ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {})
    }));
    for (const version of page.Versions ?? []) {
      if (!version.Key?.startsWith(proof.objectScope)) {
        throw new Error("S3 version inventory crossed the run-owned scope.");
      }
      versionCount += 1;
      versionByteCount += Number(version.Size ?? 0);
    }
    for (const marker of page.DeleteMarkers ?? []) {
      if (!marker.Key?.startsWith(proof.objectScope)) {
        throw new Error("S3 delete-marker inventory crossed the run-owned scope.");
      }
      deleteMarkers.push({
        storageKey: marker.Key,
        isLatest: marker.IsLatest === true
      });
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    if (page.IsTruncated && !keyMarker) {
      throw new Error("S3 version pagination was incomplete.");
    }
  } while (keyMarker);

  const multipartUploads = [];
  let uploadKeyMarker;
  let uploadIdMarker;
  do {
    const page = await s3.send(new ListMultipartUploadsCommand({
      Bucket: requiredEnv("S3_BUCKET"),
      Prefix: proof.objectScope,
      MaxUploads: 1_000,
      ...(uploadKeyMarker ? { KeyMarker: uploadKeyMarker } : {}),
      ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {})
    }));
    for (const upload of page.Uploads ?? []) {
      if (!upload.Key?.startsWith(proof.objectScope)) {
        throw new Error("S3 multipart inventory crossed the run-owned scope.");
      }
      multipartUploads.push({ storageKey: upload.Key });
    }
    uploadKeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
    if (page.IsTruncated && !uploadKeyMarker) {
      throw new Error("S3 multipart pagination was incomplete.");
    }
  } while (uploadKeyMarker);

  return {
    ownerMarkerCount,
    ownerMarkerValid,
    currentObjects,
    versionCount,
    versionByteCount,
    deleteMarkers,
    multipartUploads
  };
}

async function readAndValidateS3OwnerMarker(markerKey) {
  const response = await s3.send(new GetObjectCommand({
    Bucket: requiredEnv("S3_BUCKET"),
    Key: markerKey
  }));
  if (!response.Body) return false;
  const bytes = await response.Body.transformToString("utf8");
  if (Buffer.byteLength(bytes, "utf8") > 4_096) return false;
  try {
    const marker = JSON.parse(bytes);
    const expected = {
      version: 1,
      runId,
      ownerMarker: proof.ownerMarker,
      proofChecksum: proof.proofChecksum,
      target: proof.objectScope,
      createdByRun: true,
      existedBeforeRun: false
    };
    return Object.keys(marker).length === Object.keys(expected).length
      && Object.entries(expected).every(([key, value]) => marker[key] === value);
  } catch {
    return false;
  }
}

async function readMeilisearchEvidence() {
  const indexes = [];
  let offset = 0;
  for (;;) {
    const page = await fetchMeilisearch(`/indexes?limit=1000&offset=${offset}`);
    const scoped = (page.results ?? []).filter((item) =>
      item.uid?.startsWith(proof.searchScope)
    );
    for (const index of scoped) {
      const stats = await fetchMeilisearch(`/indexes/${encodeURIComponent(index.uid)}/stats`);
      indexes.push({ uid: index.uid, numberOfDocuments: Number(stats.numberOfDocuments) });
    }
    const pageLength = page.results?.length ?? 0;
    if (pageLength < 1_000) break;
    offset += pageLength;
  }

  const tasks = [];
  let from = null;
  for (;;) {
    const page = await fetchMeilisearch(
      `/tasks?limit=1000${from === null ? "" : `&from=${encodeURIComponent(from)}`}`
    );
    tasks.push(...(page.results ?? []).map((task) => ({
      uid: task.uid,
      status: task.status
    })));
    if (page.next === null || page.next === undefined) break;
    from = page.next;
  }
  return { indexes, tasks };
}

async function fetchMeilisearch(pathname) {
  const response = await fetch(`${requiredEnv("MEILI_HOST")}${pathname}`, {
    headers: { authorization: `Bearer ${requiredEnv("MEILI_API_KEY")}` },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    throw new Error(`Meilisearch evidence request returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function readRedisEvidence() {
  if (!redis.isOpen) await redis.connect();
  const keys = [];
  for await (const scanned of redis.scanIterator({ MATCH: "focowiki:*", COUNT: 500 })) {
    for (const key of Array.isArray(scanned) ? scanned : [scanned]) {
      keys.push({
        key,
        type: await redis.type(key),
        ttlSeconds: await redis.ttl(key)
      });
    }
  }
  keys.sort((left, right) => left.key.localeCompare(right.key));
  return { keys };
}

async function readLogEvidence() {
  const names = [
    "focowiki-api.log",
    "focowiki-source-worker.log",
    "focowiki-publication-worker.log",
    "focowiki-maintenance-worker.log"
  ];
  const files = [];
  const targetEvents = [];
  let structuredLineCount = 0;
  let nonStructuredLineCount = 0;
  for (const name of names) {
    const filePath = path.join(logRoot, name);
    const stat = fs.statSync(filePath);
    files.push({ name, byteCount: stat.size });
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        structuredLineCount += 1;
        if (record?.fields?.knowledgeBaseId === knowledgeBaseId) {
          targetEvents.push({
            event: record.event ?? "unknown",
            level: record.level ?? "unknown",
            operationPublicId: record.fields.operationPublicId ?? null
          });
        }
      } catch {
        nonStructuredLineCount += 1;
      }
    }
  }
  return {
    files,
    structuredLineCount,
    nonStructuredLineCount,
    targetEvents
  };
}

async function mapConcurrent(items, concurrency, mapper) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await mapper(items[index], index);
    }
  }));
}

function assertRunInputs() {
  const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//u, ""));
  const configuredObjectScope = `${requiredEnv("S3_PREFIX").replace(/\/+$/gu, "")}/`;
  if (
    !/^svnext-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/u.test(runId ?? "")
    || target.runId !== runId
    || path.dirname(proofPath) !== filesystemScope
    || path.dirname(targetPath) !== filesystemScope
    || !logRoot.startsWith(`${filesystemScope}${path.sep}`)
    || databaseName !== proof.postgresScope
    || configuredObjectScope !== proof.objectScope
    || !proof.searchScope.startsWith("svnext_")
    || proof.coordinationScope !== `focowiki:validation:${runId}:`
  ) {
    throw new Error("Cross-store verification is outside the exact run-owned scope.");
  }
}

function loadLocalEnv() {
  const envPath = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredBooleanEnv(name) {
  const value = requiredEnv(name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = String(selector(item));
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))
  );
}

function sum(items, selector) {
  return items.reduce((total, item) => total + Number(selector(item)), 0);
}

function minimumBoundedTtl(keys) {
  const values = keys.map((item) => item.ttlSeconds).filter((ttl) => ttl >= 1);
  return values.length === 0 ? null : Math.min(...values);
}

function digestJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function redactFailureMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replaceAll(proof.objectScope, "[object-scope]/")
    .replaceAll(proof.searchScope, "[search-scope]")
    .replaceAll(knowledgeBaseId, redactor.alias("knowledge_base", knowledgeBaseId))
    .slice(0, 500);
}
