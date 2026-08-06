#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { loadEnvFile } from "node:process";
import { promisify } from "node:util";
import {
  createStorageVnextScaleRuntimeEnvironment
} from "./lib/storage-vnext-scale-scope.mjs";
import {
  STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS,
  assertStorageVnextFullVerificationEvidence,
  isStorageVnextRunOwnedMeilisearchTask,
  listAllStorageVnextMeilisearchTasks
} from "./lib/storage-vnext-full-verification.mjs";

const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const {
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  S3Client
} = require("@aws-sdk/client-s3");
const { Meilisearch } = require("meilisearch");
const postgres = require("postgres");
const { createClient: createRedisClient } = require("redis");
const execFile = promisify(execFileCallback);
const BASELINE_COMMIT = "958515f622f4c6ee2ad9392d9ce79b0f2c9e8b88";
const FROZEN_STRUCTURE_FILES = [
  "apps/api/src/okf/generated-graph-resources.ts",
  "apps/api/src/okf/publication-files.ts",
  "apps/api/src/public-generated-path.ts",
  "packages/okf/src/conformance.ts",
  "packages/okf/src/indexes.ts",
  "packages/okf/src/markdown-links.ts",
  "packages/okf/src/public-bundle-path.ts"
];

loadLocalEnv();
const proofPath = path.resolve(requiredEnv("FOCOWIKI_STORAGE_VNEXT_PROOF_FILE"));
const manifest = readJson(proofPath);
const proof = manifest?.proof;
const runtimeEnv = createStorageVnextScaleRuntimeEnvironment({ proof, env: process.env });
Object.assign(process.env, runtimeEnv);
const corpus = readJson(path.join(proof.filesystemScope, "full-corpus.json"));
const rebuild = readJson(path.join(proof.filesystemScope, "full-rebuild.json"));
const reportPath = path.join(proof.filesystemScope, "full-verification.json");
assertInputs();

