import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresDocumentSemanticFactReuse } from
  "../src/document-indexing/infrastructure/postgres-document-semantic-fact-reuse.js";
import { createPostgresSemanticFactRepository } from
  "../src/semantic/infrastructure/postgres-fact-repository.js";
import { activateSemanticSourceRevision } from
  "../src/semantic/infrastructure/postgres-source-revision-activation.js";
import type { SemanticDesiredFactSet } from
  "../src/semantic/domain/contracts.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document semantic fact reuse PostgreSQL", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_semantic_reuse_${
    (runOwner ?? "invalid").replaceAll("-", "_")
  }_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), {
    max: 1
  });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), {
    max: 4
  });
  const database = sql as unknown as DatabaseClient;
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await applyStorageVnextTestMigrations(sql);
    await seedSemanticGeneration();
    await seedSourceRevision({
      revisionId: "source-revision-old",
      objectId: "source-sha256:semantic-old",
      checksum: "1".repeat(64),
      path: "Old.md"
    });
    await sql`
      INSERT INTO focowiki.source_file_active_revisions (
        knowledge_base_id, source_file_public_id,
        current_source_revision_public_id, active_source_revision_public_id,
        activation_sequence
      ) VALUES (
        'knowledge-base-semantic-reuse', 'source-file-semantic-reuse',
        'source-revision-old', 'source-revision-old', 1
      )
    `;
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

  it("rebases move-owned evidence and activates it without model extraction", async () => {
    const facts = createPostgresSemanticFactRepository(database);
    await facts.replaceSourceFacts(desiredFacts("source-revision-old", "Old.md"), {
      extractionContractVersion: "extract-v1",
      canonicalInputSha256: "4".repeat(64),
      skeletonPolicyVersion: "skeleton-v1",
      skeletonSelected: true,
      sourceChunkCount: 1,
      selectedChunkCount: 1,
      selectionReasons: ["explicit_reference"],
      selectionDecisionSha256: "5".repeat(64)
    });
    await seedSourceRevision({
      revisionId: "source-revision-moved",
      objectId: "source-sha256:semantic-moved",
      checksum: "1".repeat(64),
      path: "Moved/Document.md"
    });
    await seedSourceRevision({
      revisionId: "source-revision-different",
      objectId: "source-sha256:semantic-different",
      checksum: "2".repeat(64),
      path: "Moved/Different.md"
    });
    await sql`
      UPDATE focowiki.knowledge_base_sequences
      SET current_sequence = 2
      WHERE knowledge_base_id = 'knowledge-base-semantic-reuse'
    `;
    await sql`
      UPDATE focowiki.source_file_active_revisions
      SET current_source_revision_public_id = 'source-revision-moved'
      WHERE knowledge_base_id = 'knowledge-base-semantic-reuse'
        AND source_file_public_id = 'source-file-semantic-reuse'
    `;
    const reused = await createPostgresDocumentSemanticFactReuse(database)({
      knowledgeBaseId: "knowledge-base-semantic-reuse",
      semanticGenerationPublicId: "semantic-generation-reuse",
      sourceFilePublicId: "source-file-semantic-reuse",
      toSourceRevisionPublicId: "source-revision-moved",
      targetLogicalPath: "Moved/Document.md",
      semanticContractVersion: "extract-v1"
    });
    expect(reused).not.toBeNull();
    expect(reused?.facts).toMatchObject({
      sourceRevisionPublicId: "source-revision-moved",
      entities: [{ publicId: "entity-reuse-a" }, { publicId: "entity-reuse-b" }],
      relationships: [{ publicId: "relationship-reuse" }]
    });
    expect(reused?.facts.evidence[0]).toMatchObject({
      sourceRevisionPublicId: "source-revision-moved",
      logicalPath: "Moved/Document.md"
    });
    await facts.replaceSourceFacts(reused!.facts, reused!.manifest);
    await expect(readRevisionEvidence()).resolves.toEqual([
      { source_revision_public_id: "source-revision-moved", logical_path: "Moved/Document.md" },
      { source_revision_public_id: "source-revision-old", logical_path: "Old.md" }
    ]);
    const checkpointed = await createPostgresDocumentSemanticFactReuse(database)({
      knowledgeBaseId: "knowledge-base-semantic-reuse",
      semanticGenerationPublicId: "semantic-generation-reuse",
      sourceFilePublicId: "source-file-semantic-reuse",
      fromSourceRevisionPublicId: "source-revision-moved",
      toSourceRevisionPublicId: "source-revision-moved",
      targetLogicalPath: "Moved/Document.md",
      semanticContractVersion: "extract-v1"
    });
    expect(checkpointed).not.toBeNull();
    expect(checkpointed?.manifest.selectionDecisionSha256).toBe("5".repeat(64));

    const changedBody = await createPostgresDocumentSemanticFactReuse(database)({
      knowledgeBaseId: "knowledge-base-semantic-reuse",
      semanticGenerationPublicId: "semantic-generation-reuse",
      sourceFilePublicId: "source-file-semantic-reuse",
      fromSourceRevisionPublicId: "source-revision-old",
      toSourceRevisionPublicId: "source-revision-different",
      targetLogicalPath: "Moved/Different.md",
      semanticContractVersion: "extract-v1"
    });
    expect(changedBody).toBeNull();

    await sql`
      UPDATE focowiki.source_file_active_revisions
      SET active_source_revision_public_id = 'source-revision-moved',
          activation_sequence = 2
      WHERE knowledge_base_id = 'knowledge-base-semantic-reuse'
        AND source_file_public_id = 'source-file-semantic-reuse'
    `;
    await activateSemanticSourceRevision(database, {
      knowledgeBaseId: "knowledge-base-semantic-reuse",
      semanticGenerationPublicId: "semantic-generation-reuse",
      sourceFilePublicId: "source-file-semantic-reuse",
      priorSourceRevisionPublicId: "source-revision-old",
      currentSourceRevisionPublicId: "source-revision-moved",
      activatedAt: "2026-08-14T12:00:00.000Z"
    });
    await expect(readRevisionEvidence()).resolves.toEqual([{
      source_revision_public_id: "source-revision-moved",
      logical_path: "Moved/Document.md"
    }]);
    await expect(sql<Array<{
      source_revision_public_id: string;
      relationship_public_id: string;
    }>>`
      SELECT source_revision_public_id, relationship_public_id
      FROM focowiki.semantic_relationship_observations
      WHERE knowledge_base_id = 'knowledge-base-semantic-reuse'
    `).resolves.toEqual([{
      source_revision_public_id: "source-revision-moved",
      relationship_public_id: "relationship-reuse"
    }]);
  });

  async function seedSemanticGeneration(): Promise<void> {
    await sql`
      INSERT INTO focowiki.model_configs (
        public_id, provider, model, secret_reference, config,
        enabled, revision
      ) VALUES (
        'model-config-semantic-reuse', 'openai-compatible', 'test-model',
        'runtime/test-model', '{}'::jsonb, true, 1
      )
    `;
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('knowledge-base-semantic-reuse', 'Semantic reuse', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('knowledge-base-semantic-reuse', 1)
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state
      ) VALUES (
        'operation-semantic-reuse', 'knowledge-base-semantic-reuse',
        'mutation', 'processing'
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
        'semantic-generation-reuse', 'knowledge-base-semantic-reuse',
        'operation-semantic-reuse', NULL, 'active', 'active',
        'model-config-semantic-reuse', 1, 'extract-v1', 'graph-v1',
        'prompt-v1', ${"6".repeat(64)}, 1, now()
      )
    `;
    await sql`
      INSERT INTO focowiki.source_files (
        public_id, knowledge_base_id, logical_path, normalized_path,
        title, revision
      ) VALUES (
        'source-file-semantic-reuse', 'knowledge-base-semantic-reuse',
        'Old.md', 'old.md', 'Old', 1
      )
    `;
  }

  async function seedSourceRevision(input: {
    revisionId: string;
    objectId: string;
    checksum: string;
    path: string;
  }): Promise<void> {
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        ${input.objectId}, ${input.path}, ${input.checksum}, 10,
        'text/markdown; charset=utf-8', 'source-markdown-v1', 'verified',
        ${`write-${input.revisionId}`}, now()
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revisions (
        public_id, knowledge_base_id, source_file_public_id, object_id,
        checksum_sha256, byte_count, content_type
      ) VALUES (
        ${input.revisionId}, 'knowledge-base-semantic-reuse',
        'source-file-semantic-reuse', ${input.objectId}, ${input.checksum},
        10, 'text/markdown; charset=utf-8'
      )
    `;
    await sql`
      INSERT INTO focowiki.source_revision_presentations (
        knowledge_base_id, source_file_public_id, source_revision_public_id,
        logical_path, normalized_path, title, metadata
      ) VALUES (
        'knowledge-base-semantic-reuse', 'source-file-semantic-reuse',
        ${input.revisionId}, ${input.path}, ${input.path.toLowerCase()},
        ${input.path.split("/").at(-1)!.replace(/\.md$/u, "")}, '{}'::jsonb
      )
    `;
  }

  function readRevisionEvidence() {
    return sql<Array<{
      source_revision_public_id: string;
      logical_path: string;
    }>>`
      SELECT source_revision_public_id, logical_path
      FROM focowiki.semantic_evidence
      WHERE knowledge_base_id = 'knowledge-base-semantic-reuse'
      ORDER BY source_revision_public_id COLLATE "C"
    `;
  }
});

