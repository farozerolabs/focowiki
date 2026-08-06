#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import {
  buildStorageVnextCapacityProjection,
  classifyStorageVnextCapacityProjectionAssessment
} from "./lib/storage-vnext-capacity-projection.mjs";

loadLocalEnv();
const proofPath = path.resolve(requiredEnv("FOCOWIKI_STORAGE_VNEXT_PROOF_FILE"));
const manifest = readJson(proofPath);
const proof = manifest?.proof;
const rebuild = readJson(path.join(proof.filesystemScope, "full-rebuild.json"));
const resources = readJson(path.join(proof.filesystemScope, "full-resources.json"));
const verification = readJson(path.join(proof.filesystemScope, "full-verification.json"));
const reportPath = path.join(proof.filesystemScope, "full-capacity-projection.json");
assertInputs();
const resourceAssessmentStatus = classifyStorageVnextCapacityProjectionAssessment(
  resources.assessment
);

const report = {
  kind: "focowiki-storage-vnext-full-capacity-projection",
  version: 1,
  runId: proof.runId,
  knowledgeBaseId: rebuild.knowledgeBaseId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  resourceAssessment: {
    status: resourceAssessmentStatus,
    failures: [...resources.assessment.failures]
  },
  projection: null,
  failure: null
};

try {
  report.projection = buildStorageVnextCapacityProjection({
    fileCount: rebuild.corpus.fileCount,
    sourceBytes: rebuild.corpus.totalSizeBytes,
    storage: {
      postgresDirectoryBytes: resources.storage.postgresDirectoryBytes,
      s3AllVersionsBytes: resources.storage.s3AllVersionsBytes,
      meilisearchPhysicalBytes: resources.storage.meilisearchPhysicalBytes,
      redisPersistedBytes: resources.storage.redisPersistedBytes,
      fourStoreTotalBytes: resources.storage.fourStoreTotalBytes
    },
    objects: {
      currentSourceObjects: resources.objects.currentSourceObjects,
      activeGeneratedObjects: resources.objects.activeGeneratedObjects,
      searchDocuments: verification.summary.searchDocumentCount,
      graphNodes: verification.summary.graphNodeCount,
      graphEdges: verification.summary.graphEdgeCount
    },
    throughput: {
      filesPerSecond: rebuild.throughput.totalCompletedFilesPerSecond
    },
    boundedTerms: [
      bounded("candidate roots", 1, "count", "release_roots role bound"),
      bounded("rollback roots", 1, "count", "release_roots role bound"),
      bounded("candidate changed facts", 100_000, "count", "release contract"),
      bounded("source revision roles", 3, "per-file", "current/candidate/rollback roles"),
      bounded("terminal results", 100_000, "count", "postgres retention contract"),
      bounded("terminal result bytes", 192 * 1024 * 1024, "bytes", "postgres retention contract"),
      bounded("terminal result age", 30, "days", "postgres retention contract"),
      bounded("security audit", 100_000, "count", "postgres retention contract"),
      bounded("security audit bytes", 128 * 1024 * 1024, "bytes", "postgres retention contract"),
      bounded("webhook deliveries", 100_000, "count", "postgres retention contract"),
      bounded("webhook delivery bytes", 128 * 1024 * 1024, "bytes", "postgres retention contract"),
      bounded("structured logs", 1024 * 1024 * 1024, "bytes", "runtime log budget"),
      bounded(
        "graph edges per source",
        verification.evidence.postgres.graphAcceptedEdgeLimit,
        "per-file",
        "active runtime settings revision"
      ),
      bounded("Generation history", 2, "count", "one candidate plus one rollback; legacy Generation absent")
    ]
  });
  report.finishedAt = new Date().toISOString();
  writeReport();
  process.stdout.write(`${JSON.stringify({
    status: resourceAssessmentStatus === "within-budget"
      ? "passed"
      : "projected-with-budget-failures",
    runId: proof.runId,
    targets: report.projection.targets,
    nonlinearComponents: report.projection.nonlinearComponents,
    reportPath
  }, null, 2)}\n`);
} catch (error) {
  report.failure = {
    name: error instanceof Error ? error.name : "Error",
    message: String(error instanceof Error ? error.message : error).slice(0, 2_000)
  };
  report.finishedAt = new Date().toISOString();
  writeReport();
  throw error;
}

function bounded(name, limit, limitKind, evidence) {
  return { name, bounded: true, limit, limitKind, evidence };
}

function assertInputs() {
  if (
    path.dirname(proofPath) !== proof?.filesystemScope
    || rebuild?.kind !== "focowiki-storage-vnext-full-rebuild"
    || rebuild.runId !== proof.runId
    || rebuild.finishedAt === null
    || rebuild.failure !== null
    || !Number.isFinite(rebuild.throughput?.totalCompletedFilesPerSecond)
    || resources?.kind !== "focowiki-storage-vnext-full-resources"
    || resources.runId !== proof.runId
    || resources.knowledgeBaseId !== rebuild.knowledgeBaseId
    || resources.finishedAt === null
    || resources.failure !== null
    || typeof resources.assessment?.ok !== "boolean"
    || !Array.isArray(resources.assessment?.failures)
    || verification?.kind !== "focowiki-storage-vnext-full-verification"
    || verification.runId !== proof.runId
    || verification.knowledgeBaseId !== rebuild.knowledgeBaseId
    || verification.finishedAt === null
    || verification.failure !== null
    || verification.summary?.generatedStructureParity !== true
  ) throw new Error("Full capacity projection input evidence is invalid");
}

function writeReport() {
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadLocalEnv() {
  const envPath = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
