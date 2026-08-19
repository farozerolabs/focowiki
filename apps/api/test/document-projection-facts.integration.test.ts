import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { buildDocumentGraphDirectoryScopeResources } from
  "../src/document-indexing/application/document-graph-projection.js";
import { parseDocumentPortableRecords } from
  "../src/document-indexing/application/document-portable-record-parser.js";
import { createPostgresDocumentProjectionFacts } from
  "../src/document-indexing/infrastructure/postgres-document-projection-facts.js";
import { createPostgresDocumentMachineProjectionReader } from
  "../src/document-indexing/infrastructure/postgres-document-machine-projection-reader.js";
import { createPostgresCandidateFileRelationRepository } from
  "../src/document-indexing/infrastructure/postgres-candidate-file-relation-repository.js";
import { createPostgresGeneratedPageBaseRepository } from
  "../src/document-indexing/infrastructure/postgres-generated-page-base-repository.js";
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
      records: [{
        from: "pages/moved/renamed.md",
        to: "pages/reference/second.md",
        direction: "outgoing",
        relationType: "references"
      }]
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
      resourcePaths: []
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
      relationshipPagePaths: [
        "pages/moved/renamed.md",
        "pages/reference/second.md"
      ],
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
