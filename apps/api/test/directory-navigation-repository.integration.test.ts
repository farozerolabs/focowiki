import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresDirectoryNavigationRepository } from "../src/infrastructure/postgres/directory-navigation-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("directory navigation repository integration", () => {
  const sql = postgres(databaseUrl!, { max: 4 });
  let nextLeaf = 0;
  const repository = createPostgresDirectoryNavigationRepository(sql, {
    createLeafId: () => `leaf-${++nextLeaf}`
  });
  const knowledgeBaseId = "kb-directory-navigation";
  const activeGenerationId = "generation-directory-active";
  const candidateGenerationId = "generation-directory-candidate";
  const limits = { maxEntries: 2, maxBytes: 4_096, mergeBelowEntries: 1 };

  beforeEach(async () => {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Directory navigation')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state, format_version
      ) VALUES
        (${activeGenerationId}, ${knowledgeBaseId}, NULL, 'active', 2),
        (${candidateGenerationId}, ${knowledgeBaseId}, ${activeGenerationId}, 'building', 2)
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${activeGenerationId}
      WHERE id = ${knowledgeBaseId}
    `;
    nextLeaf = 0;
  });

  afterAll(async () => {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql.end({ timeout: 5 });
  });

  it("splits one persistent leaf and keeps a bounded linked navigation chain", async () => {
    await apply("source-a", "a.md");
    await apply("source-b", "b.md");
    const result = await apply("source-c", "c.md");

    expect(result.changed).toBe(true);
    expect(result.touchedLeaves).toHaveLength(2);
    expect(result.summary).toMatchObject({ entryCount: 3, firstLeafId: "leaf-1" });
    const rows = await sql<Array<{
      id: string;
      previous_leaf_id: string | null;
      next_leaf_id: string | null;
      entry_count: number;
    }>>`
      SELECT id, previous_leaf_id, next_leaf_id, entry_count
      FROM focowiki.generation_directory_navigation_leaves
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND generation_id = ${candidateGenerationId}
        AND directory_path = 'pages'
      ORDER BY first_sort_key, id
    `;
    expect(rows).toEqual([
      { id: "leaf-1", previous_leaf_id: null, next_leaf_id: "leaf-2", entry_count: 1 },
      { id: "leaf-2", previous_leaf_id: "leaf-1", next_leaf_id: null, entry_count: 2 }
    ]);
  });

  it("moves and deletes entries while rematerializing idempotent retries", async () => {
    await apply("source-a", "a.md");
    await apply("source-b", "b.md");
    await apply("source-c", "c.md");

    const unchanged = await apply("source-c", "c.md");
    expect(unchanged.changed).toBe(true);
    expect(unchanged.touchedLeaves.map((leaf) => leaf.id)).toEqual(["leaf-1", "leaf-2"]);
    expect(unchanged.removedLeafIds).toEqual([]);

    const moved = await apply("source-a", "z.md");
    expect(moved.changed).toBe(true);
    expect(moved.summary.entryCount).toBe(3);

    const deleted = await repository.applyEntry({
      knowledgeBaseId,
      generationId: candidateGenerationId,
      directoryPath: "pages",
      entryId: "source-b",
      desiredEntry: null,
      limits
    });
    expect(deleted.changed).toBe(true);
    expect(deleted.summary.entryCount).toBe(2);
    const entries = await sql<Array<{ entry: { id: string; targetPath: string } }>>`
      SELECT jsonb_array_elements(entries_json) AS entry
      FROM focowiki.generation_directory_navigation_leaves
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND generation_id = ${candidateGenerationId}
        AND directory_path = 'pages'
      ORDER BY first_sort_key, id
    `;
    expect(entries.map((row) => row.entry)).toEqual([
      expect.objectContaining({ id: "source-c", targetPath: "pages/c.md" }),
      expect.objectContaining({ id: "source-a", targetPath: "pages/z.md" })
    ]);
  });

  it("returns the outer adjacent leaf when a middle split changes its link", async () => {
    await apply("source-a", "a.md");
    await apply("source-c", "c.md");
    await apply("source-e", "e.md");
    await apply("source-g", "g.md");
    await apply("source-b", "b.md");
    const result = await apply("source-aa", "aa.md");

    expect(result.touchedLeaves.map((leaf) => leaf.id)).toContain("leaf-3");
    const outer = result.touchedLeaves.find((leaf) => leaf.id === "leaf-3");
    expect(outer?.previousLeafId).toBe("leaf-4");
  });

  it("materializes one directory batch in one durable mutation result", async () => {
    const result = await repository.applyEntries({
      knowledgeBaseId,
      generationId: candidateGenerationId,
      directoryPath: "pages",
      entries: [
        entryMutation("source-a", "a.md"),
        entryMutation("source-b", "b.md"),
        entryMutation("source-c", "c.md")
      ],
      limits
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toMatchObject({ entryCount: 3, firstLeafId: "leaf-1" });
    expect(result.touchedLeaves).toHaveLength(2);
    const rows = await sql<Array<{ entry_count: number }>>`
      SELECT entry_count::int AS entry_count
      FROM focowiki.generation_directory_navigation_summaries
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND generation_id = ${candidateGenerationId}
        AND directory_path = 'pages'
    `;
    expect(rows).toEqual([{ entry_count: 3 }]);
  });

  it("isolates candidate navigation from the active generation", async () => {
    await apply("source-a", "a.md", activeGenerationId);
    await apply("source-b", "b.md", candidateGenerationId);

    await expect(repository.getSummary({
      knowledgeBaseId,
      generationId: activeGenerationId,
      directoryPath: "pages"
    })).resolves.toMatchObject({ entryCount: 1 });
    await expect(repository.getSummary({
      knowledgeBaseId,
      generationId: candidateGenerationId,
      directoryPath: "pages"
    })).resolves.toMatchObject({ entryCount: 2 });
  });

  it("deletes the only candidate leaf when its final entry is removed", async () => {
    await apply("source-only", "only.md");

    const deleted = await repository.applyEntry({
      knowledgeBaseId,
      generationId: candidateGenerationId,
      directoryPath: "pages",
      entryId: "source-only",
      desiredEntry: null,
      limits
    });

    expect(deleted.summary).toMatchObject({ entryCount: 0, firstLeafId: null });
    expect(deleted.touchedLeaves).toEqual([]);
    expect(deleted.removedLeafIds).toEqual(["leaf-1"]);
    const leaves = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM focowiki.generation_directory_navigation_leaves
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND generation_id = ${candidateGenerationId}
        AND directory_path = 'pages'
    `;
    expect(leaves).toEqual([{ count: 0 }]);
  });

  it("does not restore predecessor leaves after candidate navigation is initialized", async () => {
    await apply("source-a", "old.md", activeGenerationId);
    await apply("source-a", "new.md", candidateGenerationId);

    await repository.applyEntries({
      knowledgeBaseId,
      generationId: candidateGenerationId,
      directoryPath: "pages",
      entries: [],
      limits
    });

    const leaves = await sql<Array<{
      id: string;
      entries_json: Array<{ id: string; targetPath: string }>;
    }>>`
      SELECT id, entries_json
      FROM focowiki.generation_directory_navigation_leaves
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND generation_id = ${candidateGenerationId}
        AND directory_path = 'pages'
      ORDER BY id
    `;
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.entries_json).toEqual([
      expect.objectContaining({ id: "source-a", targetPath: "pages/new.md" })
    ]);
  });

  it("inherits the nearest navigation ancestor when the direct predecessor did not change the directory", async () => {
    const ancestorGenerationId = "generation-directory-ancestor";
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state, format_version
      ) VALUES (${ancestorGenerationId}, ${knowledgeBaseId}, NULL, 'superseded', 2)
    `;
    await sql`
      UPDATE focowiki.publication_generations
      SET predecessor_generation_id = ${ancestorGenerationId}
      WHERE id = ${activeGenerationId}
    `;
    for (const name of ["a.md", "b.md", "c.md", "d.md"]) {
      await apply(`source-${name[0]}`, name, ancestorGenerationId);
    }

    const result = await repository.applyEntry({
      knowledgeBaseId,
      generationId: candidateGenerationId,
      directoryPath: "pages",
      entryId: "source-a",
      desiredEntry: null,
      limits
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toMatchObject({ entryCount: 3 });
    const entries = await sql<Array<{ entry: { id: string } }>>`
      SELECT jsonb_array_elements(entries_json) AS entry
      FROM focowiki.generation_directory_navigation_leaves
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND generation_id = ${candidateGenerationId}
        AND directory_path = 'pages'
      ORDER BY first_sort_key, id
    `;
    expect(entries.map((row) => row.entry.id)).toEqual([
      "source-b",
      "source-c",
      "source-d"
    ]);
  });

  function apply(
    entryId: string,
    name: string,
    generationId = candidateGenerationId
  ) {
    return repository.applyEntry({
      knowledgeBaseId,
      generationId,
      directoryPath: "pages",
      entryId,
      desiredEntry: {
        id: entryId,
        sortKey: name.toLowerCase(),
        name,
        targetPath: `pages/${name}`,
        kind: "file"
      },
      limits
    });
  }

  function entryMutation(entryId: string, name: string) {
    return {
      entryId,
      desiredEntry: {
        id: entryId,
        sortKey: name.toLowerCase(),
        name,
        targetPath: `pages/${name}`,
        kind: "file" as const
      }
    };
  }
});
