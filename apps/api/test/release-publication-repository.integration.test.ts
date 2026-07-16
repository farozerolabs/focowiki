import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresAdminRepositories } from "../src/db/admin-repositories.js";
import { createPostgresFileGraphRepository } from "../src/db/file-graph-repository.js";
import { createPostgresReleasePublicationRepository } from "../src/infrastructure/postgres/release-publication-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("release publication repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 3 });
  const repository = createPostgresReleasePublicationRepository(sql);
  const knowledgeBaseId = "kb-release-publication-integration";
  const previousReleaseId = "release-publication-previous";
  const candidateReleaseId = "release-publication-candidate";

  beforeAll(async () => {
    await cleanup();
    await seedSourceCatalog();
    await repository.materializeSourceSnapshot({
      knowledgeBaseId,
      releaseId: previousReleaseId,
      publicationSourceFileIds: []
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("materializes one release-scoped source snapshot with candidate paths and bounded cursors", async () => {
    const result = await repository.materializeSourceSnapshot({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      publicationSourceFileIds: ["release-source-file-new"]
    });

    expect(result).toEqual({ directoryCount: 4, sourceFileCount: 4 });
    expect(await repository.countSourceFiles({ knowledgeBaseId, releaseId: candidateReleaseId })).toBe(4);

    const items = [];
    let cursor: string | null = null;
    do {
      const page = await repository.listSourceFiles({
        knowledgeBaseId,
        releaseId: candidateReleaseId,
        cursor,
        limit: 2
      });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    expect(items.map((item) => item.sourceFileId)).toEqual([
      "release-source-file-a",
      "release-source-file-new",
      "release-source-file-moving",
      "release-source-file-stable"
    ]);
    expect(items.find((item) => item.sourceFileId === "release-source-file-moving")).toMatchObject({
      sourceRevisionId: "release-source-revision-moving-2",
      sourceDirectoryId: "release-source-directory-moved",
      relativePath: "moved/b.md",
      generatedPath: "pages/moved/b.md",
      objectKey: "source/moving-v2.md",
      publicationRequired: true
    });
    expect(items.find((item) => item.sourceFileId === "release-source-file-new")?.publicationRequired).toBe(true);
    expect(items.find((item) => item.sourceFileId === "release-source-file-a")?.publicationRequired).toBe(false);
    expect(items.some((item) => item.sourceFileId === "release-source-file-tail")).toBe(false);
    expect(items.some((item) => item.sourceFileId === "release-source-file-deleted")).toBe(false);
  });

  it("keeps an older release snapshot consistent while a newer directory deletion is being prepared", async () => {
    const raceKnowledgeBaseId = "kb-release-deletion-generation-race";
    const raceReleaseId = "release-deletion-generation-race";
    const directoryId = "source-directory-deletion-generation-race";
    const sourceFileId = "source-file-deletion-generation-race";
    const sourceRevisionId = "source-revision-deletion-generation-race";
    const deletionIntentId = "deletion-intent-generation-race";
    const cleanupRaceFixture = async () => {
      await sql.begin(async (transaction) => {
        await transaction`SET CONSTRAINTS ALL DEFERRED`;
        await transaction`DELETE FROM focowiki.releases WHERE knowledge_base_id = ${raceKnowledgeBaseId}`;
        await transaction`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${raceKnowledgeBaseId}`;
        await transaction`DELETE FROM focowiki.source_directories WHERE knowledge_base_id = ${raceKnowledgeBaseId}`;
        await transaction`DELETE FROM focowiki.deletion_intents WHERE knowledge_base_id = ${raceKnowledgeBaseId}`;
        await transaction`DELETE FROM focowiki.knowledge_bases WHERE id = ${raceKnowledgeBaseId}`;
      });
    };

    await cleanupRaceFixture();
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name, catalog_generation)
        VALUES (${raceKnowledgeBaseId}, 'Deletion generation race', 2)
      `;
      await transaction`
        INSERT INTO focowiki.deletion_intents (
          id, knowledge_base_id, target_kind, target_id, catalog_generation, state
        ) VALUES (
          ${deletionIntentId}, ${raceKnowledgeBaseId}, 'source_directory',
          ${directoryId}, 2, 'running'
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_directories (
          id, knowledge_base_id, parent_id, name, relative_path, path_key, depth,
          deletion_intent_id, deleted_at
        ) VALUES (
          ${directoryId}, ${raceKnowledgeBaseId}, NULL, 'documents',
          'documents', 'documents', 1, ${deletionIntentId}, now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, directory_id,
          object_key, content_type, size_bytes, checksum_sha256, active_revision_id,
          processing_status
        ) VALUES (
          ${sourceFileId}, ${raceKnowledgeBaseId}, 'guide.md', 'documents/guide.md',
          'documents/guide.md', ${directoryId}, 'objects/guide.md', 'text/markdown',
          10, 'guide-checksum', ${sourceRevisionId}, 'completed'
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        ) VALUES (
          ${sourceRevisionId}, ${raceKnowledgeBaseId}, ${sourceFileId}, 1,
          'objects/guide.md', 'text/markdown', 10, 'guide-checksum', 'completed'
        )
      `;
      await transaction`
        INSERT INTO focowiki.releases (
          id, knowledge_base_id, bundle_root_key, generated_at, file_count,
          manifest_checksum_sha256, catalog_generation
        ) VALUES (
          ${raceReleaseId}, ${raceKnowledgeBaseId}, 'bundles/race', now(), 0,
          'pending', 1
        )
      `;
    });

    try {
      await expect(repository.materializeSourceSnapshot({
        knowledgeBaseId: raceKnowledgeBaseId,
        releaseId: raceReleaseId,
        publicationSourceFileIds: [sourceFileId]
      })).resolves.toEqual({ directoryCount: 1, sourceFileCount: 1 });
    } finally {
      await cleanupRaceFixture();
    }
  });

  it("keeps an active generated page readable while a replacement publication is pending", async () => {
    const files = createPostgresAdminRepositories(sql).files;
    if (!files?.markSourceFilesPublicationDirty) {
      throw new Error("Publication dirty repository is unavailable");
    }
    await sql`
      UPDATE focowiki.source_files
      SET generated_output_status = 'visible',
          generated_bundle_file_id = 'bundle-previous-stable',
          generated_bundle_file_path = 'pages/stable.md',
          publication_dirty_at = NULL
      WHERE id = 'release-source-file-stable'
    `;

    try {
      await files.markSourceFilesPublicationDirty({
        knowledgeBaseId,
        sourceFileIds: ["release-source-file-stable", "release-source-file-new"],
        dirtyAt: new Date().toISOString()
      });

      const rows = await sql<Array<{
        id: string;
        generated_output_status: string;
        generated_bundle_file_id: string | null;
        generated_bundle_file_path: string | null;
        publication_dirty_at: Date | null;
      }>>`
        SELECT id, generated_output_status, generated_bundle_file_id,
               generated_bundle_file_path, publication_dirty_at
        FROM focowiki.source_files
        WHERE id IN ('release-source-file-stable', 'release-source-file-new')
        ORDER BY id
      `;

      expect(rows).toEqual([
        {
          id: "release-source-file-new",
          generated_output_status: "pending",
          generated_bundle_file_id: null,
          generated_bundle_file_path: null,
          publication_dirty_at: expect.any(Date)
        },
        {
          id: "release-source-file-stable",
          generated_output_status: "visible",
          generated_bundle_file_id: "bundle-previous-stable",
          generated_bundle_file_path: "pages/stable.md",
          publication_dirty_at: expect.any(Date)
        }
      ]);
    } finally {
      await sql`
        UPDATE focowiki.source_files
        SET generated_output_status = CASE
              WHEN id = 'release-source-file-stable' THEN 'visible'
              ELSE 'pending'
            END,
            generated_bundle_file_id = NULL,
            generated_bundle_file_path = NULL,
            publication_dirty_at = NULL
        WHERE id IN ('release-source-file-stable', 'release-source-file-new')
      `;
    }
  });

  it("streams directory-first navigation, including nested and empty directories", async () => {
    await seedCandidateBundleFiles();
    await sql`
      UPDATE focowiki.bundle_files
      SET title = CASE source_file_id
            WHEN 'release-source-file-moving' THEN 'Moving document'
            WHEN 'release-source-file-new' THEN 'New document'
            ELSE title
          END,
          description = CASE source_file_id
            WHEN 'release-source-file-moving' THEN 'Describes the moved document.'
            WHEN 'release-source-file-new' THEN 'Describes the new document.'
            ELSE description
          END,
          frontmatter_json = CASE source_file_id
            WHEN 'release-source-file-moving' THEN '{"timestamp":"2026-07-10T00:00:00Z","version":"2.0"}'::jsonb
            ELSE frontmatter_json
          END
      WHERE release_id = ${candidateReleaseId}
    `;
    const items = [];
    let cursor: string | null = null;
    do {
      const page = await repository.listNavigationEntries({
        knowledgeBaseId,
        releaseId: candidateReleaseId,
        cursor,
        limit: 3
      });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    expect(items.find((item) => item.id === "root")).toMatchObject({
      parentPath: "pages",
      kind: "directory_start",
      entryCount: 6
    });
    expect(items.find((item) => item.id === "start:release-source-directory-empty")).toMatchObject({
      parentPath: "pages/empty",
      kind: "directory_start",
      entryCount: 0
    });
    expect(items.find((item) => item.id === "directory:release-source-directory-moved")).toMatchObject({
      parentPath: "pages",
      kind: "directory",
      targetPath: "moved/index.md",
      directChildCount: 1
    });
    expect(items.find((item) => item.id === "file:release-source-file-moving")).toMatchObject({
      parentPath: "pages/moved",
      kind: "file",
      targetPath: "b.md",
      title: "Moving document",
      description: "Describes the moved document.",
      timestamp: "2026-07-10T00:00:00Z",
      version: "2.0",
      duplicateTitleCount: 1
    });
  });

  it("resolves graph paths through the candidate snapshot and avoids stale reusable related links", async () => {
    const relationships = await repository.listSourceGraphNeighborhood({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      sourceFileId: "release-source-file-a",
      limit: 10
    });
    expect(relationships).toEqual([
      expect.objectContaining({
        fileId: "release-source-file-moving",
        path: "pages/moved/b.md",
        title: "Moving document",
        direction: "outgoing",
        relationType: "version_relation",
        reason: 'From "A document" to "Moving document": same document'
      })
    ]);

    const incoming = await repository.listSourceGraphNeighborhood({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      sourceFileId: "release-source-file-new",
      limit: 10
    });
    expect(incoming).toEqual([
      expect.objectContaining({
        fileId: "release-source-file-moving",
        path: "pages/moved/b.md",
        direction: "incoming",
        reason: 'Incoming from "Moving document" to "New document": shared implementation background'
      })
    ]);

    const reusable = await repository.listReusablePages({
      knowledgeBaseId,
      releaseId: previousReleaseId,
      candidateReleaseId,
      sourceFileIds: ["release-source-file-a", "release-source-file-stable"]
    });
    expect(reusable.map((page) => page.sourceFileId)).toEqual(["release-source-file-stable"]);
  });

  it("preserves source relationship evidence in the release graph projection", async () => {
    const files = createPostgresAdminRepositories(sql).files;
    if (!files?.rebuildReleaseGraphProjection) {
      throw new Error("Release graph projection repository is unavailable");
    }
    await seedCandidateBundleFiles();
    await files.rebuildReleaseGraphProjection({
      knowledgeBaseId,
      releaseId: candidateReleaseId
    });
    const graph = createPostgresFileGraphRepository(sql);
    if (!graph.listActiveGraphEdges) {
      throw new Error("Active release graph reader is unavailable");
    }
    const page = await graph.listActiveGraphEdges({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      cursor: null,
      limit: 10
    });

    expect(page.items).toContainEqual(
      expect.objectContaining({
        fromFileId: "release-source-file-a",
        toFileId: "release-source-file-moving",
        evidence: { excerpt: "shared" }
      })
    );
    expect(page.items.filter((edge) => edge.relationType === "version_relation")).toHaveLength(1);

    const rows = await sql<Array<{ direction: string }>>`
      SELECT direction
      FROM focowiki.knowledge_graph_edges
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND release_id = ${candidateReleaseId}
        AND relation_type = 'version_relation'
    `;
    expect(rows).toEqual([{ direction: "bidirectional" }]);
  });

  it("persists, reuses, prunes, and validates release-scoped Markdown links", async () => {
    await repository.materializeSourceSnapshot({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      publicationSourceFileIds: ["release-source-file-new"]
    });
    await seedCandidateBundleFiles();
    await sql`
      INSERT INTO focowiki.release_markdown_links (
        release_id, knowledge_base_id, source_file_id,
        from_path, to_path, label, navigation_only
      ) VALUES (
        ${previousReleaseId}, ${knowledgeBaseId}, 'release-source-file-stable',
        'pages/stable.md', 'pages/a.md', 'A', false
      )
      ON CONFLICT DO NOTHING
    `;
    await repository.copyReusableMarkdownLinks({
      knowledgeBaseId,
      previousReleaseId,
      releaseId: candidateReleaseId,
      sourceFileIds: ["release-source-file-stable"]
    });
    await repository.persistMarkdownLinks({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      links: [
        {
          sourceFileId: null,
          from: "pages/index.md",
          to: "pages/docs/index.md",
          label: "Docs",
          navigationOnly: true
        },
        {
          sourceFileId: "release-source-file-new",
          from: "pages/docs/c.md",
          to: "pages/missing.md",
          label: "Missing source reference",
          navigationOnly: false
        },
        {
          sourceFileId: null,
          from: "pages/docs/index.md",
          to: "pages/docs/missing.md",
          label: "Missing navigation target",
          navigationOnly: true
        }
      ]
    });

    await expect(repository.pruneInvalidSourceMarkdownLinks({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      plannedTargetPaths: ["_index/links.json", "_index/manifest.json"],
      batchSize: 1
    })).resolves.toBe(1);

    const links = [];
    let cursor: string | null = null;
    do {
      const page = await repository.listValidMarkdownLinks({
        knowledgeBaseId,
        releaseId: candidateReleaseId,
        cursor,
        limit: 1,
        plannedTargetPaths: ["_index/links.json", "_index/manifest.json"]
      });
      links.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(links).toEqual([
      { from: "pages/index.md", to: "pages/docs/index.md", label: "Docs" },
      { from: "pages/stable.md", to: "pages/a.md", label: "A" }
    ]);

    const validation = await repository.validateRelease({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      requireGraph: false,
      issueLimit: 100
    });
    expect(validation.issues).toContainEqual(expect.objectContaining({
      ruleId: "FOCOWIKI-RELEASE-BROKEN-NAVIGATION-LINK",
      path: "pages/docs/index.md"
    }));

    await sql`
      DELETE FROM focowiki.release_markdown_links
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND release_id IN (${previousReleaseId}, ${candidateReleaseId})
    `;
  });

  it("streams a complete release change feed and bounded directory summary", async () => {
    const summary = await repository.summarizeChanges({
      knowledgeBaseId,
      previousReleaseId,
      releaseId: candidateReleaseId,
      directoryLimit: 10
    });
    expect(summary).toMatchObject({ created: 1, updated: 0, moved: 1, deleted: 0 });
    expect(summary.affectedDirectories).toEqual(expect.arrayContaining([
      { path: "pages/docs", changedFileCount: 1 },
      { path: "pages/moved", changedFileCount: 1 },
      { path: "pages/old", changedFileCount: 1 }
    ]));

    const changes = await repository.listChanges({
      knowledgeBaseId,
      previousReleaseId,
      releaseId: candidateReleaseId,
      cursor: null,
      limit: 10
    });
    expect(changes.nextCursor).toBeNull();
    expect(changes.items).toEqual([
      expect.objectContaining({
        sourceFileId: "release-source-file-moving",
        action: "moved",
        previousPath: "pages/old/b.md",
        path: "pages/moved/b.md"
      }),
      expect.objectContaining({
        sourceFileId: "release-source-file-new",
        action: "created",
        previousPath: null,
        path: "pages/docs/c.md"
      })
    ]);
  });

  it("materializes nested tree nodes and source counts from the same release snapshot", async () => {
    await seedCandidateBundleFiles();
    await seedCanonicalNavigationLinks();
    const result = await repository.materializeTree({ knowledgeBaseId, releaseId: candidateReleaseId });
    expect(result.entryCount).toBeGreaterThan(10);

    const rows = await sql<Array<{
      path: string;
      node_type: string;
      source_directory_id: string | null;
      direct_file_count: number;
      descendant_file_count: number;
    }>>`
      SELECT path, node_type, source_directory_id,
             direct_file_count, descendant_file_count
      FROM focowiki.knowledge_file_tree_nodes
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND release_id = ${candidateReleaseId}
        AND path IN ('pages', 'pages/moved', 'pages/empty', 'pages/moved/b.md')
      ORDER BY path
    `;

    expect(rows).toEqual([
      expect.objectContaining({
        path: "pages",
        node_type: "directory",
        source_directory_id: null,
        direct_file_count: 2,
        descendant_file_count: 4
      }),
      expect.objectContaining({
        path: "pages/empty",
        node_type: "directory",
        source_directory_id: "release-source-directory-empty",
        direct_file_count: 0,
        descendant_file_count: 0
      }),
      expect.objectContaining({
        path: "pages/moved",
        node_type: "directory",
        source_directory_id: "release-source-directory-moved",
        direct_file_count: 1,
        descendant_file_count: 1
      }),
      expect.objectContaining({
        path: "pages/moved/b.md",
        node_type: "file",
        source_directory_id: "release-source-directory-moved"
      })
    ]);
    await expect(repository.validateRelease({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      requireGraph: false,
      issueLimit: 100
    })).resolves.toEqual({ issues: [], truncated: false });
  });

  it("returns stable bounded issues for malformed concepts and broken continuation navigation", async () => {
    await seedCandidateBundleFiles();
    await seedCanonicalNavigationLinks();
    await sql`
      UPDATE focowiki.bundle_files
      SET okf_type = NULL
      WHERE id = 'bundle-candidate-a'
    `;
    await sql`
      INSERT INTO focowiki.bundle_files (
        id, knowledge_base_id, release_id, source_file_id, file_kind,
        logical_path, object_key, content_type, size_bytes, checksum_sha256,
        okf_type, title, description, frontmatter_json, navigation_only
      ) VALUES (
        'bundle-candidate-orphan-history', ${knowledgeBaseId}, ${candidateReleaseId}, NULL,
        'history_page', 'log-000099.md', 'bundles/candidate/log-000099.md',
        'text/markdown', 1, 'orphan-history', 'Update History Page',
        'Update history page 99', 'Orphaned history page.',
        '{"type":"Update History Page","title":"Update history page 99"}'::jsonb, true
      )
    `;
    await repository.persistMarkdownLinks({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      links: [{
        sourceFileId: null,
        from: "pages/moved/index.md",
        to: "pages/missing.md",
        label: "Missing page",
        navigationOnly: true
      }]
    });
    await repository.materializeTree({ knowledgeBaseId, releaseId: candidateReleaseId });

    const full = await repository.validateRelease({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      requireGraph: false,
      issueLimit: 100
    });
    expect(full.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: "OKF-0.1-CONCEPT-TYPE",
        path: "pages/a.md"
      }),
      expect.objectContaining({
        ruleId: "FOCOWIKI-RELEASE-CONTINUATION-CHAIN",
        path: "log-000099.md"
      }),
      expect.objectContaining({
        ruleId: "FOCOWIKI-RELEASE-BROKEN-NAVIGATION-LINK",
        path: "pages/moved/index.md"
      })
    ]));

    const first = await repository.validateRelease({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      requireGraph: false,
      issueLimit: 2
    });
    const second = await repository.validateRelease({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      requireGraph: false,
      issueLimit: 2
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ truncated: true });
    expect(first.issues).toHaveLength(2);
  });

  it("rejects missing entry points, disconnected extensions, and incomplete index coverage", async () => {
    await seedCandidateBundleFiles();
    await seedCanonicalNavigationLinks();
    await repository.materializeTree({ knowledgeBaseId, releaseId: candidateReleaseId });
    await sql`
      DELETE FROM focowiki.bundle_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND release_id = ${candidateReleaseId}
        AND logical_path = 'schema-frontmatter.md'
    `;
    await sql`
      DELETE FROM focowiki.release_markdown_links
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND release_id = ${candidateReleaseId}
        AND (
          (from_path = 'schema.md' AND to_path = 'pages/index.md')
          OR (from_path = 'pages/index.md' AND to_path = 'pages/a.md')
        )
    `;
    await repository.persistMarkdownLinks({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      links: [{
        sourceFileId: null,
        from: "pages/docs/index.md",
        to: "pages/stable.md",
        label: "Stable",
        navigationOnly: true
      }]
    });

    const result = await repository.validateRelease({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      requireGraph: false,
      issueLimit: 100
    });

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: "FOCOWIKI-RELEASE-REQUIRED-FILE",
        path: "schema-frontmatter.md"
      }),
      expect.objectContaining({
        ruleId: "FOCOWIKI-RELEASE-SOURCE-NAVIGATION",
        path: "schema.md"
      }),
      expect.objectContaining({
        ruleId: "FOCOWIKI-RELEASE-INDEX-COVERAGE",
        path: "pages/a.md"
      }),
      expect.objectContaining({
        ruleId: "FOCOWIKI-RELEASE-INDEX-COVERAGE",
        path: "pages/stable.md"
      })
    ]));
  });

  it("activates a candidate release and completes publishing resource operations", async () => {
    const files = createPostgresAdminRepositories(sql).files;
    if (!files?.activateRelease) throw new Error("Release activation repository is unavailable");
    await repository.materializeSourceSnapshot({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      publicationSourceFileIds: ["release-source-file-moving", "release-source-file-new"]
    });
    await seedCandidateBundleFiles();

    await files.activateRelease({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      publishedAt: new Date().toISOString(),
      fileCount: 20,
      manifestChecksumSha256: "manifest-candidate-activated"
    });

    const rows = await sql<Array<{
      active_release_id: string | null;
      operation_state: string;
      result_json: Record<string, unknown>;
      relative_path: string;
      generated_output_status: string;
      generated_bundle_file_id: string | null;
      generated_bundle_file_path: string | null;
    }>>`
      SELECT knowledge_base.active_release_id,
             operation.state AS operation_state,
             operation.result_json,
             source.relative_path,
             source.generated_output_status,
             source.generated_bundle_file_id,
             source.generated_bundle_file_path
      FROM focowiki.knowledge_bases knowledge_base
      JOIN focowiki.resource_operations operation
        ON operation.knowledge_base_id = knowledge_base.id
       AND operation.id = 'release-resource-operation-moving'
      JOIN focowiki.source_files source
        ON source.knowledge_base_id = knowledge_base.id
       AND source.id = 'release-source-file-moving'
      WHERE knowledge_base.id = ${knowledgeBaseId}
    `;
    expect(rows[0]).toMatchObject({
      active_release_id: candidateReleaseId,
      operation_state: "completed",
      result_json: { releaseId: candidateReleaseId, visibility: "active" },
      relative_path: "moved/b.md",
      generated_output_status: "visible",
      generated_bundle_file_id: "bundle-candidate-moving",
      generated_bundle_file_path: "pages/moved/b.md"
    });

    const tailRows = await sql<Array<{
      generated_output_status: string;
      generated_bundle_file_path: string | null;
    }>>`
      SELECT generated_output_status, generated_bundle_file_path
      FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND id = 'release-source-file-tail'
    `;
    expect(tailRows[0]).toEqual({
      generated_output_status: "pending",
      generated_bundle_file_path: null
    });
  });

  it("does not complete a resource operation that entered publishing after the release snapshot", async () => {
    const lateReleaseId = "release-publication-late-operation";
    const lateOperationId = "resource-operation-late";
    const files = createPostgresAdminRepositories(sql).files;
    if (!files?.activateRelease) throw new Error("Release activation repository is unavailable");
    const activeRows = await sql<Array<{ relative_path: string }>>`
      SELECT relative_path
      FROM focowiki.source_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND id = 'release-source-file-moving'
    `;
    const activeRelativePath = activeRows[0]?.relative_path;
    if (!activeRelativePath) throw new Error("Active source path is unavailable");

    await sql`
      INSERT INTO focowiki.resource_operations (
        id, knowledge_base_id, operation_kind, state, idempotency_key,
        request_fingerprint, candidate_catalog_generation
      ) VALUES (
        ${lateOperationId}, ${knowledgeBaseId}, 'source_file_move', 'accepted',
        'late-release-source-file-move', 'late-release-source-file-move-fingerprint', 2
      )
    `;
    await sql`
      INSERT INTO focowiki.resource_operation_targets (
        operation_id, target_kind, target_id, expected_resource_revision
      ) VALUES (${lateOperationId}, 'source_file', 'release-source-file-moving', 2)
    `;
    await sql`
      UPDATE focowiki.source_files
      SET candidate_operation_id = ${lateOperationId},
          candidate_name = 'b.md',
          candidate_relative_path = 'docs/b.md',
          candidate_path_key = 'docs/b.md',
          candidate_directory_id = 'release-source-directory-docs',
          candidate_metadata_json = metadata_json,
          candidate_model_suggestions_json = model_suggestions_json,
          publication_dirty_at = now(),
          generated_output_status = 'pending',
          generated_bundle_file_id = NULL,
          generated_bundle_file_path = NULL
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND id = 'release-source-file-moving'
    `;
    await sql`
      INSERT INTO focowiki.releases (
        id, knowledge_base_id, bundle_root_key, generated_at,
        file_count, manifest_checksum_sha256, catalog_generation
      ) VALUES (
        ${lateReleaseId}, ${knowledgeBaseId}, 'bundles/late-operation', now(),
        0, 'manifest-late-operation', 2
      )
    `;

    await repository.materializeSourceSnapshot({
      knowledgeBaseId,
      releaseId: lateReleaseId,
      publicationSourceFileIds: ["release-source-file-moving"]
    });
    const snapshot = await repository.listSourceFiles({
      knowledgeBaseId,
      releaseId: lateReleaseId,
      cursor: null,
      limit: 20
    });
    expect(snapshot.items.find((item) => item.sourceFileId === "release-source-file-moving")).toMatchObject({
      generatedPath: `pages/${activeRelativePath}`,
      publicationRequired: true
    });

    await sql`
      UPDATE focowiki.resource_operations
      SET state = 'publishing', updated_at = now()
      WHERE id = ${lateOperationId}
    `;
    await sql`
      INSERT INTO focowiki.bundle_files (
        id, knowledge_base_id, release_id, source_file_id, file_kind,
        logical_path, object_key, content_type, size_bytes, checksum_sha256
      ) VALUES (
        'bundle-late-moving', ${knowledgeBaseId}, ${lateReleaseId},
        'release-source-file-moving', 'page', 'pages/moved/b.md',
        'bundles/late-operation/pages/moved/b.md', 'text/markdown', 1, 'late-moving'
      )
    `;

    await files.activateRelease({
      knowledgeBaseId,
      releaseId: lateReleaseId,
      publishedAt: new Date().toISOString(),
      fileCount: 1,
      manifestChecksumSha256: "manifest-late-operation-activated"
    });

    const rows = await sql<Array<{
      state: string;
      relative_path: string;
      candidate_operation_id: string | null;
      candidate_relative_path: string | null;
      publication_dirty_at: Date | null;
    }>>`
      SELECT operation.state, source.relative_path,
             source.candidate_operation_id, source.candidate_relative_path,
             source.publication_dirty_at
      FROM focowiki.resource_operations operation
      JOIN focowiki.source_files source
        ON source.knowledge_base_id = operation.knowledge_base_id
       AND source.id = 'release-source-file-moving'
      WHERE operation.id = ${lateOperationId}
    `;
    expect(rows[0]).toMatchObject({
      state: "publishing",
      relative_path: activeRelativePath,
      candidate_operation_id: lateOperationId,
      candidate_relative_path: "docs/b.md"
    });
    expect(rows[0]?.publication_dirty_at).toBeInstanceOf(Date);
  });

  async function seedSourceCatalog(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name, catalog_generation)
      VALUES (${knowledgeBaseId}, 'Release publication integration', 2)
    `;
    await sql`
      INSERT INTO focowiki.source_directories (
        id, knowledge_base_id, parent_id, name, relative_path, path_key, depth
      ) VALUES
        ('release-source-directory-old', ${knowledgeBaseId}, NULL, 'old', 'old', 'old', 1),
        ('release-source-directory-moved', ${knowledgeBaseId}, NULL, 'moved', 'moved', 'moved', 1),
        ('release-source-directory-docs', ${knowledgeBaseId}, NULL, 'docs', 'docs', 'docs', 1),
        ('release-source-directory-empty', ${knowledgeBaseId}, NULL, 'empty', 'empty', 'empty', 1)
    `;
    await sql`
      INSERT INTO focowiki.resource_operations (
        id, knowledge_base_id, operation_kind, state, idempotency_key,
        request_fingerprint, candidate_catalog_generation
      ) VALUES (
        'release-resource-operation-moving', ${knowledgeBaseId}, 'source_file_move', 'publishing',
        'move-source-file', 'move-release-source-file-fingerprint', 2
      )
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, directory_id,
          object_key, content_type, size_bytes, checksum_sha256, active_revision_id,
          processing_status, processing_stage, generated_output_status,
          candidate_operation_id, candidate_revision_id, candidate_name,
          candidate_relative_path, candidate_path_key, candidate_directory_id,
          candidate_object_key, candidate_content_type, candidate_size_bytes,
          candidate_checksum_sha256, candidate_metadata_json
        ) VALUES
          ('release-source-file-a', ${knowledgeBaseId}, 'a.md', 'a.md', 'a.md', NULL,
            'source/a.md', 'text/markdown', 10, 'sha-a', 'release-source-revision-a',
            'completed', 'release_activation', 'visible',
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
          ('release-source-file-moving', ${knowledgeBaseId}, 'b.md', 'old/b.md', 'old/b.md', 'release-source-directory-old',
            'source/moving-v1.md', 'text/markdown', 11, 'sha-moving-v1', 'release-source-revision-moving-1',
            'completed', 'release_activation', 'visible',
            'release-resource-operation-moving', NULL, 'b.md', 'moved/b.md', 'moved/b.md', 'release-source-directory-moved',
            'source/moving-v2.md', 'text/markdown', 12, 'sha-moving-v2', '{"title":"Moving v2"}'::jsonb),
          ('release-source-file-new', ${knowledgeBaseId}, 'c.md', 'docs/c.md', 'docs/c.md', 'release-source-directory-docs',
            'source/new.md', 'text/markdown', 13, 'sha-new', 'release-source-revision-new',
            'completed', 'index_publication', 'pending',
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
          ('release-source-file-tail', ${knowledgeBaseId}, 'tail.md', 'docs/tail.md', 'docs/tail.md', 'release-source-directory-docs',
            'source/tail.md', 'text/markdown', 14, 'sha-tail', 'release-source-revision-tail',
            'completed', 'index_publication', 'pending',
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
          ('release-source-file-deleted', ${knowledgeBaseId}, 'deleted.md', 'deleted.md', 'deleted.md', NULL,
            'source/deleted.md', 'text/markdown', 15, 'sha-deleted', 'release-source-revision-deleted',
            'completed', 'release_activation', 'visible',
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
          ('release-source-file-stable', ${knowledgeBaseId}, 'stable.md', 'stable.md', 'stable.md', NULL,
            'source/stable.md', 'text/markdown', 16, 'sha-stable', 'release-source-revision-stable',
            'completed', 'release_activation', 'visible',
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, metadata_json, processing_status
        ) VALUES
          ('release-source-revision-a', ${knowledgeBaseId}, 'release-source-file-a', 1, 'source/a.md', 'text/markdown', 10, 'sha-a', '{"title":"A"}'::jsonb, 'completed'),
          ('release-source-revision-moving-1', ${knowledgeBaseId}, 'release-source-file-moving', 1, 'source/moving-v1.md', 'text/markdown', 11, 'sha-moving-v1', '{"title":"Moving v1"}'::jsonb, 'completed'),
          ('release-source-revision-moving-2', ${knowledgeBaseId}, 'release-source-file-moving', 2, 'source/moving-v2.md', 'text/markdown', 12, 'sha-moving-v2', '{"title":"Moving v2"}'::jsonb, 'completed'),
          ('release-source-revision-new', ${knowledgeBaseId}, 'release-source-file-new', 1, 'source/new.md', 'text/markdown', 13, 'sha-new', '{}'::jsonb, 'completed'),
          ('release-source-revision-tail', ${knowledgeBaseId}, 'release-source-file-tail', 1, 'source/tail.md', 'text/markdown', 14, 'sha-tail', '{}'::jsonb, 'completed'),
          ('release-source-revision-deleted', ${knowledgeBaseId}, 'release-source-file-deleted', 1, 'source/deleted.md', 'text/markdown', 15, 'sha-deleted', '{}'::jsonb, 'completed'),
          ('release-source-revision-stable', ${knowledgeBaseId}, 'release-source-file-stable', 1, 'source/stable.md', 'text/markdown', 16, 'sha-stable', '{}'::jsonb, 'completed')
      `;
      await transaction`
        UPDATE focowiki.source_files
        SET candidate_revision_id = 'release-source-revision-moving-2'
        WHERE id = 'release-source-file-moving'
      `;
      await transaction`
        UPDATE focowiki.source_files
        SET deleted_at = now()
        WHERE id = 'release-source-file-deleted'
      `;
    });
    await sql`
      INSERT INTO focowiki.releases (
        id, knowledge_base_id, bundle_root_key, generated_at,
        file_count, manifest_checksum_sha256, catalog_generation
      ) VALUES
        (${previousReleaseId}, ${knowledgeBaseId}, 'bundles/previous', now(), 3, 'manifest-previous', 1),
        (${candidateReleaseId}, ${knowledgeBaseId}, 'bundles/candidate', now(), 0, 'manifest-candidate', 2)
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_release_id = ${previousReleaseId}
      WHERE id = ${knowledgeBaseId}
    `;
    await sql`
      INSERT INTO focowiki.bundle_files (
        id, knowledge_base_id, release_id, source_file_id, file_kind,
        logical_path, object_key, content_type, size_bytes, checksum_sha256,
        title, tags_json, frontmatter_json
      ) VALUES
        ('bundle-previous-a', ${knowledgeBaseId}, ${previousReleaseId}, 'release-source-file-a', 'page',
          'pages/a.md', 'bundles/previous/pages/a.md', 'text/markdown', 20, 'bundle-sha-a', 'A', '[]'::jsonb, '{}'::jsonb),
        ('bundle-previous-moving', ${knowledgeBaseId}, ${previousReleaseId}, 'release-source-file-moving', 'page',
          'pages/old/b.md', 'bundles/previous/pages/old/b.md', 'text/markdown', 21, 'bundle-sha-moving', 'Moving', '[]'::jsonb, '{}'::jsonb),
        ('bundle-previous-stable', ${knowledgeBaseId}, ${previousReleaseId}, 'release-source-file-stable', 'page',
          'pages/stable.md', 'bundles/previous/pages/stable.md', 'text/markdown', 22, 'bundle-sha-stable', 'Stable', '[]'::jsonb, '{}'::jsonb)
    `;
    await sql`
      INSERT INTO focowiki.source_file_graph_nodes (
        knowledge_base_id, source_file_id, path, title
      ) VALUES
        (${knowledgeBaseId}, 'release-source-file-a', 'pages/a.md', 'A document'),
        (${knowledgeBaseId}, 'release-source-file-moving', 'pages/old/b.md', 'Moving document'),
        (${knowledgeBaseId}, 'release-source-file-new', 'pages/new.md', 'New document')
    `;
    await sql`
      INSERT INTO focowiki.source_file_graph_edges (
        id, knowledge_base_id, from_source_file_id, to_source_file_id,
        relation_type, weight, reason, source, status, evidence_json
      ) VALUES (
        'release-source-edge-a-moving', ${knowledgeBaseId}, 'release-source-file-a', 'release-source-file-moving',
        'related', 0.9, 'shared subject', 'content', 'accepted', '{"excerpt":"shared"}'::jsonb
      ), (
        'release-source-edge-a-moving-version', ${knowledgeBaseId}, 'release-source-file-a', 'release-source-file-moving',
        'version_relation', 0.92, 'same document', 'deterministic', 'accepted', '{"signal":"same_document_title"}'::jsonb
      ), (
        'release-source-edge-moving-a-version', ${knowledgeBaseId}, 'release-source-file-moving', 'release-source-file-a',
        'version_relation', 0.92, 'same document', 'deterministic', 'accepted', '{"signal":"same_document_title"}'::jsonb
      ), (
        'release-source-edge-moving-new', ${knowledgeBaseId}, 'release-source-file-moving', 'release-source-file-new',
        'background', 0.88, 'shared implementation background', 'deterministic', 'accepted', '{"signal":"shared_definition"}'::jsonb
      )
    `;
  }

  async function seedCandidateBundleFiles(): Promise<void> {
    await sql`
      DELETE FROM focowiki.bundle_files
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND release_id = ${candidateReleaseId}
    `;
    await sql`
      INSERT INTO focowiki.bundle_files (
        id, knowledge_base_id, release_id, source_file_id, file_kind,
        logical_path, object_key, content_type, size_bytes, checksum_sha256,
        source_directory_id, navigation_only
      ) VALUES
        ('bundle-candidate-root-index', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'index', 'index.md', 'bundles/candidate/index.md', 'text/markdown', 1, 'index', NULL, true),
        ('bundle-candidate-log', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'log', 'log.md', 'bundles/candidate/log.md', 'text/markdown', 1, 'log', NULL, true),
        ('bundle-candidate-schema', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'schema', 'schema.md', 'bundles/candidate/schema.md', 'text/markdown', 1, 'schema', NULL, true),
        ('bundle-candidate-schema-frontmatter', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'schema', 'schema-frontmatter.md', 'bundles/candidate/schema-frontmatter.md', 'text/markdown', 1, 'schema-frontmatter', NULL, true),
        ('bundle-candidate-schema-navigation', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'schema', 'schema-navigation.md', 'bundles/candidate/schema-navigation.md', 'text/markdown', 1, 'schema-navigation', NULL, true),
        ('bundle-candidate-schema-extensions', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'schema', 'schema-extensions.md', 'bundles/candidate/schema-extensions.md', 'text/markdown', 1, 'schema-extensions', NULL, true),
        ('bundle-candidate-index-catalog', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'index_catalog', '_index/index.md', 'bundles/candidate/_index/index.md', 'text/markdown', 1, 'index-catalog', NULL, true),
        ('bundle-candidate-manifest', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'manifest_index', '_index/manifest.json', 'bundles/candidate/_index/manifest.json', 'application/json', 1, 'manifest', NULL, true),
        ('bundle-candidate-search', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'search_index', '_index/search.json', 'bundles/candidate/_index/search.json', 'application/json', 1, 'search', NULL, true),
        ('bundle-candidate-links', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'link_index', '_index/links.json', 'bundles/candidate/_index/links.json', 'application/json', 1, 'links', NULL, true),
        ('bundle-candidate-changes', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'change_index', '_index/changes.json', 'bundles/candidate/_index/changes.json', 'application/json', 1, 'changes', NULL, true),
        ('bundle-candidate-pages-index', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'directory_index', 'pages/index.md', 'bundles/candidate/pages/index.md', 'text/markdown', 1, 'pages-index', NULL, true),
        ('bundle-candidate-a', ${knowledgeBaseId}, ${candidateReleaseId}, 'release-source-file-a', 'page', 'pages/a.md', 'bundles/candidate/pages/a.md', 'text/markdown', 1, 'a', NULL, false),
        ('bundle-candidate-stable', ${knowledgeBaseId}, ${candidateReleaseId}, 'release-source-file-stable', 'page', 'pages/stable.md', 'bundles/candidate/pages/stable.md', 'text/markdown', 1, 'stable', NULL, false),
        ('bundle-candidate-docs-index', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'directory_index', 'pages/docs/index.md', 'bundles/candidate/pages/docs/index.md', 'text/markdown', 1, 'docs-index', 'release-source-directory-docs', true),
        ('bundle-candidate-new', ${knowledgeBaseId}, ${candidateReleaseId}, 'release-source-file-new', 'page', 'pages/docs/c.md', 'bundles/candidate/pages/docs/c.md', 'text/markdown', 1, 'new', 'release-source-directory-docs', false),
        ('bundle-candidate-moved-index', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'directory_index', 'pages/moved/index.md', 'bundles/candidate/pages/moved/index.md', 'text/markdown', 1, 'moved-index', 'release-source-directory-moved', true),
        ('bundle-candidate-moving', ${knowledgeBaseId}, ${candidateReleaseId}, 'release-source-file-moving', 'page', 'pages/moved/b.md', 'bundles/candidate/pages/moved/b.md', 'text/markdown', 1, 'moving', 'release-source-directory-moved', false),
        ('bundle-candidate-empty-index', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'directory_index', 'pages/empty/index.md', 'bundles/candidate/pages/empty/index.md', 'text/markdown', 1, 'empty-index', 'release-source-directory-empty', true),
        ('bundle-candidate-old-index', ${knowledgeBaseId}, ${candidateReleaseId}, NULL, 'directory_index', 'pages/old/index.md', 'bundles/candidate/pages/old/index.md', 'text/markdown', 1, 'old-index', 'release-source-directory-old', true)
    `;
    await sql`
      UPDATE focowiki.bundle_files
      SET okf_type = CASE
            WHEN file_kind = 'page' THEN 'Document'
            WHEN file_kind = 'schema' THEN 'Schema Reference'
            ELSE okf_type
          END,
          title = CASE logical_path
            WHEN 'pages/a.md' THEN 'A'
            WHEN 'pages/stable.md' THEN 'Stable'
            WHEN 'pages/docs/c.md' THEN 'New'
            WHEN 'pages/moved/b.md' THEN 'Moving'
            WHEN 'schema.md' THEN 'Schema'
            WHEN 'schema-frontmatter.md' THEN 'Frontmatter'
            WHEN 'schema-navigation.md' THEN 'Navigation'
            WHEN 'schema-extensions.md' THEN 'Generated extensions'
            ELSE title
          END
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND release_id = ${candidateReleaseId}
    `;
  }

  async function seedCanonicalNavigationLinks(): Promise<void> {
    await sql`
      DELETE FROM focowiki.release_markdown_links
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND release_id = ${candidateReleaseId}
    `;
    await repository.persistMarkdownLinks({
      knowledgeBaseId,
      releaseId: candidateReleaseId,
      links: [
        { sourceFileId: null, from: "schema.md", to: "pages/index.md", label: "Browse documents", navigationOnly: true },
        { sourceFileId: null, from: "_index/index.md", to: "pages/index.md", label: "Browse documents", navigationOnly: true },
        { sourceFileId: null, from: "pages/index.md", to: "pages/a.md", label: "A", navigationOnly: true },
        { sourceFileId: null, from: "pages/index.md", to: "pages/stable.md", label: "Stable", navigationOnly: true },
        { sourceFileId: null, from: "pages/docs/index.md", to: "pages/docs/c.md", label: "New", navigationOnly: true },
        { sourceFileId: null, from: "pages/moved/index.md", to: "pages/moved/b.md", label: "Moving", navigationOnly: true }
      ]
    });
  }

  async function cleanup(): Promise<void> {
    await sql`UPDATE focowiki.knowledge_bases SET active_release_id = NULL WHERE id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_file_tree_nodes WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.release_markdown_links WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.bundle_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.releases WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_file_graph_edges WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_file_graph_nodes WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_directories WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.resource_operations WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});
