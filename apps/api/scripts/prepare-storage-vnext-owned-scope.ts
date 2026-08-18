import { randomBytes } from "node:crypto";
import {
  mkdir,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GetBucketVersioningCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Meilisearch } from "meilisearch";
import postgres from "postgres";
import { createClient } from "redis";
import { bootstrapStorageVnextOwnedScope } from "../src/storage-vnext/bootstrap/command.js";
import { createStorageVnextCoordinationPlane } from "../src/storage-vnext/bootstrap/coordination-plane.js";
import { createStorageVnextFilesystemPlane } from "../src/storage-vnext/bootstrap/filesystem-plane.js";
import { createStorageVnextObjectPlane } from "../src/storage-vnext/bootstrap/object-plane.js";
import {
  createStorageVnextOwnerMarkerDocument,
  serializeStorageVnextOwnerMarker
} from "../src/storage-vnext/bootstrap/owner-marker.js";
import { createStorageVnextOwnedScopeProof } from "../src/storage-vnext/bootstrap/owned-scope.js";
import { createStorageVnextPostgresPlane } from "../src/storage-vnext/bootstrap/postgres-plane.js";
import {
  createStorageVnextSearchPlane,
  type StorageVnextOwnedSearchClient
} from "../src/storage-vnext/bootstrap/search-plane.js";

const runId = requiredEnvironment("FOCOWIKI_STORAGE_VNEXT_RUN_ID");
const adminDatabaseUrl = databaseUrlFor(
  requiredEnvironment("DATABASE_URL"),
  "postgres"
);
const filesystemScope = join(tmpdir(), runId);
const proof = createStorageVnextOwnedScopeProof({
  runId,
  nonceHash: randomBytes(32).toString("hex"),
  createdAt: new Date().toISOString(),
  filesystemScope
});
const databaseUrl = databaseUrlFor(adminDatabaseUrl, proof.postgresScope);
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
const bucket = requiredEnvironment("S3_BUCKET");
const meilisearch = new Meilisearch({
  host: requiredEnvironment("MEILI_HOST"),
  apiKey: requiredEnvironment("MEILI_API_KEY"),
  timeout: 10_000
});
const adminSql = postgres(adminDatabaseUrl, {
  max: 1,
  idle_timeout: 5,
  connect_timeout: 5
});
let appSql: ReturnType<typeof postgres> | null = null;

