#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { loadEnvFile } from "node:process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  validateComprehensiveRedisRuntimeLedger
} from "./lib/comprehensive-redis-runtime-ledger.mjs";

loadDevelopmentEnvironment();

const runOwner = requiredEnv("FOCOWIKI_COMPREHENSIVE_RUN_OWNER");
if (!/^b[0-9a-f]{7,15}$/u.test(runOwner)) {
  throw new Error("FOCOWIKI_COMPREHENSIVE_RUN_OWNER is invalid");
}
const reportDirectory = path.resolve(requiredEnv("FOCOWIKI_COMPREHENSIVE_REPORT_DIR"));
const reportPath = path.join(reportDirectory, "redis-runtime-ledger-current.json");
const redisUrl = requireLoopbackRedisUrl(requiredEnv("REDIS_URL"));
const distModulePath = path.resolve(
  process.env.FOCOWIKI_API_DIST_REDIS_COORDINATOR?.trim()
    || "apps/api/dist/src/redis/coordination.js"
);
const { createRedisCoordinator } = await import(pathToFileURL(distModulePath));
const apiRequire = createRequire(path.resolve("apps/api/package.json"));
const { createClient } = apiRequire("redis");
const client = createClient({ url: redisUrl });
const validationPrefix = `focowiki:validation:${runOwner}:redis:${randomUUID()}`;
const coordinator = createRedisCoordinator(client, { keyPrefix: validationPrefix });
const rows = [];
let existingKeys = [];
let cleanupResidueCount = -1;

