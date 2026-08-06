import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresStorageVnextCatalogRepository } from
  "../src/storage-vnext/catalog/postgres-repository.js";
import {
  createPostgresStorageVnextGraphRepository,
  StorageVnextGraphRepositoryError
} from "../src/storage-vnext/graph/postgres-repository.js";
import { mapStorageVnextMarkdownGraph } from
  "../src/storage-vnext/graph/markdown-facts.js";
import {
  hydrateStorageVnextGraphSeedHits,
  mapStorageVnextGraphSeedDocument
} from "../src/storage-vnext/graph/read-models.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphEvidence,
  StorageVnextGraphNodeFact
} from "../src/storage-vnext/graph/ports.js";

const databaseUrl = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_DATABASE_URL;
const runOwner = process.env.FOCOWIKI_STORAGE_VNEXT_TEST_RUN_OWNER;
const hasOwnedTarget = Boolean(
  databaseUrl
  && runOwner
  && /^svnext-[a-z0-9]{8,16}$/u.test(runOwner)
);
const describeOwnedDatabase = hasOwnedTarget ? describe : describe.skip;
const bootstrap = readFileSync(
  resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
  "utf8"
);

describeOwnedDatabase("storage vNext current graph repository", () => {
  const connectionUrl = databaseUrl
    ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const ownerToken = (runOwner ?? "invalid").replaceAll("-", "_");
  const databaseName = `focowiki_vnext_graph_${ownerToken}_${
    randomUUID().replaceAll("-", "").slice(0, 10)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 8 });
  const catalog = createPostgresStorageVnextCatalogRepository(sql);
  const graph = createPostgresStorageVnextGraphRepository(sql);
  let databaseCreated = false;

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    await sql.unsafe(bootstrap);
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

  it("stores and replays one current node and accepted edge representation", async () => {
    await createKnowledgeBase("kb-graph-current");
    await createCurrentSource({
      knowledgeBaseId: "kb-graph-current",
      sourceFilePublicId: "file-current-a",
      sourceRevisionPublicId: "revision-current-a",
      logicalPath: "Overview.md",
      checksum: "a".repeat(64)
    });
    await createCurrentSource({
      knowledgeBaseId: "kb-graph-current",
      sourceFilePublicId: "file-current-b",
      sourceRevisionPublicId: "revision-current-b",
      logicalPath: "System.md",
      checksum: "b".repeat(64)
    });
    const target = nodeFact({
      knowledgeBaseId: "kb-graph-current",
      sourceFilePublicId: "file-current-b",
      sourceRevisionPublicId: "revision-current-b",
      logicalPath: "pages/System.md",
      checksum: "b".repeat(64),
      label: "System"
    });
    await graph.replaceSourceFileGraph({
      knowledgeBaseId: "kb-graph-current",
      sourceFilePublicId: target.sourceFilePublicId,
      sourceRevisionPublicId: target.sourceRevisionPublicId,
      node: target,
      edges: []
    });
    const source = nodeFact({
      knowledgeBaseId: "kb-graph-current",
      sourceFilePublicId: "file-current-a",
      sourceRevisionPublicId: "revision-current-a",
      logicalPath: "pages/Overview.md",
      checksum: "a".repeat(64),
      label: "Overview"
    });
    const edge = edgeFact(source, target);
    const replacement = {
      knowledgeBaseId: "kb-graph-current",
      sourceFilePublicId: source.sourceFilePublicId,
      sourceRevisionPublicId: source.sourceRevisionPublicId,
      node: source,
      edges: [edge]
    };

    await graph.replaceSourceFileGraph(replacement);
    await graph.replaceSourceFileGraph(replacement);

    await expect(graph.getNode({
      knowledgeBaseId: "kb-graph-current",
      publicId: source.publicId
    })).resolves.toEqual(source);
    await expect(graph.getEdge({
      knowledgeBaseId: "kb-graph-current",
      publicId: edge.publicId
    })).resolves.toEqual(edge);
    const counts = await sql<Array<{
      nodes: number | string;
      edges: number | string;
      evidence: number | string;
    }>>`
      SELECT
        (SELECT count(*) FROM focowiki.graph_nodes
          WHERE knowledge_base_id = 'kb-graph-current') AS nodes,
        (SELECT count(*) FROM focowiki.graph_edges
          WHERE knowledge_base_id = 'kb-graph-current') AS edges,
        (SELECT count(*) FROM focowiki.graph_evidence_refs
          WHERE knowledge_base_id = 'kb-graph-current') AS evidence
    `;
    expect(counts[0]).toEqual({ nodes: "2", edges: "1", evidence: "3" });

    const firstNodePage = await graph.listNodes({
      knowledgeBaseId: "kb-graph-current",
      limit: 1,
      cursor: null
    });
    const secondNodePage = await graph.listNodes({
      knowledgeBaseId: "kb-graph-current",
      limit: 1,
      cursor: firstNodePage.nextCursor
    });
    expect([
      ...firstNodePage.items,
      ...secondNodePage.items
    ].map((item) => item.publicId)).toEqual([
      source.publicId,
      target.publicId
    ]);
    expect(secondNodePage.nextCursor).toBeNull();

    await expect(graph.listEdges({
      knowledgeBaseId: "kb-graph-current",
      limit: 10,
      cursor: null
    })).resolves.toMatchObject({
      items: [{ publicId: edge.publicId }],
      nextCursor: null
    });
    await expect(graph.listNeighborhood({
      knowledgeBaseId: "kb-graph-current",
      nodePublicId: source.publicId,
      depth: 1,
      limit: 10,
      cursor: null
    })).resolves.toMatchObject({
      items: [{ publicId: edge.publicId }],
      nextCursor: null
    });
  });

  it("persists Markdown-first domain-neutral relationships across directories", async () => {
    await createKnowledgeBase("kb-graph-markdown");
    const targetBody = "# Runtime system\n\nRuntime components.";
    const targetChecksum = createHash("sha256").update(targetBody).digest("hex");
    await createCurrentSource({
      knowledgeBaseId: "kb-graph-markdown",
      sourceFilePublicId: "file-markdown-target",
      sourceRevisionPublicId: "revision-markdown-target",
      logicalPath: "Engineering/System.md",
      checksum: targetChecksum
    });
    const target = mapStorageVnextMarkdownGraph({
      knowledgeBaseId: "kb-graph-markdown",
      sourceFilePublicId: "file-markdown-target",
      sourceRevisionPublicId: "revision-markdown-target",
      sourceLogicalPath: "Engineering/System.md",
      body: targetBody,
      checksum: targetChecksum,
      fallbackTitle: "System",
      metadata: { type: "reference" },
      targets: [],
      revision: 1
    });
    await graph.replaceSourceFileGraph({
      knowledgeBaseId: "kb-graph-markdown",
      sourceFilePublicId: target.node.sourceFilePublicId,
      sourceRevisionPublicId: target.node.sourceRevisionPublicId,
      node: target.node,
      edges: target.edges
    });

    const sourceBody = [
      "# Research overview",
      "",
      "Continue with the [runtime system](../Engineering/System.md#runtime)."
    ].join("\n");
    const sourceChecksum = createHash("sha256").update(sourceBody).digest("hex");
    await createCurrentSource({
      knowledgeBaseId: "kb-graph-markdown",
      sourceFilePublicId: "file-markdown-source",
      sourceRevisionPublicId: "revision-markdown-source",
      logicalPath: "Research/Overview.md",
      checksum: sourceChecksum
    });
    const source = mapStorageVnextMarkdownGraph({
      knowledgeBaseId: "kb-graph-markdown",
      sourceFilePublicId: "file-markdown-source",
      sourceRevisionPublicId: "revision-markdown-source",
      sourceLogicalPath: "Research/Overview.md",
      body: sourceBody,
      checksum: sourceChecksum,
      fallbackTitle: "Metadata title",
      metadata: { title: "Metadata title", type: "guide" },
      targets: [{
        nodePublicId: target.node.publicId,
        sourceFilePublicId: target.node.sourceFilePublicId,
        sourceRevisionPublicId: target.node.sourceRevisionPublicId,
        logicalPath: target.node.logicalPath,
        label: target.node.label
      }],
      revision: 1
    });
    await graph.replaceSourceFileGraph({
      knowledgeBaseId: "kb-graph-markdown",
      sourceFilePublicId: source.node.sourceFilePublicId,
      sourceRevisionPublicId: source.node.sourceRevisionPublicId,
      node: source.node,
      edges: source.edges
    });

    expect(source.node.label).toBe("Research overview");
    expect(source.node.metadata.title).toBe("Metadata title");
    expect(source.edges).toHaveLength(1);
    await expect(graph.getEdge({
      knowledgeBaseId: "kb-graph-markdown",
      publicId: source.edges[0]!.publicId
    })).resolves.toMatchObject({
      fromNodePublicId: source.node.publicId,
      toNodePublicId: target.node.publicId,
      reason: "Research overview links to Runtime system.",
      evidence: [{
        logicalPath: "pages/Research/Overview.md",
        checksum: sourceChecksum
      }]
    });
  });

  it("converges move and replacement paths without retaining stale graph facts", async () => {
    await createKnowledgeBase("kb-graph-change");
    await createCurrentSource({
      knowledgeBaseId: "kb-graph-change",
      sourceFilePublicId: "file-change",
      sourceRevisionPublicId: "revision-change-a",
      logicalPath: "Old/Move.md",
      checksum: "d".repeat(64)
    });
    await catalog.createDirectory({
      publicId: "directory-change-new",
      knowledgeBaseId: "kb-graph-change",
      parentPublicId: null,
      logicalPath: "New",
      title: "New"
    });
    const original = nodeFact({
      knowledgeBaseId: "kb-graph-change",
      sourceFilePublicId: "file-change",
      sourceRevisionPublicId: "revision-change-a",
      logicalPath: "pages/Old/Move.md",
      checksum: "d".repeat(64),
      label: "Move"
    });
    await graph.replaceSourceFileGraph({
      knowledgeBaseId: "kb-graph-change",
      sourceFilePublicId: original.sourceFilePublicId,
      sourceRevisionPublicId: original.sourceRevisionPublicId,
      node: original,
      edges: []
    });

    const sourceBeforeMove = await catalog.getSourceFile({
      knowledgeBaseId: "kb-graph-change",
      publicId: "file-change"
    });
    await catalog.moveSourceFile({
      knowledgeBaseId: "kb-graph-change",
      publicId: "file-change",
      directoryPublicId: "directory-change-new",
      logicalPath: "New/Move.md",
      revisionCheck: { expectedRevision: sourceBeforeMove!.revision }
    });
    const moved = await graph.updateSourceFileGraphPath({
      knowledgeBaseId: "kb-graph-change",
      sourceFilePublicId: "file-change",
      sourceRevisionPublicId: "revision-change-a"
    });
    expect(moved).toMatchObject({
      publicId: original.publicId,
      logicalPath: "pages/New/Move.md",
      revision: original.revision + 1,
      evidence: [{ logicalPath: "pages/New/Move.md" }]
    });

    const sourceBeforeReplace = await catalog.getSourceFile({
      knowledgeBaseId: "kb-graph-change",
      publicId: "file-change"
    });
    await createReplacementRevision({
      knowledgeBaseId: "kb-graph-change",
      sourceFilePublicId: "file-change",
      sourceRevisionPublicId: "revision-change-b",
      checksum: "e".repeat(64),
      expectedSourceRevision: sourceBeforeReplace!.revision
    });
    await expect(graph.getNode({
      knowledgeBaseId: "kb-graph-change",
      publicId: original.publicId
    })).resolves.toBeNull();
    const replacement = nodeFact({
      knowledgeBaseId: "kb-graph-change",
      sourceFilePublicId: "file-change",
      sourceRevisionPublicId: "revision-change-b",
      logicalPath: "pages/New/Move.md",
      checksum: "e".repeat(64),
      label: "Move revised"
    });
    replacement.publicId = original.publicId;
    replacement.revision = moved!.revision + 1;
    await graph.replaceSourceFileGraph({
      knowledgeBaseId: "kb-graph-change",
      sourceFilePublicId: "file-change",
      sourceRevisionPublicId: "revision-change-b",
      node: replacement,
      edges: []
    });
    await expect(graph.getNode({
      knowledgeBaseId: "kb-graph-change",
      publicId: original.publicId
    })).resolves.toEqual(replacement);
    const evidenceRows = await sql<Array<{
      source_revision_public_id: string;
      logical_path: string;
    }>>`
      SELECT source_revision_public_id, logical_path
      FROM focowiki.graph_evidence_refs
      WHERE knowledge_base_id = 'kb-graph-change'
    `;
    expect(evidenceRows).toEqual([{
      source_revision_public_id: "revision-change-b",
      logical_path: "pages/New/Move.md"
    }]);
  });

  it("deletes file, directory-batch, and knowledge-base graph scopes symmetrically", async () => {
    await createKnowledgeBase("kb-graph-delete");
    for (const item of [
      { file: "file-delete-a", revision: "revision-delete-a", path: "Delete/A.md", checksum: "f".repeat(64) },
      { file: "file-delete-b", revision: "revision-delete-b", path: "Delete/B.md", checksum: "1".repeat(64) },
      { file: "file-delete-c", revision: "revision-delete-c", path: "Keep/C.md", checksum: "2".repeat(64) }
    ]) {
      await createCurrentSource({
        knowledgeBaseId: "kb-graph-delete",
        sourceFilePublicId: item.file,
        sourceRevisionPublicId: item.revision,
        logicalPath: item.path,
        checksum: item.checksum
      });
    }
    const nodes = [
      nodeFact({
        knowledgeBaseId: "kb-graph-delete",
        sourceFilePublicId: "file-delete-a",
        sourceRevisionPublicId: "revision-delete-a",
        logicalPath: "pages/Delete/A.md",
        checksum: "f".repeat(64),
        label: "A"
      }),
      nodeFact({
        knowledgeBaseId: "kb-graph-delete",
        sourceFilePublicId: "file-delete-b",
        sourceRevisionPublicId: "revision-delete-b",
        logicalPath: "pages/Delete/B.md",
        checksum: "1".repeat(64),
        label: "B"
      }),
      nodeFact({
        knowledgeBaseId: "kb-graph-delete",
        sourceFilePublicId: "file-delete-c",
        sourceRevisionPublicId: "revision-delete-c",
        logicalPath: "pages/Keep/C.md",
        checksum: "2".repeat(64),
        label: "C"
      })
    ];
    for (const current of nodes) {
      await graph.replaceSourceFileGraph({
        knowledgeBaseId: "kb-graph-delete",
        sourceFilePublicId: current.sourceFilePublicId,
        sourceRevisionPublicId: current.sourceRevisionPublicId,
        node: current,
        edges: []
      });
    }
    const edge = edgeFact(nodes[0]!, nodes[2]!);
    await graph.replaceSourceFileGraph({
      knowledgeBaseId: "kb-graph-delete",
      sourceFilePublicId: nodes[0]!.sourceFilePublicId,
      sourceRevisionPublicId: nodes[0]!.sourceRevisionPublicId,
      node: nodes[0]!,
      edges: [edge]
    });

    const closure = await graph.deleteSourceFileGraphs({
      knowledgeBaseId: "kb-graph-delete",
      sourceFilePublicIds: ["file-delete-a", "file-delete-b"]
    });
    expect(closure).toEqual({
      nodePublicIds: [nodes[0]!.publicId, nodes[1]!.publicId],
      edgePublicIds: [edge.publicId],
      affectedSourceFilePublicIds: ["file-delete-a", "file-delete-c"],
      logicalPaths: ["pages/Delete/A.md", "pages/Delete/B.md"]
    });
    await expect(graph.getEdge({
      knowledgeBaseId: "kb-graph-delete",
      publicId: edge.publicId
    })).resolves.toBeNull();
    await expect(graph.getNode({
      knowledgeBaseId: "kb-graph-delete",
      publicId: nodes[2]!.publicId
    })).resolves.toEqual(nodes[2]);

    await expect(graph.deleteKnowledgeBaseGraph({
      knowledgeBaseId: "kb-graph-delete"
    })).resolves.toEqual({ nodeCount: 1, edgeCount: 0, evidenceCount: 1 });
    const remaining = await sql<Array<{ count: number | string }>>`
      SELECT
        (SELECT count(*) FROM focowiki.graph_nodes
          WHERE knowledge_base_id = 'kb-graph-delete')
        + (SELECT count(*) FROM focowiki.graph_edges
          WHERE knowledge_base_id = 'kb-graph-delete')
        + (SELECT count(*) FROM focowiki.graph_evidence_refs
          WHERE knowledge_base_id = 'kb-graph-delete') AS count
    `;
    expect(Number(remaining[0]?.count)).toBe(0);
  });

  it("bounds large-degree pagination, cycles, duplicates, missing evidence, and Markdown hydration", async () => {
    await createKnowledgeBase("kb-graph-scale");
    const rootChecksum = createHash("sha256").update("root").digest("hex");
    await createCurrentSource({
      knowledgeBaseId: "kb-graph-scale",
      sourceFilePublicId: "file-scale-root",
      sourceRevisionPublicId: "revision-scale-root",
      logicalPath: "Root.md",
      checksum: rootChecksum
    });
    const root = nodeFact({
      knowledgeBaseId: "kb-graph-scale",
      sourceFilePublicId: "file-scale-root",
      sourceRevisionPublicId: "revision-scale-root",
      logicalPath: "pages/Root.md",
      checksum: rootChecksum,
      label: "Root"
    });
    const targets: StorageVnextGraphNodeFact[] = [];
    for (let index = 0; index < 70; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const checksum = createHash("sha256").update(`target-${suffix}`).digest("hex");
      await createCurrentSource({
        knowledgeBaseId: "kb-graph-scale",
        sourceFilePublicId: `file-scale-${suffix}`,
        sourceRevisionPublicId: `revision-scale-${suffix}`,
        logicalPath: `Targets/Target-${suffix}.md`,
        checksum
      });
      const target = nodeFact({
        knowledgeBaseId: "kb-graph-scale",
        sourceFilePublicId: `file-scale-${suffix}`,
        sourceRevisionPublicId: `revision-scale-${suffix}`,
        logicalPath: `pages/Targets/Target-${suffix}.md`,
        checksum,
        label: `Target ${suffix}`
      });
      targets.push(target);
      await graph.replaceSourceFileGraph({
        knowledgeBaseId: "kb-graph-scale",
        sourceFilePublicId: target.sourceFilePublicId,
        sourceRevisionPublicId: target.sourceRevisionPublicId,
        node: target,
        edges: []
      });
    }
    const edges = targets.map((target, index): StorageVnextGraphEdgeFact => ({
      publicId: `graph-edge-scale-${String(index).padStart(3, "0")}`,
      knowledgeBaseId: "kb-graph-scale",
      fromNodePublicId: root.publicId,
      toNodePublicId: target.publicId,
      relation: "related",
      weight: 0.8,
      reason: null,
      evidence: [],
      revision: 1
    }));
    await graph.replaceSourceFileGraph({
      knowledgeBaseId: "kb-graph-scale",
      sourceFilePublicId: root.sourceFilePublicId,
      sourceRevisionPublicId: root.sourceRevisionPublicId,
      node: root,
      edges
    });
    await expect(graph.replaceSourceFileGraph({
      knowledgeBaseId: "kb-graph-scale",
      sourceFilePublicId: root.sourceFilePublicId,
      sourceRevisionPublicId: root.sourceRevisionPublicId,
      node: root,
      edges: [edges[0]!, { ...edges[0]!, publicId: "graph-edge-scale-duplicate" }]
    })).rejects.toMatchObject({ code: "duplicate_graph_fact" });

    const cycleForward: StorageVnextGraphEdgeFact = {
      publicId: "graph-edge-cycle-forward",
      knowledgeBaseId: "kb-graph-scale",
      fromNodePublicId: targets[0]!.publicId,
      toNodePublicId: targets[1]!.publicId,
      relation: "continues",
      weight: 1,
      reason: "Target 000 continues to Target 001.",
      evidence: [],
      revision: 1
    };
    const cycleBack: StorageVnextGraphEdgeFact = {
      publicId: "graph-edge-cycle-back",
      knowledgeBaseId: "kb-graph-scale",
      fromNodePublicId: targets[1]!.publicId,
      toNodePublicId: root.publicId,
      relation: "returns",
      weight: 1,
      reason: "Target 001 returns to Root.",
      evidence: [],
      revision: 1
    };
    await graph.replaceSourceFileGraph({
      knowledgeBaseId: "kb-graph-scale",
      sourceFilePublicId: targets[0]!.sourceFilePublicId,
      sourceRevisionPublicId: targets[0]!.sourceRevisionPublicId,
      node: targets[0]!,
      edges: [cycleForward]
    });
    await graph.replaceSourceFileGraph({
      knowledgeBaseId: "kb-graph-scale",
      sourceFilePublicId: targets[1]!.sourceFilePublicId,
      sourceRevisionPublicId: targets[1]!.sourceRevisionPublicId,
      node: targets[1]!,
      edges: [cycleBack]
    });

    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await graph.listNeighborhood({
        knowledgeBaseId: "kb-graph-scale",
        nodePublicId: root.publicId,
        depth: 1,
        limit: 25,
        cursor
      });
      collected.push(...page.items.map((item) => item.publicId));
      if (!cursor) {
        await expect(graph.listNeighborhood({
          knowledgeBaseId: "kb-other",
          nodePublicId: root.publicId,
          depth: 1,
          limit: 25,
          cursor: page.nextCursor
        })).rejects.toMatchObject({ code: "invalid_cursor" });
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(collected)).toHaveLength(71);
    expect(collected).toHaveLength(71);

    const cycle = await graph.listNeighborhood({
      knowledgeBaseId: "kb-graph-scale",
      nodePublicId: root.publicId,
      depth: 2,
      limit: 200,
      cursor: null
    });
    expect(cycle.items.map((item) => item.publicId)).toEqual(
      expect.arrayContaining([
        cycleBack.publicId,
        cycleForward.publicId,
        edges[0]!.publicId
      ])
    );

    const document = mapStorageVnextGraphSeedDocument(targets[0]!);
    const hydrated = await hydrateStorageVnextGraphSeedHits({
      knowledgeBaseId: "kb-graph-scale",
      hits: [{ document, score: 0.95 }],
      limit: 10,
      loadCurrentFiles: async (sourceFilePublicIds, limit) => [
        ...await catalog.listSourceFilesByPublicIds({
          knowledgeBaseId: "kb-graph-scale",
          publicIds: sourceFilePublicIds,
          limit
        })
      ]
    });
    expect(hydrated).toEqual([{
      publicId: document.publicId,
      sourceFilePublicId: targets[0]!.sourceFilePublicId,
      sourceRevisionPublicId: targets[0]!.sourceRevisionPublicId,
      logicalPath: "pages/Targets/Target-000.md",
      title: "Target 000",
      score: 0.95
    }]);
  });

  it("rejects unbounded evidence, stale revisions, wrong paths, and cross-scope facts", async () => {
    await createKnowledgeBase("kb-graph-invalid");
    await createKnowledgeBase("kb-graph-other");
    await createCurrentSource({
      knowledgeBaseId: "kb-graph-invalid",
      sourceFilePublicId: "file-invalid",
      sourceRevisionPublicId: "revision-invalid",
      logicalPath: "Folder/Invalid.md",
      checksum: "c".repeat(64)
    });
    const node = nodeFact({
      knowledgeBaseId: "kb-graph-invalid",
      sourceFilePublicId: "file-invalid",
      sourceRevisionPublicId: "revision-invalid",
      logicalPath: "pages/Folder/Invalid.md",
      checksum: "c".repeat(64),
      label: "Invalid"
    });

    await expect(graph.replaceSourceFileGraph({
      knowledgeBaseId: "kb-graph-invalid",
      sourceFilePublicId: "file-invalid",
      sourceRevisionPublicId: "revision-invalid",
      node: {
        ...node,
        evidence: Array.from({ length: 17 }, (_, index) => ({
          ...node.evidence[0]!,
          publicId: `evidence-unbounded-${index}`,
          startOffset: index,
          endOffset: index + 1
        }))
      },
      edges: []
    })).rejects.toMatchObject({ code: "evidence_limit_exceeded" });
    await expect(graph.replaceSourceFileGraph({
      knowledgeBaseId: "kb-graph-invalid",
      sourceFilePublicId: "file-invalid",
      sourceRevisionPublicId: "revision-stale",
      node: { ...node, sourceRevisionPublicId: "revision-stale" },
      edges: []
    })).rejects.toMatchObject({ code: "stale_source_revision" });
    await expect(graph.replaceSourceFileGraph({
      knowledgeBaseId: "kb-graph-invalid",
      sourceFilePublicId: "file-invalid",
      sourceRevisionPublicId: "revision-invalid",
      node: {
        ...node,
        logicalPath: "pages/Wrong/Invalid.md",
        evidence: node.evidence.map((item) => ({
          ...item,
          logicalPath: "pages/Wrong/Invalid.md"
        }))
      },
      edges: []
    })).rejects.toMatchObject({ code: "markdown_path_mismatch" });
    await expect(graph.replaceSourceFileGraph({
      knowledgeBaseId: "kb-graph-other",
      sourceFilePublicId: "file-invalid",
      sourceRevisionPublicId: "revision-invalid",
      node: { ...node, knowledgeBaseId: "kb-graph-other" },
      edges: []
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof StorageVnextGraphRepositoryError
      && error.code === "scope_conflict"
    );
    await expect(graph.getNode({
      knowledgeBaseId: "kb-graph-invalid",
      publicId: node.publicId
    })).resolves.toBeNull();
  });

  async function createKnowledgeBase(knowledgeBaseId: string): Promise<void> {
    await catalog.createKnowledgeBase({
      publicId: knowledgeBaseId,
      name: knowledgeBaseId,
      description: null
    });
  }

  async function createCurrentSource(input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    logicalPath: string;
    checksum: string;
  }): Promise<void> {
    const directoryPath = input.logicalPath.split("/").slice(0, -1).join("/");
    const directoryPublicId = directoryPath
      ? `directory-${createHash("sha256")
          .update(`${input.knowledgeBaseId}\u0000${directoryPath}`)
          .digest("hex")
          .slice(0, 24)}`
      : null;
    if (directoryPublicId) {
      const directory = await catalog.getDirectory({
        knowledgeBaseId: input.knowledgeBaseId,
        publicId: directoryPublicId
      });
      if (!directory) {
        await catalog.createDirectory({
          publicId: directoryPublicId,
          knowledgeBaseId: input.knowledgeBaseId,
          parentPublicId: null,
          logicalPath: directoryPath,
          title: directoryPath
        });
      }
    }
    const source = await catalog.createSourceFile({
      publicId: input.sourceFilePublicId,
      knowledgeBaseId: input.knowledgeBaseId,
      directoryPublicId,
      logicalPath: input.logicalPath,
      title: input.logicalPath.split("/").at(-1)!,
      metadata: {},
      status: "ready"
    });
    const objectId = `object-${input.sourceRevisionPublicId}`;
    await sql`
      INSERT INTO focowiki.object_registrations
        (object_id, storage_key, checksum_sha256, byte_count, content_type,
         object_format, state, write_attempt_public_id, verified_at)
      VALUES (${objectId}, ${`owned/source/${objectId}`}, ${input.checksum},
        512, 'text/markdown; charset=utf-8', 'source-markdown-v1',
        'verified', ${`write-${objectId}`}, now())
    `;
    await catalog.createImmutableRevision({
      publicId: input.sourceRevisionPublicId,
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFilePublicId: input.sourceFilePublicId,
      objectId,
      checksum: input.checksum,
      byteCount: 512,
      contentType: "text/markdown; charset=utf-8",
      createdAt: "2026-08-01T00:00:00.000Z"
    });
    await catalog.compareAndSetCurrentRevision({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFilePublicId: input.sourceFilePublicId,
      revisionPublicId: input.sourceRevisionPublicId,
      revisionCheck: { expectedRevision: source.revision }
    });
  }

  async function createReplacementRevision(input: {
    knowledgeBaseId: string;
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    checksum: string;
    expectedSourceRevision: number;
  }): Promise<void> {
    const objectId = `object-${input.sourceRevisionPublicId}`;
    await sql`
      INSERT INTO focowiki.object_registrations
        (object_id, storage_key, checksum_sha256, byte_count, content_type,
         object_format, state, write_attempt_public_id, verified_at)
      VALUES (${objectId}, ${`owned/source/${objectId}`}, ${input.checksum},
        512, 'text/markdown; charset=utf-8', 'source-markdown-v1',
        'verified', ${`write-${objectId}`}, now())
    `;
    await catalog.createImmutableRevision({
      publicId: input.sourceRevisionPublicId,
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFilePublicId: input.sourceFilePublicId,
      objectId,
      checksum: input.checksum,
      byteCount: 512,
      contentType: "text/markdown; charset=utf-8",
      createdAt: "2026-08-01T01:00:00.000Z"
    });
    await catalog.compareAndSetCurrentRevision({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFilePublicId: input.sourceFilePublicId,
      revisionPublicId: input.sourceRevisionPublicId,
      revisionCheck: { expectedRevision: input.expectedSourceRevision }
    });
  }
});

function nodeFact(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  checksum: string;
  label: string;
}): StorageVnextGraphNodeFact {
  return {
    publicId: `graph-node-${input.sourceFilePublicId}`,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    logicalPath: input.logicalPath,
    label: input.label,
    kind: "page",
    metadata: { language: "en" },
    evidence: [evidenceFact({
      publicId: `evidence-node-${input.sourceFilePublicId}`,
      sourceFilePublicId: input.sourceFilePublicId,
      sourceRevisionPublicId: input.sourceRevisionPublicId,
      logicalPath: input.logicalPath,
      startOffset: 0,
      endOffset: 24,
      checksum: input.checksum
    })],
    revision: 1
  };
}

function edgeFact(
  source: StorageVnextGraphNodeFact,
  target: StorageVnextGraphNodeFact
): StorageVnextGraphEdgeFact {
  return {
    publicId: `graph-edge-${source.sourceFilePublicId}-${target.sourceFilePublicId}`,
    knowledgeBaseId: source.knowledgeBaseId,
    fromNodePublicId: source.publicId,
    toNodePublicId: target.publicId,
    relation: "references",
    weight: 0.9,
    reason: "The source Markdown directly references the related file.",
    source: "deterministic",
    metadata: {},
    evidence: [evidenceFact({
      publicId: `evidence-edge-${source.sourceFilePublicId}-${target.sourceFilePublicId}`,
      sourceFilePublicId: source.sourceFilePublicId,
      sourceRevisionPublicId: source.sourceRevisionPublicId,
      logicalPath: source.logicalPath,
      startOffset: 25,
      endOffset: 56,
      checksum: source.evidence[0]!.checksum
    })],
    revision: 1
  };
}

function evidenceFact(input: StorageVnextGraphEvidence): StorageVnextGraphEvidence {
  return input;
}

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
