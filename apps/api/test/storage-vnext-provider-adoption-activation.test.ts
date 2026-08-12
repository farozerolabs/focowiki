import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

type Factory = (sql: unknown, input: {
  selectedProviderKind: "meilisearch" | "opensearch";
}) => {
  activate(input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    candidatePublicId: string;
    expectedResourceRevision: number;
    activatedAt: string;
    cleanupNotBefore: string;
  }): Promise<{
    outcome: "activated" | "stale" | "not_ready";
    retiredProviderKind: "meilisearch" | "opensearch" | null;
    retiredProviderIndexUid: string | null;
  }>;
};

let factory: Factory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/search/postgres-provider-adoption.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      createPostgresStorageVnextSearchProviderAdoption?: Factory;
    };
  factory = loaded.createPostgresStorageVnextSearchProviderAdoption;
});

describe("storage vNext provider adoption activation", () => {
  it("swaps only the active search projection and persists exact retired ownership", async () => {
    const sql = sqlFixture();
    const adoption = createAdoption(sql);

    await expect(adoption.activate({
      knowledgeBaseId: "kb-adoption",
      operationPublicId: "maintenance-adoption",
      candidatePublicId: "search-opensearch-candidate",
      expectedResourceRevision: 7,
      activatedAt: "2026-08-01T01:00:00.000Z",
      cleanupNotBefore: "2026-08-02T01:00:00.000Z"
    })).resolves.toEqual({
      outcome: "activated",
      retiredProviderKind: "meilisearch",
      retiredProviderIndexUid: "focowiki_meilisearch_active"
    });

    const source = sql.sources.join("\n");
    expect(source).toContain("UPDATE focowiki.active_snapshots");
    expect(source).toContain("INSERT INTO focowiki.cleanup_actions");
    expect(source).not.toContain("UPDATE focowiki.release_roots");
    expect(source).not.toContain("graph_nodes");
    expect(source).not.toContain("object_owners");
  });
});

function createAdoption(sql: ReturnType<typeof sqlFixture>) {
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("Provider adoption activation is unavailable");
  return factory(sql, { selectedProviderKind: "opensearch" });
}

function sqlFixture() {
  const sources: string[] = [];
  const query = vi.fn(async (strings: TemplateStringsArray) => {
    const source = strings.join(" ");
    sources.push(source);
    if (source.includes("FROM focowiki.knowledge_bases")) {
      return [{ revision: 7, deleted_at: null }];
    }
    if (source.includes("FROM focowiki.active_snapshots")) {
      return [{
        search_projection_public_id: "search-meilisearch-active",
        provider_kind: "meilisearch",
        provider_index_uid: "focowiki_meilisearch_active",
        document_count: "9"
      }];
    }
    if (source.includes("SELECT public_id, knowledge_base_id, projection_role")) {
      return [{
        public_id: "search-opensearch-candidate",
        knowledge_base_id: "kb-adoption",
        projection_role: "candidate",
        provider_kind: "opensearch",
        state: "ready"
      }];
    }
    if (source.includes("FROM focowiki.operations operation")) {
      return [{ operation_public_id: "maintenance-adoption" }];
    }
    if (source.includes("UPDATE focowiki.active_snapshots")) {
      return [{ knowledge_base_id: "kb-adoption" }];
    }
    if (source.includes("DELETE FROM focowiki.search_projections")) {
      return [{ public_id: "search-meilisearch-active" }];
    }
    if (source.includes("UPDATE focowiki.search_projections")) {
      return [{ public_id: "search-opensearch-candidate" }];
    }
    return [];
  });
  return Object.assign(query, {
    begin: vi.fn(async (callback: (transaction: typeof query) => unknown) =>
      callback(query)),
    json: (value: unknown) => value,
    sources
  });
}
