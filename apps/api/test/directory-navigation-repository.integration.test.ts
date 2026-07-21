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
  const limits = { maxEntries: 2, maxBytes: 4_096, mergeBelowEntries: 1 };

  beforeEach(async () => {
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Directory navigation')
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
      FROM focowiki.directory_navigation_leaves
      WHERE knowledge_base_id = ${knowledgeBaseId} AND directory_path = 'pages'
      ORDER BY first_sort_key, id
    `;
    expect(rows).toEqual([
      { id: "leaf-1", previous_leaf_id: null, next_leaf_id: "leaf-2", entry_count: 1 },
      { id: "leaf-2", previous_leaf_id: "leaf-1", next_leaf_id: null, entry_count: 2 }
    ]);
  });

  it("moves and deletes entries with local mutations and idempotent no-ops", async () => {
    await apply("source-a", "a.md");
    await apply("source-b", "b.md");
    await apply("source-c", "c.md");

    const unchanged = await apply("source-c", "c.md");
    expect(unchanged).toMatchObject({ changed: false, touchedLeaves: [], removedLeafIds: [] });

    const moved = await apply("source-a", "z.md");
    expect(moved.changed).toBe(true);
    expect(moved.summary.entryCount).toBe(3);

    const deleted = await repository.applyEntry({
      knowledgeBaseId,
      directoryPath: "pages",
      entryId: "source-b",
      desiredEntry: null,
      limits
    });
    expect(deleted.changed).toBe(true);
    expect(deleted.summary.entryCount).toBe(2);
    const entries = await sql<Array<{ entry: { id: string; targetPath: string } }>>`
      SELECT jsonb_array_elements(entries_json) AS entry
      FROM focowiki.directory_navigation_leaves
      WHERE knowledge_base_id = ${knowledgeBaseId} AND directory_path = 'pages'
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
      FROM focowiki.directory_navigation_summaries
      WHERE knowledge_base_id = ${knowledgeBaseId} AND directory_path = 'pages'
    `;
    expect(rows).toEqual([{ entry_count: 3 }]);
  });

  function apply(entryId: string, name: string) {
    return repository.applyEntry({
      knowledgeBaseId,
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
