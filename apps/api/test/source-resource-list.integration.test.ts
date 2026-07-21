import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresSourceResourceRepository } from "../src/infrastructure/postgres/source-resource-repository.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const emptyFilters = {
  pathQuery: null,
  sourceFileIdPrefix: null,
  state: null,
  currentStage: null,
  generatedOutputStatus: null
} as const;

describeDatabase("source resource list integration", () => {
  const sql = postgres(databaseUrl!, { max: 2 });
  const repository = createPostgresSourceResourceRepository(sql);
  const knowledgeBaseId = "kb-source-resource-list-integration";

  beforeAll(async () => {
    await cleanup();
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Source resource list integration')
    `;
    await sql`
      INSERT INTO focowiki.source_directories (
        id, knowledge_base_id, parent_id, name, relative_path, path_key, depth
      ) VALUES
        ('source-directory-list-guides', ${knowledgeBaseId}, NULL, 'guides', 'guides', 'guides', 1),
        ('source-directory-list-notes', ${knowledgeBaseId}, NULL, 'notes', 'notes', 'notes', 1),
        ('source-directory-list-nested', ${knowledgeBaseId}, 'source-directory-list-guides',
         'nested', 'guides/nested', 'guides/nested', 2)
    `;
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, name, relative_path, path_key, directory_id,
          object_key, content_type, size_bytes, checksum_sha256, active_revision_id,
          processing_status, processing_stage, generated_output_status,
          terminal_failure_stage, terminal_failure_code,
          terminal_failure_message, terminal_failure_at, terminal_failure_retry_kind,
          terminal_failure_correlation_id
        ) VALUES
          ('source-file-list-a', ${knowledgeBaseId}, 'guide.md', 'guides/guide.md', 'guides/guide.md',
           'source-directory-list-guides', 'objects/list-a', 'text/markdown', 1, 'a',
           'source-revision-list-a', 'completed', 'generation_activation', 'visible',
           NULL, NULL, NULL, NULL, NULL, NULL),
          ('source-file-list-b', ${knowledgeBaseId}, '100%_guide.md', 'guides/100%_guide.md', 'guides/100%_guide.md',
           'source-directory-list-guides', 'objects/list-b', 'text/markdown', 1, 'b',
           'source-revision-list-b', 'failed', 'graph_generation', 'unavailable',
           'graph_generation', 'GRAPH_GENERATION_FAILED', 'Graph generation did not complete.',
           now(), 'source_processing', 'source-job-list-b'),
          ('source-file-list-c', ${knowledgeBaseId}, 'note.md', 'notes/note.md', 'notes/note.md',
           'source-directory-list-notes', 'objects/list-c', 'text/markdown', 1, 'c',
           'source-revision-list-c', 'queued', 'upload_storage', 'pending',
           NULL, NULL, NULL, NULL, NULL, NULL),
          ('source-file-list-d', ${knowledgeBaseId}, 'nested.md', 'guides/nested/nested.md',
           'guides/nested/nested.md', 'source-directory-list-nested', 'objects/list-d',
           'text/markdown', 1, 'd', 'source-revision-list-d', 'completed',
           'generation_activation', 'visible',
           NULL, NULL, NULL, NULL, NULL, NULL)
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256
        ) VALUES
          ('source-revision-list-a', ${knowledgeBaseId}, 'source-file-list-a', 1, 'objects/list-a', 'text/markdown', 1, 'a'),
          ('source-revision-list-b', ${knowledgeBaseId}, 'source-file-list-b', 1, 'objects/list-b', 'text/markdown', 1, 'b'),
          ('source-revision-list-c', ${knowledgeBaseId}, 'source-file-list-c', 1, 'objects/list-c', 'text/markdown', 1, 'c'),
          ('source-revision-list-d', ${knowledgeBaseId}, 'source-file-list-d', 1, 'objects/list-d', 'text/markdown', 1, 'd')
      `;
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
  });

  it("combines indexed path, identity, state, and directory filters", async () => {
    const page = await repository.listSourceFiles({
      knowledgeBaseId,
      directoryId: "source-directory-list-guides",
      filters: {
        ...emptyFilters,
        pathQuery: "guides/guide",
        sourceFileIdPrefix: "source-file-list-a",
        state: "visible",
        currentStage: "generation_activation",
        generatedOutputStatus: "visible"
      },
      limit: 10,
      cursor: null
    });

    expect(page.items).toEqual([
      expect.objectContaining({
        id: "source-file-list-a",
        name: "guide.md",
        relativePath: "guides/guide.md",
        generatedPath: "pages/guides/guide.md"
      })
    ]);
  });

  it("treats SQL wildcard characters as literal path query text", async () => {
    const page = await repository.listSourceFiles({
      knowledgeBaseId,
      directoryId: undefined,
      filters: { ...emptyFilters, pathQuery: "100%_guide" },
      limit: 10,
      cursor: null
    });

    expect(page.items.map((item) => item.id)).toEqual(["source-file-list-b"]);
  });

  it("uses a stable source ID cursor without loading the full collection", async () => {
    const first = await repository.listSourceFiles({
      knowledgeBaseId,
      directoryId: undefined,
      filters: emptyFilters,
      limit: 1,
      cursor: null
    });
    const second = await repository.listSourceFiles({
      knowledgeBaseId,
      directoryId: undefined,
      filters: emptyFilters,
      limit: 1,
      cursor: first.nextCursor
    });

    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe(first.items[0]?.id);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  });

  it("reads direct and descendant file counts from maintained statistics", async () => {
    const page = await repository.listDirectories({
      knowledgeBaseId,
      parentDirectoryId: null,
      limit: 10,
      cursor: null
    });

    expect(page.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "source-directory-list-guides",
        directFileCount: 2,
        descendantFileCount: 3
      }),
      expect.objectContaining({
        id: "source-directory-list-notes",
        directFileCount: 1,
        descendantFileCount: 1
      })
    ]));

    await sql`
      UPDATE focowiki.source_files
      SET directory_id = 'source-directory-list-notes',
          relative_path = 'notes/nested.md', path_key = 'notes/nested.md'
      WHERE id = 'source-file-list-d'
    `;
    await expect(repository.getDirectory({
      knowledgeBaseId,
      directoryId: "source-directory-list-guides"
    })).resolves.toMatchObject({ directFileCount: 2, descendantFileCount: 2 });
    await expect(repository.getDirectory({
      knowledgeBaseId,
      directoryId: "source-directory-list-notes"
    })).resolves.toMatchObject({ directFileCount: 2, descendantFileCount: 2 });

    await sql`DELETE FROM focowiki.source_files WHERE id = 'source-file-list-d'`;
    await expect(repository.getDirectory({
      knowledgeBaseId,
      directoryId: "source-directory-list-notes"
    })).resolves.toMatchObject({ directFileCount: 1, descendantFileCount: 1 });
  });

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM focowiki.source_files WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.source_directories WHERE knowledge_base_id = ${knowledgeBaseId}`;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});
