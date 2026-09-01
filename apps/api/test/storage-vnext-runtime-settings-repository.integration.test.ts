import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeSettingsRepository } from
  "../src/runtime-settings/repository.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase("storage vNext runtime settings revision repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_settings_${ownerToken}_${randomUUID()
    .replaceAll("-", "").slice(0, 10)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 6 });
  const repository = createRuntimeSettingsRepository(sql);
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
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
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    await repository.createAuditLog({
      settingKey: "worker",
      action: "update",
      actor: "admin",
      value: { sourceFileConcurrency: 2 },
      expiresAt
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
    expect(paused).toMatchObject({
      status: "paused",
      isActive: false,
      configurationRevision: created.configurationRevision
    });
    expect(await repository.getActiveModel()).toBeNull();

    const activated = await repository.setActiveModel(created.id);
    expect(activated).toMatchObject({
      status: "active",
      isActive: true,
      configurationRevision: created.configurationRevision
    });
    const modelConfigurationRevision = created.configurationRevision;
    if (typeof modelConfigurationRevision !== "number"
      || !Number.isSafeInteger(modelConfigurationRevision)) {
      throw new Error("Model configuration revision is missing");
    }

    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('kb-model-running-work', 'Model running work', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('kb-model-running-work', 0)
    `;
    await sql`
      INSERT INTO focowiki.embedding_configurations (
        public_id, display_name, lifecycle_status, revision
      ) VALUES ('embedding-model-running-work', 'Embedding', 'active', 1)
    `;
    await sql`
      INSERT INTO focowiki.embedding_configuration_revisions (
        public_id, configuration_public_id, revision_number,
        authentication_mode, base_url, model_name, requested_dimension,
        resolved_dimension, normalization, maximum_input_tokens, batch_size,
        timeout_ms, retry_count, minimum_interval_ms, concurrency,
        maximum_response_bytes, minimum_vector_relevance,
        vector_producing_revision_public_id, validation_status,
        validation_fingerprint_sha256, validated_at
      ) VALUES (
        'embedding-revision-model-running-work', 'embedding-model-running-work', 1,
        'none', 'http://embedding.local/v1', 'embedding-model', 3, 3, 'l2',
        8192, 16, 5000, 1, 0, 2, 1048576, 0.7,
        'embedding-revision-model-running-work', 'valid', ${"d".repeat(64)}, now()
      )
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state, completed_at
      ) VALUES (
        'operation-semantic-model-running-work', 'kb-model-running-work',
        'semantic_contract_bootstrap', 'completed', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.semantic_generations (
        public_id, knowledge_base_id, operation_public_id,
        expected_predecessor_public_id, generation_role, state,
        generation_model_configuration_public_id,
        generation_model_configuration_revision,
        extraction_contract_version, graph_schema_version,
        prompt_contract_version, contract_fingerprint_sha256,
        revision, activated_at
      ) VALUES (
        'semantic-generation-model-running-work', 'kb-model-running-work',
        'operation-semantic-model-running-work', NULL, 'active', 'active',
        ${created.id}, ${modelConfigurationRevision},
        'extract-v1', 'graph-v1', 'prompt-v1', ${"e".repeat(64)}, 1, now()
      )
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.runtime_setting_revisions (
          public_id, checksum_sha256, settings_values
        ) VALUES (
          'settings-model-running-work', ${"b".repeat(64)}, '{}'::jsonb
        )
      `;
      await transaction`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count,
          content_type, object_format, state, write_attempt_public_id, verified_at
        ) VALUES (
          'object-model-running-work', 'tests/running.md', ${"c".repeat(64)}, 10,
          'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
          'write-model-running-work', now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_files (
          public_id, knowledge_base_id, logical_path, normalized_path,
          title, revision
        ) VALUES (
          'file-model-running-work', 'kb-model-running-work',
          'running.md', 'running.md', 'Running', 1
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          public_id, knowledge_base_id, source_file_public_id, object_id,
          checksum_sha256, byte_count, content_type
        ) VALUES (
          'revision-model-running-work', 'kb-model-running-work',
          'file-model-running-work', 'object-model-running-work',
          ${"c".repeat(64)}, 10, 'text/markdown; charset=utf-8'
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_file_active_revisions (
          knowledge_base_id, source_file_public_id,
          current_source_revision_public_id, active_source_revision_public_id
        ) VALUES (
          'kb-model-running-work', 'file-model-running-work',
          'revision-model-running-work', NULL
        )
      `;
      await transaction`
        INSERT INTO focowiki.operations (
          public_id, knowledge_base_id, operation_kind, state,
          target_kind, target_public_id
        ) VALUES (
          'operation-model-running-work', 'kb-model-running-work',
          'source_processing', 'processing', 'source_file',
          'file-model-running-work'
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
          semantic_generation_public_id,
          semantic_contract_version, state, attempt_count,
          failure_count, total_attempt_count, maximum_attempts,
          required_work_count, completed_work_count,
          active_work_kinds, blocking_work_kind, retryable,
          accepted_at, started_at
        ) VALUES (
          'document-job-model-running-work', 'kb-model-running-work',
          'operation-model-running-work', 'file-model-running-work',
          'revision-model-running-work', 'settings-model-running-work',
          ${created.id}, ${modelConfigurationRevision},
          'embedding-revision-model-running-work',
          'semantic-generation-model-running-work',
          'semantic-contract-v1', 'processing', 1,
          0, 1, 3, 8, 0, ARRAY['first_layer']::text[], 'first_layer',
          false, now(), now()
        )
      `;
    });
    expect(await repository.countRunningModelInvocations(created.id)).toBe(1);

    const deleted = await repository.softDeleteModel(created.id);
    expect(deleted).toMatchObject({
      id: created.id,
      status: "deleted",
      isActive: false
    });
    expect(deleted?.deletedAt).not.toBeNull();
    expect(await repository.getModel(created.id)).toBeNull();
    expect(await repository.listModels()).toEqual([]);
    const persistedDeletion = await sql<Array<{
      status: string;
      enabled: boolean;
      row_count: number | string;
    }>>`
      SELECT config ->> 'status' AS status, enabled,
             count(*) OVER () AS row_count
      FROM focowiki.model_configs
      WHERE public_id = ${created.id}
    `;
    expect(persistedDeletion).toEqual([expect.objectContaining({
      status: "deleted",
      enabled: false,
      row_count: "1"
    })]);
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

});


function databaseConnectionUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
