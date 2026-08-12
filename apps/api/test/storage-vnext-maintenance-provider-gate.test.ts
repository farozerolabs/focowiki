import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../src/db/client.js";
import { createPostgresStorageVnextMaintenanceRepository } from
  "../src/storage-vnext/maintenance/postgres-repository.js";
import { createStorageVnextMaintenanceRequestService } from
  "../src/storage-vnext/maintenance/maintenance-coordinator.js";

describe("storage vNext maintenance provider gate", () => {
  it("reports maintenance required when the active semantic contract differs from the adoption target", async () => {
    const sql = sqlFixture((source) => {
      if (source.includes("operation_work_items AS work")) return [];
      if (source.includes("root.navigation_profile_version")) {
        return [{
          navigation_profile_version: 1,
          provider_kind: "opensearch",
          semantic_maintenance_required: true
        }];
      }
      if (source.includes("operation_results AS result")) return [];
      return [];
    });
    const repository = createPostgresStorageVnextMaintenanceRepository(
      sql as unknown as DatabaseClient,
      { selectedSearchProviderKind: "opensearch" }
    );

    await expect(repository.getStatus({ knowledgeBaseId: "kb-semantic-gate" }))
      .resolves.toMatchObject({
        state: "idle",
        maintenanceRequired: true
      });
  });

  it("compares vector-producing and query-policy revisions independently", async () => {
    const sources: string[] = [];
    const sql = sqlFixture((source) => {
      sources.push(source);
      return [];
    });
    const repository = createPostgresStorageVnextMaintenanceRepository(
      sql as unknown as DatabaseClient,
      { selectedSearchProviderKind: "opensearch" }
    );

    await repository.getStatus({ knowledgeBaseId: "kb-embedding-revision-gate" });

    const source = sources.join("\n");
    expect(source).toMatch(
      /semantic_contract\.embedding_configuration_revision_public_id\s+IS DISTINCT FROM\s+active_embedding\.vector_producing_revision_public_id/u
    );
    expect(source).toMatch(
      /semantic_contract\.embedding_query_policy_revision_public_id\s+IS DISTINCT FROM active_embedding\.query_policy_revision_public_id/u
    );
    expect(source).toMatch(
      /semantic_contract\.minimum_vector_relevance\s+IS DISTINCT FROM active_embedding\.minimum_vector_relevance/u
    );
  });

  it("reports maintenance required when the active projection uses another provider", async () => {
    const sql = sqlFixture((source) => {
      if (source.includes("operation_work_items AS work")) return [];
      if (source.includes("root.navigation_profile_version")) {
        return [{ navigation_profile_version: 1, provider_kind: "meilisearch" }];
      }
      if (source.includes("operation_results AS result")) return [];
      return [];
    });
    const repository = createPostgresStorageVnextMaintenanceRepository(
      sql as unknown as DatabaseClient,
      { selectedSearchProviderKind: "opensearch" }
    );

    await expect(repository.getStatus({ knowledgeBaseId: "kb-provider-gate" }))
      .resolves.toMatchObject({
        state: "idle",
        maintenanceRequired: true
      });
  });

  it("binds maintenance claims to the selected provider", async () => {
    const sources: string[] = [];
    const sql = sqlFixture((source) => {
      sources.push(source);
      return [];
    });
    const repository = createPostgresStorageVnextMaintenanceRepository(
      sql as unknown as DatabaseClient,
      { selectedSearchProviderKind: "opensearch" }
    );

    await expect(repository.claimOne({
      workerId: "maintenance-worker-opensearch",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      searchProviderKind: "opensearch"
    })).resolves.toBeNull();

    expect(sources.join("\n")).toContain(
      "AND work.search_provider_kind ="
    );
  });

  it("persists manual provider adoption and rejects automatic adoption", async () => {
    const acceptMaintenance = vi.fn(async () => ({
      outcome: "queued" as const,
      operationPublicId: "maintenance-provider-adoption",
      state: "queued" as const,
      reasonCode: null
    }));
    const service = createStorageVnextMaintenanceRequestService({
      repository: { acceptMaintenance } as never,
      searchProviderKind: "opensearch",
      activeSearchProjections: {
        async getActiveProjection() {
          return {
            publicId: "search-meilisearch-active",
            knowledgeBaseId: "kb-provider-adoption",
            providerKind: "meilisearch" as const,
            providerIndexUid: "focowiki_meilisearch_active",
            schemaChecksum: "a".repeat(64),
            settingsChecksum: "b".repeat(64),
            documentChecksum: "c".repeat(64),
            documentCount: 3
          };
        }
      }
    });
    const request = maintenanceRequest("manual");

    await expect(service.requestMaintenance(request)).resolves.toMatchObject({
      outcome: "queued"
    });
    expect(acceptMaintenance).toHaveBeenCalledWith(expect.objectContaining({
      searchProviderKind: "opensearch",
      initialCheckpoint: expect.objectContaining({
        maintenanceKind: "provider_adoption"
      })
    }));

    acceptMaintenance.mockClear();
    await expect(service.requestMaintenance({
      ...request,
      trigger: "automatic"
    })).resolves.toEqual({
      outcome: "deferred",
      operationPublicId: null,
      state: "deferred",
      reasonCode: "SEARCH_PROVIDER_ADOPTION_REQUIRES_MANUAL"
    });
    expect(acceptMaintenance).not.toHaveBeenCalled();
  });
});

function maintenanceRequest(trigger: "manual" | "automatic") {
  return {
    knowledgeBaseId: "kb-provider-adoption",
    operationPublicId: "maintenance-provider-adoption",
    trigger,
    idempotencyKey: "maintenance-provider-adoption",
    expectedResourceRevision: 1,
    settingsRevisionPublicId: "settings-provider-adoption",
    requestedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-08-02T00:00:00.000Z",
    maxAttempts: 3
  };
}

function sqlFixture(
  resolveRows: (source: string) => readonly Record<string, unknown>[]
) {
  const query = vi.fn(async (strings: TemplateStringsArray) =>
    resolveRows(strings.join(" "))
  );
  return Object.assign(query, {
    begin: vi.fn(async (callback: (transaction: typeof query) => unknown) =>
      callback(query)),
    json: (value: unknown) => value,
    unsafe: (value: string) => value
  });
}
