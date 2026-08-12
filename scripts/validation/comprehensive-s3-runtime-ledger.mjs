#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadEnvFile } from "node:process";

import {
  buildComprehensiveS3RuntimeLedger
} from "./lib/comprehensive-s3-runtime-ledger.mjs";

loadDevelopmentEnvironment();
const reportDirectory = requireReportDirectory();
const output = path.join(reportDirectory, "s3-runtime-ledger-current.json");
const databaseUrl = requireLoopbackUrl(
  "FOCOWIKI_COMPREHENSIVE_DATABASE_URL",
  ["postgres:"]
);
const s3Endpoint = requireLoopbackUrl(
  "FOCOWIKI_COMPREHENSIVE_S3_ENDPOINT",
  ["http:", "https:"]
);
const apiRequire = createRequire(path.join(process.cwd(), "apps/api/package.json"));
const postgres = apiRequire("postgres");
const {
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  S3Client
} = apiRequire("@aws-sdk/client-s3");
const sql = postgres(databaseUrl, {
  max: 2,
  connect_timeout: 10,
  idle_timeout: 5,
  prepare: false
});
const s3 = new S3Client({
  endpoint: s3Endpoint,
  region: requiredEnv("S3_REGION"),
  forcePathStyle: requiredBooleanEnv("S3_FORCE_PATH_STYLE"),
  credentials: {
    accessKeyId: requiredEnv("S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("S3_SECRET_ACCESS_KEY")
  },
  maxAttempts: 3
});
const bucket = requiredEnv("S3_BUCKET");
const startedAt = new Date().toISOString();
const started = performance.now();

try {
  const [registrations, owners] = await Promise.all([
    readRegistrations(),
    readOwners()
  ]);
  const listingStarted = performance.now();
  const [listedCurrentObjects, versionListing, multipartUploads] = await Promise.all([
    listCurrentObjects(),
    listVersionsAndMarkers(),
    listMultipartUploads()
  ]);
  const { versions: listedVersions, deleteMarkers } = versionListing;
  const listingDurationMs = duration(listingStarted);
  const versionByLatestKey = new Map(listedVersions
    .filter((version) => version.isLatest)
    .map((version) => [version.storageKey, version.versionId]));
  const currentObjects = listedCurrentObjects.map((object) => ({
    ...object,
    versionId: versionByLatestKey.get(object.storageKey) ?? "missing-latest-version"
  }));
  const readingStarted = performance.now();
  const versions = await mapConcurrent(
    listedVersions,
    positiveIntegerEnv("FOCOWIKI_COMPREHENSIVE_S3_READ_CONCURRENCY", 8, 32),
    readVersion
  );
  const readingDurationMs = duration(readingStarted);
  const ledger = buildComprehensiveS3RuntimeLedger({
    registrations,
    owners,
    currentObjects,
    versions,
    deleteMarkers,
    multipartUploads
  });
  const report = {
    kind: "focowiki-comprehensive-s3-runtime-ledger",
    version: 1,
    generatedAt: new Date().toISOString(),
    startedAt,
    ok: ledger.ok,
    isolatedValidationBucket: true,
    privacy: {
      objectBodiesRetained: false,
      rawStorageKeysRetained: false,
      rawOwnerIdentitiesRetained: false,
      identityFingerprintAlgorithm: "sha256"
    },
    timings: {
      listingDurationMs,
      versionReadDurationMs: readingDurationMs,
      totalDurationMs: duration(started),
      readConcurrency: positiveIntegerEnv(
        "FOCOWIKI_COMPREHENSIVE_S3_READ_CONCURRENCY",
        8,
        32
      )
    },
    ...ledger
  };
  writeJson(output, report);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    output,
    summary: report.summary,
    timings: report.timings
  })}\n`);
  if (!report.ok) throw new Error("S3 runtime ledger contains failed rows");
} catch (error) {
  if (!fs.existsSync(output)) {
    writeJson(output, {
      kind: "focowiki-comprehensive-s3-runtime-ledger",
      version: 1,
      generatedAt: new Date().toISOString(),
      startedAt,
      ok: false,
      failure: { message: safeFailure(error) }
    });
  }
  throw new Error(safeFailure(error));
} finally {
  s3.destroy();
  await sql.end({ timeout: 5 }).catch(() => undefined);
}

async function readRegistrations() {
  const rows = await sql`
    SELECT object_id AS "objectId", storage_key AS "storageKey",
           checksum_sha256 AS "checksumSha256", byte_count AS "byteCount",
           content_type AS "contentType", object_format AS "objectFormat",
           state, zero_owner_since AS "zeroOwnerSince"
    FROM focowiki.object_registrations
    ORDER BY storage_key COLLATE "C", object_id
  `;
  return rows.map((row) => ({
    ...row,
    byteCount: nonnegativeInteger(row.byteCount),
    zeroOwnerSince: timestamp(row.zeroOwnerSince)
  }));
}

async function readOwners() {
  const rows = await sql`
    SELECT public_id AS "publicId", knowledge_base_id AS "knowledgeBaseId",
           object_id AS "objectId", owner_kind AS "ownerKind",
           owner_public_id AS "ownerPublicId"
    FROM focowiki.object_owners
    ORDER BY object_id, owner_kind, owner_public_id, public_id
  `;
  return rows;
}

async function listCurrentObjects() {
  const rows = [];
  let continuationToken;
  do {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ...(continuationToken ? { ContinuationToken: continuationToken } : {})
    }));
    for (const item of response.Contents ?? []) {
      rows.push({
        storageKey: requiredS3String(item.Key, "current object key"),
        size: nonnegativeInteger(item.Size)
      });
    }
    continuationToken = response.IsTruncated
      ? requiredS3String(response.NextContinuationToken, "continuation token")
      : undefined;
  } while (continuationToken);
  return rows;
}

async function listVersionsAndMarkers() {
  const versions = [];
  const deleteMarkers = [];
  let keyMarker;
  let versionIdMarker;
  do {
    const response = await s3.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      ...(keyMarker ? { KeyMarker: keyMarker } : {}),
      ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {})
    }));
    for (const item of response.Versions ?? []) {
      versions.push({
        storageKey: requiredS3String(item.Key, "version key"),
        versionId: requiredS3String(item.VersionId, "version ID"),
        isLatest: item.IsLatest === true,
        size: nonnegativeInteger(item.Size)
      });
    }
    for (const item of response.DeleteMarkers ?? []) {
      deleteMarkers.push({
        storageKey: requiredS3String(item.Key, "delete marker key"),
        versionId: requiredS3String(item.VersionId, "delete marker version ID"),
        isLatest: item.IsLatest === true
      });
    }
    if (response.IsTruncated) {
      keyMarker = requiredS3String(response.NextKeyMarker, "next key marker");
      versionIdMarker = response.NextVersionIdMarker;
    } else {
      keyMarker = undefined;
      versionIdMarker = undefined;
    }
  } while (keyMarker);
  return { versions, deleteMarkers };
}

async function listMultipartUploads() {
  const rows = [];
  let keyMarker;
  let uploadIdMarker;
  do {
    const response = await s3.send(new ListMultipartUploadsCommand({
      Bucket: bucket,
      ...(keyMarker ? { KeyMarker: keyMarker } : {}),
      ...(uploadIdMarker ? { UploadIdMarker: uploadIdMarker } : {})
    }));
    for (const item of response.Uploads ?? []) {
      rows.push({
        storageKey: requiredS3String(item.Key, "multipart upload key"),
        uploadId: requiredS3String(item.UploadId, "multipart upload ID")
      });
    }
    if (response.IsTruncated) {
      keyMarker = requiredS3String(response.NextKeyMarker, "multipart next key marker");
      uploadIdMarker = requiredS3String(
        response.NextUploadIdMarker,
        "multipart next upload ID marker"
      );
    } else {
      keyMarker = undefined;
      uploadIdMarker = undefined;
    }
  } while (keyMarker);
  return rows;
}

async function readVersion(version) {
  const startedAt = performance.now();
  let body;
  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: version.storageKey,
      VersionId: version.versionId
    }), { abortSignal: AbortSignal.timeout(30_000) });
    body = response.Body;
    if (!body || !(Symbol.asyncIterator in Object(body))) {
      throw new Error("S3 version body is not stream-readable");
    }
    const hash = crypto.createHash("sha256");
    let bodyByteCount = 0;
    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array)) {
        throw new Error("S3 version body returned a non-byte chunk");
      }
      bodyByteCount += chunk.byteLength;
      hash.update(chunk);
    }
    return {
      ...version,
      durationMs: duration(startedAt),
      head: {
        contentLength: nonnegativeInteger(response.ContentLength),
        contentType: response.ContentType ?? null,
        checksumSha256: response.Metadata?.["checksum-sha256"] ?? null,
        objectFormat: response.Metadata?.["object-format"] ?? null,
        bodyByteCount,
        bodyChecksumSha256: hash.digest("hex")
      }
    };
  } catch (error) {
    return {
      ...version,
      durationMs: duration(startedAt),
      head: null,
      readFailure: safeFailure(error)
    };
  } finally {
    if (body && typeof body.destroy === "function") body.destroy();
  }
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function loadDevelopmentEnvironment() {
  const file = process.env.ENV_FILE || ".env.dev.example";
  if (fs.existsSync(file)) loadEnvFile(file);
}

function requireLoopbackUrl(name, protocols) {
  const value = requiredEnv(name);
  const parsed = new URL(value);
  if (!protocols.includes(parsed.protocol)
    || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error(`${name} must target an approved loopback service`);
  }
  return value;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredBooleanEnv(name) {
  const value = requiredEnv(name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function positiveIntegerEnv(name, fallback, maximum) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function requireReportDirectory() {
  const value = process.env.FOCOWIKI_COMPREHENSIVE_REPORT_DIR;
  if (!value
    || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(value)) {
    throw new Error("FOCOWIKI_COMPREHENSIVE_REPORT_DIR must be an exact ignored run-owned directory");
  }
  return path.resolve(value);
}

function requiredS3String(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`S3 ${label} is missing`);
  }
  return value;
}

function nonnegativeInteger(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Runtime returned an invalid nonnegative integer");
  }
  return result;
}

function timestamp(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function duration(start) {
  return Number((performance.now() - start).toFixed(3));
}

function writeJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function safeFailure(error) {
  const name = error instanceof Error ? error.name : "Error";
  return `${name}: runtime verification failed`.slice(0, 200);
}