try {
  await client.connect();
  existingKeys = await inspectExistingRuntimeKeys();

  await exercise({
    responsibility: "session",
    expectedMaximumTtlSeconds: 60,
    prepare: async () => {
      await coordinator.setSession("session-one", { subject: "validation" }, 60);
      return [coordinator.buildKey("sessions", "session-one")];
    },
    verify: async () => (await coordinator.getSession("session-one"))?.subject === "validation",
    cleanup: () => coordinator.clearSession("session-one")
  });
  await exerciseLock({
    responsibility: "generic-lock",
    key: coordinator.buildKey("locks", "validation", "operation-one"),
    acquire: (owner) => coordinator.acquireLock("validation", "operation-one", owner, 30),
    release: (owner) => coordinator.releaseLock("validation", "operation-one", owner)
  });
  await exerciseLock({
    responsibility: "source-file-lock",
    key: coordinator.buildKey("source-file-locks", "source-one"),
    acquire: (owner) => coordinator.acquireSourceFileLock("source-one", owner, 30),
    release: (owner) => coordinator.releaseSourceFileLock("source-one", owner)
  });
  await exerciseLock({
    responsibility: "source-file-graph-lock",
    key: coordinator.buildKey("source-file-graph-locks", "source-one"),
    acquire: (owner) => coordinator.acquireSourceFileGraphLock("source-one", owner, 30),
    release: (owner) => coordinator.releaseSourceFileGraphLock("source-one", owner)
  });
  await exerciseLock({
    responsibility: "knowledge-base-publication-lock",
    key: coordinator.buildKey("knowledge-base-publication-locks", "knowledge-base-one"),
    acquire: (owner) => coordinator.acquireKnowledgeBasePublicationLock(
      "knowledge-base-one",
      owner,
      30
    ),
    release: (owner) => coordinator.releaseKnowledgeBasePublicationLock(
      "knowledge-base-one",
      owner
    )
  });
  await exercise({
    responsibility: "pagination-cursor",
    expectedMaximumTtlSeconds: 60,
    prepare: async () => {
      await coordinator.setPaginationCursor("files", "cursor-one", { after: "one" }, 60);
      return [coordinator.buildKey("pagination-cursors", "files", "cursor-one")];
    },
    verify: async () => (await coordinator.getPaginationCursor("files", "cursor-one"))
      ?.after === "one",
    cleanup: async (keys) => deleteKeys(keys)
  });
  await exercise({
    responsibility: "page-cache",
    expectedMaximumTtlSeconds: 60,
    prepare: async () => {
      await coordinator.setPageCache("tree", "page-one", { count: 1 }, 60);
      return [coordinator.buildKey("page-cache", "tree", "page-one")];
    },
    verify: async () => (await coordinator.getPageCache("tree", "page-one"))?.count === 1,
    cleanup: async (keys) => deleteKeys(keys)
  });
  await exercise({
    responsibility: "pagination-invalidation",
    expectedMaximumTtlSeconds: 60,
    prepare: async () => {
      await coordinator.markPaginationInvalid("files", "changed", 60);
      return [coordinator.buildKey("pagination-invalid", "files")];
    },
    verify: async () => (await coordinator.getPaginationInvalid("files")) === "changed",
    cleanup: async (keys) => deleteKeys(keys)
  });
  await exercise({
    responsibility: "public-openapi-key-cache",
    expectedMaximumTtlSeconds: 60,
    prepare: async () => {
      await coordinator.setPublicOpenApiKeyCache("hash-one", { id: "key-one" }, 60);
      return [coordinator.buildKey("public-openapi-key-cache", "hash-one")];
    },
    verify: async () => (await coordinator.getPublicOpenApiKeyCache("hash-one"))?.id === "key-one",
    cleanup: () => coordinator.clearPublicOpenApiKeyRuntimeKeys("key-one", "hash-one")
  });
  await exercise({
    responsibility: "public-openapi-key-usage",
    expectedMaximumTtlSeconds: 60,
    prepare: async () => {
      if (!await coordinator.markPublicOpenApiKeyUsed("key-two", 60)) {
        throw new Error("OpenAPI key usage marker was not acquired");
      }
      return [coordinator.buildKey("public-openapi-key-used", "key-two")];
    },
    verify: async () => !await coordinator.markPublicOpenApiKeyUsed("key-two", 60),
    cleanup: () => coordinator.clearPublicOpenApiKeyRuntimeKeys("key-two", "hash-two")
  });
  await exercise({
    responsibility: "runtime-settings-version",
    expectedMaximumTtlSeconds: 300,
    prepare: async () => {
      await coordinator.setRuntimeSettingsVersion("version-one");
      return [coordinator.buildKey("runtime-settings", "version")];
    },
    verify: async () => (await coordinator.getRuntimeSettingsVersion()) === "version-one",
    cleanup: async (keys) => deleteKeys(keys)
  });
  await exercise({
    responsibility: "rate-limit",
    expectedMaximumTtlSeconds: 60,
    prepare: async () => {
      const first = await coordinator.hitRateLimit("validation", "client-one", {
        max: 2,
        windowSeconds: 60
      });
      if (!first.allowed || first.remaining !== 1) {
        throw new Error("First rate-limit result is invalid");
      }
      return [coordinator.buildKey("rate-limits", "validation", "client-one")];
    },
    verify: async () => {
      const second = await coordinator.hitRateLimit("validation", "client-one", {
        max: 2,
        windowSeconds: 60
      });
      return second.allowed && second.remaining === 0;
    },
    cleanup: async (keys) => deleteKeys(keys)
  });
  await exerciseRuntimeCleanup("source-runtime-cleanup", async () => {
    const knowledgeBaseId = "knowledge-base-cleanup-source";
    const sourceFileId = "source-cleanup";
    const keys = [
      coordinator.buildKey("source-file-locks", sourceFileId),
      coordinator.buildKey("source-file-graph-locks", sourceFileId),
      coordinator.buildKey(
        "pagination-cursors",
        "files",
        knowledgeBaseId,
        sourceFileId,
        "cursor-one"
      )
    ];
    return {
      keys,
      cleanup: () => coordinator.clearSourceFileRuntimeKeys({ knowledgeBaseId, sourceFileId })
    };
  });
  await exerciseRuntimeCleanup("knowledge-base-runtime-cleanup", async () => {
    const knowledgeBaseId = "knowledge-base-cleanup-all";
    const keys = [
      coordinator.buildKey("knowledge-base-publication-locks", knowledgeBaseId),
      coordinator.buildKey("page-cache", "tree", knowledgeBaseId, "page-one"),
      coordinator.buildKey("pagination-invalid", "files", knowledgeBaseId)
    ];
    return {
      keys,
      cleanup: () => coordinator.clearKnowledgeBaseRuntimeKeys({ knowledgeBaseId })
    };
  });
} finally {
  if (client.isOpen) {
    await deleteMatching(`${validationPrefix}:*`);
    cleanupResidueCount = (await scanKeys(`${validationPrefix}:*`)).length;
    await client.quit();
  }
}