try {
  await redis.connect();
  const controls = await captureImmutableControls();
  assertFreshOwnedTargets(controls);

  await mkdir(proof.filesystemScope, { mode: 0o700 });
  await Promise.all([
    mkdir(join(proof.filesystemScope, "runtime-secrets"), { mode: 0o700 }),
    mkdir(join(proof.filesystemScope, "tmp"), { mode: 0o700 }),
    mkdir(join(proof.filesystemScope, "logs"), { mode: 0o700 })
  ]);
  await writeFile(
    join(proof.filesystemScope, ".focowiki-run-owner.json"),
    serializeStorageVnextOwnerMarker(
      createStorageVnextOwnerMarkerDocument(proof, proof.filesystemScope)
    ),
    { mode: 0o600, flag: "wx" }
  );

  await adminSql.unsafe(`CREATE DATABASE ${quoteIdentifier(proof.postgresScope)}`);
  appSql = postgres(databaseUrl, {
    max: 2,
    idle_timeout: 5,
    connect_timeout: 5
  });
  await appSql.unsafe(`
    CREATE SCHEMA focowiki_validation;
    CREATE TABLE focowiki_validation.run_owner (
      singleton boolean PRIMARY KEY CHECK (singleton),
      run_id text NOT NULL,
      owner_marker text NOT NULL,
      proof_checksum text NOT NULL,
      target text NOT NULL,
      created_by_run boolean NOT NULL CHECK (created_by_run),
      existed_before_run boolean NOT NULL CHECK (NOT existed_before_run)
    );
  `);
  await appSql`
    INSERT INTO focowiki_validation.run_owner (
      singleton,
      run_id,
      owner_marker,
      proof_checksum,
      target,
      created_by_run,
      existed_before_run
    ) VALUES (
      true,
      ${proof.runId},
      ${proof.ownerMarker},
      ${proof.proofChecksum},
      ${proof.postgresScope},
      true,
      false
    )
  `;

  const objectMarker = serializeStorageVnextOwnerMarker(
    createStorageVnextOwnerMarkerDocument(proof, proof.objectScope)
  );
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: `${proof.objectScope}_run-owner.json`,
    Body: objectMarker,
    ContentType: "application/json"
  }));

  const coordinationMarker = serializeStorageVnextOwnerMarker(
    createStorageVnextOwnerMarkerDocument(proof, proof.coordinationScope)
  );
  const coordinationMarkerResult = await redis.set(
    `${proof.coordinationScope}_run-owner`,
    coordinationMarker,
    { NX: true }
  );
  if (coordinationMarkerResult !== "OK") {
    throw new Error("Run-owned Redis marker already exists");
  }

  const searchReceipt = {
    marker: createStorageVnextOwnerMarkerDocument(proof, proof.searchScope),
    recordedIndexUids: [] as string[],
    recordedTaskUids: [] as number[]
  };
  const proofPath = join(proof.filesystemScope, "storage-vnext-proof.json");
  await writeFile(
    proofPath,
    `${JSON.stringify({
      version: 1,
      proof,
      search: searchReceipt,
      immutableControls: controls
    }, null, 2)}\n`,
    { mode: 0o600, flag: "wx" }
  );

  const bootstrap = await bootstrapStorageVnextOwnedScope({
    proof,
    planes: [
      createStorageVnextSearchPlane({
        client: meilisearch as unknown as StorageVnextOwnedSearchClient,
        receipt: searchReceipt
      }),
      createStorageVnextObjectPlane({ client: s3, bucket }),
      createStorageVnextCoordinationPlane(redis),
      createStorageVnextPostgresPlane({ sql: appSql }),
      createStorageVnextFilesystemPlane("runtime-secrets"),
      createStorageVnextFilesystemPlane("temporary-files")
    ]
  });

  process.stdout.write(`${JSON.stringify({
    runId,
    proofPath,
    databaseUrl,
    s3Prefix: proof.objectScope.replace(/\/$/u, ""),
    meiliIndexPrefix: proof.searchScope,
    coordinationPrefix: proof.coordinationScope,
    logDirectory: join(proof.filesystemScope, "logs"),
    bootstrap,
    immutableControlCounts: {
      databases: controls.postgres.databases.length,
      knowledgeBases: controls.postgres.knowledgeBases.length,
      redisKeys: controls.redis.keys.length,
      s3Versions: controls.s3.versions.length,
      s3MultipartUploads: controls.s3.multipartUploads.length,
      meilisearchIndexes: controls.meilisearch.indexes.length,
      meilisearchTasks: controls.meilisearch.tasks.length
    }
  }, null, 2)}\n`);
} finally {
  await Promise.allSettled([
    appSql?.end({ timeout: 5 }) ?? Promise.resolve(),
    adminSql.end({ timeout: 5 }),
    redis.isOpen ? redis.quit() : Promise.resolve()
  ]);
  s3.destroy();
}

async function captureImmutableControls() {
  const [databases, knowledgeBases, redisKeys, s3Inventory, versioning, indexes, tasks] =
    await Promise.all([
      adminSql<Array<{ name: string }>>`
        SELECT datname AS name
        FROM pg_database
        WHERE datistemplate = false
        ORDER BY datname
      `,
      captureExistingKnowledgeBases(),
      listRedisKeys("*"),
      listS3Inventory(""),
      s3.send(new GetBucketVersioningCommand({ Bucket: bucket })),
      listMeilisearchIndexes(),
      meilisearch.tasks.getTasks({ limit: 1_000 })
    ]);

  if (versioning.Status !== "Enabled") {
    throw new Error("Validation S3 bucket versioning must be enabled");
  }

  return {
    capturedAt: new Date().toISOString(),
    postgres: {
      databases: databases.map((row) => row.name),
      knowledgeBases
    },
    redis: { keys: redisKeys },
    s3: s3Inventory,
    meilisearch: {
      indexes,
      tasks: tasks.results.map((task) => ({ uid: task.uid, status: task.status }))
    },
    filesystem: {
      runRootExisted: await pathExists(proof.filesystemScope)
    }
  };
}

