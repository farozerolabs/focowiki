import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { buildDocumentGraphDirectoryScopeResources } from
  "../src/document-indexing/application/document-graph-projection.js";
import { parseDocumentPortableRecords } from
  "../src/document-indexing/application/document-portable-record-parser.js";
import { documentDirectoryEntryId } from
  "../src/document-indexing/domain/document-directory-entry-identity.js";
import { createPostgresDocumentProjectionFacts } from
  "../src/document-indexing/infrastructure/postgres-document-projection-facts.js";
import { createPostgresDocumentMachineProjectionReader } from
  "../src/document-indexing/infrastructure/postgres-document-machine-projection-reader.js";
import { createPostgresCandidateFileRelationRepository } from
  "../src/document-indexing/infrastructure/postgres-candidate-file-relation-repository.js";
import { createPostgresGeneratedPageBaseRepository } from
  "../src/document-indexing/infrastructure/postgres-generated-page-base-repository.js";
import {
  applyPostgresDocumentDirectoryNavigation,
  createPostgresDocumentDirectoryNavigation
} from "../src/document-indexing/infrastructure/postgres-document-directory-navigation.js";
import { applyStorageVnextTestMigrations } from
  "./helpers/storage-vnext-test-migrations.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const enabled = Boolean(databaseUrl && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner));
const describeOwnedDatabase = enabled ? describe : describe.skip;

