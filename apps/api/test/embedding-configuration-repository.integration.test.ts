import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyStorageVnextTestMigrations } from './helpers/storage-vnext-test-migrations.js';
import { createPostgresEmbeddingConfigurationRepository } from '../src/semantic/infrastructure/postgres-embedding-configuration-repository.js';

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(databaseUrl && runOwner && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;

describeOwnedDatabase('embedding configuration PostgreSQL repository', () => {
  const connectionUrl = databaseUrl ?? 'postgres://unused:unused@127.0.0.1:5432/unused';
  const owner = (runOwner ?? 'invalid').replaceAll('-', '_');
  const databaseName = 'focowiki_embedding_' + owner + '_' + randomUUID().replaceAll('-', '').slice(0, 10);
  const admin = postgres(databaseConnectionUrl(connectionUrl, 'postgres'), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 4 });
  const repository = createPostgresEmbeddingConfigurationRepository(sql);
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe('CREATE DATABASE ' + quoteIdentifier(databaseName));
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (databaseCreated) {
      await admin.unsafe('DROP DATABASE IF EXISTS ' + quoteIdentifier(databaseName) + ' WITH (FORCE)');
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it('persists immutable revisions, validation, and lifecycle state', async () => {
    const created = await repository.create({
      configurationPublicId: 'embedding-config-a',
      revisionPublicId: 'embedding-revision-a1',
      ...write('encrypted-v1', 'embedding-revision-a1'),
      createdAt: '2026-08-08T00:00:00.000Z'
    });
    expect(created).toMatchObject({
      revision: 1,
      encryptedApiKey: 'encrypted-v1',
      validationStatus: 'not_tested',
      lifecycleStatus: 'draft'
    });
    const revised = await repository.createRevision({
      configurationPublicId: created.publicId,
      revisionPublicId: 'embedding-revision-a2',
      ...write('encrypted-v1', 'embedding-revision-a2'),
      displayName: 'Embedding revised',
      expectedConfigurationRevision: 1,
      reuseValidationFromRevisionPublicId: null,
      createdAt: '2026-08-08T00:01:00.000Z'
    });
    const revisionRows = await sql<Array<{ public_id: string }>>`
      SELECT public_id FROM focowiki.embedding_configuration_revisions
      WHERE configuration_public_id = 'embedding-config-a'
      ORDER BY revision_number
    `;
    expect(revisionRows.map((row) => row.public_id)).toEqual([
      'embedding-revision-a1',
      'embedding-revision-a2'
    ]);
    await repository.recordValidation({
      configurationPublicId: created.publicId,
      revisionPublicId: revised.revisionPublicId,
      status: 'valid',
      resolvedDimension: 3,
      validationFingerprintSha256: 'a'.repeat(64),
      safeValidationErrorCode: null,
      validatedAt: '2026-08-08T00:02:00.000Z'
    });
    await expect(repository.setLifecycle({
      configurationPublicId: created.publicId,
      status: 'active',
      expectedConfigurationRevision: 2
    })).resolves.toMatchObject({
      lifecycleStatus: 'active',
      revision: 3,
      resolvedDimension: 3
    });
  });

  it('counts active projection references before lifecycle changes', async () => {
    await sql`INSERT INTO focowiki.knowledge_bases (public_id, name, revision) VALUES ('kb-embedding-ref', 'Embedding ref', 1)`;
    await sql`INSERT INTO focowiki.operations (public_id, knowledge_base_id, operation_kind, state) VALUES ('operation-embedding-ref', 'kb-embedding-ref', 'mutation', 'processing')`;
    await sql`
      INSERT INTO focowiki.model_configs (
        public_id, provider, model, secret_reference, config, enabled, revision
      ) VALUES (
        'model-config-test', 'openai-compatible', 'generation-model',
        'runtime-settings:model-config-test', '{}'::jsonb, true, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.semantic_generations (
        public_id, knowledge_base_id, operation_public_id, generation_role,
        state, generation_model_configuration_public_id,
        generation_model_configuration_revision,
        extraction_contract_version, graph_schema_version,
        prompt_contract_version, contract_fingerprint_sha256, revision
      ) VALUES (
        'semantic-embedding-ref', 'kb-embedding-ref', 'operation-embedding-ref',
        'candidate', 'building', 'model-config-test', 1,
        'extract-v1', 'graph-v1', 'prompt-v1',
        ${'b'.repeat(64)}, 0
      )
    `;
    await sql`
      INSERT INTO focowiki.semantic_projection_contracts (
        public_id, knowledge_base_id, semantic_generation_public_id,
        embedding_configuration_revision_public_id,
        search_provider_kind,
        resolved_dimension, normalization, artifact_schema_version,
        vector_schema_version, mapping_fingerprint_sha256
      ) VALUES (
        'semantic-contract-ref', 'kb-embedding-ref', 'semantic-embedding-ref',
        'embedding-revision-a2', 'opensearch', 3, 'l2',
        'artifact-v1', 'vector-v1', ${'c'.repeat(64)}
      )
    `;
    await expect(repository.countReferences('embedding-config-a')).resolves.toBe(1);
  });

  function write(encryptedApiKey: string, vectorProducingRevisionPublicId: string) {
    return {
      displayName: 'Embedding', authenticationMode: 'api_key' as const,
      baseUrl: 'https://embedding.example/v1', encryptedApiKey,
      modelName: 'embedding-model', requestedDimension: 3,
      normalization: 'l2' as const, maximumInputTokens: 8_192,
      batchSize: 16, timeoutMs: 10_000, retryCount: 2,
      minimumIntervalMs: 20, concurrency: 2,
      maximumResponseBytes: 1_000_000,
      vectorProducingRevisionPublicId
    };
  }
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = '/' + databaseName;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  const quote = String.fromCharCode(34);
  return quote + value.replaceAll(quote, quote + quote) + quote;
}
