import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createDocumentProjectionCleanupRuntime } from
  "../src/document-indexing/application/document-projection-cleanup-runtime.js";
import { createPostgresProjectionCleanupOutbox } from
  "../src/document-indexing/infrastructure/postgres-projection-cleanup-outbox.js";
import { createPostgresProjectionDirtyScopeRepository } from
  "../src/document-indexing/infrastructure/postgres-projection-dirty-scope-repository.js";
import { createPostgresProjectionScopeOutputRepository } from
  "../src/document-indexing/infrastructure/postgres-projection-scope-output-repository.js";
import { createPostgresStorageVnextOwnershipRepository } from
  "../src/storage-vnext/ownership/postgres-repository.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("projection lease and cleanup", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_projection_fence_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 4 });
  const database = sql as unknown as DatabaseClient;
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quote(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await seed(sql);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(databaseName)} WITH (FORCE)`);
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("heartbeats long work, fences stale output, and reuses persisted output",
    async () => {
      const scopes = createPostgresProjectionDirtyScopeRepository(database);
      const outputs = createPostgresProjectionScopeOutputRepository(database);
      const first = (await scopes.claim({
        workerId: "worker-a",
        now: "2026-08-21T10:00:00.000Z",
        leaseDurationMs: 30_000,
        limit: 1
      }))[0]!;
      expect(first.leaseGeneration).toBe(1);
      await expect(scopes.heartbeat({
        publicId: first.publicId,
        workerId: "worker-a",
        leaseGeneration: first.leaseGeneration,
        now: "2026-08-21T10:00:20.000Z",
        leaseDurationMs: 30_000
      })).resolves.toBe(true);
      await expect(scopes.recoverExpired({
        now: "2026-08-21T10:00:31.000Z",
        retryAt: "2026-08-21T10:00:31.000Z",
        limit: 10
      })).resolves.toBe(0);
      await expect(scopes.recoverExpired({
        now: "2026-08-21T10:00:51.000Z",
        retryAt: "2026-08-21T10:00:51.000Z",
        limit: 10
      })).resolves.toBe(1);
      const second = (await scopes.claim({
        workerId: "worker-b",
        now: "2026-08-21T10:00:51.000Z",
        leaseDurationMs: 30_000,
        limit: 1
      }))[0]!;
      expect(second.leaseGeneration).toBe(2);

      await expect(outputs.persist(output({
        leaseOwner: "worker-a",
        leaseGeneration: first.leaseGeneration,
        leaseCheckedAt: "2026-08-21T10:00:51.500Z"
      }))).rejects.toMatchObject({
        code: "projection_scope_lease_lost"
      });
      await expect(outputs.persist(output({
        leaseOwner: "worker-b",
        leaseGeneration: second.leaseGeneration,
        leaseCheckedAt: "2026-08-21T10:00:51.500Z",
        cleanupReservations: [{
          objectId: objectId("a"),
          writeAttemptPublicId: "projection-write-a"
        }]
      }))).resolves.toBeUndefined();
      await expect(outputs.read({
        scopePublicId: "lease-scope",
        renderedSequence: 1
      })).resolves.toMatchObject({
        outputFingerprintSha256: "b".repeat(64)
      });
    });

  it("allows only one replica to claim a scope generation", async () => {
    await sql`
      INSERT INTO focowiki.projection_dirty_scopes (
        public_id, knowledge_base_id, scope_kind, scope_key,
        required_sequence, completed_sequence, state, next_eligible_at,
        coalesce_until
      ) VALUES (
        'replica-scope', 'lease-kb', 'root', 'replica',
        1, 0, 'waiting', '2026-08-21T11:00:00Z', '2026-08-21T11:00:00Z'
      )
    `;
    const left = createPostgresProjectionDirtyScopeRepository(database);
    const right = createPostgresProjectionDirtyScopeRepository(database);
    const claims = await Promise.all([
      left.claim({
        workerId: "replica-a", now: "2026-08-21T11:00:01.000Z",
        leaseDurationMs: 30_000, limit: 1
      }),
      right.claim({
        workerId: "replica-b", now: "2026-08-21T11:00:01.000Z",
        leaseDurationMs: 30_000, limit: 1
      })
    ]);
    expect(claims.flat()).toHaveLength(1);
  });

  it("replays cleanup after a crash and isolates permanent cleanup debt",
    async () => {
      let now = "2026-08-21T10:00:52.000Z";
      const outbox = createPostgresProjectionCleanupOutbox(database);
      const transient = createDocumentProjectionCleanupRuntime({
        workerId: "cleanup-a",
        leaseDurationMs: 30_000,
        concurrency: 1,
        retryDelayMs: 1_000,
        outbox,
        ownership: {
          releaseVerifiedReservation: vi.fn(async () => {
            throw Object.assign(new Error("temporary"), {
              code: "provider_unavailable"
            });
          })
        },
        now: () => now,
        wait: async () => undefined
      });
      await expect(transient.runOnce(new AbortController().signal))
        .resolves.toBe(1);
      now = "2026-08-21T10:00:53.000Z";
      const replay = createDocumentProjectionCleanupRuntime({
        workerId: "cleanup-b",
        leaseDurationMs: 30_000,
        concurrency: 1,
        retryDelayMs: 1_000,
        outbox,
        ownership: createPostgresStorageVnextOwnershipRepository(database),
        now: () => now,
        wait: async () => undefined
      });
      await expect(replay.runOnce(new AbortController().signal)).resolves.toBe(1);
      await expect(sql<Array<{
        state: string;
        reservation_expires_at: Date | null;
      }>>`
        SELECT outbox.state, registration.reservation_expires_at
        FROM focowiki.projection_cleanup_outbox outbox
        JOIN focowiki.object_registrations registration
          ON registration.object_id = outbox.object_id
        WHERE outbox.scope_public_id = 'lease-scope'
      `).resolves.toEqual([{
        state: "completed",
        reservation_expires_at: null
      }]);

      await sql`
        INSERT INTO focowiki.projection_cleanup_outbox (
          public_id, knowledge_base_id, scope_public_id, rendered_sequence,
          object_id, write_attempt_public_id, maximum_attempts,
          next_eligible_at, created_at, updated_at
        ) VALUES (
          'cleanup-permanent', 'lease-kb', 'lease-scope', 1,
          ${objectId("c")}, 'projection-write-c', 1,
          ${now}, ${now}, ${now}
        )
      `;
      const permanent = createDocumentProjectionCleanupRuntime({
        workerId: "cleanup-c",
        leaseDurationMs: 30_000,
        concurrency: 1,
        retryDelayMs: 1_000,
        outbox,
        ownership: {
          releaseVerifiedReservation: vi.fn(async () => {
            throw Object.assign(new Error("permanent"), { code: "denied" });
          })
        },
        now: () => now,
        wait: async () => undefined
      });
      await permanent.runOnce(new AbortController().signal);
      await expect(sql<Array<{ state: string }>>`
        SELECT state FROM focowiki.projection_cleanup_outbox
        WHERE public_id = 'cleanup-permanent'
      `).resolves.toEqual([{ state: "error" }]);
      await expect(sql<Array<{ state: string }>>`
        SELECT state FROM focowiki.document_processing_jobs
        WHERE public_id = 'lease-job'
      `).resolves.toEqual([{ state: "available" }]);
    });
});

function output(fence: {
  leaseOwner: string;
  leaseGeneration: number;
  leaseCheckedAt: string;
  cleanupReservations?: readonly {
    objectId: string;
    writeAttemptPublicId: string;
  }[];
}) {
  return {
    scopePublicId: "lease-scope",
    renderedSequence: 1,
    knowledgeBaseId: "lease-kb",
    outputFingerprintSha256: "b".repeat(64),
    pages: [{
      logicalPath: "index.md",
      normalizedPath: "index.md",
      entryKind: "root-index",
      sourceFilePublicId: null,
      sourceRevisionPublicId: null,
      objectId: objectId("a"),
      checksumSha256: "a".repeat(64),
      byteCount: 32
    }],
    removedNormalizedPaths: [],
    navigationMutations: [],
    activationOwnerVersions: [],
    createdAt: "2026-08-21T10:00:51.500Z",
    ...fence
  };
}

async function seed(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
    VALUES ('lease-kb', 'Lease', 1)
  `;
  await sql.begin(async (transaction) => {
    await transaction`SET LOCAL session_replication_role = replica`;
    await transaction`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, completed_at
      ) VALUES (
        'lease-operation', 'lease-kb', 'source_upload', 'completed',
        'source_file', 'lease-source', now()
      )
    `;
    await transaction`
      INSERT INTO focowiki.document_processing_jobs (
        public_id, knowledge_base_id, operation_public_id,
        source_file_public_id, source_revision_public_id,
        runtime_settings_revision_public_id,
        generation_model_configuration_public_id,
        generation_model_configuration_revision,
        embedding_configuration_revision_public_id,
        semantic_generation_public_id, semantic_contract_version,
        state, maximum_attempts, accepted_at, started_at, terminal_at
      ) VALUES (
        'lease-job', 'lease-kb', 'lease-operation', 'lease-source',
        'lease-revision', 'settings', 'model', 1, 'embedding', 'semantic',
        'contract', 'available', 3, now(), now(), now()
      )
    `;
  });
  await sql`
    INSERT INTO focowiki.projection_dirty_scopes (
      public_id, knowledge_base_id, scope_kind, scope_key,
      required_sequence, completed_sequence, state, next_eligible_at,
      coalesce_until
    ) VALUES (
      'lease-scope', 'lease-kb', 'root', 'index',
      1, 0, 'waiting', '2026-08-21T10:00:00Z', '2026-08-21T10:00:00Z'
    )
  `;
  await sql`
    INSERT INTO focowiki.object_registrations (
      object_id, storage_key, checksum_sha256, byte_count, content_type,
      object_format, state, write_attempt_public_id, verified_at,
      reservation_expires_at
    ) VALUES (
      ${objectId("a")}, 'generated/a.md', ${"a".repeat(64)}, 32,
      'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
      'verified', 'projection-write-a', '2026-08-21T09:00:00Z',
      '2026-08-21T12:00:00Z'
    ), (
      ${objectId("c")}, 'generated/c.md', ${"c".repeat(64)}, 32,
      'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
      'verified', 'projection-write-c', '2026-08-21T09:00:00Z',
      '2026-08-21T12:00:00Z'
    )
  `;
}

function objectId(seed: string): string {
  return `generated-sha256:okf-generated-markdown-v1:${seed.repeat(64)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
