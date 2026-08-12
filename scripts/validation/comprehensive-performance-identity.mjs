#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildComprehensivePerformanceIdentity,
  sha256
} from "./lib/comprehensive-performance-identity.mjs";

const runId = requiredEnv("FOCOWIKI_COMPREHENSIVE_RUN_ID");
const composeProject = requiredEnv("FOCOWIKI_COMPREHENSIVE_COMPOSE_PROJECT");
const evidenceDirectory = path.resolve(
  requiredEnv("FOCOWIKI_COMPREHENSIVE_EVIDENCE_DIR")
);
const postgresContainer = requiredEnv("FOCOWIKI_COMPREHENSIVE_POSTGRES_CONTAINER");
const outputPath = path.join(evidenceDirectory, "performance-identity.json");
const corpusPath = path.join(evidenceDirectory, "corpus-manifest.json");
const corpus = readJson(corpusPath);

if (!/^focowiki-clr-[a-z0-9-]+$/u.test(composeProject)) {
  throw new Error("The performance identity Docker project is not validation-owned.");
}
if (corpus.counts?.total !== 200 || corpus.rows?.length !== 200) {
  throw new Error("The exact 200-file corpus manifest is unavailable.");
}

const status = command("git", ["status", "--porcelain=v1"]);
const settings = queryRows(`
  SELECT current.revision_public_id, revision.checksum_sha256
  FROM focowiki.runtime_setting_current current
  JOIN focowiki.runtime_setting_revisions revision
    ON revision.public_id = current.revision_public_id
  WHERE current.singleton = true
`)[0];
if (!settings) throw new Error("The active runtime settings revision is unavailable.");

