import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { normalizeDocumentPublicationScopeOutput } from
  "../src/document-indexing/application/document-publication-scope-output.js";
import {
  documentLeaseGeneration,
  documentPublicationGenerationId,
  documentScopeGeneration
} from
  "../src/document-indexing/domain/document-publication-identifiers.js";
import { createPostgresDocumentPublicationValidator } from
  "../src/document-indexing/infrastructure/postgres-document-publication-validator.js";
import { createPostgresDocumentScopeGenerationRepository } from
  "../src/document-indexing/infrastructure/postgres-document-scope-generation-repository.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("publication validation completion order", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_validation_order_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 8 });
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

  it("matches the serial checksum for every independent scope order", async () => {
    const fingerprints: string[] = [];
    for (const order of [["a", "b"], ["b", "a"]]) {
      await resetScopes(sql);
      const repository = createPostgresDocumentScopeGenerationRepository(
        database
      );
      for (const marker of ["a", "b"]) {
        await repository.create({
          publicId: `order-scope-${marker}`,
          publicationGenerationId:
            documentPublicationGenerationId("order-generation"),
          knowledgeBaseId: "order-kb",
          scopeIdentity: `source:order-source-${marker}`,
          scopeKind: "source",
          scopeKey: `order-source-${marker}`,
          scopeGeneration: documentScopeGeneration(1),
          inputSnapshotFingerprintSha256: marker.repeat(64),
          createdAt: "2026-08-21T12:00:00.000Z"
        });
      }
      const claims = await repository.claim({
        workerId: "order-worker",
        now: "2026-08-21T12:00:01.000Z",
        leaseDurationMs: 30_000,
        limit: 2
      });
      const leaseByScope = new Map(claims.map((claim) => [
        claim.publicId,
        claim.leaseGeneration
      ]));
      for (const marker of order) {
        const output = outputFor(marker);
        await repository.persistOutput({
          scopeGenerationPublicId: `order-scope-${marker}`,
          workerId: "order-worker",
          leaseGeneration: leaseByScope.get(`order-scope-${marker}`)
            ?? documentLeaseGeneration(1),
          checkedAt: "2026-08-21T12:00:02.000Z",
          verifiedReservations: [],
          ...output
        });
      }
      const result = await createPostgresDocumentPublicationValidator(database)
        .validate({
          generationPublicId: "order-generation",
          checkedAt: "2026-08-21T12:00:03.000Z"
        });
      expect(result).toMatchObject({ state: "ready", failedChecks: [] });
      fingerprints.push(result.outputFingerprintSha256);
    }
    expect(new Set(fingerprints)).toEqual(new Set([fingerprints[0]]));
  });
});

function outputFor(marker: string) {
  const pages = [{
    logicalPath: `pages/${marker}.md`,
    normalizedPath: `pages/${marker}.md`,
    action: "put" as const,
    entryKind: "source-page",
    objectId: `generated-${marker}`,
    checksumSha256: marker.repeat(64),
    byteCount: 64
  }];
  const validationEvidence = {
    scopeIdentity: `source:order-source-${marker}`,
    sourceTargets: { checked: 1, missing: 0 },
    linkTargets: { checked: 0, missing: 0 },
    continuationChains: { checked: 0, broken: 0 },
    navigation: { expected: 0, actual: 0 },
    graph: { outgoing: 0, incoming: 0 },
    indexes: { expected: 0, actual: 0 },
    tombstones: { expected: 0, actual: 0 },
    search: { expected: 1, ready: 1 }
  };
  const outputFingerprintSha256 = normalizeDocumentPublicationScopeOutput({
    scope: { kind: "source", key: `order-source-${marker}` },
    sourceFilePublicId: `order-source-${marker}`,
    inputSnapshotFingerprintSha256: marker.repeat(64),
    rendererContractVersion: "portable-okf-v2",
    pages,
    navigationMutations: [],
    validationEvidence
  }).outputFingerprintSha256;
  return {
    outputFingerprintSha256,
    validationEvidence,
    pages,
    navigationMutations: []
  };
}