const sql = postgres(runtimeEnv.DATABASE_URL, { max: 2, prepare: false });
const redis = createRedisClient({ url: requiredEnv("REDIS_URL") });
const s3 = new S3Client({
  endpoint: requiredEnv("S3_ENDPOINT"),
  region: requiredEnv("S3_REGION"),
  forcePathStyle: requiredBooleanEnv("S3_FORCE_PATH_STYLE"),
  credentials: {
    accessKeyId: requiredEnv("S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("S3_SECRET_ACCESS_KEY")
  }
});
const meilisearch = new Meilisearch({
  host: requiredEnv("MEILI_HOST"),
  apiKey: requiredEnv("MEILI_API_KEY"),
  timeout: 30_000
});
const report = {
  kind: "focowiki-storage-vnext-full-verification",
  version: 1,
  runId: proof.runId,
  knowledgeBaseId: rebuild.knowledgeBaseId,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  evidence: null,
  summary: null,
  failure: null
};

try {
  await redis.connect();
  const expectedDirectories = listExpectedDirectories(corpus.files);
  const [postgresEvidence, s3Inventory, searchEvidence, frozenStructure] =
    await Promise.all([
      readPostgresEvidence(expectedDirectories),
      listS3Inventory(""),
      readMeilisearchEvidence(),
      frozenStructureContractPassed()
    ]);
  const controls = await readControlEvidence(s3Inventory, searchEvidence);
  const runS3 = summarizeRunS3(s3Inventory, postgresEvidence.registrationStorageKeys);
  const evidence = {
    runId: proof.runId,
    knowledgeBaseId: rebuild.knowledgeBaseId,
    corpus: {
      fileCount: corpus.fileCount,
      totalSizeBytes: corpus.totalSizeBytes,
      checksumMismatchCount: postgresEvidence.checksumMismatchCount,
      expectedDirectoryCount: expectedDirectories.length
    },
    postgres: postgresEvidence.summary,
    providers: {
      ...runS3,
      ...searchEvidence.summary
    },
    controls,
    releasedStructureParity: {
      requiredNavigationOrderMatches: sameJson(
        postgresEvidence.summary.requiredNavigationPaths,
        STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS
      ),
      sourceMappingCount: postgresEvidence.summary.sourceBackedEntryCount,
      directoryNavigationCount: postgresEvidence.directoryNavigationCount,
      pathValidationPassed: postgresEvidence.summary.invalidGeneratedPathCount === 0,
      frozenStructureContractPassed: frozenStructure
    }
  };
  report.evidence = evidence;
  report.summary = assertStorageVnextFullVerificationEvidence(evidence);
  report.finishedAt = new Date().toISOString();
  writeReport();
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    runId: proof.runId,
    summary: report.summary,
    controls,
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
} finally {
  await Promise.allSettled([
    sql.end({ timeout: 5 }),
    redis.isOpen ? redis.quit() : Promise.resolve()
  ]);
  s3.destroy();
}

async function readPostgresEvidence(expectedDirectories) {
  const sources = await sql`
    SELECT source.logical_path, revision.checksum_sha256,
           revision.byte_count::text AS byte_count
    FROM focowiki.source_files source
    JOIN focowiki.source_file_current_revisions current_revision
      ON current_revision.knowledge_base_id = source.knowledge_base_id
     AND current_revision.source_file_public_id = source.public_id
    JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = current_revision.knowledge_base_id
     AND revision.public_id = current_revision.source_revision_public_id
    WHERE source.knowledge_base_id = ${rebuild.knowledgeBaseId}
      AND source.deleted_at IS NULL
    ORDER BY source.logical_path COLLATE "C"
  `;
  const expectedFiles = new Map(corpus.files.map((file) => [file.relativePath, file]));
  let checksumMismatchCount = 0;
  for (const source of sources) {
    const expected = expectedFiles.get(source.logical_path);
    if (
      !expected
      || source.checksum_sha256 !== expected.checksumSha256
      || integer(source.byte_count) !== expected.sizeBytes
    ) checksumMismatchCount += 1;
    else expectedFiles.delete(source.logical_path);
  }
  checksumMismatchCount += expectedFiles.size;

  const [counts] = await sql`
    SELECT
      (SELECT count(*) FROM focowiki.knowledge_bases
        WHERE deleted_at IS NULL)::text AS knowledge_base_count,
      (SELECT count(*) FROM focowiki.source_files
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND deleted_at IS NULL)::text AS source_file_count,
      (SELECT count(*) FROM focowiki.source_revisions
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND revision_role = 'current')::text AS current_revision_count,
      (SELECT count(*) FROM focowiki.source_file_current_revisions
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId})::text AS current_pointer_count,
      (SELECT count(DISTINCT logical_path) FROM focowiki.source_files
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND deleted_at IS NULL)::text AS distinct_logical_path_count,
      (SELECT coalesce(sum(revision.byte_count), 0)
        FROM focowiki.source_revisions revision
        WHERE revision.knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND revision.revision_role = 'current')::text AS current_source_bytes,
      (SELECT count(*) FROM focowiki.source_directories
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND deleted_at IS NULL)::text AS source_directory_count,
      (SELECT count(*) FROM focowiki.graph_nodes
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId})::text AS graph_node_count,
      (SELECT count(*) FROM focowiki.graph_edges
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId})::text AS graph_edge_count,
      (SELECT (revision.settings_values->'sections'->'graph'
        ->>'acceptedEdgeLimit')::text
        FROM focowiki.runtime_setting_current current_setting
        JOIN focowiki.runtime_setting_revisions revision
          ON revision.public_id = current_setting.revision_public_id
        WHERE current_setting.singleton) AS graph_accepted_edge_limit,
      (SELECT count(*) FROM focowiki.release_roots
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND root_role = 'active')::text AS active_root_count,
      (SELECT count(*) FROM focowiki.release_roots
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND root_role = 'candidate')::text AS candidate_root_count,
      (SELECT count(*) FROM focowiki.release_roots
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND root_role = 'rollback')::text AS rollback_root_count,
      (SELECT count(*) FROM focowiki.active_snapshots
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId})::text AS active_snapshot_count,
      (SELECT count(*) FROM focowiki.release_candidates
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId})::text AS live_candidate_count,
      (SELECT count(*) FROM focowiki.search_projections
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND projection_role = 'active')::text AS active_search_projection_count,
      (SELECT count(*) FROM focowiki.search_projections
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND projection_role = 'candidate')::text AS candidate_search_projection_count,
      (SELECT coalesce(max(document_count), 0) FROM focowiki.search_projections
        WHERE knowledge_base_id = ${rebuild.knowledgeBaseId}
          AND projection_role = 'active')::text AS active_search_document_count,
      (SELECT count(*) FROM focowiki.object_registrations
        WHERE state = 'verified')::text AS verified_registration_count,
      (SELECT count(*) FROM focowiki.object_registrations registration
        WHERE registration.state = 'verified'
          AND EXISTS (SELECT 1 FROM focowiki.object_owners owner
            WHERE owner.object_id = registration.object_id))::text
        AS owned_verified_registration_count,
      (SELECT count(*) FROM focowiki.object_registrations registration
        WHERE registration.state = 'verified'
          AND NOT EXISTS (SELECT 1 FROM focowiki.object_owners owner
            WHERE owner.object_id = registration.object_id))::text
        AS zero_owner_object_count,
      (SELECT count(*) FROM focowiki.object_owners owner
        WHERE NOT EXISTS (SELECT 1 FROM focowiki.object_registrations registration
          WHERE registration.object_id = owner.object_id))::text AS orphan_owner_count
  `;
  const [active] = await sql`
    SELECT snapshot.release_root_public_id,
           projection.provider_index_uid
    FROM focowiki.active_snapshots snapshot
    JOIN focowiki.search_projections projection
      ON projection.knowledge_base_id = snapshot.knowledge_base_id
     AND projection.public_id = snapshot.search_projection_public_id
    WHERE snapshot.knowledge_base_id = ${rebuild.knowledgeBaseId}
  `;
  const catalog = active ? await sql`
    SELECT logical_path, entry_kind, source_file_public_id
    FROM focowiki.resolve_release_catalog(${active.release_root_public_id})
    ORDER BY CASE logical_path
      WHEN 'index.md' THEN 0 WHEN 'pages/index.md' THEN 1
      WHEN 'schema.md' THEN 2 WHEN 'log.md' THEN 3
      WHEN '_index/index.md' THEN 4 WHEN '_graph/index.md' THEN 5
      WHEN '_index/catalog.json' THEN 6
      ELSE CASE WHEN logical_path LIKE 'pages/%' THEN 7
        WHEN logical_path LIKE '_index/%' THEN 8
        WHEN logical_path LIKE '_graph/%' THEN 9 ELSE 10 END
    END, logical_path COLLATE "C"
  ` : [];
  const catalogPaths = new Set(catalog.map((entry) => entry.logical_path));
  const requiredNavigationPaths = catalog.slice(
    0,
    STORAGE_VNEXT_RELEASED_NAVIGATION_PATHS.length
  ).map((entry) => entry.logical_path);
  const directoryNavigationCount = expectedDirectories.filter((directory) =>
    catalogPaths.has(`pages/${directory}/index.md`)
  ).length;
  const sourceBackedEntryCount = catalog.filter((entry) =>
    entry.entry_kind === "source"
      && entry.source_file_public_id
      && entry.logical_path.startsWith("pages/")
  ).length;
  const invalidGeneratedPathCount = catalog.filter((entry) =>
    !isCanonicalGeneratedPath(entry.logical_path)
  ).length;
  const registrations = await sql`
    SELECT storage_key
    FROM focowiki.object_registrations
    WHERE state = 'verified'
    ORDER BY storage_key COLLATE "C"
  `;
  return {
    checksumMismatchCount,
    directoryNavigationCount,
    activeProviderIndexUid: active?.provider_index_uid ?? null,
    registrationStorageKeys: new Set(registrations.map((row) => row.storage_key)),
    summary: {
      knowledgeBaseCount: integer(counts.knowledge_base_count),
      sourceFileCount: integer(counts.source_file_count),
      currentRevisionCount: integer(counts.current_revision_count),
      currentPointerCount: integer(counts.current_pointer_count),
      distinctLogicalPathCount: integer(counts.distinct_logical_path_count),
      currentSourceBytes: integer(counts.current_source_bytes),
      sourceDirectoryCount: integer(counts.source_directory_count),
      graphNodeCount: integer(counts.graph_node_count),
      graphEdgeCount: integer(counts.graph_edge_count),
      graphAcceptedEdgeLimit: integer(counts.graph_accepted_edge_limit),
      generatedEntryCount: catalog.length,
      sourceBackedEntryCount,
      activeRootCount: integer(counts.active_root_count),
      candidateRootCount: integer(counts.candidate_root_count),
      rollbackRootCount: integer(counts.rollback_root_count),
      activeSnapshotCount: integer(counts.active_snapshot_count),
      liveCandidateCount: integer(counts.live_candidate_count),
      activeSearchProjectionCount: integer(counts.active_search_projection_count),
      candidateSearchProjectionCount: integer(counts.candidate_search_projection_count),
      activeSearchDocumentCount: integer(counts.active_search_document_count),
      verifiedRegistrationCount: integer(counts.verified_registration_count),
      ownedVerifiedRegistrationCount: integer(counts.owned_verified_registration_count),
      orphanOwnerCount: integer(counts.orphan_owner_count),
      zeroOwnerObjectCount: integer(counts.zero_owner_object_count),
      invalidGeneratedPathCount,
      requiredNavigationPaths
    }
  };
}

async function readMeilisearchEvidence() {
  const indexes = [];
  let offset = 0;
  do {
    const page = await meilisearch.getRawIndexes({ offset, limit: 1_000 });
    indexes.push(...page.results.map((index) => index.uid));
    offset += page.results.length;
    if (offset >= page.total) break;
    if (page.results.length === 0) throw new Error("Full verification index pagination stalled");
  } while (true);
  const owned = indexes.filter((uid) => uid.startsWith(proof.searchScope));
  const tasks = await listAllStorageVnextMeilisearchTasks((query) =>
    meilisearch.tasks.getTasks(query));
  const taskScope = meilisearchTaskScope();
  const ownedTasks = tasks.filter((task) =>
    isStorageVnextRunOwnedMeilisearchTask(task, taskScope)
  );
  const documentCount = owned.length === 1
    ? integer((await meilisearch.index(owned[0]).getStats()).numberOfDocuments)
    : 0;
  return {
    indexes,
    tasks,
    summary: {
      meilisearchIndexCount: owned.length,
      meilisearchDocumentCount: documentCount,
      meilisearchTasksInFlight: ownedTasks.filter((task) =>
        ["enqueued", "processing"].includes(task.status)
      ).length,
      activeIndexMatchesProvider: owned.length === 1
        && owned[0] === (await readActiveProviderIndexUid())
    }
  };
}

async function readActiveProviderIndexUid() {
  const [row] = await sql`
    SELECT projection.provider_index_uid
    FROM focowiki.active_snapshots snapshot
    JOIN focowiki.search_projections projection
      ON projection.public_id = snapshot.search_projection_public_id
     AND projection.knowledge_base_id = snapshot.knowledge_base_id
    WHERE snapshot.knowledge_base_id = ${rebuild.knowledgeBaseId}
  `;
  return row?.provider_index_uid ?? null;
}

async function listS3Inventory(prefix) {
  const versions = [];
  let keyMarker;
  let versionIdMarker;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({
      Bucket: requiredEnv("S3_BUCKET"), Prefix: prefix,
      KeyMarker: keyMarker, VersionIdMarker: versionIdMarker, MaxKeys: 1_000
    }));
    for (const entry of page.Versions ?? []) {
      if (entry.Key && entry.VersionId) versions.push({
        key: entry.Key,
        versionId: entry.VersionId,
        isLatest: entry.IsLatest === true,
        deleteMarker: false,
        size: entry.Size ?? 0
      });
    }
    for (const entry of page.DeleteMarkers ?? []) {
      if (entry.Key && entry.VersionId) versions.push({
        key: entry.Key,
        versionId: entry.VersionId,
        isLatest: entry.IsLatest === true,
        deleteMarker: true,
        size: 0
      });
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker);
  const multipartUploads = [];
  let uploadKeyMarker;
  let uploadIdMarker;
  do {
    const page = await s3.send(new ListMultipartUploadsCommand({
      Bucket: requiredEnv("S3_BUCKET"), Prefix: prefix,
      KeyMarker: uploadKeyMarker, UploadIdMarker: uploadIdMarker, MaxUploads: 1_000
    }));
    for (const upload of page.Uploads ?? []) {
      if (upload.Key && upload.UploadId) multipartUploads.push({
        key: upload.Key,
        uploadId: upload.UploadId
      });
    }
    uploadKeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    uploadIdMarker = page.IsTruncated ? page.NextUploadIdMarker : undefined;
  } while (uploadKeyMarker);
  return { versions, multipartUploads };
}