const validation = validateComprehensiveRedisRuntimeLedger({ rows, existingKeys });
const report = {
  kind: "focowiki-comprehensive-redis-runtime-ledger",
  version: 2,
  generatedAt: new Date().toISOString(),
  ok: validation.ok && cleanupResidueCount === 0,
  privacy: {
    rawKeyNamesStored: false,
    rawValuesReadForExistingKeys: false,
    identityFingerprintAlgorithm: "sha256"
  },
  summary: {
    ...validation,
    cleanupResidueCount
  },
  rows,
  existingKeys
};
writePrivateReport(reportPath, report);
process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  reportPath,
  summary: report.summary
})}\n`);
if (!report.ok) throw new Error("Redis runtime ledger failed");

async function exerciseLock(input) {
  await exercise({
    responsibility: input.responsibility,
    expectedMaximumTtlSeconds: 30,
    prepare: async () => {
      if (!await input.acquire("owner-one")) throw new Error("Lock was not acquired");
      return [input.key];
    },
    verify: async () => !await input.release("owner-two"),
    cleanup: async () => {
      if (!await input.release("owner-one")) throw new Error("Owned lock was not released");
    }
  });
}

async function exerciseRuntimeCleanup(responsibility, prepareCleanup) {
  const prepared = await prepareCleanup();
  await exercise({
    responsibility,
    expectedMaximumTtlSeconds: 60,
    prepare: async () => {
      for (const key of prepared.keys) await client.set(key, "validation", { EX: 60 });
      return prepared.keys;
    },
    verify: async () => (await Promise.all(prepared.keys.map((key) => client.exists(key))))
      .every((exists) => exists === 1),
    cleanup: prepared.cleanup
  });
}

async function exercise(input) {
  const started = performance.now();
  const keys = await input.prepare();
  const inspection = await inspectKeys(keys);
  const recoveryConfirmed = await input.verify();
  await input.cleanup(keys);
  const cleanupConfirmed = (await Promise.all(keys.map((key) => client.exists(key))))
    .every((exists) => exists === 0);
  rows.push({
    responsibility: input.responsibility,
    keyCount: keys.length,
    types: [...new Set(inspection.map((row) => row.type))].sort(),
    minimumTtlSeconds: Math.min(...inspection.map((row) => row.ttlSeconds)),
    maximumTtlSeconds: Math.max(...inspection.map((row) => row.ttlSeconds)),
    expectedMaximumTtlSeconds: input.expectedMaximumTtlSeconds,
    memoryBytes: inspection.reduce((sum, row) => sum + row.memoryBytes, 0),
    latencyMs: Number((performance.now() - started).toFixed(3)),
    recoveryConfirmed,
    cleanupConfirmed,
    automatedStatus: recoveryConfirmed && cleanupConfirmed ? "pass" : "fail",
    manualStatus: recoveryConfirmed && cleanupConfirmed ? "pass" : "fail"
  });
}

async function inspectExistingRuntimeKeys() {
  const match = process.env.FOCOWIKI_COMPREHENSIVE_REDIS_MATCH?.trim() || "focowiki:*";
  const keys = (await scanKeys(match)).filter((key) => !key.startsWith(`${validationPrefix}:`));
  const inspected = await inspectKeys(keys);
  return inspected.map((row) => ({
    keyFingerprintSha256: sha256(row.keyName),
    type: row.type,
    ttlSeconds: row.ttlSeconds,
    memoryBytes: row.memoryBytes
  })).sort((left, right) => left.keyFingerprintSha256.localeCompare(
    right.keyFingerprintSha256,
    "en"
  ));
}

async function inspectKeys(keys) {
  return Promise.all(keys.map(async (keyName) => ({
    keyName,
    type: await client.type(keyName),
    ttlSeconds: await client.ttl(keyName),
    memoryBytes: Number(await client.memoryUsage(keyName) ?? 0)
  })));
}

async function scanKeys(match) {
  const keys = [];
  for await (const scanned of client.scanIterator({ MATCH: match, COUNT: 100 })) {
    keys.push(...(Array.isArray(scanned) ? scanned : [scanned]));
  }
  return [...new Set(keys)].sort((left, right) => left.localeCompare(right, "en"));
}

async function deleteMatching(match) {
  await deleteKeys(await scanKeys(match));
}

async function deleteKeys(keys) {
  for (const key of keys) await client.del(key);
}

function loadDevelopmentEnvironment() {
  const envFile = process.env.ENV_FILE?.trim() || ".env.dev.example";
  if (fs.existsSync(envFile)) loadEnvFile(envFile);
}

function requireLoopbackRedisUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "redis:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Redis runtime ledger requires a loopback redis URL");
  }
  return url.toString();
}

function writePrivateReport(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