async function resetScopes(sql: postgres.Sql): Promise<void> {
  await sql`
    DELETE FROM focowiki.projection_scope_generations
    WHERE publication_generation_public_id = 'order-generation'
  `;
  await sql`
    DELETE FROM focowiki.projection_generation_validation_results
    WHERE generation_public_id = 'order-generation'
  `;
  await sql`
    UPDATE focowiki.projection_publication_generations
    SET state = 'rendering', output_fingerprint_sha256 = NULL,
        updated_at = '2026-08-21T12:00:00.000Z'
    WHERE public_id = 'order-generation'
  `;
}

async function seed(sql: postgres.Sql): Promise<void> {
  await sql`
    INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
    VALUES ('order-kb', 'Order', 1)
  `;
  await sql`
    INSERT INTO focowiki.knowledge_base_projection_heads (
      knowledge_base_id, updated_at
    ) VALUES ('order-kb', '2026-08-21T12:00:00.000Z')
  `;
  await sql`
    INSERT INTO focowiki.projection_cutover_states (
      knowledge_base_id, writer_mode, updated_at
    ) VALUES ('order-kb', 'coherent', '2026-08-21T12:00:00.000Z')
  `;
  await sql.begin(async (transaction) => {
    await transaction`SET LOCAL session_replication_role = replica`;
    for (const marker of ["a", "b"]) {
      await transaction`
        INSERT INTO focowiki.document_processing_jobs (
          public_id, knowledge_base_id, operation_public_id,
          source_file_public_id, source_revision_public_id,
          runtime_settings_revision_public_id,
          generation_model_configuration_public_id,
          generation_model_configuration_revision,
          embedding_configuration_revision_public_id,
          semantic_generation_public_id, semantic_contract_version,
          state, maximum_attempts, accepted_at, started_at,
          created_at, updated_at
        ) VALUES (
          ${`order-job-${marker}`}, 'order-kb', ${`order-operation-${marker}`},
          ${`order-source-${marker}`}, ${`order-revision-${marker}`},
          'settings', 'model', 1, 'embedding', 'semantic', 'contract',
          'processing', 3, '2026-08-21T11:59:00.000Z',
          '2026-08-21T11:59:00.000Z', '2026-08-21T11:59:00.000Z',
          '2026-08-21T11:59:00.000Z'
        )
      `;
    }
  });
  await sql`
    INSERT INTO focowiki.projection_fact_epochs (
      knowledge_base_id, fact_epoch, mutation_public_id,
      source_file_public_id, source_revision_public_id, fact_kind, state
    ) VALUES
      ('order-kb', 1, 'order-job-a', 'order-source-a', 'order-revision-a',
       'create', 'included'),
      ('order-kb', 2, 'order-job-b', 'order-source-b', 'order-revision-b',
       'create', 'included')
  `;
  await sql`
    INSERT INTO focowiki.projection_publication_generations (
      public_id, knowledge_base_id, target_fact_epoch,
      renderer_contract_version, deterministic_changed_at, state,
      input_fingerprint_sha256
    ) VALUES (
      'order-generation', 'order-kb', 2, 'portable-okf-v2',
      '2026-08-21T12:00:00.000Z', 'rendering', ${"f".repeat(64)}
    )
  `;
  await sql`
    INSERT INTO focowiki.projection_generation_documents (
      generation_public_id, mutation_public_id, document_job_public_id,
      source_file_public_id,
      source_revision_public_id, fact_epoch
    ) VALUES
      ('order-generation', 'order-job-a', 'order-job-a', 'order-source-a',
       'order-revision-a', 1),
      ('order-generation', 'order-job-b', 'order-job-b', 'order-source-b',
       'order-revision-b', 2)
  `;
  await sql`
    INSERT INTO focowiki.object_registrations (
      object_id, storage_key, checksum_sha256, byte_count, content_type,
      object_format, state, write_attempt_public_id, verified_at
    ) VALUES
      ('generated-a', 'generated/a.md', ${"a".repeat(64)}, 64,
       'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
       'verified', 'write-a', now()),
      ('generated-b', 'generated/b.md', ${"b".repeat(64)}, 64,
       'text/markdown; charset=utf-8', 'okf-generated-markdown-v1',
       'verified', 'write-b', now())
  `;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
