import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { expandActiveGenerationGraph } from "../src/developer-openapi/active-generation-graph-expansion.js";
import { createPostgresActiveGenerationReadRepository } from "../src/infrastructure/postgres/active-generation-read-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("active generation read repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 4 });
  const repository = createPostgresActiveGenerationReadRepository(sql);
  const knowledgeBaseId = "kb-active-read-integration";

  beforeEach(async () => {
    await cleanup();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Active read integration')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("keeps candidate objects and projections invisible", async () => {
    await insertGeneration("generation-candidate", "building");
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = 'generation-candidate'
      WHERE id = ${knowledgeBaseId}
    `;
    await insertObject("11".repeat(32), "generated/11/page.md");
    await sql`
      INSERT INTO focowiki.generation_object_refs (
        generation_id, knowledge_base_id, ref_kind, ref_key, file_id,
        action, checksum_sha256, format_version, logical_path, source_file_id
      ) VALUES (
        'generation-candidate', ${knowledgeBaseId}, 'page', 'source-file-candidate',
        'source-file-candidate', 'upsert', ${"11".repeat(32)}, 1,
        'pages/candidate.md', 'source-file-candidate'
      )
    `;
    await sql`
      INSERT INTO focowiki.generation_projection_records (
        generation_id, knowledge_base_id, projection_kind, record_id,
        action, shard_key, source_file_id, logical_path, sort_key,
        title, searchable_text, payload_json
      ) VALUES (
        'generation-candidate', ${knowledgeBaseId}, 'search',
        'source-file-candidate', 'upsert', 'search/v1/0011',
        'source-file-candidate', 'pages/candidate.md', 'pages/candidate.md',
        'Candidate', 'candidate hidden text',
        ${sql.json({ fileId: "source-file-candidate", path: "pages/candidate.md" })}
      )
    `;

    await expect(repository.withActiveGeneration(knowledgeBaseId, async (scope) => ({
      file: await scope.findFileById("source-file-candidate"),
      search: await scope.search({ query: "candidate", mode: "file", limit: 10, cursor: null })
    }))).resolves.toBeNull();
  });

  it("does not scan active graph records when an optimized summary is missing", async () => {
    await seedActiveGeneration("generation-active-a", "source-file-a", "pages/alpha.md", "Alpha");
    await sql`
      INSERT INTO focowiki.knowledge_base_optimization_migrations (
        knowledge_base_id, state, prior_active_generation_id,
        optimized_active_generation_id, completed_at
      ) VALUES (
        ${knowledgeBaseId}, 'optimized_active', 'generation-active-a',
        'generation-active-a', now()
      )
      ON CONFLICT (knowledge_base_id) DO UPDATE
      SET state = EXCLUDED.state,
          prior_active_generation_id = EXCLUDED.prior_active_generation_id,
          optimized_active_generation_id = EXCLUDED.optimized_active_generation_id,
          completed_at = EXCLUDED.completed_at
    `;

    await expect(repository.withActiveGeneration(knowledgeBaseId, async (scope) => (
      scope.getGraphSummary()
    ))).rejects.toThrow("Active graph summary is unavailable");
  });

  it("hydrates missing optimized directory statistics with one bounded page query", async () => {
    await seedActiveGeneration("generation-active-a", "source-file-a", "pages/alpha.md", "Alpha");
    await seedActiveTreeDirectory("generation-active-a", "pages");
    await sql`
      INSERT INTO focowiki.knowledge_base_optimization_migrations (
        knowledge_base_id, state, prior_active_generation_id,
        optimized_active_generation_id, completed_at
      ) VALUES (
        ${knowledgeBaseId}, 'optimized_active', 'generation-active-a',
        'generation-active-a', now()
      )
      ON CONFLICT (knowledge_base_id) DO UPDATE
      SET state = EXCLUDED.state,
          prior_active_generation_id = EXCLUDED.prior_active_generation_id,
          optimized_active_generation_id = EXCLUDED.optimized_active_generation_id,
          completed_at = EXCLUDED.completed_at
    `;

    await expect(repository.withActiveGeneration(knowledgeBaseId, async (scope) => (
      scope.listTree({ parentPath: "", entryType: "directory", query: null, limit: 10, cursor: null })
    ))).resolves.toMatchObject({
      items: [{
        path: "pages",
        payload: {
          directEntryCount: 1,
          directDirectoryCount: 0,
          directFileCount: 1,
          descendantFileCount: 1
        }
      }]
    });
  });

  it("uses complete directory statistics already stored in the active projection", async () => {
    await seedActiveGeneration("generation-active-a", "source-file-a", "pages/alpha.md", "Alpha");
    await seedActiveTreeDirectory("generation-active-a", "pages", {
      directEntryCount: 1,
      directDirectoryCount: 0,
      directFileCount: 1,
      descendantFileCount: 1
    });
    await sql`
      INSERT INTO focowiki.knowledge_base_optimization_migrations (
        knowledge_base_id, state, prior_active_generation_id,
        optimized_active_generation_id, completed_at
      ) VALUES (
        ${knowledgeBaseId}, 'optimized_active', 'generation-active-a',
        'generation-active-a', now()
      )
      ON CONFLICT (knowledge_base_id) DO UPDATE
      SET state = EXCLUDED.state,
          prior_active_generation_id = EXCLUDED.prior_active_generation_id,
          optimized_active_generation_id = EXCLUDED.optimized_active_generation_id,
          completed_at = EXCLUDED.completed_at
    `;

    await expect(repository.withActiveGeneration(knowledgeBaseId, async (scope) => (
      scope.listTree({ parentPath: "", entryType: "directory", query: null, limit: 10, cursor: null })
    ))).resolves.toMatchObject({
      items: [{
        path: "pages",
        payload: {
          directEntryCount: 1,
          directDirectoryCount: 0,
          directFileCount: 1,
          descendantFileCount: 1
        }
      }]
    });
  });

  it("resolves stable file identity and bounded projection pages in one generation", async () => {
    await seedActiveGeneration("generation-active-a", "source-file-a", "pages/alpha.md", "Alpha");
    await seedAdditionalActiveFile("generation-active-a", "source-file-b", "pages/beta.md", "Beta");
    await seedRelatedProjection("generation-active-a", "source-file-a", "source-file-b");

    const result = await repository.withActiveGeneration(knowledgeBaseId, async (scope) => ({
      generationId: scope.generationId,
      byId: await scope.findFileById("source-file-a"),
      byPath: await scope.findFileByPath("pages/alpha.md"),
      tree: await scope.listTree({ parentPath: "pages", entryType: "file", query: null, limit: 1, cursor: null }),
      search: await scope.search({ query: "alpha", mode: "file", limit: 1, cursor: null }),
      edge: await scope.findProjection({ projectionKind: "graph_edge", recordId: "relationship-a-b" }),
      outgoing: await scope.listRelated({ sourceFileId: "source-file-a", limit: 1, cursor: null }),
      incoming: await scope.listRelated({ sourceFileId: "source-file-b", limit: 1, cursor: null }),
      relatedBySource: await scope.listRelatedForSources({
        sourceFileIds: ["source-file-a", "source-file-b"],
        limitPerSource: 1
      })
    }));

    expect(result).toMatchObject({
      generationId: "generation-active-a",
      byId: { fileId: "source-file-a", path: "pages/alpha.md" },
      byPath: { fileId: "source-file-a", path: "pages/alpha.md" },
      tree: { items: [{ recordId: "source-file-a", path: "pages/alpha.md" }] },
      search: { items: [{ recordId: "source-file-a", path: "pages/alpha.md" }] },
      edge: {
        recordId: "relationship-a-b",
        sourceFileId: "source-file-a",
        relatedSourceFileId: "source-file-b"
      },
      outgoing: { items: [{ relatedSourceFileId: "source-file-b", path: "pages/beta.md" }] },
      incoming: { items: [{ relatedSourceFileId: "source-file-a", path: "pages/alpha.md" }] },
      relatedBySource: new Map([
        ["source-file-a", [expect.objectContaining({
          relatedSourceFileId: "source-file-b",
          path: "pages/beta.md"
        })]],
        ["source-file-b", [expect.objectContaining({
          relatedSourceFileId: "source-file-a",
          path: "pages/alpha.md"
        })]]
      ])
    });
  });

  it("hides logically deleted sources from every active read path immediately", async () => {
    await seedActiveGeneration("generation-active-a", "source-file-a", "pages/alpha.md", "Alpha");
    await seedAdditionalActiveFile("generation-active-a", "source-file-b", "pages/beta.md", "Beta");
    await seedRelatedProjection("generation-active-a", "source-file-a", "source-file-b");
    await seedActiveGeneratedFile("generation-active-a", "root", "index.md");

    await sql`
      UPDATE focowiki.source_files
      SET deleted_at = now()
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND id = 'source-file-a'
    `;

    const result = await repository.withActiveGeneration(knowledgeBaseId, async (scope) => ({
      byId: await scope.findFileById("source-file-a"),
      byPath: await scope.findFileByPath("pages/alpha.md"),
      generatedRoot: await scope.findFileByPath("index.md"),
      tree: await scope.listTree({
        parentPath: "pages",
        entryType: "file",
        query: null,
        limit: 10,
        cursor: null
      }),
      search: await scope.search({ query: "Alpha", mode: "hybrid", limit: 10, cursor: null }),
      edge: await scope.findProjection({ projectionKind: "graph_edge", recordId: "relationship-a-b" }),
      outgoing: await scope.listRelated({ sourceFileId: "source-file-a", limit: 10, cursor: null }),
      incoming: await scope.listRelated({ sourceFileId: "source-file-b", limit: 10, cursor: null }),
      relatedBySource: await scope.listRelatedForSources({
        sourceFileIds: ["source-file-a", "source-file-b"],
        limitPerSource: 10
      })
    }));

    expect(result).toMatchObject({
      byId: null,
      byPath: null,
      generatedRoot: { path: "index.md", sourceFileId: null },
      tree: { items: [] },
      search: { items: [] },
      edge: null,
      outgoing: { items: [] },
      incoming: { items: [] },
      relatedBySource: new Map([
        ["source-file-a", []],
        ["source-file-b", []]
      ])
    });
  });

  it("hides all nested files as soon as a directory deletion marks its sources", async () => {
    await seedActiveGeneration(
      "generation-active-a",
      "source-file-a",
      "pages/archive/alpha.md",
      "Alpha"
    );
    await seedAdditionalActiveFile(
      "generation-active-a",
      "source-file-b",
      "pages/archive/beta.md",
      "Beta"
    );

    await sql`
      UPDATE focowiki.source_files
      SET deleted_at = now()
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND id = ANY(${["source-file-a", "source-file-b"]})
    `;

    await expect(repository.withActiveGeneration(knowledgeBaseId, async (scope) => ({
      tree: await scope.listTree({
        parentPath: "pages/archive",
        entryType: "file",
        query: null,
        limit: 10,
        cursor: null
      }),
      search: await scope.search({ query: "Alpha", mode: "hybrid", limit: 10, cursor: null }),
      files: await scope.findFilesBySourceIds(["source-file-a", "source-file-b"])
    }))).resolves.toMatchObject({
      tree: { items: [] },
      search: { items: [] },
      files: []
    });
  });

  it("lists generated roots and machine-readable files alongside source-backed pages", async () => {
    await seedActiveGeneration("generation-active-a", "source-file-a", "pages/alpha.md", "Alpha");
    await seedActiveTreeDirectory("generation-active-a", "pages");
    for (const [refKind, path] of [
      ["root", "index.md"],
      ["root", "schema.md"],
      ["root", "log.md"],
      ["root", "_index/index.md"],
      ["root", "_index/catalog.json"],
      ["root", "_graph/index.md"],
      ["directory_root", "pages/index.md"],
      ["projection_shard", "_index/search/v1/0001.json"],
      ["projection_shard", "_index/tree/v1/0001.json"],
      ["projection_shard", "_graph/graph_node/v1/0001.json"],
      ["projection_shard", "_graph/by-file/source-file-a.json"],
      ["projection_shard", "_graph/by-file/source-file-b.json"],
      ["projection_shard", "_graph/by-file/source-file-c.json"]
    ] as const) {
      await seedActiveGeneratedFile("generation-active-a", refKind, path);
    }

    const result = await repository.withActiveGeneration(knowledgeBaseId, async (scope) => {
      const graphByFileFirst = await scope.listTree({
        parentPath: "_graph/by-file",
        entryType: "file",
        query: null,
        limit: 1,
        cursor: null
      });
      const graphByFileSecond = await scope.listTree({
        parentPath: "_graph/by-file",
        entryType: "file",
        query: null,
        limit: 1,
        cursor: graphByFileFirst.nextCursor
      });
      const graphByFileThird = await scope.listTree({
        parentPath: "_graph/by-file",
        entryType: "file",
        query: null,
        limit: 1,
        cursor: graphByFileSecond.nextCursor
      });
      return {
        root: await scope.listTree({
          parentPath: "",
          entryType: null,
          query: null,
          limit: 20,
          cursor: null
        }),
        index: await scope.listTree({
          parentPath: "_index",
          entryType: null,
          query: null,
          limit: 20,
          cursor: null
        }),
        graph: await scope.listTree({
          parentPath: "_graph",
          entryType: null,
          query: null,
          limit: 20,
          cursor: null
        }),
        pages: await scope.listTree({
          parentPath: "pages",
          entryType: null,
          query: null,
          limit: 20,
          cursor: null
        }),
        graphByFile: [
          graphByFileFirst.items[0]?.path,
          graphByFileSecond.items[0]?.path,
          graphByFileThird.items[0]?.path
        ]
      };
    });

    expect(result?.root.items.map((item) => item.path)).toEqual(expect.arrayContaining([
      "_graph",
      "_index",
      "pages",
      "index.md",
      "log.md",
      "schema.md"
    ]));
    expect(result?.index.items.map((item) => item.path)).toEqual(expect.arrayContaining([
      "_index/catalog.json",
      "_index/index.md",
      "_index/search",
      "_index/tree"
    ]));
    expect(result?.graph.items.map((item) => item.path)).toEqual(expect.arrayContaining([
      "_graph/by-file",
      "_graph/graph_node",
      "_graph/index.md"
    ]));
    expect(result?.root.items.find((item) => item.path === "_graph")?.payload).toMatchObject({
      directEntryCount: 3,
      directDirectoryCount: 2,
      directFileCount: 1,
      descendantFileCount: 5
    });
    expect(result?.graph.items.find((item) => item.path === "_graph/graph_node")?.payload).toMatchObject({
      directEntryCount: 1,
      directDirectoryCount: 1,
      directFileCount: 0,
      descendantFileCount: 1
    });
    expect(result?.pages.items.map((item) => item.path)).toEqual(expect.arrayContaining([
      "pages/alpha.md",
      "pages/index.md"
    ]));
    expect(result?.graphByFile).toEqual([
      "_graph/by-file/source-file-a.json",
      "_graph/by-file/source-file-b.json",
      "_graph/by-file/source-file-c.json"
    ]);
    expect(result?.root.items.find((item) => item.path === "index.md")?.payload).toMatchObject({
      fileId: expect.any(String),
      fileKind: "index",
      kind: "file",
      path: "index.md"
    });
  });

  it("searches graph nodes and edges without leaking them into file-only mode", async () => {
    await seedActiveGeneration("generation-active-a", "source-file-a", "pages/alpha.md", "Alpha");
    await seedAdditionalActiveFile("generation-active-a", "source-file-b", "pages/beta.md", "Beta");
    await seedRelatedProjection("generation-active-a", "source-file-a", "source-file-b");
    await sql`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, source_file_id,
        logical_path, sort_key, title, summary, searchable_text, payload_json
      ) VALUES (
        ${knowledgeBaseId}, 'graph_node', 'source-file-b',
        'generation-active-a', 'graph-node/v1/0001', 'source-file-b',
        'pages/beta.md', 'pages/beta.md', 'Beta', 'Graph-only concept',
        'Beta graph-only concept',
        ${sql.json({ fileId: "source-file-b", path: "pages/beta.md", title: "Beta" })}
      )
    `;

    const result = await repository.withActiveGeneration(knowledgeBaseId, async (scope) => ({
      file: await scope.search({
        query: "graph-only concept",
        mode: "file",
        limit: 10,
        cursor: null
      }),
      graph: await scope.search({
        query: "graph-only concept",
        mode: "graph",
        limit: 10,
        cursor: null
      }),
      hybrid: await scope.search({
        query: "Alpha",
        mode: "hybrid",
        limit: 10,
        cursor: null
      })
    }));

    expect(result?.file.items).toEqual([]);
    expect(result?.graph.items).toContainEqual(expect.objectContaining({
      sourceFileId: "source-file-b",
      path: "pages/beta.md"
    }));
    expect(result?.hybrid.items.filter((item) => item.sourceFileId === "source-file-a")).toHaveLength(1);
  });

  it("keeps high-frequency CJK graph retrieval bounded before scoring", async () => {
    await seedActiveGeneration("generation-active-a", "source-file-a", "pages/alpha.md", "Alpha");
    await seedAdditionalActiveFile("generation-active-a", "source-file-b", "pages/beta.md", "Beta");
    await sql`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, source_file_id,
        related_source_file_id, logical_path, sort_key, title,
        summary, searchable_text, payload_json
      )
      SELECT
        ${knowledgeBaseId}, 'graph_edge', 'bulk-edge-' || lpad(item::text, 6, '0'),
        'generation-active-a', 'graph-edge/v1/0001', 'source-file-a',
        'source-file-b', 'pages/alpha.md', 'bulk-edge-' || lpad(item::text, 6, '0'),
        'Alpha -> Beta', 'Common relationship', '法律 common relationship',
        jsonb_build_object(
          'fromFileId', 'source-file-a',
          'fromPath', 'pages/alpha.md',
          'fromTitle', 'Alpha',
          'toFileId', 'source-file-b',
          'toPath', 'pages/beta.md',
          'toTitle', 'Beta',
          'relationType', 'related',
          'weight', 0.5,
          'reason', 'Common relationship'
        )
      FROM generate_series(1, 30000) AS item
    `;

    const startedAt = performance.now();
    const result = await repository.withActiveGeneration(knowledgeBaseId, async (scope) =>
      expandActiveGenerationGraph(scope, {
        fileId: null,
        nodeId: null,
        edgeId: null,
        query: "法律",
        depth: 1,
        fanout: 5,
        limit: 10,
        cursor: null
      })
    );
    const elapsedMs = performance.now() - startedAt;

    expect(result?.seedResults.length).toBeGreaterThan(0);
    expect(result?.seedResults.every((item) => item.path?.startsWith("pages/"))).toBe(true);
    expect(result?.relationships.every((item) => item.path?.startsWith("pages/"))).toBe(true);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("holds one repeatable-read generation snapshot across concurrent activation", async () => {
    await seedActiveGeneration("generation-active-a", "source-file-a", "pages/alpha.md", "Alpha");
    let releaseRead!: () => void;
    const waitForActivation = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });

    const read = repository.withActiveGeneration(knowledgeBaseId, async (scope) => {
      const before = await scope.findFileByPath("pages/alpha.md");
      releaseRead();
      await waitForGeneration("generation-active-b");
      const after = await scope.findFileByPath("pages/alpha.md");
      return { generationId: scope.generationId, before, after };
    });
    await waitForActivation;
    await replaceActiveGeneration();

    await expect(read).resolves.toMatchObject({
      generationId: "generation-active-a",
      before: { fileId: "source-file-a" },
      after: { fileId: "source-file-a" }
    });
    await expect(repository.withActiveGeneration(knowledgeBaseId, async (scope) => ({
      generationId: scope.generationId,
      file: await scope.findFileByPath("pages/alpha.md")
    }))).resolves.toMatchObject({
      generationId: "generation-active-b",
      file: { fileId: "source-file-b" }
    });
  });

  async function seedActiveGeneration(
    generationId: string,
    sourceFileId: string,
    path: string,
    title: string
  ): Promise<void> {
    const parentPath = path.slice(0, path.lastIndexOf("/"));
    await insertGeneration(generationId, "active");
    await insertSource(sourceFileId, path);
    const checksum = sourceFileId === "source-file-a" ? "aa".repeat(32) : "bb".repeat(32);
    await insertObject(checksum, `generated/${checksum}`);
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${generationId}
      WHERE id = ${knowledgeBaseId}
    `;
    await sql`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id,
        last_changed_generation_id, checksum_sha256, format_version,
        logical_path, source_file_id
      ) VALUES (
        ${knowledgeBaseId}, 'page', ${sourceFileId}, ${sourceFileId},
        ${generationId}, ${checksum}, 1, ${path}, ${sourceFileId}
      )
    `;
    for (const projectionKind of ["tree", "search"] as const) {
      await sql`
        INSERT INTO focowiki.active_projection_records (
          knowledge_base_id, projection_kind, record_id,
          last_changed_generation_id, shard_key, source_file_id,
          logical_path, parent_path, sort_key, title, summary,
          searchable_text, payload_json
        ) VALUES (
          ${knowledgeBaseId}, ${projectionKind}, ${sourceFileId},
          ${generationId}, ${`${projectionKind}/v1/0001`}, ${sourceFileId},
          ${path}, ${parentPath}, ${path.toLowerCase()}, ${title},
          ${`${title} summary`}, ${`${title} searchable body`},
          ${sql.json({ fileId: sourceFileId, path, title, kind: "file" })}
        )
      `;
    }
  }

  async function seedRelatedProjection(
    generationId: string,
    sourceFileId: string,
    relatedSourceFileId: string
  ): Promise<void> {
    await sql`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, source_file_id,
        related_source_file_id, logical_path, sort_key, title,
        searchable_text, payload_json
      ) VALUES (
        ${knowledgeBaseId}, 'graph_edge', 'relationship-a-b',
        ${generationId}, 'related/v1/0001', ${sourceFileId},
        ${relatedSourceFileId}, 'pages/beta.md', 'relationship-a-b', 'Beta',
        'Alpha Beta relationship',
        ${sql.json({
          fromFileId: sourceFileId,
          fromPath: "pages/alpha.md",
          fromTitle: "Alpha",
          toFileId: relatedSourceFileId,
          toPath: "pages/beta.md",
          toTitle: "Beta",
          relationType: "related",
          weight: 0.9,
          reason: "Shared subject"
        })}
      )
    `;
  }

  async function seedActiveTreeDirectory(
    generationId: string,
    path: string,
    statistics?: {
      directEntryCount: number;
      directDirectoryCount: number;
      directFileCount: number;
      descendantFileCount: number;
    }
  ): Promise<void> {
    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    await sql`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, logical_path,
        parent_path, sort_key, title, searchable_text, payload_json
      ) VALUES (
        ${knowledgeBaseId}, 'tree', ${`directory:${path}`},
        ${generationId}, 'tree/v1/0001', ${path}, ${parentPath},
        ${path.toLowerCase()}, ${path.split("/").at(-1) ?? path}, ${path},
        ${sql.json({
          kind: "directory",
          name: path.split("/").at(-1) ?? path,
          parentPath,
          path,
          ...statistics
        })}
      )
    `;
  }

  async function seedActiveGeneratedFile(
    generationId: string,
    refKind: string,
    path: string
  ): Promise<void> {
    const checksum = createHash("sha256").update(path).digest("hex");
    const fileId = `bundle-file-${checksum.slice(0, 24)}`;
    await insertObject(checksum, `generated/${checksum}`);
    await sql`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id,
        last_changed_generation_id, checksum_sha256, format_version,
        logical_path, source_file_id
      ) VALUES (
        ${knowledgeBaseId}, ${refKind}, ${path}, ${fileId},
        ${generationId}, ${checksum}, 1, ${path}, NULL
      )
    `;
  }

  async function seedAdditionalActiveFile(
    generationId: string,
    sourceFileId: string,
    path: string,
    title: string
  ): Promise<void> {
    const parentPath = path.slice(0, path.lastIndexOf("/"));
    await insertSource(sourceFileId, path);
    const checksum = "cc".repeat(32);
    await insertObject(checksum, `generated/${checksum}`);
    await sql`
      INSERT INTO focowiki.active_object_refs (
        knowledge_base_id, ref_kind, ref_key, file_id,
        last_changed_generation_id, checksum_sha256, format_version,
        logical_path, source_file_id
      ) VALUES (
        ${knowledgeBaseId}, 'page', ${sourceFileId}, ${sourceFileId},
        ${generationId}, ${checksum}, 1, ${path}, ${sourceFileId}
      )
    `;
    await sql`
      INSERT INTO focowiki.active_projection_records (
        knowledge_base_id, projection_kind, record_id,
        last_changed_generation_id, shard_key, source_file_id,
        logical_path, parent_path, sort_key, title, summary,
        searchable_text, payload_json
      ) VALUES (
        ${knowledgeBaseId}, 'search', ${sourceFileId}, ${generationId},
        'search/v1/0002', ${sourceFileId}, ${path}, ${parentPath}, ${path},
        ${title}, ${`${title} summary`}, ${`${title} searchable body`},
        ${sql.json({ fileId: sourceFileId, path, title, kind: "file" })}
      )
    `;
  }

  async function replaceActiveGeneration(): Promise<void> {
    await insertSource("source-file-b", "pages/beta.md");
    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE focowiki.publication_generations
        SET state = 'superseded'
        WHERE id = 'generation-active-a'
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id, state, format_version
        ) VALUES (
          'generation-active-b', ${knowledgeBaseId}, 'generation-active-a', 'active', 1
        )
      `;
      const checksum = "bb".repeat(32);
      await transaction`
        INSERT INTO focowiki.immutable_objects (
          checksum_sha256, format_version, object_key, content_type, size_bytes,
          verified_at
        ) VALUES (
          ${checksum}, 1, ${`generated/${checksum}`}, 'text/markdown', 4, now()
        )
        ON CONFLICT (checksum_sha256, format_version) DO NOTHING
      `;
      await transaction`
        DELETE FROM focowiki.active_object_refs
        WHERE knowledge_base_id = ${knowledgeBaseId}
      `;
      await transaction`
        INSERT INTO focowiki.active_object_refs (
          knowledge_base_id, ref_kind, ref_key, file_id,
          last_changed_generation_id, checksum_sha256, format_version,
          logical_path, source_file_id
        ) VALUES (
          ${knowledgeBaseId}, 'page', 'source-file-b', 'source-file-b',
          'generation-active-b', ${checksum}, 1, 'pages/alpha.md', 'source-file-b'
        )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = 'generation-active-b'
        WHERE id = ${knowledgeBaseId}
      `;
    });
  }

  async function insertGeneration(id: string, state: string): Promise<void> {
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, format_version
      ) VALUES (${id}, ${knowledgeBaseId}, ${state}, 1)
    `;
  }

  async function insertObject(checksum: string, objectKey: string): Promise<void> {
    await sql`
      INSERT INTO focowiki.immutable_objects (
        checksum_sha256, format_version, object_key, content_type, size_bytes,
        verified_at
      ) VALUES (${checksum}, 1, ${objectKey}, 'text/markdown', 4, now())
      ON CONFLICT (checksum_sha256, format_version) DO NOTHING
    `;
  }

  async function insertSource(sourceFileId: string, generatedPath: string): Promise<void> {
    const relativePath = generatedPath.replace(/^pages\//u, "");
    const revisionId = `source-revision-${sourceFileId}`;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, object_key,
          content_type, size_bytes, checksum_sha256, active_revision_id,
          processing_status, processing_stage, generated_output_status
        ) VALUES (
          ${sourceFileId}, ${knowledgeBaseId}, ${relativePath.split("/").at(-1) ?? relativePath},
          ${relativePath}, ${relativePath.toLocaleLowerCase("en-US")},
          ${`sources/${sourceFileId}.md`}, 'text/markdown', 4, ${"dd".repeat(32)},
          ${revisionId}, 'completed', 'generation_activation', 'visible'
        )
        ON CONFLICT (id) DO NOTHING
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        ) VALUES (
          ${revisionId}, ${knowledgeBaseId}, ${sourceFileId}, 1,
          ${`sources/${sourceFileId}.md`}, 'text/markdown', 4,
          ${"dd".repeat(32)}, 'completed'
        )
        ON CONFLICT (id) DO NOTHING
      `;
    });
  }

  async function waitForGeneration(generationId: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const rows = await sql<Array<{ active_generation_id: string | null }>>`
        SELECT active_generation_id
        FROM focowiki.knowledge_bases
        WHERE id = ${knowledgeBaseId}
      `;
      if (rows[0]?.active_generation_id === generationId) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for generation activation");
  }

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM focowiki.active_projection_records WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.active_object_refs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.generation_projection_records WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.generation_object_refs WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.publication_generations WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});