describeOwnedDatabase("PostgreSQL document projection fact set-diff", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = "focowiki_projection_facts_"
    + (runOwner ?? "invalid").replaceAll("-", "_") + "_"
    + randomUUID().replaceAll("-", "").slice(0, 10);
  const admin = postgres(withDatabase(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(withDatabase(connectionUrl, databaseName), { max: 2 });
  let created = false;

  beforeAll(async () => {
    await admin.unsafe("CREATE DATABASE " + quote(databaseName));
    created = true;
    await applyStorageVnextTestMigrations(sql);
    await sql`
      INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
      VALUES ('kb-projection-facts', 'Projection facts', 1)
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_sequences (knowledge_base_id)
      VALUES ('kb-projection-facts')
    `;
    await seedSource(sql, "first", "a");
    await seedSource(sql, "second", "b");
    await seedSource(sql, "third", "c");
  }, 120_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    if (created) {
      await admin.unsafe(
        "DROP DATABASE IF EXISTS " + quote(databaseName) + " WITH (FORCE)"
      );
    }
    await admin.end({ timeout: 5 });
  }, 120_000);

  it("mutates only the exact revision fact difference and cascades exact deletion", async () => {
    const repository = createPostgresDocumentProjectionFacts(
      sql as unknown as DatabaseClient
    );
    await repository.replaceRevision(fact("first", {
      pagePath: "pages/guides/first.md",
      terms: [
        { term: "alpha", fields: ["title"] },
        { term: "shared", fields: ["heading"] }
      ],
      directories: ["pages", "pages/guides"]
    }));
    await repository.replaceRevision(fact("second", {
      pagePath: "pages/reference/second.md",
      terms: [{ term: "stable", fields: ["title"] }],
      directories: ["pages", "pages/reference"]
    }));

    const before = await rowVersions(sql);
    await repository.replaceRevision(fact("first", {
      pagePath: "pages/guides/first.md",
      terms: [
        { term: "alpha", fields: ["title"] },
        { term: "shared", fields: ["heading"] }
      ],
      directories: ["pages", "pages/guides"]
    }));
    expect(await rowVersions(sql)).toEqual(before);

    await repository.replaceRevision({
      ...fact("first", {
        pagePath: "pages/moved/renamed.md",
        terms: [
          { term: "alpha", fields: ["title", "path"] },
          { term: "replacement", fields: ["heading"] }
        ],
        directories: ["pages", "pages/moved"]
      }),
      logicalPath: "moved/renamed.md",
      normalizedPath: "moved/renamed.md",
      title: "Renamed",
      incomingRelationshipCount: 1,
      outgoingRelationshipCount: 2
    });

    await expect(sql<Array<{ term: string; fields: string[]; page_path: string }>>`
      SELECT term.term, posting.fields, posting.page_path
      FROM focowiki.document_navigation_terms term
      JOIN focowiki.document_navigation_postings posting
        USING (knowledge_base_id, source_revision_public_id, term)
      WHERE term.source_revision_public_id = 'source-revision-projection-first'
      ORDER BY term.term COLLATE "C"
    `).resolves.toEqual([
      {
        term: "alpha",
        fields: ["title", "path"],
        page_path: "pages/moved/renamed.md"
      },
      {
        term: "replacement",
        fields: ["heading"],
        page_path: "pages/moved/renamed.md"
      }
    ]);
    await expect(sql<Array<{ directory_path: string }>>`
      SELECT directory_path
      FROM focowiki.document_semantic_directory_memberships
      WHERE source_revision_public_id = 'source-revision-projection-first'
      ORDER BY directory_path COLLATE "C"
    `).resolves.toEqual([
      { directory_path: "pages" },
      { directory_path: "pages/moved" }
    ]);
    await expect(sql<Array<{ incoming_count: number; outgoing_count: number }>>`
      SELECT incoming_count, outgoing_count
      FROM focowiki.document_graph_degrees
      WHERE source_revision_public_id = 'source-revision-projection-first'
    `).resolves.toEqual([{ incoming_count: 1, outgoing_count: 2 }]);

    const secondAfter = (await rowVersions(sql)).filter((row) =>
      row.identity.includes("source-revision-projection-second"));
    expect(secondAfter).toEqual(before.filter((row) =>
      row.identity.includes("source-revision-projection-second")));

    const inactiveReader = createPostgresDocumentMachineProjectionReader(
      sql as unknown as DatabaseClient
    );
    await expect(inactiveReader.listNavigationTermBucketsForSources({
      knowledgeBaseId: "kb-projection-facts",
      sourceFilePublicIds: ["source-file-projection-first"]
    })).resolves.toEqual(["latin"]);
    await expect(inactiveReader.listNavigationTermRecords({
      knowledgeBaseId: "kb-projection-facts",
      bucket: "latin"
    })).resolves.toEqual([]);
    await expect(inactiveReader.listNavigationTermRecords({
      knowledgeBaseId: "kb-projection-facts",
      bucket: "latin",
      includedSourceRevisionPublicIds: ["source-revision-projection-first"]
    })).resolves.toEqual([{
      term: "alpha",
      postings: [{
        path: "pages/moved/renamed.md",
        fields: ["title", "path"]
      }]
    }, {
      term: "replacement",
      postings: [{
        path: "pages/moved/renamed.md",
        fields: ["heading"]
      }]
    }]);
    await expect(inactiveReader.readNavigationTermCatalogState({
      knowledgeBaseId: "kb-projection-facts",
      includedSourceRevisionPublicIds: ["source-revision-projection-first"],
      excludedActiveSourceFilePublicIds: ["source-file-projection-first"]
    })).resolves.toEqual({ buckets: ["latin"] });

    await expect(inactiveReader.readDocumentDirectoryState({
      knowledgeBaseId: "kb-projection-facts",
      scopePath: "pages/moved",
      includedSourceRevisionPublicIds: ["source-revision-projection-first"],
      excludedActiveSourceFilePublicIds: ["source-file-projection-first"]
    })).resolves.toMatchObject({
      records: [{
        path: "pages/moved/renamed.md",
        title: "Renamed"
      }]
    });

  });

  it("updates generated page integrity against the migrated projection schema", async () => {
    const repository = createPostgresDocumentProjectionFacts(
      sql as unknown as DatabaseClient
    );
    await repository.replaceRevision(fact("third", {
      pagePath: "pages/guides/third.md",
      terms: [{ term: "alpha", fields: ["title"] }],
      directories: ["pages", "pages/guides"]
    }));

    await repository.replaceGeneratedPageIntegrity({
      knowledgeBaseId: "kb-projection-facts",
      pages: [{
        sourceRevisionPublicId: "source-revision-projection-third",
        checksumSha256: "9".repeat(64),
        byteCount: 321
      }]
    });

    await expect(sql<Array<{ checksum_sha256: string; byte_count: string }>>`
      SELECT checksum_sha256, byte_count
      FROM focowiki.document_projection_records
      WHERE knowledge_base_id = 'kb-projection-facts'
        AND source_revision_public_id = 'source-revision-projection-third'
    `).resolves.toEqual([{
      checksum_sha256: "9".repeat(64),
      byte_count: "321"
    }]);
  });

  it("reads active directory projection state directly from PostgreSQL facts", async () => {
    const facts = createPostgresDocumentProjectionFacts(
      sql as unknown as DatabaseClient
    );
    await facts.activateRevision({
      knowledgeBaseId: "kb-projection-facts",
      sourceFilePublicId: "source-file-projection-second",
      sourceRevisionPublicId: "source-revision-projection-second",
      now: "2026-08-17T00:00:00.000Z"
    });
    for (const suffix of ["first", "second"] as const) {
      const objectId = `generated-base-object-${suffix}`;
      await sql`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count, content_type,
          object_format, state, write_attempt_public_id, verified_at
        ) VALUES (
          ${objectId}, ${`generated/${suffix}.json`}, ${"f".repeat(64)}, 10,
          'application/json; charset=utf-8', 'okf-generated-json-v1',
          'verified', ${`generated-base-write-${suffix}`}, now()
        )
      `;
      await sql`
        INSERT INTO focowiki.generated_page_bases (
          public_id, knowledge_base_id, source_file_public_id,
          source_revision_public_id, input_fingerprint_sha256,
          object_id, checksum_sha256
        ) VALUES (
          ${`generated-base-${suffix}`}, 'kb-projection-facts',
          ${`source-file-projection-${suffix}`},
          ${`source-revision-projection-${suffix}`}, ${"e".repeat(64)},
          ${objectId}, ${"f".repeat(64)}
        )
      `;
    }
    const baseReader = createPostgresGeneratedPageBaseRepository(
      sql as unknown as DatabaseClient
    );
    await expect(baseReader.listVisibleForSources({
      knowledgeBaseId: "kb-projection-facts",
      sourceFilePublicIds: [
        "source-file-projection-first",
        "source-file-projection-second"
      ],
      includedSourceRevisionPublicIds: ["source-revision-projection-first"],
      excludedActiveSourceFilePublicIds: ["source-file-projection-first"],
      limit: 10
    })).resolves.toMatchObject([{
      sourceFilePublicId: "source-file-projection-first",
      sourceRevisionPublicId: "source-revision-projection-first"
    }, {
      sourceFilePublicId: "source-file-projection-second",
      sourceRevisionPublicId: "source-revision-projection-second"
    }]);
    await expect(baseReader.listVisibleForSources({
      knowledgeBaseId: "kb-projection-facts",
      sourceFilePublicIds: ["source-file-projection-first"],
      includedSourceRevisionPublicIds: [
        "source-revision-projection-first",
        "source-revision-projection-second"
      ],
      excludedActiveSourceFilePublicIds: [
        "source-file-projection-first",
        "source-file-projection-second"
      ],
      preferredCurrentSourceFilePublicIds: [
        "source-file-projection-first"
      ],
      limit: 1
    })).resolves.toMatchObject([{
      sourceFilePublicId: "source-file-projection-first",
      sourceRevisionPublicId: "source-revision-projection-first"
    }]);
    await facts.activateRevision({
      knowledgeBaseId: "kb-projection-facts",
      sourceFilePublicId: "source-file-projection-first",
      sourceRevisionPublicId: "source-revision-projection-first",
      now: "2026-08-17T00:00:00.000Z"
    });
    const bucketReader = createPostgresDocumentMachineProjectionReader(
      sql as unknown as DatabaseClient
    );
    await expect(bucketReader.readNavigationTermBucketState({
      knowledgeBaseId: "kb-projection-facts",
      affectedSourceFilePublicIds: ["source-file-projection-first"]
    })).resolves.toEqual({
      catalogBuckets: ["latin"],
      affectedBuckets: ["latin"]
    });
    await expect(bucketReader.listNavigationTermDeltaRecords({
      knowledgeBaseId: "kb-projection-facts",
      bucket: "latin",
      affectedSourceFilePublicIds: ["source-file-projection-first"],
      includedSourceRevisionPublicIds: ["source-revision-projection-first"]
    })).resolves.toEqual([{
      term: "alpha",
      postings: [{
        path: "pages/moved/renamed.md",
        fields: ["title", "path"]
      }]
    }, {
      term: "replacement",
      postings: [{
        path: "pages/moved/renamed.md",
        fields: ["heading"]
      }]
    }]);
    await sql`
      INSERT INTO focowiki.relation_candidate_pairs (
        public_id, knowledge_base_id, first_source_file_public_id,
        first_source_revision_public_id, second_source_file_public_id,
        second_source_revision_public_id, evidence_fingerprint_sha256,
        state, next_eligible_at
      ) VALUES (
        'pair-projection', 'kb-projection-facts',
        'source-file-projection-first', 'source-revision-projection-first',
        'source-file-projection-second', 'source-revision-projection-second',
        ${"e".repeat(64)}, 'resolved', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.relation_directed_evidence (
        public_id, knowledge_base_id, pair_public_id,
        source_file_public_id, source_revision_public_id,
        target_source_file_public_id, target_source_revision_public_id,
        evidence_kind, evidence_fingerprint_sha256, evidence, active
      ) VALUES (
        'evidence-projection', 'kb-projection-facts', 'pair-projection',
        'source-file-projection-first', 'source-revision-projection-first',
        'source-file-projection-second', 'source-revision-projection-second',
        'explicit_reference', ${"e".repeat(64)},
        ${sql.json({ sourceExcerpt: "See Second." })}, false
      )
    `;
    await sql`
      INSERT INTO focowiki.canonical_file_relations (
        public_id, knowledge_base_id, pair_public_id,
        first_source_file_public_id, first_source_revision_public_id,
        second_source_file_public_id, second_source_revision_public_id,
        relation_kind, direction, active, activated_sequence
      ) VALUES (
        'relation-projection', 'kb-projection-facts', 'pair-projection',
        'source-file-projection-first', 'source-revision-projection-first',
        'source-file-projection-second', 'source-revision-projection-second',
        'references', 'first_to_second', false, NULL
      )
    `;
    const relationReader = createPostgresCandidateFileRelationRepository(
      sql as unknown as DatabaseClient
    );
    await expect(relationReader.listVisibleForSource({
      knowledgeBaseId: "kb-projection-facts",
      sourceFilePublicId: "source-file-projection-first",
      includedSourceRevisionPublicIds: [
        "source-revision-projection-first",
        "source-revision-projection-second"
      ],
      excludedActiveSourceFilePublicIds: [
        "source-file-projection-first",
        "source-file-projection-second"
      ],
      limit: 10
    })).resolves.toMatchObject([{
      publicId: "relation-projection",
      firstSourceFilePublicId: "source-file-projection-first",
      secondSourceFilePublicId: "source-file-projection-second",
      relationKind: "references",
      evidence: {
        publicId: "evidence-projection",
        sourceRevisionPublicId: "source-revision-projection-first",
        evidenceKind: "markdown_link"
      }
    }]);
    const reader = createPostgresDocumentMachineProjectionReader(
      sql as unknown as DatabaseClient
    );
    await sql`
      UPDATE focowiki.document_projection_records
      SET active = false
      WHERE knowledge_base_id = 'kb-projection-facts'
        AND source_revision_public_id = 'source-revision-projection-second'
    `;
    await expect(reader.readGraphDirectoryState({
      knowledgeBaseId: "kb-projection-facts",
      scopePath: "pages/moved",
      includedSourceRevisionPublicIds: [
        "source-revision-projection-first"
      ],
      excludedActiveSourceFilePublicIds: [
        "source-file-projection-first"
      ]
    })).resolves.toMatchObject({
      records: []
    });
    await sql`
      UPDATE focowiki.document_projection_records
      SET active = true
      WHERE knowledge_base_id = 'kb-projection-facts'
        AND source_revision_public_id = 'source-revision-projection-second'
    `;
    await expect(reader.readGraphDirectoryState({
      knowledgeBaseId: "kb-projection-facts",
      scopePath: "pages/moved",
      includedSourceRevisionPublicIds: [
        "source-revision-projection-first",
        "source-revision-projection-second"
      ],
      excludedActiveSourceFilePublicIds: [
        "source-file-projection-first",
        "source-file-projection-second"
      ]
    })).resolves.toMatchObject({
      records: [{
        from: "pages/moved/renamed.md",
        to: "pages/reference/second.md",
        direction: "outgoing",
        relationType: "references"
      }]
    });
    const referenceGraphState = await reader.readGraphDirectoryState({
      knowledgeBaseId: "kb-projection-facts",
      scopePath: "pages/reference",
      includedSourceRevisionPublicIds: [
        "source-revision-projection-first",
        "source-revision-projection-second"
      ],
      excludedActiveSourceFilePublicIds: [
        "source-file-projection-first",
        "source-file-projection-second"
      ]
    });
    expect(referenceGraphState).toMatchObject({
      records: [{
        from: "pages/reference/second.md",
        to: "pages/moved/renamed.md",
        direction: "incoming",
        relationType: "references"
      }]
    });
    const referenceGraphPages = buildDocumentGraphDirectoryScopeResources({
      scopePath: "pages/reference",
      records: referenceGraphState.records,
      childDirectories: referenceGraphState.childDirectories,
      previousPaths: referenceGraphState.resourcePaths,
      maximumRecordsPerShard: 100,
      maximumShardBytes: 1_048_576
    }).pages;
    expect(referenceGraphPages.length).toBeGreaterThan(0);
    for (const page of referenceGraphPages) {
      expect(() => parseDocumentPortableRecords(page.bytes, page.logicalPath))
        .not.toThrow();
    }
    await expect(reader.readGraphCatalogState({
      knowledgeBaseId: "kb-projection-facts",
      includedSourceRevisionPublicIds: [
        "source-revision-projection-first",
        "source-revision-projection-second"
      ],
      excludedActiveSourceFilePublicIds: [
        "source-file-projection-first",
        "source-file-projection-second"
      ]
    })).resolves.toEqual({ relationshipCount: 1 });
    const priorGraphObjectId = `generated-sha256:okf-generated-json-v1:${
      "7".repeat(64)}`;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        ${priorGraphObjectId}, 'generated/prior-file-graph.json',
        ${"7".repeat(64)}, 10, 'application/json; charset=utf-8',
        'okf-generated-json-v1', 'verified', 'prior-file-graph-write', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.operations (
        public_id, knowledge_base_id, operation_kind, state,
        target_kind, target_public_id, completed_at
      ) VALUES (
        'prior-file-graph-operation', 'kb-projection-facts',
        'projection_test', 'completed', 'source_file',
        'source-file-projection-first', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_candidates (
        public_id, knowledge_base_id, owner_operation_public_id,
        logical_path, normalized_path, entry_kind, object_id,
        checksum_sha256, byte_count, base_activation_revision, state
      ) VALUES (
        'prior-file-graph-candidate', 'kb-projection-facts',
        'prior-file-graph-operation',
        '_graph/by-file/guides/first.json',
        '_graph/by-file/guides/first.json', 'related_files',
        ${priorGraphObjectId}, ${"7".repeat(64)}, 10, 0, 'active'
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        page_candidate_public_id, object_id, checksum_sha256,
        byte_count, activation_revision,
        source_file_public_id, source_revision_public_id
      ) VALUES (
        'kb-projection-facts', '_graph/by-file/guides/first.json',
        '_graph/by-file/guides/first.json', 'related_files',
        'prior-file-graph-candidate', ${priorGraphObjectId},
        ${"7".repeat(64)}, 10, 1,
        'source-file-projection-first', 'source-revision-projection-first'
      )
    `;
    const olderGraphObjectId = `generated-sha256:okf-generated-json-v1:${
      "8".repeat(64)}`;
    await sql`
      INSERT INTO focowiki.object_registrations (
        object_id, storage_key, checksum_sha256, byte_count, content_type,
        object_format, state, write_attempt_public_id, verified_at
      ) VALUES (
        ${olderGraphObjectId}, 'generated/older-file-graph.json',
        ${"8".repeat(64)}, 10, 'application/json; charset=utf-8',
        'okf-generated-json-v1', 'verified', 'older-file-graph-write', now()
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_candidates (
        public_id, knowledge_base_id, owner_operation_public_id,
        logical_path, normalized_path, entry_kind, object_id,
        checksum_sha256, byte_count, base_activation_revision, state
      ) VALUES (
        'older-file-graph-candidate', 'kb-projection-facts',
        'prior-file-graph-operation',
        '_graph/by-file/legacy/first.json',
        '_graph/by-file/legacy/first.json', 'related_files',
        ${olderGraphObjectId}, ${"8".repeat(64)}, 10, 0, 'active'
      )
    `;
    await sql`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        page_candidate_public_id, object_id, checksum_sha256,
        byte_count, activation_revision,
        source_file_public_id, source_revision_public_id
      ) VALUES (
        'kb-projection-facts', '_graph/by-file/legacy/first.json',
        '_graph/by-file/legacy/first.json', 'related_files',
        'older-file-graph-candidate', ${olderGraphObjectId},
        ${"8".repeat(64)}, 10, 1,
        'source-file-projection-first', 'source-revision-projection-first'
      )
    `;
    await expect(reader.readPerFileGraphState({
      knowledgeBaseId: "kb-projection-facts",
      sourceFilePublicId: "source-file-projection-first",
      includedSourceRevisionPublicIds: [
        "source-revision-projection-first",
        "source-revision-projection-second"
      ],
      excludedActiveSourceFilePublicIds: [
        "source-file-projection-first",
        "source-file-projection-second"
      ]
    })).resolves.toMatchObject({
      source: { path: "pages/moved/renamed.md", title: "Renamed" },
      relationships: [{
        targetPath: "pages/reference/second.md",
        targetTitle: "Second",
        direction: "outgoing",
        relationType: "references"
      }],
      resourcePaths: [
        "_graph/by-file/guides/first.json",
        "_graph/by-file/legacy/first.json"
      ]
    });
    await expect(reader.readPerFileGraphState({
      knowledgeBaseId: "kb-projection-facts",
      sourceFilePublicId: "source-file-projection-second",
      includedSourceRevisionPublicIds: [
        "source-revision-projection-first",
        "source-revision-projection-second"
      ],
      excludedActiveSourceFilePublicIds: [
        "source-file-projection-first",
        "source-file-projection-second"
      ]
    })).resolves.toMatchObject({
      source: { path: "pages/reference/second.md", title: "Second" },
      relationships: [{
        targetPath: "pages/moved/renamed.md",
        targetTitle: "Renamed",
        direction: "incoming",
        relationType: "references"
      }]
    });
    await expect(reader.readPerFileGraphDirectoryState({
      knowledgeBaseId: "kb-projection-facts",
      scopePath: "pages",
      includedSourceRevisionPublicIds: [
        "source-revision-projection-first",
        "source-revision-projection-second"
      ],
      excludedActiveSourceFilePublicIds: [
        "source-file-projection-first",
        "source-file-projection-second"
      ]
    })).resolves.toEqual({
      relationshipPagePaths: [],
      records: [],
      childDirectories: [{
        title: "moved",
        scopePath: "pages/moved",
        path: "_graph/by-file/moved/index.md"
      }, {
        title: "reference",
        scopePath: "pages/reference",
        path: "_graph/by-file/reference/index.md"
      }]
    });
    await expect(reader.readPerFileGraphDirectoryState({
      knowledgeBaseId: "kb-projection-facts",
      scopePath: "pages/moved",
      includedSourceRevisionPublicIds: [
        "source-revision-projection-first",
        "source-revision-projection-second"
      ],
      excludedActiveSourceFilePublicIds: [
        "source-file-projection-first",
        "source-file-projection-second"
      ]
    })).resolves.toEqual({
      relationshipPagePaths: ["pages/moved/renamed.md"],
      records: [{
        path: "_graph/by-file/moved/renamed.json",
        title: "Renamed"
      }],
      childDirectories: []
    });
    await sql`
      UPDATE focowiki.relation_directed_evidence
      SET active = true
      WHERE public_id = 'evidence-projection'
    `;
    await sql`
      UPDATE focowiki.canonical_file_relations
      SET active = true, activated_sequence = 1
      WHERE public_id = 'relation-projection'
    `;
    await sql`
      UPDATE focowiki.document_graph_degrees
      SET incoming_count = CASE
            WHEN source_revision_public_id = 'source-revision-projection-second'
              THEN 1 ELSE 0 END,
          outgoing_count = CASE
            WHEN source_revision_public_id = 'source-revision-projection-first'
              THEN 1 ELSE 0 END,
          updated_at = now()
      WHERE knowledge_base_id = 'kb-projection-facts'
        AND source_revision_public_id IN (
          'source-revision-projection-first',
          'source-revision-projection-second'
        )
    `;
    const removedGraphRecordKeys: string[] = [];
    const replacementGraphRecords: Record<string, unknown>[] = [];
    await reader.scanGraphDirectoryDeltaState({
      knowledgeBaseId: "kb-projection-facts",
      scopePath: "pages/moved",
      affectedSourceFilePublicIds: ["source-file-projection-first"],
      includedSourceRevisionPublicIds: [],
      excludedActiveSourceFilePublicIds: ["source-file-projection-first"],
      affectedLogicalPaths: ["pages/moved/renamed.md"],
      baseDeterministicChangedAt: "2100-01-01T00:00:00.000Z",
      onRemovedRecordKeys(keys) {
        removedGraphRecordKeys.push(...keys);
      },
      onRecords(records) {
        replacementGraphRecords.push(...records);
      }
    });
    expect(replacementGraphRecords).toEqual([]);
    expect(removedGraphRecordKeys).toHaveLength(1);
    const reverseEndpointKeys: string[] = [];
    await reader.scanGraphDirectoryDeltaState({
      knowledgeBaseId: "kb-projection-facts",
      scopePath: "pages/reference",
      affectedSourceFilePublicIds: ["source-file-projection-second"],
      includedSourceRevisionPublicIds: [],
      excludedActiveSourceFilePublicIds: ["source-file-projection-second"],
      affectedLogicalPaths: ["pages/reference/second.md"],
      baseDeterministicChangedAt: "2100-01-01T00:00:00.000Z",
      onRemovedRecordKeys(keys) {
        reverseEndpointKeys.push(...keys);
      },
      onRecords() {}
    });
    expect(reverseEndpointKeys).toEqual([
      "pages/reference/second.md\0pages/moved/renamed.md\0references"
    ]);
    await expect(reader.readPerFileGraphDirectoryDeltaState({
      knowledgeBaseId: "kb-projection-facts",
      scopePath: "pages",
      includedSourceRevisionPublicIds: [
        "source-revision-projection-first"
      ],
      excludedActiveSourceFilePublicIds: [
        "source-file-projection-first"
      ],
      affectedSourceFilePublicIds: [
        "source-file-projection-first",
        "source-file-projection-second"
      ],
      candidateChildScopePaths: ["pages/moved", "pages/reference"]
    })).resolves.toEqual({
      records: [],
      childDirectories: [{
        title: "moved",
        scopePath: "pages/moved",
        path: "_graph/by-file/moved/index.md"
      }, {
        title: "reference",
        scopePath: "pages/reference",
        path: "_graph/by-file/reference/index.md"
      }]
    });
    await expect(reader.readDocumentDirectoryState({
      knowledgeBaseId: "kb-projection-facts",
      scopePath: "pages/reference"
    })).resolves.toMatchObject({
      records: [{
        path: "pages/reference/second.md",
        title: "Second",
        summary: "Summary for second",
        graphPath: "_graph/by-file/reference/second.json"
      }],
      childDirectories: [],
      resourcePaths: []
    });
    await expect(reader.readDocumentDirectoryState({
      knowledgeBaseId: "kb-projection-facts",
      scopePath: "pages"
    })).resolves.toMatchObject({
      records: [],
      childDirectories: [{
        title: "moved",
        scopePath: "pages/moved",
        path: "_index/pages/moved/index.json"
      }, {
        title: "reference",
        scopePath: "pages/reference",
        path: "_index/pages/reference/index.json"
      }]
    });
    await expect(reader.readGraphDirectoryState({
      knowledgeBaseId: "kb-projection-facts",
      scopePath: "pages/moved"
    })).resolves.toMatchObject({
      records: [{
        from: "pages/moved/renamed.md",
        to: "pages/reference/second.md",
        direction: "outgoing",
        relationType: "references"
      }],
      childDirectories: [],
      resourcePaths: []
    });
    await expect(reader.readGraphDirectoryState({
      knowledgeBaseId: "kb-projection-facts",
      scopePath: "pages/reference"
    })).resolves.toMatchObject({
      records: [{
        from: "pages/reference/second.md",
        to: "pages/moved/renamed.md",
        direction: "incoming",
        relationType: "references"
      }],
      childDirectories: [],
      resourcePaths: []
    });
    await sql`
      INSERT INTO focowiki.relation_directed_evidence (
        public_id, knowledge_base_id, pair_public_id,
        source_file_public_id, source_revision_public_id,
        target_source_file_public_id, target_source_revision_public_id,
        evidence_kind, evidence_fingerprint_sha256, evidence, active
      )
      SELECT 'evidence-projection-scale-' || sequence::text,
             'kb-projection-facts', 'pair-projection',
             'source-file-projection-first',
             'source-revision-projection-first',
             'source-file-projection-second',
             'source-revision-projection-second',
             'explicit_reference',
             md5(sequence::text) || md5(sequence::text),
             jsonb_build_object('sourceExcerpt', 'See Second.'), true
      FROM generate_series(1, 10001) sequence
    `;
    await expect(reader.readGraphDirectoryState({
      knowledgeBaseId: "kb-projection-facts",
      scopePath: "pages/moved"
    })).resolves.toMatchObject({
      records: [{
        from: "pages/moved/renamed.md",
        to: "pages/reference/second.md",
        direction: "outgoing",
        relationType: "references"
      }]
    });
    await sql`
      DELETE FROM focowiki.relation_directed_evidence
      WHERE public_id LIKE 'evidence-projection-scale-%'
    `;
    await expect(reader.readGraphDirectoryState({
      knowledgeBaseId: "kb-projection-facts",
      scopePath: "pages"
    })).resolves.toMatchObject({
      records: [],
      childDirectories: [{
        title: "moved",
        scopePath: "pages/moved",
        path: "_graph/by-directory/moved/index.json"
      }, {
        title: "reference",
        scopePath: "pages/reference",
        path: "_graph/by-directory/reference/index.json"
      }]
    });
    await expect(reader.readRootProjectionState({
      knowledgeBaseId: "kb-projection-facts",
      includedSourceRevisionPublicIds: [
        "source-revision-projection-first",
        "source-revision-projection-second"
      ],
      excludedActiveSourceFilePublicIds: [
        "source-file-projection-first",
        "source-file-projection-second"
      ],
      logLimit: 10
    })).resolves.toMatchObject({
      knowledgeBase: {
        id: "kb-projection-facts",
        name: "Projection facts"
      },
      sourceFileCount: 2,
      graphEdgeCount: 1,
      rootEntryCount: 2,
      currentLogEntries: [{
        message: "Updated pages/moved/renamed.md."
      }, {
        message: "Updated pages/second.md."
      }],
      previousLogEntries: []
    });

    await sql`
      UPDATE focowiki.relation_directed_evidence
      SET active = false, retired_at = now()
      WHERE public_id = 'evidence-projection'
    `;
    await sql`
      UPDATE focowiki.canonical_file_relations
      SET active = false, retired_at = now()
      WHERE public_id = 'relation-projection'
    `;
    const retiredVisibility = {
      knowledgeBaseId: "kb-projection-facts",
      includedSourceRevisionPublicIds: [
        "source-revision-projection-first",
        "source-revision-projection-second"
      ],
      excludedActiveSourceFilePublicIds: [
        "source-file-projection-first",
        "source-file-projection-second"
      ]
    };
    await expect(reader.readGraphCatalogState(
      retiredVisibility
    )).resolves.toEqual({ relationshipCount: 0 });
    await expect(reader.readGraphDirectoryState({
      ...retiredVisibility,
      scopePath: "pages/moved"
    })).resolves.toMatchObject({ records: [] });
    await expect(reader.readPerFileGraphState({
      ...retiredVisibility,
      sourceFilePublicId: "source-file-projection-first"
    })).resolves.toMatchObject({ relationships: [] });
    await expect(reader.readPerFileGraphDirectoryState({
      ...retiredVisibility,
      scopePath: "pages"
    })).resolves.toEqual({
      relationshipPagePaths: [],
      records: [],
      childDirectories: []
    });
  });

  it("cascades every exact projection fact when a revision is deleted", async () => {
    await sql`
      DELETE FROM focowiki.generated_page_heads
      WHERE knowledge_base_id = 'kb-projection-facts'
        AND source_file_public_id = 'source-file-projection-first'
    `;
    await sql`
      DELETE FROM focowiki.source_file_active_revisions
      WHERE knowledge_base_id = 'kb-projection-facts'
        AND source_file_public_id = 'source-file-projection-first'
    `;
    await sql`
      DELETE FROM focowiki.source_revisions
      WHERE public_id = 'source-revision-projection-first'
    `;
    await expect(sql<Array<{ count: number | string }>>`
      SELECT count(*) AS count
      FROM (
        SELECT source_revision_public_id FROM focowiki.document_projection_records
        UNION ALL
        SELECT source_revision_public_id FROM focowiki.document_navigation_terms
        UNION ALL
        SELECT source_revision_public_id FROM focowiki.document_navigation_postings
        UNION ALL
        SELECT source_revision_public_id
          FROM focowiki.document_semantic_directory_memberships
        UNION ALL
        SELECT source_revision_public_id FROM focowiki.document_graph_degrees
      ) owned
      WHERE source_revision_public_id = 'source-revision-projection-first'
    `).resolves.toEqual([{ count: "0" }]);
  });

  it("keeps the latest inactive path as a deletion navigation candidate",
    async () => {
      const facts = createPostgresDocumentProjectionFacts(
        sql as unknown as DatabaseClient
      );
      await facts.activateRevision({
        knowledgeBaseId: "kb-projection-facts",
        sourceFilePublicId: "source-file-projection-third",
        sourceRevisionPublicId: "source-revision-projection-third",
        now: "2026-08-17T00:00:00.000Z"
      });
      const reader = createPostgresDocumentMachineProjectionReader(
        sql as unknown as DatabaseClient
      );
      const relationClosureDelta = await reader.readSemanticDirectoryDeltaState({
        knowledgeBaseId: "kb-projection-facts",
        scopePath: "pages",
        affectedSourceFilePublicIds: [
          "source-file-projection-second",
          "source-file-projection-third"
        ],
        includedSourceRevisionPublicIds: [
          "source-revision-projection-second"
        ],
        navigationSourceFilePublicIds: ["source-file-projection-second"]
      });
      expect(relationClosureDelta.navigationCandidateEntryIds).toEqual([
        documentDirectoryEntryId("directory", "pages/reference/index.md")
      ]);

      await sql`
        UPDATE focowiki.document_projection_records
        SET active = false
        WHERE knowledge_base_id = 'kb-projection-facts'
          AND source_revision_public_id = 'source-revision-projection-second'
      `;
      await sql`
        UPDATE focowiki.document_semantic_directory_memberships
        SET directory_path = 'pages/reference',
            page_path = 'pages/reference/third.md'
        WHERE knowledge_base_id = 'kb-projection-facts'
          AND source_revision_public_id = 'source-revision-projection-third'
          AND directory_path = 'pages/guides'
      `;
      const relationOnlyNeighborDelta =
        await reader.readSemanticDirectoryDeltaState({
          knowledgeBaseId: "kb-projection-facts",
          scopePath: "pages",
          affectedSourceFilePublicIds: [
            "source-file-projection-second",
            "source-file-projection-third"
          ],
          includedSourceRevisionPublicIds: [],
          navigationSourceFilePublicIds: ["source-file-projection-second"]
        });
      expect(relationOnlyNeighborDelta.childDirectories).toEqual([{
        title: "reference",
        scopePath: "pages/reference",
        path: "pages/reference/index.md"
      }]);
      await sql`
        UPDATE focowiki.document_semantic_directory_memberships
        SET directory_path = 'pages/guides',
            page_path = 'pages/guides/third.md'
        WHERE knowledge_base_id = 'kb-projection-facts'
          AND source_revision_public_id = 'source-revision-projection-third'
          AND directory_path = 'pages/reference'
      `;
      await expect(reader.readSemanticDirectoryDeltaState({
        knowledgeBaseId: "kb-projection-facts",
        scopePath: "pages/reference",
        affectedSourceFilePublicIds: ["source-file-projection-second"],
        includedSourceRevisionPublicIds: []
      })).resolves.toEqual({
        records: [],
        childDirectories: [],
        navigationCandidateEntryIds: [documentDirectoryEntryId(
          "file", "pages/reference/second.md"
        )],
        removedRecordPaths: ["pages/reference/second.md"]
      });
      await sql`
        UPDATE focowiki.document_projection_records
        SET active = true
        WHERE knowledge_base_id = 'kb-projection-facts'
          AND source_revision_public_id = 'source-revision-projection-second'
      `;
      await expect(reader.readSemanticDirectoryDeltaState({
        knowledgeBaseId: "kb-projection-facts",
        scopePath: "pages/reference",
        affectedSourceFilePublicIds: ["source-file-projection-second"],
        includedSourceRevisionPublicIds: [],
        excludedActiveSourceFilePublicIds: ["source-file-projection-second"]
      })).resolves.toEqual({
        records: [],
        childDirectories: [],
        navigationCandidateEntryIds: [documentDirectoryEntryId(
          "file", "pages/reference/second.md"
        )],
        removedRecordPaths: ["pages/reference/second.md"]
      });
    });

  it("reads only a changed stable-leaf window and its bounded neighbors",
    async () => {
      const leaves = ["a", "b", "c", "d", "e"].map((suffix, index, all) => ({
        id: `delta-leaf-${suffix}`,
        previousLeafId: index === 0 ? null : `delta-leaf-${all[index - 1]}`,
        nextLeafId: index === all.length - 1
          ? null : `delta-leaf-${all[index + 1]}`,
        revision: 1,
        changedAt: "2026-08-24T01:00:00.000Z",
        entries: [{
          id: `delta-entry-${suffix}`,
          sortKey: `${suffix}.md`,
          name: `${suffix}.md`,
          targetPath: `pages/delta/${suffix}.md`,
          kind: "file" as const
        }]
      }));
      await applyPostgresDocumentDirectoryNavigation({
        transaction: sql as unknown as DatabaseClient,
        knowledgeBaseId: "kb-projection-facts",
        activationRevision: 1,
        mutations: [{
          directoryPath: "pages/delta",
          touchedLeaves: leaves,
          removedLeafIds: []
        }],
        activatedAt: "2026-08-24T01:00:00.000Z"
      });
      const desiredEntries = [
        ...leaves.flatMap((leaf) => leaf.entries),
        {
          id: "delta-entry-c2", sortKey: "c2.md", name: "c2.md",
          targetPath: "pages/delta/c2.md", kind: "file" as const
        }
      ];
      await expect(createPostgresDocumentDirectoryNavigation(
        sql as unknown as DatabaseClient
      ).readDelta({
        knowledgeBaseId: "kb-projection-facts",
        directoryPath: "pages/delta",
        desiredEntries,
        maximumChanges: 16,
        maximumLeaves: 16,
        maximumEntries: 32
      })).resolves.toMatchObject({
        mode: "window",
        totalEntryCount: 5,
        firstLeafId: "delta-leaf-a",
        occupiedLeafIds: leaves.map((leaf) => leaf.id),
        changes: [{
          entryId: "delta-entry-c2",
          desiredEntry: { targetPath: "pages/delta/c2.md" }
        }],
        leaves: [
          { id: "delta-leaf-c" },
          { id: "delta-leaf-d" },
          { id: "delta-leaf-e" }
        ]
      });
    });

  it("loads a full reconciliation snapshot for an asymmetric navigation chain",
    async () => {
      const leaves = ["a", "b", "c"].map((suffix, index, all) => ({
        id: `repair-leaf-${suffix}`,
        previousLeafId: index === 0 ? null : `repair-leaf-${all[index - 1]}`,
        nextLeafId: index === all.length - 1
          ? null : `repair-leaf-${all[index + 1]}`,
        revision: 1,
        changedAt: "2026-08-27T06:00:00.000Z",
        entries: [{
          id: `repair-entry-${suffix}`,
          sortKey: `${suffix}.md`,
          name: `${suffix}.md`,
          targetPath: `pages/repair/${suffix}.md`,
          kind: "file" as const
        }]
      }));
      await applyPostgresDocumentDirectoryNavigation({
        transaction: sql as unknown as DatabaseClient,
        knowledgeBaseId: "kb-projection-facts",
        activationRevision: 1,
        mutations: [{
          directoryPath: "pages/repair",
          touchedLeaves: leaves,
          removedLeafIds: []
        }],
        activatedAt: "2026-08-27T06:00:00.000Z"
      });
      await sql`
        UPDATE focowiki.generated_directory_leaves
        SET next_leaf_public_id = 'repair-leaf-c'
        WHERE knowledge_base_id = 'kb-projection-facts'
          AND directory_path = 'pages/repair'
          AND leaf_public_id = 'repair-leaf-a'
      `;
      await sql`
        UPDATE focowiki.generated_directory_leaves
        SET previous_leaf_public_id = 'repair-leaf-a'
        WHERE knowledge_base_id = 'kb-projection-facts'
          AND directory_path = 'pages/repair'
          AND leaf_public_id = 'repair-leaf-c'
      `;

      await expect(createPostgresDocumentDirectoryNavigation(
        sql as unknown as DatabaseClient
      ).readDelta({
        knowledgeBaseId: "kb-projection-facts",
        directoryPath: "pages/repair",
        desiredEntries: [{
          ...leaves[1]!.entries[0]!, name: "Updated b.md"
        }],
        candidateEntryIds: ["repair-entry-b"],
        maximumChanges: 16,
        maximumLeaves: 16,
        maximumEntries: 32
      })).resolves.toMatchObject({
        mode: "reconcile",
        totalEntryCount: 3,
        firstLeafId: "repair-leaf-a",
        changes: [{
          entryId: "repair-entry-b",
          desiredEntry: { name: "Updated b.md" }
        }],
        leaves: [{
          id: "repair-leaf-a", nextLeafId: "repair-leaf-c"
        }, {
          id: "repair-leaf-b"
        }, {
          id: "repair-leaf-c", previousLeafId: "repair-leaf-a"
        }]
      });
    });

  it("loads one reconciliation snapshot for disconnected delta windows",
    async () => {
      const leaves = ["a", "b", "c", "d", "e", "f", "g"].map(
        (suffix, index, all) => ({
          id: `disconnected-leaf-${suffix}`,
          previousLeafId: index === 0
            ? null : `disconnected-leaf-${all[index - 1]}`,
          nextLeafId: index === all.length - 1
            ? null : `disconnected-leaf-${all[index + 1]}`,
          revision: 1,
          changedAt: "2026-08-27T08:00:00.000Z",
          entries: [{
            id: `disconnected-entry-${suffix}`,
            sortKey: `${suffix}.md`,
            name: `${suffix}.md`,
            targetPath: `pages/disconnected/${suffix}.md`,
            kind: "file" as const
          }]
        })
      );
      await applyPostgresDocumentDirectoryNavigation({
        transaction: sql as unknown as DatabaseClient,
        knowledgeBaseId: "kb-projection-facts",
        activationRevision: 1,
        mutations: [{
          directoryPath: "pages/disconnected",
          touchedLeaves: leaves,
          removedLeafIds: []
        }],
        activatedAt: "2026-08-27T08:00:00.000Z"
      });
      const additions = [{
        id: "disconnected-entry-b2",
        sortKey: "b2.md",
        name: "b2.md",
        targetPath: "pages/disconnected/b2.md",
        kind: "file" as const
      }, {
        id: "disconnected-entry-f2",
        sortKey: "f2.md",
        name: "f2.md",
        targetPath: "pages/disconnected/f2.md",
        kind: "file" as const
      }];

      await expect(createPostgresDocumentDirectoryNavigation(
        sql as unknown as DatabaseClient
      ).readDelta({
        knowledgeBaseId: "kb-projection-facts",
        directoryPath: "pages/disconnected",
        desiredEntries: additions,
        candidateEntryIds: additions.map((entry) => entry.id),
        maximumChanges: 16,
        maximumLeaves: 16,
        maximumEntries: 32
      })).resolves.toMatchObject({
        mode: "reconcile",
        totalEntryCount: 7,
        firstLeafId: "disconnected-leaf-a",
        leaves: leaves.map((leaf) => ({ id: leaf.id }))
      });
    });

  it("reads more than ten thousand direct relationship files without a directory cap",
    async () => {
      const count = 10_001;
      const checksum = "9".repeat(64);
      const objectId = `source-sha256:${checksum}`;
      await sql`
        INSERT INTO focowiki.knowledge_bases (public_id, name, revision)
        VALUES ('kb-large-flat-directory', 'Large flat directory', 1)
      `;
      await sql`
        INSERT INTO focowiki.object_registrations (
          object_id, storage_key, checksum_sha256, byte_count, content_type,
          object_format, state, write_attempt_public_id, verified_at
        ) VALUES (
          ${objectId}, 'runs/projection/large-flat.md', ${checksum}, 10,
          'text/markdown; charset=utf-8', 'source_markdown', 'verified',
          'write-large-flat-directory', now()
        )
      `;
      await sql`
        INSERT INTO focowiki.source_files (
          public_id, knowledge_base_id, logical_path, normalized_path,
          title, metadata, revision
        )
        SELECT source_file_public_id, 'kb-large-flat-directory', logical_path,
               logical_path, title, '{}'::jsonb, 1
        FROM (
          SELECT 'source-a-' || lpad(value::text, 5, '0') source_file_public_id,
                 'file-' || lpad(value::text, 5, '0') || '.md' logical_path,
                 'File ' || lpad(value::text, 5, '0') title
          FROM generate_series(1, ${count}) value
          UNION ALL
          SELECT 'source-z-anchor', 'anchor.md', 'Anchor'
        ) sources
      `;
      await sql`
        INSERT INTO focowiki.source_revisions (
          public_id, knowledge_base_id, source_file_public_id, object_id,
          checksum_sha256, byte_count, content_type
        )
        SELECT 'revision-' || source.public_id, 'kb-large-flat-directory',
               source.public_id, ${objectId}, ${checksum}, 10,
               'text/markdown; charset=utf-8'
        FROM focowiki.source_files source
        WHERE source.knowledge_base_id = 'kb-large-flat-directory'
      `;
      await sql`
        INSERT INTO focowiki.document_projection_records (
          knowledge_base_id, source_file_public_id, source_revision_public_id,
          logical_path, normalized_path, title, summary, metadata, headings,
          entities, content_type, checksum_sha256, byte_count,
          tokenizer_contract_version, navigation_term_fingerprint_sha256,
          active
        )
        SELECT 'kb-large-flat-directory', source.public_id,
               'revision-' || source.public_id, source.logical_path,
               source.normalized_path, source.title, '', '{}'::jsonb,
               '{}'::text[], '{}'::text[], 'text/markdown; charset=utf-8',
               ${checksum}, 10, 'nodejieba-test-v1', ${checksum}, true
        FROM focowiki.source_files source
        WHERE source.knowledge_base_id = 'kb-large-flat-directory'
      `;
      await sql`
        INSERT INTO focowiki.document_semantic_directory_memberships (
          knowledge_base_id, source_revision_public_id, directory_path,
          page_path
        )
        SELECT 'kb-large-flat-directory', 'revision-' || source.public_id,
               'pages', 'pages/' || source.logical_path
        FROM focowiki.source_files source
        WHERE source.knowledge_base_id = 'kb-large-flat-directory'
      `;
      await sql`
        INSERT INTO focowiki.relation_candidate_pairs (
          public_id, knowledge_base_id, first_source_file_public_id,
          first_source_revision_public_id, second_source_file_public_id,
          second_source_revision_public_id, evidence_fingerprint_sha256,
          state, next_eligible_at
        )
        SELECT 'pair-' || source.public_id, 'kb-large-flat-directory',
               source.public_id, 'revision-' || source.public_id,
               'source-z-anchor', 'revision-source-z-anchor', ${checksum},
               'resolved', now()
        FROM focowiki.source_files source
        WHERE source.knowledge_base_id = 'kb-large-flat-directory'
          AND source.public_id <> 'source-z-anchor'
      `;
      await sql`
        INSERT INTO focowiki.relation_directed_evidence (
          public_id, knowledge_base_id, pair_public_id,
          source_file_public_id, source_revision_public_id,
          target_source_file_public_id, target_source_revision_public_id,
          evidence_kind, evidence_fingerprint_sha256, evidence, active
        )
        SELECT 'evidence-' || source.public_id, 'kb-large-flat-directory',
               'pair-' || source.public_id, source.public_id,
               'revision-' || source.public_id, 'source-z-anchor',
               'revision-source-z-anchor', 'explicit_reference', ${checksum},
               '{}'::jsonb, true
        FROM focowiki.source_files source
        WHERE source.knowledge_base_id = 'kb-large-flat-directory'
          AND source.public_id <> 'source-z-anchor'
      `;
      await sql`
        INSERT INTO focowiki.canonical_file_relations (
          public_id, knowledge_base_id, pair_public_id,
          first_source_file_public_id, first_source_revision_public_id,
          second_source_file_public_id, second_source_revision_public_id,
          relation_kind, direction, active, activated_sequence
        )
        SELECT 'relation-' || source.public_id, 'kb-large-flat-directory',
               'pair-' || source.public_id, source.public_id,
               'revision-' || source.public_id, 'source-z-anchor',
               'revision-source-z-anchor', 'references', 'first_to_second',
               true, 1
        FROM focowiki.source_files source
        WHERE source.knowledge_base_id = 'kb-large-flat-directory'
          AND source.public_id <> 'source-z-anchor'
      `;
      await sql`
        INSERT INTO focowiki.document_graph_degrees (
          knowledge_base_id, source_revision_public_id,
          incoming_count, outgoing_count
        )
        SELECT 'kb-large-flat-directory', record.source_revision_public_id,
               CASE WHEN record.source_file_public_id = 'source-z-anchor'
                 THEN ${count} ELSE 0 END,
               CASE WHEN record.source_file_public_id = 'source-z-anchor'
                 THEN 0 ELSE 1 END
        FROM focowiki.document_projection_records record
        WHERE record.knowledge_base_id = 'kb-large-flat-directory'
        ON CONFLICT (knowledge_base_id, source_revision_public_id)
        DO UPDATE SET incoming_count = EXCLUDED.incoming_count,
                      outgoing_count = EXCLUDED.outgoing_count,
                      updated_at = now()
      `;
      const reader = createPostgresDocumentMachineProjectionReader(
        sql as unknown as DatabaseClient
      );
      const graphStartedAt = performance.now();
      const graphDirectory = await reader.readPerFileGraphDirectoryState({
        knowledgeBaseId: "kb-large-flat-directory",
        scopePath: "pages",
      });
      const graphDurationMs = performance.now() - graphStartedAt;
      expect(graphDirectory.records).toHaveLength(count + 1);
      expect(graphDirectory.childDirectories).toEqual([]);
      expect(graphDirectory.relationshipPagePaths).toHaveLength(count + 1);
      const indexStartedAt = performance.now();
      const pageDirectory = await reader.readDocumentDirectoryState({
        knowledgeBaseId: "kb-large-flat-directory",
        scopePath: "pages",
      });
      const indexDurationMs = performance.now() - indexStartedAt;
      expect(pageDirectory.records).toHaveLength(count + 1);
      expect(pageDirectory.records.every((record) =>
        record.relationshipCount === 1)).toBe(true);
      expect(pageDirectory.childDirectories).toEqual([]);
      const affectedSourceFilePublicIds = Array.from({ length: 314 },
        (_, index) => `source-a-${String(index + 1).padStart(5, "0")}`);
      const navigationSourceFilePublicIds =
        affectedSourceFilePublicIds.slice(0, 51);
      const deltaStartedAt = performance.now();
      const semanticDelta = await reader.readSemanticDirectoryDeltaState({
        knowledgeBaseId: "kb-large-flat-directory",
        scopePath: "pages",
        affectedSourceFilePublicIds,
        includedSourceRevisionPublicIds: navigationSourceFilePublicIds.map(
          (sourceFilePublicId) => `revision-${sourceFilePublicId}`
        ),
        navigationSourceFilePublicIds
      });
      const batchedAffectedSourceFilePublicIds = Array.from({ length: 700 },
        (_, index) => `source-a-${String(index + 1).padStart(5, "0")}`);
      const batchedSemanticDelta =
        await reader.readSemanticDirectoryDeltaState({
          knowledgeBaseId: "kb-large-flat-directory",
          scopePath: "pages",
          affectedSourceFilePublicIds: batchedAffectedSourceFilePublicIds,
          includedSourceRevisionPublicIds:
            navigationSourceFilePublicIds.map(
              (sourceFilePublicId) => `revision-${sourceFilePublicId}`
            ),
          navigationSourceFilePublicIds
        });
      const deltaDurationMs = performance.now() - deltaStartedAt;
      expect(semanticDelta.records).toHaveLength(314);
      expect(semanticDelta.navigationCandidateEntryIds).toHaveLength(51);
      expect(batchedSemanticDelta.records).toHaveLength(700);
      expect(batchedSemanticDelta.navigationCandidateEntryIds)
        .toHaveLength(51);
      expect(graphDurationMs).toBeLessThan(5_000);
      expect(indexDurationMs).toBeLessThan(5_000);
      expect(deltaDurationMs).toBeLessThan(5_000);
    }, 120_000);
});

function fact(
  suffix: string,
  input: {
    pagePath: string;
    terms: readonly {
      term: string;
      fields: readonly ("title" | "path" | "heading")[];
    }[];
    directories: readonly string[];
  }
) {
  return {
    knowledgeBaseId: "kb-projection-facts",
    sourceFilePublicId: `source-file-projection-${suffix}`,
    sourceRevisionPublicId: `source-revision-projection-${suffix}`,
    logicalPath: `${suffix}.md`,
    normalizedPath: `${suffix}.md`,
    pagePath: input.pagePath,
    title: suffix === "first" ? "First" : "Second",
    summary: `Summary for ${suffix}`,
    metadata: { category: suffix },
    headings: [`Heading ${suffix}`],
    entities: [`Entity ${suffix}`],
    contentType: "text/markdown; charset=utf-8",
    checksumSha256: (suffix === "first" ? "a" : "b").repeat(64),
    byteCount: 10,
    tokenizerContractVersion: "nodejieba-test-v1",
    navigationTermFingerprintSha256:
      (suffix === "first" ? "c" : "d").repeat(64),
    navigationTerms: input.terms,
    directoryPaths: input.directories,
    incomingRelationshipCount: 0,
    outgoingRelationshipCount: 0
  };
}

async function seedSource(
  sql: postgres.Sql,
  suffix: string,
  checksumCharacter: string
): Promise<void> {
  const objectId = `source-sha256:${checksumCharacter.repeat(64)}`;
  await sql`
    INSERT INTO focowiki.object_registrations (
      object_id, storage_key, checksum_sha256, byte_count, content_type,
      object_format, state, write_attempt_public_id, verified_at
    ) VALUES (
      ${objectId}, ${`runs/projection/${suffix}.md`},
      ${checksumCharacter.repeat(64)}, 10, 'text/markdown; charset=utf-8',
      'source_markdown', 'verified', ${`write-projection-${suffix}`}, now()
    )
  `;
  await sql`
    INSERT INTO focowiki.source_files (
      public_id, knowledge_base_id, logical_path, normalized_path,
      title, metadata, revision
    ) VALUES (
      ${`source-file-projection-${suffix}`}, 'kb-projection-facts',
      ${`${suffix}.md`}, ${`${suffix}.md`}, ${suffix}, '{}'::jsonb, 1
    )
  `;
  await sql`
    INSERT INTO focowiki.source_revisions (
      public_id, knowledge_base_id, source_file_public_id, object_id,
      checksum_sha256, byte_count, content_type
    ) VALUES (
      ${`source-revision-projection-${suffix}`}, 'kb-projection-facts',
      ${`source-file-projection-${suffix}`}, ${objectId},
      ${checksumCharacter.repeat(64)}, 10, 'text/markdown; charset=utf-8'
    )
  `;
  await sql`
    INSERT INTO focowiki.source_file_active_revisions (
      knowledge_base_id, source_file_public_id,
      current_source_revision_public_id, active_source_revision_public_id,
      activation_sequence
    ) VALUES (
      'kb-projection-facts', ${`source-file-projection-${suffix}`},
      ${`source-revision-projection-${suffix}`},
      ${`source-revision-projection-${suffix}`}, 0
    )
  `;
}

async function rowVersions(sql: postgres.Sql): Promise<readonly {
  table_name: string;
  identity: string;
  version: string;
}[]> {
  return sql`
    SELECT table_name, identity, version
    FROM (
      SELECT 'record' AS table_name, source_revision_public_id AS identity,
             xmin::text AS version
      FROM focowiki.document_projection_records
      UNION ALL
      SELECT 'term', source_revision_public_id || ':' || term, xmin::text
      FROM focowiki.document_navigation_terms
      UNION ALL
      SELECT 'posting', source_revision_public_id || ':' || term, xmin::text
      FROM focowiki.document_navigation_postings
      UNION ALL
      SELECT 'directory', source_revision_public_id || ':' || directory_path,
             xmin::text
      FROM focowiki.document_semantic_directory_memberships
      UNION ALL
      SELECT 'degree', source_revision_public_id, xmin::text
      FROM focowiki.document_graph_degrees
    ) versions
    ORDER BY table_name COLLATE "C", identity COLLATE "C"
  `;
}

function withDatabase(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = "/" + databaseName;
  return url.toString();
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