function summarizeRunS3(inventory, registrationStorageKeys) {
  const markerKey = `${proof.objectScope}_run-owner.json`;
  const current = inventory.versions.filter((entry) =>
    entry.key.startsWith(proof.objectScope) && entry.isLatest && !entry.deleteMarker
  );
  const currentKeys = new Set(current.map((entry) => entry.key));
  const orphanObjects = [...currentKeys].filter((key) =>
    key !== markerKey && !registrationStorageKeys.has(key)
  );
  const missingObjects = [...registrationStorageKeys].filter((key) => !currentKeys.has(key));
  return {
    s3CurrentObjectCount: current.length,
    s3OwnerMarkerCount: current.filter((entry) => entry.key === markerKey).length,
    s3OrphanObjectCount: orphanObjects.length + missingObjects.length
  };
}

async function readControlEvidence(inventory, searchEvidence) {
  const controls = manifest.immutableControls;
  const adminUrl = databaseUrlFor(runtimeEnv.DATABASE_URL, "postgres");
  const adminSql = postgres(adminUrl, { max: 1, prepare: false });
  let databases;
  let knowledgeBases;
  try {
    databases = (await adminSql`
      SELECT datname AS name FROM pg_database
      WHERE datistemplate = false ORDER BY datname
    `).map((row) => row.name).filter((name) => name !== proof.postgresScope);
    knowledgeBases = await captureKnowledgeBaseControls(adminUrl, databases);
  } finally {
    await adminSql.end({ timeout: 5 });
  }
  const redisKeys = [];
  for await (const result of redis.scanIterator({ MATCH: "*", COUNT: 500 })) {
    for (const key of Array.isArray(result) ? result : [result]) {
      if (!key.startsWith(proof.coordinationScope)) redisKeys.push(key);
    }
  }
  redisKeys.sort();
  const controlS3 = {
    versions: inventory.versions.filter((entry) => !entry.key.startsWith(proof.objectScope)),
    multipartUploads: inventory.multipartUploads.filter((entry) =>
      !entry.key.startsWith(proof.objectScope)
    )
  };
  const controlIndexes = searchEvidence.indexes
    .filter((uid) => !uid.startsWith(proof.searchScope)).sort();
  const taskScope = meilisearchTaskScope();
  const controlTasks = searchEvidence.tasks.filter((task) =>
    !isStorageVnextRunOwnedMeilisearchTask(task, taskScope)
  ).map((task) => ({ uid: task.uid, status: task.status }));
  return {
    postgres: sameJson(databases, controls.postgres.databases)
      && sameJson(knowledgeBases, controls.postgres.knowledgeBases),
    s3: sameJson(controlS3, controls.s3),
    meilisearch: sameJson(controlIndexes, controls.meilisearch.indexes)
      && sameJson(controlTasks, controls.meilisearch.tasks),
    redis: sameJson(redisKeys, controls.redis.keys),
    filesystem: controls.filesystem.runRootExisted === false
      && fs.existsSync(path.join(proof.filesystemScope, ".focowiki-run-owner.json"))
  };
}

