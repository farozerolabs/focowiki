import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresPublicationValidationRepository } from "../src/infrastructure/postgres/publication-validation-repository.js";
import { REQUIRED_GENERATED_NAVIGATION_RESOURCES } from "../src/okf/generated-graph-resources.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("publication validation repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 4 });
  const repository = createPostgresPublicationValidationRepository(sql);
  const knowledgeBaseId = "kb-publication-validation";
  const generationId = "generation-publication-validation";
  const checksum = "7a".repeat(32);

  beforeEach(async () => {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Publication validation')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, format_version
      ) VALUES (${generationId}, ${knowledgeBaseId}, 'building', 2)
    `;
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type,
        size_bytes, lifecycle_state, verified_at
      ) VALUES (
        ${checksum}, 1, 'generated/validation-object',
        'text/markdown; charset=utf-8', 100, 'active', now()
      )
      ON CONFLICT (checksum_sha256, format_version) DO UPDATE
      SET lifecycle_state = 'active', verified_at = now()
    `;
    for (const resource of REQUIRED_GENERATED_NAVIGATION_RESOURCES) {
      await sql`
        INSERT INTO focowiki.generation_object_refs (
          generation_id, knowledge_base_id, ref_kind, ref_key, file_id,
          action, checksum_sha256, format_version, logical_path
        ) VALUES (
          ${generationId}, ${knowledgeBaseId}, ${resource.refKind},
          ${resource.path}, ${`file:${resource.path}`}, 'upsert',
          ${checksum}, 1, ${resource.path}
        )
      `;
    }
    await sql`
      INSERT INTO focowiki.generation_projection_records (
        generation_id, knowledge_base_id, projection_kind, record_id,
        action, shard_key, logical_path, parent_path, sort_key, payload_json
      ) VALUES
        (${generationId}, ${knowledgeBaseId}, 'tree', 'directory:',
         'upsert', 'tree/v1/root', 'pages', '', 'pages',
         '{"kind":"directory"}'::jsonb),
        (${generationId}, ${knowledgeBaseId}, 'tree', 'directory:06',
         'upsert', 'tree/v1/06', 'pages/06', 'pages', '06',
         '{"kind":"directory"}'::jsonb),
        (${generationId}, ${knowledgeBaseId}, 'tree', 'source-06-a',
         'upsert', 'tree/v1/06', 'pages/06/a.md', 'pages/06', 'a.md',
         '{"kind":"file"}'::jsonb),
        (${generationId}, ${knowledgeBaseId}, 'graph_node', 'source-06-a',
         'upsert', 'graph_node/v1/00', 'pages/06/a.md', NULL, 'a.md',
         '{"kind":"graph_node"}'::jsonb),
        (${generationId}, ${knowledgeBaseId}, 'graph_edge', 'edge-06-a',
         'upsert', 'graph_edge/v1/00', '_graph/graph_edge/v1/00.json', NULL, 'edge',
         '{"kind":"graph_edge"}'::jsonb)
    `;
    await sql`
      INSERT INTO focowiki.generation_tree_directory_stats (
        knowledge_base_id, generation_id, path, parent_path,
        direct_entry_count, direct_directory_count, direct_file_count,
        descendant_file_count
      ) VALUES
        (${knowledgeBaseId}, ${generationId}, 'pages', '', 1, 1, 0, 1),
        (${knowledgeBaseId}, ${generationId}, 'pages/06', 'pages', 1, 0, 1, 1)
    `;
    await sql`
      INSERT INTO focowiki.generation_directory_navigation_summaries (
        generation_id, knowledge_base_id, directory_path,
        entry_count, first_leaf_id
      ) VALUES (${generationId}, ${knowledgeBaseId}, 'pages', 1, 'leaf-root')
    `;
    await sql`
      INSERT INTO focowiki.generation_directory_navigation_leaves (
        generation_id, id, knowledge_base_id, directory_path,
        previous_leaf_id, next_leaf_id, entry_count, byte_count,
        first_sort_key, last_sort_key, entries_json
      ) VALUES (
        ${generationId}, 'leaf-root', ${knowledgeBaseId}, 'pages',
        NULL, NULL, 1, 100, '06', '06',
        '[{"id":"directory:06","sortKey":"06","name":"06","targetPath":"pages/06/index.md","kind":"directory"}]'::jsonb
      )
    `;
    await sql`
      INSERT INTO focowiki.generation_graph_summaries (
        knowledge_base_id, generation_id, node_count, edge_count,
        graph_index_available
      ) VALUES (${knowledgeBaseId}, ${generationId}, 1, 0, true)
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`
      DELETE FROM focowiki.immutable_objects
      WHERE checksum_sha256 = ${checksum} AND format_version = 1
    `;
    await sql.end({ timeout: 5 });
  });

  it("rejects omitted directories and stale graph summaries before activation", async () => {
    const issues = await repository.validateChangedClosure({
      knowledgeBaseId,
      generationId,
      issueLimit: 50
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DIRECTORY_NAVIGATION_MISSING",
        reference: "pages/06"
      }),
      expect.objectContaining({
        code: "GRAPH_SUMMARY_MISMATCH",
        reference: generationId
      })
    ]));
  });

  it("accepts complete navigation and one canonical graph summary", async () => {
    await sql`
      INSERT INTO focowiki.generation_directory_navigation_summaries (
        generation_id, knowledge_base_id, directory_path,
        entry_count, first_leaf_id
      ) VALUES (${generationId}, ${knowledgeBaseId}, 'pages/06', 1, 'leaf-06')
    `;
    await sql`
      INSERT INTO focowiki.generation_directory_navigation_leaves (
        generation_id, id, knowledge_base_id, directory_path,
        previous_leaf_id, next_leaf_id, entry_count, byte_count,
        first_sort_key, last_sort_key, entries_json
      ) VALUES (
        ${generationId}, 'leaf-06', ${knowledgeBaseId}, 'pages/06',
        NULL, NULL, 1, 100, 'a.md', 'a.md',
        '[{"id":"source-06-a","sortKey":"a.md","name":"a.md","targetPath":"pages/06/a.md","kind":"file"}]'::jsonb
      )
    `;
    await sql`
      UPDATE focowiki.generation_graph_summaries
      SET edge_count = 1
      WHERE generation_id = ${generationId}
    `;

    await expect(repository.validateChangedClosure({
      knowledgeBaseId,
      generationId,
      issueLimit: 50
    })).resolves.toEqual([]);
  });

  it("validates projection repair graph summaries from the completed repair checkpoint", async () => {
    const baseGenerationId = "generation-publication-validation-base";
    await completeNavigationAndGraphSummary(sql, {
      knowledgeBaseId,
      generationId
    });
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, format_version, activated_at
      ) VALUES (${baseGenerationId}, ${knowledgeBaseId}, 'active', 2, now())
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${baseGenerationId}
      WHERE id = ${knowledgeBaseId}
    `;
    await sql`
      UPDATE focowiki.publication_generations
      SET predecessor_generation_id = ${baseGenerationId},
          generation_kind = 'projection_repair'
      WHERE id = ${generationId}
    `;
    await sql`
      DELETE FROM focowiki.generation_projection_records
      WHERE generation_id = ${generationId}
        AND projection_kind IN ('graph_node', 'graph_edge')
    `;
    await sql`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, logical_path, payload_json
      ) VALUES
        (${knowledgeBaseId}, 'graph_node', 'node-a', ${baseGenerationId},
         'graph_node/v1/00', 'pages/06/a.md', '{"kind":"graph_node"}'::jsonb),
        (${knowledgeBaseId}, 'graph_node', 'node-b', ${baseGenerationId},
         'graph_node/v1/00', 'pages/06/b.md', '{"kind":"graph_node"}'::jsonb),
        (${knowledgeBaseId}, 'graph_edge', 'edge-a-b', ${baseGenerationId},
         'graph_edge/v1/00', '_graph/graph_edge/v1/00.json', '{"kind":"graph_edge"}'::jsonb)
    `;
    await sql`
      UPDATE focowiki.generation_graph_summaries
      SET node_count = 2, edge_count = 1
      WHERE generation_id = ${generationId}
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_projection_repairs (
        knowledge_base_id, repair_version, base_generation_id,
        target_generation_id, state, checkpoint_json
      ) VALUES (
        ${knowledgeBaseId}, 2, ${baseGenerationId}, ${generationId}, 'running',
        ${sql.json({
          treeComplete: true,
          navigationComplete: true,
          graphNodeCount: 2,
          graphEdgeCount: 1,
          graphComplete: true
        })}
      )
    `;

    const issues = await repository.validateChangedClosure({
      knowledgeBaseId,
      generationId,
      issueLimit: 50
    });

    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "GRAPH_SUMMARY_MISMATCH" })
    ]));

    await sql`
      UPDATE focowiki.knowledge_base_projection_repairs
      SET checkpoint_json = checkpoint_json || '{"graphComplete":false}'::jsonb
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND repair_version = 2
    `;
    await expect(repository.validateChangedClosure({
      knowledgeBaseId,
      generationId,
      issueLimit: 50
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "GRAPH_SUMMARY_MISMATCH" })
    ]));
  });

  it("rejects stale descendant statistics before activation", async () => {
    await completeNavigationAndGraphSummary(sql, {
      knowledgeBaseId,
      generationId
    });
    await sql`
      UPDATE focowiki.generation_tree_directory_stats
      SET descendant_file_count = 0
      WHERE generation_id = ${generationId}
        AND path = 'pages'
    `;

    const issues = await repository.validateChangedClosure({
      knowledgeBaseId,
      generationId,
      issueLimit: 50
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "DIRECTORY_STATISTICS_MISMATCH",
        reference: "pages"
      })
    ]));
  });

  it("resolves unchanged navigation through the nearest generation ancestor", async () => {
    const ancestorGenerationId = "generation-publication-navigation-ancestor";
    const predecessorGenerationId = "generation-publication-navigation-predecessor";
    await completeNavigationAndGraphSummary(sql, {
      knowledgeBaseId,
      generationId
    });
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state, format_version
      ) VALUES
        (${ancestorGenerationId}, ${knowledgeBaseId}, NULL, 'superseded', 2),
        (${predecessorGenerationId}, ${knowledgeBaseId}, ${ancestorGenerationId}, 'active', 2)
    `;
    await sql`
      UPDATE focowiki.publication_generations
      SET predecessor_generation_id = ${predecessorGenerationId}
      WHERE id = ${generationId}
    `;
    await sql`
      UPDATE focowiki.generation_directory_navigation_summaries
      SET generation_id = ${ancestorGenerationId}
      WHERE generation_id = ${generationId}
    `;
    await sql`
      UPDATE focowiki.generation_directory_navigation_leaves
      SET generation_id = ${ancestorGenerationId}
      WHERE generation_id = ${generationId}
    `;
    await sql`
      INSERT INTO focowiki.generation_tree_directory_stats (
        knowledge_base_id, generation_id, path, parent_path,
        direct_entry_count, direct_directory_count, direct_file_count,
        descendant_file_count
      )
      SELECT knowledge_base_id, ${predecessorGenerationId}, path, parent_path,
             direct_entry_count, direct_directory_count, direct_file_count,
             descendant_file_count
      FROM focowiki.generation_tree_directory_stats
      WHERE generation_id = ${generationId}
    `;
    await sql`
      INSERT INTO focowiki.generation_graph_summaries (
        knowledge_base_id, generation_id, node_count, edge_count,
        graph_index_available
      ) VALUES (${knowledgeBaseId}, ${predecessorGenerationId}, 1, 1, true)
    `;
    await sql`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, source_file_id,
        related_source_file_id, logical_path, parent_path, sort_key,
        title, summary, searchable_text, payload_json
      )
      SELECT knowledge_base_id, projection_kind, record_id,
             ${predecessorGenerationId}, shard_key, source_file_id,
             related_source_file_id, logical_path, parent_path, sort_key,
             title, summary, searchable_text, payload_json
      FROM focowiki.generation_projection_records
      WHERE generation_id = ${generationId}
    `;

    await expect(repository.validateChangedClosure({
      knowledgeBaseId,
      generationId,
      issueLimit: 50
    })).resolves.toEqual([]);
  });

  it("validates the final directory leaf action after earlier touches are superseded", async () => {
    await completeNavigationAndGraphSummary(sql, {
      knowledgeBaseId,
      generationId
    });
    await sql`
      INSERT INTO focowiki.generation_directory_navigation_changes (
        generation_id, knowledge_base_id, directory_path, entry_id,
        touched_leaf_ids, removed_leaf_ids
      ) VALUES
        (${generationId}, ${knowledgeBaseId}, 'pages/06', 'source-touch',
         ARRAY['leaf-06'], ARRAY[]::text[]),
        (${generationId}, ${knowledgeBaseId}, 'pages/06', 'source-remove',
         ARRAY[]::text[], ARRAY['leaf-06'])
    `;
    await sql`
      INSERT INTO focowiki.generation_object_refs (
        generation_id, knowledge_base_id, ref_kind, ref_key, file_id,
        action, checksum_sha256, format_version, logical_path
      ) VALUES
        (${generationId}, ${knowledgeBaseId}, 'directory_root',
         'directory-root:pages/06', 'directory-root-file', 'upsert',
         ${checksum}, 1, 'pages/06/index.md'),
        (${generationId}, ${knowledgeBaseId}, 'directory_leaf',
         'directory-leaf:pages/06:leaf-06', NULL, 'delete',
         NULL, NULL, 'pages/06/index-leaf-06.md')
    `;

    const issues = await repository.validateChangedClosure({
      knowledgeBaseId,
      generationId,
      issueLimit: 50
    });

    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DIRECTORY_REFERENCE_MISSING" })
    ]));
  });
});

async function completeNavigationAndGraphSummary(
  sql: ReturnType<typeof postgres>,
  input: { knowledgeBaseId: string; generationId: string }
): Promise<void> {
  await sql`
    INSERT INTO focowiki.generation_directory_navigation_summaries (
      generation_id, knowledge_base_id, directory_path,
      entry_count, first_leaf_id
    ) VALUES (${input.generationId}, ${input.knowledgeBaseId}, 'pages/06', 1, 'leaf-06')
    ON CONFLICT (generation_id, directory_path) DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.generation_directory_navigation_leaves (
      generation_id, id, knowledge_base_id, directory_path,
      previous_leaf_id, next_leaf_id, entry_count, byte_count,
      first_sort_key, last_sort_key, entries_json
    ) VALUES (
      ${input.generationId}, 'leaf-06', ${input.knowledgeBaseId}, 'pages/06',
      NULL, NULL, 1, 100, 'a.md', 'a.md',
      '[{"id":"source-06-a","sortKey":"a.md","name":"a.md","targetPath":"pages/06/a.md","kind":"file"}]'::jsonb
    )
    ON CONFLICT (generation_id, id) DO NOTHING
  `;
  await sql`
    UPDATE focowiki.generation_graph_summaries
    SET edge_count = 1
    WHERE generation_id = ${input.generationId}
  `;
}
