import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

type Factory = (sql: unknown) => {
  findActivated(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
  }): Promise<{
    releaseRootPublicId: string;
    searchProjectionPublicId: string;
  } | null>;
  read(input: {
    knowledgeBaseId: string;
    targetKind: "source_file" | "source_directory" | "knowledge_base";
    targetPublicId: string;
    normalizedPath: string | null;
    maximumSources: number;
    maximumGraphEdges: number;
  }): Promise<{
    sourceFilePublicIds: readonly string[];
    sourceLogicalPaths: readonly string[];
    directoryLogicalPaths: readonly string[];
    graphSourceFilePublicIds: readonly string[];
    graphEdgePublicIds: readonly string[];
  }>;
};

let factory: Factory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/deletion/postgres-release-scope.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      createPostgresStorageVnextDeletionReleaseScope?: Factory;
    };
  factory = loaded.createPostgresStorageVnextDeletionReleaseScope;
});

describe("storage vNext deletion PostgreSQL release scope", () => {
  it("recovers an activated deletion release and its unified index", async () => {
    const sql = sqlFixture({
      release_root_public_id: "root-activated",
      search_projection_public_id: "search-activated"
    });

    await expect(createScope(sql).findActivated({
      knowledgeBaseId: "kb-scope",
      operationPublicId: "operation-scope"
    })).resolves.toEqual({
      releaseRootPublicId: "root-activated",
      searchProjectionPublicId: "search-activated"
    });
  });

  it("loads one deleted directory scope with bounded graph dependencies", async () => {
    const sql = sqlFixture(null, [
      { public_id: "source-a", logical_path: "Guides/A.md" },
      { public_id: "source-b", logical_path: "Guides/B.md" }
    ], [
      {
        public_id: "edge-a",
        from_source_file_public_id: "source-a",
        to_source_file_public_id: "source-related-a"
      },
      {
        public_id: "edge-b",
        from_source_file_public_id: "source-related-b",
        to_source_file_public_id: "source-b"
      }
    ]);

    await expect(createScope(sql).read({
      knowledgeBaseId: "kb-scope",
      targetKind: "source_directory",
      targetPublicId: "directory-guides",
      normalizedPath: "Guides",
      maximumSources: 10,
      maximumGraphEdges: 10
    })).resolves.toEqual({
      sourceFilePublicIds: ["source-a", "source-b"],
      sourceLogicalPaths: ["Guides/A.md", "Guides/B.md"],
      directoryLogicalPaths: ["Guides"],
      graphSourceFilePublicIds: [
        "source-a",
        "source-b",
        "source-related-a",
        "source-related-b"
      ],
      graphEdgePublicIds: ["edge-a", "edge-b"]
    });
  });
});

function createScope(sql: ReturnType<typeof sqlFixture>) {
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("Deletion release scope is unavailable");
  return factory(sql);
}

function sqlFixture(
  activated: Record<string, string> | null,
  sources: readonly Record<string, string>[] = [],
  edges: readonly Record<string, string>[] = []
) {
  return vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("active_snapshots")) return activated ? [activated] : [];
    if (query.includes("source_files")) return sources;
    if (query.includes("graph_edges")) return edges;
    throw new Error(`Unexpected query: ${query}`);
  });
}
