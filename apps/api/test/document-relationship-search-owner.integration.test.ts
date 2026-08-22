import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import {
  activateDocumentRelationshipSearchOwners,
  activateDocumentSearchOwners,
  createPostgresDocumentSearchOwnerRepository
} from
  "../src/document-indexing/infrastructure/postgres-document-search-owner-repository.js";
import { readDocumentRelationshipSearchActivation } from
  "../src/document-indexing/infrastructure/postgres-document-publication-source-activation.js";
import { createPostgresActiveFileRelationshipHitRepository } from
  "../src/document-indexing/infrastructure/postgres-active-file-relationship-hit-repository.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));

(enabled ? describe : describe.skip)("document relationship search ownership PostgreSQL", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_relationship_search_${
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
      VALUES ('knowledge-base-relationship-search', 'Relationship search', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (
        knowledge_base_id, current_sequence
      ) VALUES ('knowledge-base-relationship-search', 1)
    `;
    await sql`
      INSERT INTO focowiki.search_projections (
        public_id, knowledge_base_id, provider_kind, provider_index_uid,
        schema_checksum_sha256, settings_checksum_sha256, state
      ) VALUES (
        'search-projection-relationship', 'knowledge-base-relationship-search',
        'opensearch', 'relationship-search-index', ${"a".repeat(64)},
        ${"b".repeat(64)}, 'active'
      )
    `;
    for (const suffix of ["a", "b"] as const) {
      await sql`
        INSERT INTO focowiki.source_files (
          public_id, knowledge_base_id, logical_path, normalized_path,
          title, revision
        ) VALUES (
          ${`source-file-${suffix}`}, 'knowledge-base-relationship-search',
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
          ${`source-revision-${suffix}`}, 'knowledge-base-relationship-search',
          ${`source-file-${suffix}`}, ${`object-${suffix}`},
          ${suffix.repeat(64)}, 1, 'text/markdown; charset=utf-8'
        )
      `;
      await sql`
        INSERT INTO focowiki.source_file_active_revisions (
          knowledge_base_id, source_file_public_id,
          current_source_revision_public_id, active_source_revision_public_id,
          activation_sequence
        ) VALUES (
          'knowledge-base-relationship-search', ${`source-file-${suffix}`},
          ${`source-revision-${suffix}`}, ${`source-revision-${suffix}`}, 1
        )
      `;
    }
    await sql`
      INSERT INTO focowiki.search_document_owners (
        knowledge_base_id, search_projection_public_id, provider_kind,
        provider_document_id, document_kind, source_file_public_id,
        source_revision_public_id, document_checksum_sha256, state,
        acknowledged_at
      ) VALUES
        ('knowledge-base-relationship-search', 'search-projection-relationship',
         'opensearch', 'content-a', 'file', 'source-file-a',
         'source-revision-a', ${"c".repeat(64)}, 'active', now()),
        ('knowledge-base-relationship-search', 'search-projection-relationship',
         'opensearch', 'relation-a-old', 'file_relationship', 'source-file-a',
         'source-revision-a', ${"d".repeat(64)}, 'active', now()),
        ('knowledge-base-relationship-search', 'search-projection-relationship',
         'opensearch', 'content-b', 'file', 'source-file-b',
         'source-revision-b', ${"e".repeat(64)}, 'active', now()),
        ('knowledge-base-relationship-search', 'search-projection-relationship',
         'opensearch', 'relation-b-old', 'file_relationship', 'source-file-b',
         'source-revision-b', ${"f".repeat(64)}, 'active', now()),
        ('knowledge-base-relationship-search', 'search-projection-relationship',
         'opensearch', 'relation-a-new', 'file_relationship', 'source-file-a',
         'source-revision-a', ${"1".repeat(64)}, 'staged', now()),
        ('knowledge-base-relationship-search', 'search-projection-relationship',
         'opensearch', 'relation-a-stale', 'file_relationship', 'source-file-a',
         'source-revision-a', ${"2".repeat(64)}, 'staged', now())
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

  it("activates only current relationship documents for every affected endpoint", async () => {
    const transaction = sql as unknown as DatabaseClient;
    await activateDocumentSearchOwners({
      transaction,
      knowledgeBaseId: "knowledge-base-relationship-search",
      sourceFilePublicId: "source-file-a",
      sourceRevisionPublicId: "source-revision-a",
      activatedAt: "2026-08-15T08:00:00.000Z"
    });
    await activateDocumentRelationshipSearchOwners({
      transaction,
      knowledgeBaseId: "knowledge-base-relationship-search",
      affectedSourceFilePublicIds: ["source-file-a", "source-file-b"],
      providerDocumentIds: ["relation-a-new"],
      activatedAt: "2026-08-15T08:00:00.000Z"
    });

    const owners = createPostgresDocumentSearchOwnerRepository(transaction);
    await expect(owners.stageAcknowledged({
      knowledgeBaseId: "knowledge-base-relationship-search",
      sourceFilePublicId: "source-file-a",
      sourceRevisionPublicId: "source-revision-a",
      searchProjectionPublicId: "search-projection-relationship",
      providerKind: "opensearch",
      acknowledgementPublicId: "ack-repeat-active",
      documents: [{
        providerDocumentId: "relation-a-new",
        documentKind: "file_relationship",
        checksumSha256: "1".repeat(64)
      }],
      stagedAt: "2026-08-15T08:00:01.000Z"
    })).resolves.toBe(1);

    await expect(sql`
      SELECT provider_document_id, document_kind, state
      FROM focowiki.search_document_owners
      ORDER BY provider_document_id COLLATE "C"
    `).resolves.toEqual([
      { provider_document_id: "content-a", document_kind: "file", state: "active" },
      { provider_document_id: "content-b", document_kind: "file", state: "active" },
      { provider_document_id: "relation-a-new", document_kind: "file_relationship", state: "active" },
      { provider_document_id: "relation-a-old", document_kind: "file_relationship", state: "obsolete" },
      { provider_document_id: "relation-a-stale", document_kind: "file_relationship", state: "obsolete" },
      { provider_document_id: "relation-b-old", document_kind: "file_relationship", state: "obsolete" }
    ]);
    await expect(sql`
      SELECT document_count
      FROM focowiki.search_projections
      WHERE public_id = 'search-projection-relationship'
    `).resolves.toEqual([{ document_count: "3" }]);
    const activeHits = createPostgresActiveFileRelationshipHitRepository(
      transaction
    );
    await expect(activeHits.resolveActive({
      knowledgeBaseId: "knowledge-base-relationship-search",
      documents: [{
        documentId: "relation-a-new",
        sourceFilePublicId: "source-file-a",
        sourceRevisionPublicId: "source-revision-a",
        targetSourceFilePublicId: "source-file-b",
        targetSourceRevisionPublicId: "source-revision-b"
      }, {
        documentId: "relation-b-old",
        sourceFilePublicId: "source-file-b",
        sourceRevisionPublicId: "source-revision-b",
        targetSourceFilePublicId: "source-file-a",
        targetSourceRevisionPublicId: "source-revision-a"
      }],
      limit: 2
    })).resolves.toEqual(["relation-a-new"]);
  });

  it("derives every staged relationship endpoint from an acknowledged receipt", async () => {
    await sql`
      INSERT INTO focowiki.search_family_receipts (
        public_id, knowledge_base_id, source_file_public_id,
        source_revision_public_id, provider_kind, family,
        input_fingerprint_sha256, provider_document_ids,
        state, acknowledged_at
      ) VALUES (
        'search-family-relationship-activation',
        'knowledge-base-relationship-search', 'source-file-a',
        'source-revision-a', 'opensearch', 'relation_evidence',
        ${"9".repeat(64)}, ARRAY['relation-a-new']::text[],
        'acknowledged', now()
      )
    `;
    await sql`
      UPDATE focowiki.search_document_owners
      SET state = 'staged'
      WHERE provider_document_id = 'relation-a-new'
    `;
    await sql`
      INSERT INTO focowiki.search_document_owners (
        knowledge_base_id, search_projection_public_id, provider_kind,
        provider_document_id, document_kind, source_file_public_id,
        source_revision_public_id, document_checksum_sha256, state,
        acknowledged_at
      ) VALUES (
        'knowledge-base-relationship-search', 'search-projection-relationship',
        'opensearch', 'relation-b-new', 'file_relationship', 'source-file-b',
        'source-revision-b', ${"8".repeat(64)}, 'staged', now()
      )
    `;
    await sql`
      UPDATE focowiki.search_family_receipts
      SET provider_document_ids = ARRAY['relation-a-new', 'relation-b-new']::text[]
      WHERE public_id = 'search-family-relationship-activation'
    `;

    await expect(readDocumentRelationshipSearchActivation({
      transaction: sql as unknown as DatabaseClient,
      knowledgeBaseId: 'knowledge-base-relationship-search',
      documents: [{
        source_file_public_id: 'source-file-a',
        source_revision_public_id: 'source-revision-a'
      }]
    })).resolves.toEqual({
      affectedSourceFilePublicIds: ['source-file-a', 'source-file-b'],
      providerDocumentIds: ['relation-a-new', 'relation-b-new']
    });
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
