import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildExplainAnalyzeSql,
  createReleaseValidationPlanTargets,
  summarizeQueryPlan,
  type QueryPlanSummary
} from "../src/db/query-plan-validation.js";
import { createPostgresReleasePublicationRepository } from "../src/infrastructure/postgres/release-publication-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const runScale = process.env.FOCOWIKI_RUN_OKF_100K_SCALE === "1";
const describeScale = databaseUrl && runScale ? describe : describe.skip;

const CONCEPT_COUNT = 100_000;
const CONTINUATION_SIZE = 200;
const CONTINUATION_COUNT = CONCEPT_COUNT / CONTINUATION_SIZE;
const KNOWLEDGE_BASE_ID = "kb-okf-scale";
const RELEASE_ID = "release-okf-scale";

describeScale("OKF release validation scale integration", () => {
  const sql = postgres(databaseUrl!, { max: 2, onnotice: () => undefined });
  const repository = createPostgresReleasePublicationRepository(sql);

  beforeAll(async () => {
    await assertDedicatedDatabase();
    await cleanup();
    await seedRelease();
  }, 180_000);

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  }, 180_000);

  it("validates 100,000 concepts with bounded process memory and release-scoped plans", async () => {
    const startedAt = performance.now();
    const baselineRssBytes = process.memoryUsage().rss;
    const validation = await repository.validateRelease({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      releaseId: RELEASE_ID,
      requireGraph: false,
      issueLimit: 100
    });
    const peakRssBytes = process.memoryUsage().rss;
    const validationDurationMs = Math.round((performance.now() - startedAt) * 100) / 100;

    expect(validation).toEqual({ issues: [], truncated: false });
    expect(peakRssBytes - baselineRssBytes).toBeLessThan(128 * 1024 * 1024);

    const plans: Record<string, QueryPlanSummary> = {};
    for (const target of createReleaseValidationPlanTargets()) {
      const rows = await sql.unsafe<Array<Record<string, unknown>>>(
        buildExplainAnalyzeSql(target.sql)
      );
      plans[target.name] = summarizeQueryPlan(rows[0]?.["QUERY PLAN"]);
    }

    const counts = await sql<Array<{
      concepts: number;
      continuation_pages: number;
      generated_links: number;
      tree_entries: number;
    }>>`
      SELECT
        (SELECT count(*)::int
         FROM focowiki.bundle_files
         WHERE knowledge_base_id = ${KNOWLEDGE_BASE_ID}
           AND release_id = ${RELEASE_ID}
           AND file_kind = 'page') AS concepts,
        (SELECT count(*)::int
         FROM focowiki.bundle_files
         WHERE knowledge_base_id = ${KNOWLEDGE_BASE_ID}
           AND release_id = ${RELEASE_ID}
           AND file_kind = 'directory_index_page') AS continuation_pages,
        (SELECT count(*)::int
         FROM focowiki.release_markdown_links
         WHERE knowledge_base_id = ${KNOWLEDGE_BASE_ID}
           AND release_id = ${RELEASE_ID}) AS generated_links,
        (SELECT count(*)::int
         FROM focowiki.knowledge_file_tree_nodes
         WHERE knowledge_base_id = ${KNOWLEDGE_BASE_ID}
           AND release_id = ${RELEASE_ID}) AS tree_entries
    `;

    expect(counts[0]).toEqual({
      concepts: CONCEPT_COUNT,
      continuation_pages: CONTINUATION_COUNT,
      generated_links: CONCEPT_COUNT + CONTINUATION_COUNT + 2,
      tree_entries: CONCEPT_COUNT + CONTINUATION_COUNT + 12
    });
    console.info("OKF 100k release validation evidence", JSON.stringify({
      ...counts[0],
      validationDurationMs,
      baselineRssBytes,
      peakRssBytes,
      peakRssDeltaBytes: Math.max(0, peakRssBytes - baselineRssBytes),
      plans
    }, null, 2));
  }, 180_000);

  it("bounds issue output and process memory when 100,000 concepts lose index coverage", async () => {
    await sql`
      DELETE FROM focowiki.release_markdown_links
      WHERE knowledge_base_id = ${KNOWLEDGE_BASE_ID}
        AND release_id = ${RELEASE_ID}
        AND to_path LIKE 'pages/flat/concept-%'
    `;
    const startedAt = performance.now();
    const baselineRssBytes = process.memoryUsage().rss;
    const validation = await repository.validateRelease({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      releaseId: RELEASE_ID,
      requireGraph: false,
      issueLimit: 25
    });
    const peakRssBytes = process.memoryUsage().rss;
    const validationDurationMs = Math.round((performance.now() - startedAt) * 100) / 100;

    expect(validation.truncated).toBe(true);
    expect(validation.issues).toHaveLength(25);
    expect(validation.issues.every((issue) =>
      issue.ruleId === "FOCOWIKI-RELEASE-INDEX-COVERAGE"
    )).toBe(true);
    expect(peakRssBytes - baselineRssBytes).toBeLessThan(128 * 1024 * 1024);
    console.info("OKF 100k bounded defect evidence", JSON.stringify({
      issueLimit: 25,
      returnedIssues: validation.issues.length,
      truncated: validation.truncated,
      validationDurationMs,
      baselineRssBytes,
      peakRssBytes,
      peakRssDeltaBytes: Math.max(0, peakRssBytes - baselineRssBytes)
    }, null, 2));
  }, 180_000);

  async function seedRelease(): Promise<void> {
    await sql.begin(async (transaction) => {
      await transaction.unsafe("SET CONSTRAINTS ALL DEFERRED");
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES (${KNOWLEDGE_BASE_ID}, 'OKF 100k scale validation')
      `;
      await transaction`
        INSERT INTO focowiki.releases (
          id, knowledge_base_id, bundle_root_key, generated_at,
          manifest_checksum_sha256, catalog_generation
        ) VALUES (
          ${RELEASE_ID}, ${KNOWLEDGE_BASE_ID}, 'generated/okf-scale/', now(),
          repeat('a', 64), 1
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, processing_status, processing_stage,
          generated_output_status, name, relative_path, path_key,
          active_revision_id, resource_revision, content_revision
        )
        SELECT
          'source-file-okf-scale-' || lpad(item::text, 6, '0'),
          ${KNOWLEDGE_BASE_ID},
          'source/okf-scale/' || lpad(item::text, 6, '0') || '.md',
          'text/markdown; charset=utf-8',
          128,
          md5(item::text) || md5(item::text),
          'completed',
          'release_activation',
          'visible',
          'concept-' || lpad(item::text, 6, '0') || '.md',
          'flat/concept-' || lpad(item::text, 6, '0') || '.md',
          'flat/concept-' || lpad(item::text, 6, '0') || '.md',
          'source-revision-okf-scale-' || lpad(item::text, 6, '0'),
          1,
          1
        FROM generate_series(1, ${CONCEPT_COUNT}) item
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        )
        SELECT
          'source-revision-okf-scale-' || lpad(item::text, 6, '0'),
          ${KNOWLEDGE_BASE_ID},
          'source-file-okf-scale-' || lpad(item::text, 6, '0'),
          1,
          'source/okf-scale/' || lpad(item::text, 6, '0') || '-revision.md',
          'text/markdown; charset=utf-8',
          128,
          md5(item::text) || md5(item::text),
          'completed'
        FROM generate_series(1, ${CONCEPT_COUNT}) item
      `;
      await transaction`
        INSERT INTO focowiki.release_source_files (
          release_id, knowledge_base_id, source_file_id, source_revision_id,
          name, relative_path, path_key, generated_path, object_key,
          content_type, size_bytes, checksum_sha256,
          resource_revision, content_revision
        )
        SELECT
          ${RELEASE_ID},
          ${KNOWLEDGE_BASE_ID},
          'source-file-okf-scale-' || lpad(item::text, 6, '0'),
          'source-revision-okf-scale-' || lpad(item::text, 6, '0'),
          'concept-' || lpad(item::text, 6, '0') || '.md',
          'flat/concept-' || lpad(item::text, 6, '0') || '.md',
          'flat/concept-' || lpad(item::text, 6, '0') || '.md',
          'pages/flat/concept-' || lpad(item::text, 6, '0') || '.md',
          'source/okf-scale/' || lpad(item::text, 6, '0') || '-revision.md',
          'text/markdown; charset=utf-8',
          128,
          md5(item::text) || md5(item::text),
          1,
          1
        FROM generate_series(1, ${CONCEPT_COUNT}) item
      `;
      await transaction`
        INSERT INTO focowiki.bundle_files (
          id, knowledge_base_id, release_id, source_file_id, file_kind,
          logical_path, object_key, content_type, size_bytes, checksum_sha256,
          okf_type, title, description, navigation_only
        )
        SELECT
          'bundle-okf-scale-' || lpad(item::text, 6, '0'),
          ${KNOWLEDGE_BASE_ID},
          ${RELEASE_ID},
          'source-file-okf-scale-' || lpad(item::text, 6, '0'),
          'page',
          'pages/flat/concept-' || lpad(item::text, 6, '0') || '.md',
          'generated/okf-scale/pages/flat/concept-' || lpad(item::text, 6, '0') || '.md',
          'text/markdown; charset=utf-8',
          128,
          md5(item::text) || md5(item::text),
          'Document',
          'Concept ' || item::text,
          'Describes concept ' || item::text || '.',
          false
        FROM generate_series(1, ${CONCEPT_COUNT}) item
      `;
      await transaction.unsafe(generatedEntryPointSql());
      await transaction`
        INSERT INTO focowiki.bundle_files (
          id, knowledge_base_id, release_id, file_kind, logical_path,
          object_key, content_type, size_bytes, checksum_sha256,
          okf_type, title, description, navigation_only
        )
        SELECT
          'bundle-okf-continuation-' || lpad(page::text, 6, '0'),
          ${KNOWLEDGE_BASE_ID},
          ${RELEASE_ID},
          'directory_index_page',
          'pages/index-' || lpad(page::text, 6, '0') || '.md',
          'generated/okf-scale/pages/index-' || lpad(page::text, 6, '0') || '.md',
          'text/markdown; charset=utf-8',
          4096,
          md5(page::text) || md5(page::text),
          'Directory Index Page',
          'Documents ' || page::text,
          'Continues the flat document index.',
          true
        FROM generate_series(1, ${CONTINUATION_COUNT}) page
      `;
      await transaction.unsafe(generatedNavigationLinksSql());
      await transaction`
        INSERT INTO focowiki.release_markdown_links (
          release_id, knowledge_base_id, from_path, to_path, label, navigation_only
        )
        SELECT
          ${RELEASE_ID},
          ${KNOWLEDGE_BASE_ID},
          'pages/index-' || lpad(ceil(item::numeric / ${CONTINUATION_SIZE})::text, 6, '0') || '.md',
          'pages/flat/concept-' || lpad(item::text, 6, '0') || '.md',
          'Concept ' || item::text,
          true
        FROM generate_series(1, ${CONCEPT_COUNT}) item
      `;
      await transaction`
        INSERT INTO focowiki.knowledge_file_tree_nodes (
          id, knowledge_base_id, release_id, path, name, node_type,
          file_id, depth, sort_key
        )
        SELECT
          'tree-okf-scale-' || row_number() OVER (ORDER BY file.logical_path),
          file.knowledge_base_id,
          file.release_id,
          file.logical_path,
          file.logical_path,
          'file',
          file.id,
          0,
          file.logical_path
        FROM focowiki.bundle_files file
        WHERE file.knowledge_base_id = ${KNOWLEDGE_BASE_ID}
          AND file.release_id = ${RELEASE_ID}
      `;
    });
    await sql.unsafe(`
      ANALYZE focowiki.release_source_files;
      ANALYZE focowiki.bundle_files;
      ANALYZE focowiki.release_markdown_links;
      ANALYZE focowiki.knowledge_file_tree_nodes;
    `);
  }

  async function cleanup(): Promise<void> {
    await sql.unsafe("TRUNCATE TABLE focowiki.knowledge_bases CASCADE");
  }

  async function assertDedicatedDatabase(): Promise<void> {
    const rows = await sql<Array<{ database_name: string }>>`
      SELECT current_database() AS database_name
    `;
    if (rows[0]?.database_name !== "focowiki_okf_scale_test") {
      throw new Error("OKF 100k scale validation requires the dedicated focowiki_okf_scale_test database");
    }
  }
});

function generatedEntryPointSql(): string {
  return `
    INSERT INTO focowiki.bundle_files (
      id, knowledge_base_id, release_id, file_kind, logical_path,
      object_key, content_type, size_bytes, checksum_sha256,
      okf_type, title, description, navigation_only
    ) VALUES
      ('bundle-okf-root-index', '${KNOWLEDGE_BASE_ID}', '${RELEASE_ID}', 'index', 'index.md', 'generated/okf-scale/index.md', 'text/markdown; charset=utf-8', 128, repeat('1', 64), NULL, 'Knowledge base', 'Explore the knowledge base.', true),
      ('bundle-okf-log', '${KNOWLEDGE_BASE_ID}', '${RELEASE_ID}', 'log', 'log.md', 'generated/okf-scale/log.md', 'text/markdown; charset=utf-8', 128, repeat('2', 64), NULL, 'Directory update log', 'Recent updates.', true),
      ('bundle-okf-schema', '${KNOWLEDGE_BASE_ID}', '${RELEASE_ID}', 'schema', 'schema.md', 'generated/okf-scale/schema.md', 'text/markdown; charset=utf-8', 128, repeat('3', 64), 'Schema', 'Metadata and navigation schema', 'Explains bundle conventions.', false),
      ('bundle-okf-schema-frontmatter', '${KNOWLEDGE_BASE_ID}', '${RELEASE_ID}', 'schema', 'schema-frontmatter.md', 'generated/okf-scale/schema-frontmatter.md', 'text/markdown; charset=utf-8', 128, repeat('4', 64), 'Schema Reference', 'Frontmatter schema', 'Explains frontmatter fields.', false),
      ('bundle-okf-schema-navigation', '${KNOWLEDGE_BASE_ID}', '${RELEASE_ID}', 'schema', 'schema-navigation.md', 'generated/okf-scale/schema-navigation.md', 'text/markdown; charset=utf-8', 128, repeat('5', 64), 'Schema Reference', 'Navigation schema', 'Explains navigation.', false),
      ('bundle-okf-schema-extensions', '${KNOWLEDGE_BASE_ID}', '${RELEASE_ID}', 'schema', 'schema-extensions.md', 'generated/okf-scale/schema-extensions.md', 'text/markdown; charset=utf-8', 128, repeat('6', 64), 'Schema Reference', 'Extension schema', 'Explains extensions.', false),
      ('bundle-okf-pages-index', '${KNOWLEDGE_BASE_ID}', '${RELEASE_ID}', 'directory_index', 'pages/index.md', 'generated/okf-scale/pages/index.md', 'text/markdown; charset=utf-8', 128, repeat('7', 64), NULL, 'Documents', 'Browse source-backed documents.', true),
      ('bundle-okf-machine-index', '${KNOWLEDGE_BASE_ID}', '${RELEASE_ID}', 'index_catalog', '_index/index.md', 'generated/okf-scale/_index/index.md', 'text/markdown; charset=utf-8', 128, repeat('8', 64), NULL, 'Machine-readable indexes', 'Browse generated indexes.', true),
      ('bundle-okf-manifest', '${KNOWLEDGE_BASE_ID}', '${RELEASE_ID}', 'manifest_index', '_index/manifest.json', 'generated/okf-scale/_index/manifest.json', 'application/json', 128, repeat('9', 64), NULL, NULL, NULL, false),
      ('bundle-okf-search', '${KNOWLEDGE_BASE_ID}', '${RELEASE_ID}', 'search_index', '_index/search.json', 'generated/okf-scale/_index/search.json', 'application/json', 128, repeat('a', 64), NULL, NULL, NULL, false),
      ('bundle-okf-links', '${KNOWLEDGE_BASE_ID}', '${RELEASE_ID}', 'link_index', '_index/links.json', 'generated/okf-scale/_index/links.json', 'application/json', 128, repeat('b', 64), NULL, NULL, NULL, false),
      ('bundle-okf-changes', '${KNOWLEDGE_BASE_ID}', '${RELEASE_ID}', 'change_index', '_index/changes.json', 'generated/okf-scale/_index/changes.json', 'application/json', 128, repeat('c', 64), NULL, NULL, NULL, false)
  `;
}

function generatedNavigationLinksSql(): string {
  return `
    INSERT INTO focowiki.release_markdown_links (
      release_id, knowledge_base_id, from_path, to_path, label, navigation_only
    )
    SELECT '${RELEASE_ID}', '${KNOWLEDGE_BASE_ID}', 'pages/index.md',
           'pages/index-' || lpad(page::text, 6, '0') || '.md',
           'Documents ' || page::text, true
    FROM generate_series(1, ${CONTINUATION_COUNT}) page;

    INSERT INTO focowiki.release_markdown_links (
      release_id, knowledge_base_id, from_path, to_path, label, navigation_only
    ) VALUES
      ('${RELEASE_ID}', '${KNOWLEDGE_BASE_ID}', 'schema.md', 'pages/index.md', 'Browse documents', true),
      ('${RELEASE_ID}', '${KNOWLEDGE_BASE_ID}', '_index/index.md', 'pages/index.md', 'Browse documents', true)
  `;
}
