import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeSettingsRepository } from
  "../src/runtime-settings/repository.js";
import { createPostgresStorageVnextWorkflowRepository } from
  "../src/storage-vnext/workflow/postgres-repository.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;
const bootstrap = readFileSync(
  resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
  "utf8"
);

describeOwnedDatabase("storage vNext runtime settings revision repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_settings_${ownerToken}_${randomUUID()
    .replaceAll("-", "").slice(0, 10)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 6 });
  const repository = createRuntimeSettingsRepository(sql);
  const workflow = createPostgresStorageVnextWorkflowRepository(sql);
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await sql.unsafe(bootstrap);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("persists immutable complete revisions behind one current pointer", async () => {
    const worker = await repository.upsertSetting({
      key: "worker",
      value: { sourceFileConcurrency: 2 },
      source: "bootstrap"
    });
    const firstIdentity = await repository.getCurrentRevision();
    const search = await repository.upsertSetting({
      key: "search",
      value: { maxInFlightTasks: 4 },
      source: "admin"
    });
    const secondIdentity = await repository.getCurrentRevision();

    expect(worker.version).toBe(1);
    expect(search.version).toBe(2);
    expect(firstIdentity?.publicId).not.toBe(secondIdentity?.publicId);
    expect(await repository.listSettings()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "worker",
        value: { sourceFileConcurrency: 2 },
        version: 2
      }),
      expect.objectContaining({
        key: "search",
        value: { maxInFlightTasks: 4 },
        version: 2
      })
    ]));

    await Promise.all([
      repository.upsertSetting({
        key: "graph",
        value: { candidateLimit: 100 },
        source: "admin"
      }),
      repository.upsertSetting({
        key: "maintenance",
        value: { scanBatchSize: 500 },
        source: "admin"
      })
    ]);
    const current = await repository.getCurrentRevision();
    expect(current?.version).toBe(4);
    expect((await repository.listSettings()).map((item) => item.key)).toEqual([
      "worker",
      "graph",
      "maintenance",
      "search"
    ]);

    const counts = await sql<Array<{
      revisions: number | string;
      current_pointers: number | string;
    }>>`
      SELECT
        (SELECT count(*) FROM focowiki.runtime_setting_revisions) AS revisions,
        (SELECT count(*) FROM focowiki.runtime_setting_current) AS current_pointers
    `;
    expect(Number(counts[0]?.revisions)).toBe(4);
    expect(Number(counts[0]?.current_pointers)).toBe(1);

    await expect(sql`
      UPDATE focowiki.runtime_setting_revisions
      SET settings_values = settings_values || '{"tampered":true}'::jsonb
      WHERE public_id = ${current?.publicId ?? "missing"}
    `).rejects.toMatchObject({ code: "23514" });
  });

  it("writes bounded security audit and exposes the live-work revision foreign key", async () => {
    await repository.createAuditLog({
      settingKey: "worker",
      action: "update",
      actor: "admin",
      value: { sourceFileConcurrency: 2 },
      expiresAt: "2026-09-01T00:00:00.000Z"
    });
    const audit = await sql<Array<{
      event_type: string;
      target_kind: string;
      target_public_id: string;
      metadata: Record<string, unknown>;
    }>>`
      SELECT event_type, target_kind, target_public_id, metadata
      FROM focowiki.security_audit_events
      WHERE event_type = 'runtime_settings.update'
    `;
    expect(audit).toEqual([expect.objectContaining({
      event_type: "runtime_settings.update",
      target_kind: "runtime_setting",
      target_public_id: "worker",
      metadata: { settingKey: "worker", action: "update" }
    })]);

    const constraints = await sql<Array<{
      definition: string;
      target_matches: boolean;
    }>>`
      SELECT pg_get_constraintdef(c.oid) AS definition,
             c.confrelid
               = 'focowiki.runtime_setting_revisions'::regclass
               AS target_matches
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'focowiki'
        AND c.conname = 'operation_work_items_settings_fkey'
    `;
    expect(constraints).toEqual([expect.objectContaining({
      definition: expect.stringContaining(
        "FOREIGN KEY (settings_revision_public_id)"
      ),
      target_matches: true
    })]);
  });

  it("persists model settings through the storage vNext model config contract", async () => {
    const created = await repository.createModel({
      displayName: "Primary model",
      apiMode: "responses",
      baseUrl: "https://api.example.com/v1",
      encryptedApiKey: "encrypted-api-key",
      apiKeyFingerprint: "fingerprint",
      modelName: "example-model",
      contextWindowTokens: 128_000,
      requestMaxTimeoutMs: 600_000,
      requestIdleTimeoutMs: 120_000,
      suggestionConcurrency: 2,
      transientRetryDelayMs: 60_000,
      requestMinIntervalMs: 2_000,
      isActive: true
    });

    expect(created).toMatchObject({
      displayName: "Primary model",
      apiMode: "responses",
      modelName: "example-model",
      status: "active",
      isActive: true,
      deletedAt: null
    });
    expect(await repository.listModels()).toEqual([created]);
    expect(await repository.getActiveModel()).toEqual(created);

    const paused = await repository.setModelStatus({
      id: created.id,
      status: "paused"
    });
    expect(paused).toMatchObject({ status: "paused", isActive: false });
    expect(await repository.getActiveModel()).toBeNull();

    const activated = await repository.setActiveModel(created.id);
    expect(activated).toMatchObject({ status: "active", isActive: true });

    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('kb-model-running-work', 'Model running work', 1)
    `;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, status, revision
      ) VALUES (
        'file-model-running-work', 'kb-model-running-work',
        'running.md', 'running.md', 'Running', 'processing', 1
      )
    `;
    expect(await repository.countRunningModelInvocations(created.id)).toBe(1);
    expect(await repository.countRunningSourceFileJobs()).toBe(1);

    const deleted = await repository.softDeleteModel(created.id);
    expect(deleted).toMatchObject({
      id: created.id,
      status: "deleted",
      isActive: false
    });
    expect(deleted?.deletedAt).not.toBeNull();
    expect(await repository.getModel(created.id)).toBeNull();
    expect(await repository.listModels()).toEqual([]);
  });

  it("does not rewrite a pinned model revision when another model becomes active", async () => {
    const pinned = await repository.createModel({
      displayName: "Pinned model",
      apiMode: "responses",
      baseUrl: "https://api.example.com/v1",
      encryptedApiKey: "encrypted-pinned-key",
      apiKeyFingerprint: "pinned-fingerprint",
      modelName: "pinned-model",
      contextWindowTokens: 128_000,
      requestMaxTimeoutMs: 600_000,
      requestIdleTimeoutMs: 120_000,
      suggestionConcurrency: 2,
      transientRetryDelayMs: 60_000,
      requestMinIntervalMs: 2_000,
      isActive: true
    });
    const replacement = await repository.createModel({
      displayName: "Replacement model",
      apiMode: "responses",
      baseUrl: "https://api.example.com/v1",
      encryptedApiKey: "encrypted-replacement-key",
      apiKeyFingerprint: "replacement-fingerprint",
      modelName: "replacement-model",
      contextWindowTokens: 128_000,
      requestMaxTimeoutMs: 600_000,
      requestIdleTimeoutMs: 120_000,
      suggestionConcurrency: 2,
      transientRetryDelayMs: 60_000,
      requestMinIntervalMs: 2_000,
      isActive: false
    });

    await repository.setActiveModel(replacement.id);

    expect(await repository.getModel(pinned.id)).toMatchObject({
      id: pinned.id,
      configurationRevision: pinned.configurationRevision,
      isActive: false,
      status: "active"
    });
  });

  it("keeps accepted work on its revision while later work uses the new revision", async () => {
    const first = await repository.upsertSetting({
      key: "worker",
      value: { sourceFileConcurrency: 2 },
      source: "bootstrap"
    });
    const firstRevision = await repository.getCurrentRevision();
    expect(firstRevision).not.toBeNull();
    expect(first.version).toBe(firstRevision?.version);

    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('kb-settings-revision-isolation', 'Settings revision isolation', 1)
    `;
    await sql`
      INSERT INTO focowiki.release_roots (
        public_id, knowledge_base_id, root_role,
        manifest_checksum_sha256, revision
      ) VALUES (
        'root-settings-revision-active', 'kb-settings-revision-isolation',
        'active', ${"a".repeat(64)}, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.search_projections (
        public_id, knowledge_base_id, projection_role, provider_kind,
        provider_index_uid,
        schema_checksum_sha256, settings_checksum_sha256,
        document_checksum_sha256, revision, document_count, state
      ) VALUES (
        'search-settings-revision-active', 'kb-settings-revision-isolation',
        'active', 'meilisearch',
        'focowiki_kb_settings_revision_isolation_active',
        ${"b".repeat(64)}, ${"c".repeat(64)}, ${"d".repeat(64)}, 1, 2, 'ready'
      )
    `;
    await workflow.enqueue(liveWork({
      publicId: "operation-before-settings-update",
      settingsRevisionPublicId: firstRevision!.publicId,
      idempotencyKey: "before-settings-update"
    }));

    await repository.upsertSetting({
      key: "search",
      value: { maxInFlightTasks: 4 },
      source: "admin"
    });
    const secondRevision = await repository.getCurrentRevision();
    expect(secondRevision?.version).toBe((firstRevision?.version ?? 0) + 1);
    await workflow.enqueue(liveWork({
      publicId: "operation-after-settings-update",
      settingsRevisionPublicId: secondRevision!.publicId,
      idempotencyKey: "after-settings-update"
    }));

    const claimed = await workflow.claim({
      kinds: ["source"],
      owner: "settings-revision-worker",
      limit: 2,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    expect(claimed).toHaveLength(2);
    expect(Object.fromEntries(claimed.map((work) => [
      work.publicId,
      work.settingsRevisionPublicId
    ]))).toEqual({
      "operation-before-settings-update": firstRevision!.publicId,
      "operation-after-settings-update": secondRevision!.publicId
    });

    const authority = await sql<Array<{
      active_roots: number | string;
      active_indexes: number | string;
      candidate_indexes: number | string;
      provider_index_uid: string;
      document_count: number | string;
    }>>`
      SELECT
        (SELECT count(*) FROM focowiki.release_roots
          WHERE knowledge_base_id = 'kb-settings-revision-isolation'
            AND root_role = 'active') AS active_roots,
        (SELECT count(*) FROM focowiki.search_projections
          WHERE knowledge_base_id = 'kb-settings-revision-isolation'
            AND projection_role = 'active') AS active_indexes,
        (SELECT count(*) FROM focowiki.search_projections
          WHERE knowledge_base_id = 'kb-settings-revision-isolation'
            AND projection_role = 'candidate') AS candidate_indexes,
        projection.provider_index_uid,
        projection.document_count
      FROM focowiki.search_projections projection
      WHERE projection.knowledge_base_id = 'kb-settings-revision-isolation'
        AND projection.projection_role = 'active'
    `;
    expect(authority[0]).toMatchObject({
      active_roots: "1",
      active_indexes: "1",
      candidate_indexes: "0",
      provider_index_uid: "focowiki_kb_settings_revision_isolation_active",
      document_count: "2"
    });
  });
});

function liveWork(input: {
  publicId: string;
  settingsRevisionPublicId: string;
  idempotencyKey: string;
}) {
  return {
    publicId: input.publicId,
    knowledgeBaseId: "kb-settings-revision-isolation",
    kind: "source" as const,
    searchProviderKind: null,
    state: "queued" as const,
    operationRevision: 1,
    settingsRevisionPublicId: input.settingsRevisionPublicId,
    attempt: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    nextAttemptAt: null,
    safeErrorCode: null,
    checkpoint: {},
    idempotency: {
      key: input.idempotencyKey,
      requestHash: createHash(input.publicId),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    }
  };
}

function createHash(value: string): string {
  return Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64);
}

function databaseConnectionUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
