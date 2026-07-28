import {
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { applyMigrations } from "../src/db/migrations.js";
import { createImmutableObjectKey } from "../src/domain/generation.js";
import { createPostgresObjectProtectionRepository } from "../src/infrastructure/postgres/object-protection-repository.js";
import { createPostgresStorageReconciliationRepository } from "../src/infrastructure/postgres/storage-reconciliation-repository.js";
import { runObjectProtectionMaintenanceSlice } from "../src/maintenance/object-protection-maintenance.js";
import {
  runStorageReconciliationSlice,
  type StorageReconciliationSliceResult
} from "../src/maintenance/storage-reconciliation.js";
import {
  createS3ClientConfig,
  createS3StorageAdapter
} from "../src/storage/s3.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const s3Endpoint = process.env.FOCOWIKI_TEST_S3_ENDPOINT;
const describeS3 = databaseUrl && s3Endpoint ? describe : describe.skip;
const resolvedDatabaseUrl =
  databaseUrl ?? "postgres://unused:unused@127.0.0.1:1/unused";

describeS3("storage reconciliation with S3-compatible storage", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = `focowiki_s3_reconciliation_${suffix}`;
  const bucket = `focowiki-reconciliation-${suffix}`;
  const prefix = `validation/${suffix}`;
  const knowledgeBaseId = `kb-reconciliation-${suffix}`;
  const storageConfig: RuntimeConfig["storage"] = {
    endpoint: s3Endpoint ?? "http://127.0.0.1:49000",
    region: process.env.FOCOWIKI_TEST_S3_REGION ?? "us-east-1",
    bucket,
    accessKeyId: process.env.FOCOWIKI_TEST_S3_ACCESS_KEY_ID ?? "unused",
    secretAccessKey: process.env.FOCOWIKI_TEST_S3_SECRET_ACCESS_KEY ?? "unused",
    prefix,
    forcePathStyle: true
  };
  const s3 = new S3Client(createS3ClientConfig(storageConfig));
  const storage = createS3StorageAdapter(storageConfig, s3);
  const admin = postgres(databaseConnectionUrl(resolvedDatabaseUrl, "postgres"), {
    max: 1,
    onnotice: () => {}
  });
  const sql = postgres(databaseConnectionUrl(resolvedDatabaseUrl, databaseName), {
    max: 4,
    onnotice: () => {}
  });
  const protection = createPostgresObjectProtectionRepository(sql);
  const reconciliation = createPostgresStorageReconciliationRepository(sql);
  let bucketCreated = false;
  let databaseCreated = false;

  const checksums = {
    protected: "11".repeat(32),
    retained: "22".repeat(32),
    reserved: "33".repeat(32),
    missing: "44".repeat(32),
    unregistered: "55".repeat(32),
    versioned: "66".repeat(32)
  };
  const keys = Object.fromEntries(
    Object.entries(checksums).map(([name, checksumSha256]) => [
      name,
      createImmutableObjectKey({ prefix, checksumSha256 })
    ])
  ) as Record<keyof typeof checksums, string>;
  const invalidManagedKey = `${prefix}/generated/not-an-immutable-object`;
  const outsidePrefixKey = `outside/${suffix}/generated/v1/objects/77/${"77".repeat(32)}`;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyMigrations(sql);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    bucketCreated = true;
    await s3.send(new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: "Enabled" }
    }));
  }, 120_000);

  afterAll(async () => {
    if (bucketCreated) {
      await storage.purgePrefix(`${prefix}/`).catch(() => undefined);
      await storage.purgePrefix(`outside/${suffix}/`).catch(() => undefined);
      await s3.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
    }
    s3.destroy();
    await sql.end({ timeout: 5 }).catch(() => undefined);
    if (databaseCreated) {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
      ).catch(() => undefined);
    }
    await admin.end({ timeout: 5 }).catch(() => undefined);
  });

  it("preserves authoritative objects and removes only confirmed storage orphans", async () => {
    await seedAuthoritativeObjects();
    await seedStorageObjects();
    await completeProtectionBackfill();

    let clock = new Date("2090-07-27T00:00:00.000Z");
    const now = () => new Date(clock);
    const first = await completeReconciliationCycle(now);
    expect(first.phase).toBe("completed");

    const firstPassCandidates = await sql<Array<{
      object_key: string;
      state: string;
      confirmation_count: number;
    }>>`
      SELECT object_key, state, confirmation_count
      FROM focowiki.storage_reconciliation_candidates
      WHERE prefix = ${`${prefix}/generated/`}
      ORDER BY object_key
    `;
    expect(firstPassCandidates).toEqual([
      expect.objectContaining({
        object_key: keys.unregistered,
        state: "quarantined",
        confirmation_count: 1
      }),
      expect.objectContaining({
        object_key: keys.versioned,
        state: "quarantined",
        confirmation_count: 1
      })
    ]);
    clock = new Date(clock.getTime() + 2_000);
    const second = await completeReconciliationCycle(now);
    expect(second.phase).toBe("completed");

    await expect(storage.headObjectMetadata!(keys.protected)).resolves.not.toBeNull();
    await expect(storage.headObjectMetadata!(keys.retained)).resolves.not.toBeNull();
    await expect(storage.headObjectMetadata!(keys.reserved)).resolves.not.toBeNull();
    await expect(storage.headObjectMetadata!(keys.unregistered)).resolves.toBeNull();
    await expect(storage.headObjectMetadata!(keys.versioned)).resolves.toBeNull();
    await expect(storage.headObjectMetadata!(invalidManagedKey)).resolves.not.toBeNull();
    await expect(storage.headObjectMetadata!(outsidePrefixKey)).resolves.not.toBeNull();

    const versionRows = await s3.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: keys.versioned
    }));
    expect([
      ...(versionRows.Versions ?? []),
      ...(versionRows.DeleteMarkers ?? [])
    ].filter((entry) => entry.Key === keys.versioned)).toEqual([]);

    const missing = await sql<Array<{
      lifecycle_state: string;
      integrity_error_code: string | null;
    }>>`
      SELECT lifecycle_state, integrity_error_code
      FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${checksums.missing}
        AND format_version = 1
    `;
    expect(missing).toEqual([{
      lifecycle_state: "active",
      integrity_error_code: "STORAGE_OBJECT_MISSING"
    }]);

    const deletedCandidates = await sql<Array<{
      object_key: string;
      state: string;
      confirmation_count: number;
    }>>`
      SELECT object_key, state, confirmation_count
      FROM focowiki.storage_reconciliation_candidates
      WHERE prefix = ${`${prefix}/generated/`}
      ORDER BY object_key
    `;
    expect(deletedCandidates).toEqual([
      expect.objectContaining({
        object_key: keys.unregistered,
        state: "deleted",
        confirmation_count: 2
      }),
      expect.objectContaining({
        object_key: keys.versioned,
        state: "deleted",
        confirmation_count: 2
      })
    ]);
  }, 120_000);

  async function seedAuthoritativeObjects(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'S3 reconciliation validation')
    `;
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type,
        size_bytes, lifecycle_state, verified_at
      ) VALUES
        (${checksums.protected}, 1, ${keys.protected}, 'application/json', 9, 'active', now()),
        (${checksums.missing}, 1, ${keys.missing}, 'application/json', 7, 'active', now())
    `;
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type,
        size_bytes, lifecycle_state, write_token, write_started_at,
        write_attempt_count, verified_at
      ) VALUES (
        ${checksums.reserved}, 1, ${keys.reserved}, 'application/json',
        8, 'writing', 'validation-write-token', now(), 1, NULL
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_segments (
        id, knowledge_base_id, projection_kind, logical_partition,
        segment_kind, sequence_number, format_version, checksum_sha256,
        object_key, logical_path, entry_count, encoded_bytes,
        lifecycle_state, ownership_count
      ) VALUES (
        ${`segment-reconciliation-${suffix}`}, ${knowledgeBaseId},
        'search', 'validation/retained', 'base', 0, 1,
        ${checksums.retained}, ${keys.retained},
        '_segments/search/retained.json', 1, 8, 'retained', 0
      )
    `;
  }

  async function seedStorageObjects(): Promise<void> {
    await storage.putObject({ key: keys.protected, body: "protected" });
    await storage.putObject({ key: keys.retained, body: "retained" });
    await storage.putObject({ key: keys.reserved, body: "reserved" });
    await storage.putObject({ key: keys.unregistered, body: "orphan" });
    await storage.putObject({ key: keys.versioned, body: "version-one" });
    await storage.putObject({ key: keys.versioned, body: "version-two" });
    await storage.putObject({ key: invalidManagedKey, body: "invalid" });
    await storage.putObject({ key: outsidePrefixKey, body: "outside" });
  }

  async function completeProtectionBackfill(): Promise<void> {
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const result = await runObjectProtectionMaintenanceSlice({
        repository: protection,
        batchSize: 100,
        leaseToken: `protection-${iteration}`,
        now: () => new Date("2090-07-26T00:00:00.000Z")
      });
      if (result.failed) throw new Error("Object protection backfill failed");
      if (result.completed) return;
    }
    throw new Error("Object protection backfill did not complete");
  }

  async function completeReconciliationCycle(
    now: () => Date
  ): Promise<StorageReconciliationSliceResult> {
    let lastFailure: { operation: string; error: unknown } | null = null;
    const tracedRepository = traceAsyncMethods(
      reconciliation,
      "repository",
      (failure) => {
        lastFailure = failure;
      }
    );
    const tracedStorage = traceAsyncMethods(
      storage,
      "storage",
      (failure) => {
        lastFailure = failure;
      }
    );
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const result = await runStorageReconciliationSlice({
        repository: tracedRepository,
        storage: tracedStorage,
        settings: {
          reconciliationEnabled: true,
          scanIntervalSeconds: 1,
          scanBatchSize: 100,
          deletionBatchSize: 10,
          quarantineGracePeriodSeconds: 0,
          confirmationPasses: 2,
          maxAttempts: 3,
          retryDelayMs: 10
        },
        versionPurgeEnabled: true,
        leaseToken: "s3-reconciliation-lease",
        now
      });
      if (result.phase === "failed") {
        const status = await reconciliation.getStatus(`${prefix}/generated/`);
        const trace = formatTraceFailure(lastFailure);
        throw new Error(
          `Storage reconciliation cycle failed: ${
            status?.lastErrorCode ?? "UNKNOWN"
          }; operation=${trace.operation}; cause=${trace.errorName}`
        );
      }
      if (result.phase === "completed") return result;
    }
    throw new Error("Storage reconciliation cycle did not complete");
  }
});

function databaseConnectionUrl(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function traceAsyncMethods<T extends object>(
  target: T,
  prefix: string,
  onFailure: (failure: { operation: string; error: unknown }) => void
): T {
  return new Proxy(target, {
    get(current, property) {
      const value = Reflect.get(current, property, current);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          return await Reflect.apply(value, current, args);
        } catch (error) {
          onFailure({ operation: `${prefix}.${String(property)}`, error });
          throw error;
        }
      };
    }
  });
}

function readErrorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}

function formatTraceFailure(
  failure: { operation: string; error: unknown } | null
): { operation: string; errorName: string } {
  return {
    operation: failure?.operation ?? "unknown",
    errorName: readErrorName(failure?.error)
  };
}
