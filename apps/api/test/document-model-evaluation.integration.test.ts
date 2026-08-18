import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import {
  createDocumentModelAnalysisFingerprint,
  createDocumentRelationshipEvaluationFingerprint
} from "../src/document-indexing/application/document-model-evaluation.js";
import { createPostgresDocumentModelEvaluationRepository } from
  "../src/document-indexing/infrastructure/postgres-document-model-evaluation.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document model evaluation PostgreSQL", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_model_evaluation_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 2 });
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('knowledge-base-evaluation', 'Evaluation', 1)
    `;
    await sql`
      INSERT INTO focowiki.model_configs (
        public_id, provider, model, secret_reference, config, enabled, revision
      ) VALUES (
        'model-config-evaluation', 'openai-compatible', 'test-model',
        'runtime/test-model', '{}'::jsonb, true, 1
      )
    `;
    for (const suffix of ["a", "b"] as const) {
      await sql`
        INSERT INTO focowiki.source_files (
          public_id, knowledge_base_id, logical_path, normalized_path,
          title, revision
        ) VALUES (
          ${`source-file-${suffix}`}, 'knowledge-base-evaluation',
          ${`${suffix}.md`}, ${`${suffix}.md`}, ${suffix.toUpperCase()}, 1
        )
      `;
      await sql`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count, content_type,
          object_format, state, write_attempt_public_id, verified_at
        ) VALUES (
          ${`object-${suffix}`}, ${`sources/${suffix}.md`}, ${suffix.repeat(64)}, 1,
          'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
          ${`write-${suffix}`}, now()
        )
      `;
      await sql`
        INSERT INTO focowiki.source_revisions (
          public_id, knowledge_base_id, source_file_public_id, object_id,
          checksum_sha256, byte_count, content_type
        ) VALUES (
          ${`source-revision-${suffix}`}, 'knowledge-base-evaluation',
          ${`source-file-${suffix}`}, ${`object-${suffix}`},
          ${suffix.repeat(64)}, 1, 'text/markdown; charset=utf-8'
        )
      `;
    }
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

  it("keeps the first exact analysis and relationship decision authoritative", async () => {
    const repository = createPostgresDocumentModelEvaluationRepository(
      sql as unknown as DatabaseClient
    );
    const prompt = "a".repeat(64);
    const analysis = createDocumentModelAnalysisFingerprint({
      sourceRevisionPublicId: "source-revision-a",
      modelConfigurationPublicId: "model-config-evaluation",
      modelConfigurationRevision: 1,
      promptContractSha256: prompt,
      modelInput: { bodySha256: "b".repeat(64) }
    });
    const storedAnalysis = await repository.storeAnalysis({
      ...analysis,
      knowledgeBaseId: "knowledge-base-evaluation",
      sourceRevisionPublicId: "source-revision-a",
      modelConfigurationPublicId: "model-config-evaluation",
      modelConfigurationRevision: 1,
      promptContractSha256: prompt,
      result: { suggestions: { title: "A" } },
      warnings: []
    });
    const reusableAnalysis = await repository.findReusableAnalysis({
      knowledgeBaseId: "knowledge-base-evaluation",
      modelConfigurationPublicId: "model-config-evaluation",
      modelConfigurationRevision: 1,
      promptContractSha256: prompt,
      modelInputSha256: analysis.modelInputSha256
    });
    const relationship = createDocumentRelationshipEvaluationFingerprint({
      sourceRevisionPublicId: "source-revision-a",
      targetRevisionPublicId: "source-revision-b",
      evidence: { sourceExcerpt: "See B" },
      modelConfigurationPublicId: "model-config-evaluation",
      modelConfigurationRevision: 1,
      promptContractSha256: prompt
    });
    const [storedRelationship] = await repository.storeRelationships({
      evaluations: [{
        ...relationship,
        knowledgeBaseId: "knowledge-base-evaluation",
        sourceRevisionPublicId: "source-revision-a",
        targetRevisionPublicId: "source-revision-b",
        modelConfigurationPublicId: "model-config-evaluation",
        modelConfigurationRevision: 1,
        promptContractSha256: prompt,
        decision: "accepted",
        confidence: 0.91,
        result: {
          targetFileId: "source-file-b",
          accepted: true,
          relationType: "direct_reference",
          weight: 0.91,
          reason: "A names B."
        }
      }]
    });

    expect(storedAnalysis.publicId).toBe(analysis.publicId);
    expect(reusableAnalysis).toMatchObject({
      publicId: analysis.publicId,
      sourceRevisionPublicId: "source-revision-a"
    });
    expect(storedRelationship).toMatchObject({
      publicId: relationship.publicId,
      decision: "accepted",
      confidence: 0.91
    });
    await expect(repository.findRelationships({
      knowledgeBaseId: "knowledge-base-evaluation",
      publicIds: [relationship.publicId]
    })).resolves.toHaveLength(1);
    await expect(repository.findReusableRelationships({
      knowledgeBaseId: "knowledge-base-evaluation",
      targetRevisionPublicIds: ["source-revision-b"],
      evidenceFingerprintSha256s: [relationship.evidenceFingerprintSha256],
      modelConfigurationPublicId: "model-config-evaluation",
      modelConfigurationRevision: 1,
      promptContractSha256: prompt
    })).resolves.toEqual([
      expect.objectContaining({ publicId: relationship.publicId })
    ]);
  });
});

function databaseConnectionUrl(value: string, databaseName: string): string {
  const url = new URL(value);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