async function captureExistingKnowledgeBases(): Promise<Array<{
  database: string;
  ids: string[];
}>> {
  const results: Array<{ database: string; ids: string[] }> = [];
  const databases = await adminSql<Array<{ name: string }>>`
    SELECT datname AS name
    FROM pg_database
    WHERE datistemplate = false
      AND datallowconn = true
    ORDER BY datname
  `;
  for (const database of databases) {
    const sql = postgres(databaseUrlFor(adminDatabaseUrl, database.name), {
      max: 1,
      idle_timeout: 2,
      connect_timeout: 2
    });
    try {
      const relation = await sql<Array<{ exists: boolean }>>`
        SELECT to_regclass('focowiki.knowledge_bases') IS NOT NULL AS exists
      `;
      if (!relation[0]?.exists) continue;
      const rows = await sql<Array<{ id: string }>>`
        SELECT public_id AS id
        FROM focowiki.knowledge_bases
        ORDER BY public_id
      `;
      results.push({ database: database.name, ids: rows.map((row) => row.id) });
    } finally {
      await sql.end({ timeout: 2 });
    }
  }
  return results;
}

function assertFreshOwnedTargets(controls: Awaited<ReturnType<typeof captureImmutableControls>>): void {
  if (
    controls.postgres.databases.includes(proof.postgresScope)
    || controls.redis.keys.some((key) => key.startsWith(proof.coordinationScope))
    || controls.s3.versions.some((entry) => entry.key.startsWith(proof.objectScope))
    || controls.s3.multipartUploads.some((entry) => entry.key.startsWith(proof.objectScope))
    || controls.meilisearch.indexes.some((uid) => uid.startsWith(proof.searchScope))
    || controls.filesystem.runRootExisted
  ) {
    throw new Error("Validation run-owned scope already exists or is not empty");
  }
}

async function listRedisKeys(match: string): Promise<string[]> {
  const keys = new Set<string>();
  for await (const result of redis.scanIterator({ MATCH: match, COUNT: 500 })) {
    for (const key of Array.isArray(result) ? result : [result]) keys.add(key);
  }
  return [...keys].sort();
}

async function listS3Inventory(prefix: string) {
  const versions: Array<{
    key: string;
    versionId: string;
    isLatest: boolean;
    deleteMarker: boolean;
    size: number;
  }> = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: prefix,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
      MaxKeys: 1_000
    }));
    for (const entry of page.Versions ?? []) {
      if (!entry.Key || !entry.VersionId) continue;
      versions.push({
        key: entry.Key,
        versionId: entry.VersionId,
        isLatest: entry.IsLatest === true,
        deleteMarker: false,
        size: entry.Size ?? 0
      });
    }
    for (const entry of page.DeleteMarkers ?? []) {
      if (!entry.Key || !entry.VersionId) continue;
      versions.push({
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

  const multipartUploads: Array<{ key: string; uploadId: string }> = [];
  let uploadKeyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  do {
    const page = await s3.send(new ListMultipartUploadsCommand({
      Bucket: bucket,
      Prefix: prefix,
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

  return { versions, multipartUploads };
}

async function listMeilisearchIndexes(): Promise<string[]> {
  const indexes: string[] = [];
  let offset = 0;
  const limit = 1_000;
  while (true) {
    const page = await meilisearch.getRawIndexes({ offset, limit });
    indexes.push(...page.results.map((index) => index.uid));
    offset += page.results.length;
    if (offset >= page.total) return [...new Set(indexes)].sort();
    if (page.results.length === 0) {
      throw new Error("Meilisearch index inventory pagination is incomplete");
    }
  }
}

function databaseUrlFor(value: string, database: string): string {
  const url = new URL(value);
  url.pathname = `/${database}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}