function desiredFacts(
  sourceRevisionPublicId: string,
  logicalPath: string
): SemanticDesiredFactSet {
  return {
    knowledgeBaseId: "knowledge-base-semantic-reuse",
    semanticGenerationPublicId: "semantic-generation-reuse",
    sourceFilePublicId: "source-file-semantic-reuse",
    sourceRevisionPublicId,
    entities: [{
      publicId: "entity-reuse-a", canonicalKey: "concept:reuse:a",
      kind: "concept", label: "Reuse A", description: null, aliases: [],
      extractionContractVersion: "extract-v1", confidence: 0.9,
      provenance: "model", revision: 1
    }, {
      publicId: "entity-reuse-b", canonicalKey: "concept:reuse:b",
      kind: "concept", label: "Reuse B", description: null, aliases: [],
      extractionContractVersion: "extract-v1", confidence: 0.8,
      provenance: "model", revision: 1
    }],
    evidence: [{
      publicId: `evidence-${sourceRevisionPublicId}`,
      sourceFilePublicId: "source-file-semantic-reuse",
      sourceRevisionPublicId,
      logicalPath,
      startOffset: 0,
      endOffset: 8,
      excerptChecksumSha256: "7".repeat(64),
      extractionContractVersion: "extract-v1"
    }],
    mentions: [{
      publicId: `mention-${sourceRevisionPublicId}`,
      entityPublicId: "entity-reuse-a",
      evidencePublicId: `evidence-${sourceRevisionPublicId}`,
      sourceFilePublicId: "source-file-semantic-reuse",
      sourceRevisionPublicId,
      text: "Reuse A",
      confidence: 0.9
    }],
    relationships: [{
      publicId: "relationship-reuse",
      fromEntityPublicId: "entity-reuse-a",
      toEntityPublicId: "entity-reuse-b",
      kind: "related_to",
      description: "Reusable relation",
      evidencePublicIds: [`evidence-${sourceRevisionPublicId}`],
      confidence: 0.8,
      provenance: "model",
      revision: 1
    }],
    communities: [],
    communityReports: []
  };
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  const quote = String.fromCharCode(34);
  return quote + value.replaceAll(quote, quote + quote) + quote;
}