const schemaRows = [
  ...queryRows(`
    SELECT table_name, column_name, data_type, is_nullable,
           coalesce(column_default, '')
    FROM information_schema.columns
    WHERE table_schema = 'focowiki'
    ORDER BY table_name, ordinal_position
  `),
  ...queryRows(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'focowiki'
    ORDER BY tablename, indexname
  `),
  ...queryRows(`
    SELECT table_name, constraint_name, constraint_type
    FROM information_schema.table_constraints
    WHERE table_schema = 'focowiki'
    ORDER BY table_name, constraint_name
  `)
];
const activeGenerations = queryRows(`
  SELECT knowledge_base_id, release_root_public_id,
         search_projection_public_id, revision::text
  FROM focowiki.active_snapshots
  ORDER BY knowledge_base_id
`).map(([knowledgeBaseId, releaseRootPublicId, searchProjectionPublicId, revision]) => ({
  knowledgeBaseId,
  releaseRootPublicId,
  searchProjectionPublicId,
  revision: Number(revision)
}));

const generationModels = queryRows(`
  SELECT public_id, revision::text, enabled::text
  FROM focowiki.model_configs
  ORDER BY public_id
`).map(([revisionPublicId, revision, enabled]) => ({
  role: "generation",
  revisionPublicId,
  revision: Number(revision),
  state: enabled === "t" ? "active" : "inactive"
}));
const embeddingModels = queryRows(`
  SELECT configuration.public_id, configuration.active_revision_public_id,
         configuration.lifecycle_status, revision.resolved_dimension::text,
         revision.normalization
  FROM focowiki.embedding_configurations configuration
  JOIN focowiki.embedding_configuration_revisions revision
    ON revision.public_id = configuration.active_revision_public_id
  WHERE configuration.deleted_at IS NULL
  ORDER BY configuration.public_id
`).map(([configurationPublicId, revisionPublicId, state, dimension, normalization]) => ({
  role: "embedding",
  configurationPublicId,
  revisionPublicId,
  state,
  dimension: Number(dimension),
  normalization
}));
const rerankerModels = queryRows(`
  SELECT configuration.public_id, configuration.active_revision_public_id,
         configuration.lifecycle_status
  FROM focowiki.reranker_configurations configuration
  JOIN focowiki.reranker_configuration_revisions revision
    ON revision.public_id = configuration.active_revision_public_id
  ORDER BY configuration.public_id
`).map(([configurationPublicId, revisionPublicId, state]) => ({
  role: "reranker",
  configurationPublicId,
  revisionPublicId,
  state
}));

const composeSource = fs.readFileSync(
  path.resolve("docker-compose.dev.yml.example"), "utf8"
);
const identity = buildComprehensivePerformanceIdentity({
  runId,
  application: {
    commit: command("git", ["rev-parse", "HEAD"]).trim(),
    dirtyFileCount: status.split("\n").filter(Boolean).length,
    worktreeFingerprintSha256: sha256(status)
  },
  corpus: {
    manifestSha256: sha256(fs.readFileSync(corpusPath)),
    fileCount: corpus.counts.total,
    officialFileCount: corpus.counts.official,
    legalFileCount: corpus.counts.legacy
  },
  database: {
    schemaFingerprintSha256: sha256(JSON.stringify(schemaRows)),
    activeGenerations
  },
  runtime: {
    settingsRevisionPublicId: settings[0],
    settingsChecksumSha256: settings[1]
  },
  models: [...generationModels, ...embeddingModels, ...rerankerModels],
  providers: {
    opensearchVersion: imageVersion(
      composeSource, /opensearchproject\/opensearch:([^\s]+)/u, "OpenSearch"
    ),
    meilisearchVersion: imageVersion(
      composeSource, /getmeili\/meilisearch:v([^\s]+)/u, "Meilisearch"
    )
  },
  docker: {
    roles: ["api", "source-worker", "publication-worker", "maintenance-worker"]
      .map((role) => dockerRole(role))
  },
  host: {
    platform: os.platform(),
    architecture: os.arch(),
    logicalCpuCount: os.cpus().length,
    cpuClassSha256: sha256(os.cpus().map((cpu) => cpu.model).join("|")),
    memoryBytes: os.totalmem()
  },
  measurement: {
    clientConcurrency: [1, 20],
    warmupRepetitions: 1,
    measuredRepetitions: 3,
    telemetryIntervalMs: 1_000,
    endpointPercentiles: [50, 90, 95, 99],
    regressionTolerancePercent: 10
  },
  externalTimeClassifications: {
    generation: "external-user-configured-model",
    embedding: "external-user-configured-model",
    reranker: "external-user-configured-model",
    s3: "local-container-compatible-s3",
    opensearch: "local-container-search-provider",
    meilisearch: "local-container-search-provider"
  }
});

fs.writeFileSync(outputPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  outputPath,
  identitySha256: identity.identitySha256,
  corpusFileCount: identity.corpus.fileCount,
  modelRevisionCount: identity.models.length,
  dockerRoleCount: identity.docker.roles.length
}, null, 2)}\n`);

function dockerRole(role) {
  const container = `${composeProject}-${role}-1`;
  const resources = JSON.parse(command("docker", [
    "inspect", container, "--format", "{{json .HostConfig.Resources}}"
  ]));
  return {
    role,
    memoryBytes: Number(resources.Memory ?? 0),
    nanoCpus: Number(resources.NanoCpus ?? 0),
    pidsLimit: resources.PidsLimit === null ? null : Number(resources.PidsLimit)
  };
}

function queryRows(sql) {
  const raw = command("docker", [
    "exec", postgresContainer, "psql", "-U", "focowiki", "-d", "focowiki",
    "-At", "-F", "\t", "-c", sql
  ]).trim();
  return raw ? raw.split("\n").map((line) => line.split("\t")) : [];
}

function command(name, args) {
  const result = spawnSync(name, args, { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${name} failed: ${String(result.stderr).trim().slice(0, 300)}`);
  }
  return result.stdout;
}

function imageVersion(source, pattern, name) {
  const match = source.match(pattern)?.[1];
  if (!match) throw new Error(`${name} version is unavailable.`);
  return match;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