function meilisearchTaskScope() {
  return {
    searchScope: proof.searchScope,
    controlTaskUids: new Set(
      manifest.immutableControls.meilisearch.tasks.map((task) => task.uid)
    )
  };
}

async function captureKnowledgeBaseControls(adminUrl, databases) {
  const results = [];
  for (const database of databases) {
    const controlSql = postgres(databaseUrlFor(adminUrl, database), {
      max: 1, prepare: false, connect_timeout: 2
    });
    try {
      const [relation] = await controlSql`
        SELECT to_regclass('focowiki.knowledge_bases') IS NOT NULL AS exists
      `;
      if (!relation?.exists) continue;
      const rows = await controlSql`
        SELECT public_id AS id FROM focowiki.knowledge_bases ORDER BY public_id
      `;
      results.push({ database, ids: rows.map((row) => row.id) });
    } finally {
      await controlSql.end({ timeout: 2 });
    }
  }
  return results;
}

async function frozenStructureContractPassed() {
  try {
    await execFile("git", [
      "diff", "--quiet", BASELINE_COMMIT, "--", ...FROZEN_STRUCTURE_FILES
    ], { cwd: process.cwd(), env: process.env });
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === 1) return false;
    throw error;
  }
}

function listExpectedDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    const parts = file.relativePath.split("/").slice(0, -1);
    for (let index = 1; index <= parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return [...directories].sort();
}

