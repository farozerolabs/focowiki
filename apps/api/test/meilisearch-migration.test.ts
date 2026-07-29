import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  import.meta.dirname,
  "../migrations/018_meilisearch_search_projection.sql"
);
const maintenanceRepositoryPath = resolve(
  import.meta.dirname,
  "../src/infrastructure/postgres/knowledge-base-index-maintenance-repository.ts"
);

describe("Meilisearch search projection migration", () => {
  it("adds compatible search state and durable work", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain("CREATE TABLE focowiki.knowledge_base_search_states");
    expect(migration).toContain("CREATE TABLE focowiki.search_projection_work");
    expect(migration).toContain("active_epoch");
    expect(migration).toContain("pending_epoch");
    expect(migration).toContain("pending_activation_state");
    expect(migration).toContain("pending_full_rebuild");
    expect(migration).toContain("settings_checksum");
    expect(migration).toContain("task_uid");
    expect(migration).toContain("lease_expires_at");
    expect(migration).toContain("checkpoint_json");
    expect(migration).toContain("safe_error_code");
    expect(migration).toContain("search_projection_work_claim_idx");
    expect(migration).toContain(
      "knowledge_base_id, generation_id,\n    epoch"
    );
    expect(migration).not.toContain(
      "REFERENCES focowiki.publication_generations(id) ON DELETE SET NULL"
    );
  });

  it("keeps released knowledge bases on compatibility search until maintenance cutover", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const maintenanceRepository = readFileSync(maintenanceRepositoryPath, "utf8");

    expect(migration).toContain("'postgres_compatibility'");
    expect(migration).toContain("maintenance_required");
    expect(migration).toContain("INSERT INTO focowiki.knowledge_base_search_states");
    expect(migration).toContain("ON CONFLICT (knowledge_base_id) DO NOTHING");
    expect(migration).toContain(
      "UPDATE focowiki.runtime_generation\nSET generation = 'meilisearch-search-projection-v18'"
    );
    expect(migration).not.toContain("DROP TABLE focowiki.search_projection_documents");
    expect(maintenanceRepository).toContain(
      "search_state.maintenance_required"
    );
  });
});