function isCanonicalGeneratedPath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.includes("\\")
    && !value.split("/").some((segment) => !segment || segment === "." || segment === "..")
    && /\.(?:md|json|jsonl)$/u.test(value)
    && /^(?:index\.md|log(?:-[0-9]+)?\.md|schema(?:-[^/]+)?\.md|pages\/|_index\/|_graph\/|_segments\/)/u.test(value);
}

function assertInputs() {
  if (
    path.dirname(proofPath) !== proof?.filesystemScope
    || corpus?.kind !== "storage-vnext-scale-corpus-manifest"
    || corpus.selectionStrategy !== "complete-formal-corpus-v1"
    || corpus.fileCount !== 29_736
    || corpus.totalSizeBytes !== 526_803_253
    || rebuild?.kind !== "focowiki-storage-vnext-full-rebuild"
    || rebuild.runId !== proof.runId
    || rebuild.corpus?.manifestChecksumSha256 !== corpus.manifestChecksumSha256
    || rebuild.failure !== null
    || rebuild.finishedAt === null
  ) throw new Error("Full verification input evidence is invalid");
}

function databaseUrlFor(value, database) {
  const url = new URL(value);
  url.pathname = `/${database}`;
  return url.toString();
}

function writeReport() {
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function integer(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a safe nonnegative integer, received ${value}`);
  }
  return parsed;
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

function requiredBooleanEnv(name) {
  const value = requiredEnv(name);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}
