import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = resolve(import.meta.dirname, "../../..");

function read(path: string): string {
  return readFileSync(resolve(rootDir, path), "utf8");
}

describe("dedicated lexical rebuild runtime boundary", () => {
  it("packages a private lexical worker in every Compose template", () => {
    for (const path of [
      "docker-compose.yml.example",
      "docker-compose.dev.yml.example",
      "docker-compose.local.yml.example"
    ]) {
      const compose = read(path);
      expect(compose).toContain("lexical-rebuild-worker:");
      expect(compose).toContain("apps/api/runtime/lexical-rebuild-worker.mjs");
      expect(compose).toContain("--healthcheck");
    }
  });

  it("defines an additive durable work migration", () => {
    const migrationPath = resolve(
      rootDir,
      "apps/api/migrations/015_lexical_rebuild_worker.sql"
    );
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readFileSync(migrationPath, "utf8");
    const repository = read(
      "apps/api/src/infrastructure/postgres/lexical-rebuild-work-repository.ts"
    );
    expect(migration).toContain("CREATE TABLE focowiki.lexical_rebuild_work_items");
    expect(repository).toContain("FOR UPDATE OF item SKIP LOCKED");
    expect(migration).toContain("lexical_rebuild_work_items_claim_idx");
    expect(migration).toContain("lexical-rebuild-worker-v15");
  });

  it("keeps source-body execution out of the maintenance sweep", () => {
    const maintenance = read("apps/api/src/maintenance-worker-main.ts");
    const lexicalWorker = read("apps/api/src/lexical-rebuild-worker-main.ts");
    expect(maintenance).not.toContain("runLexicalRebuildSlice");
    expect(maintenance).not.toContain("getObjectText");
    expect(maintenance).toContain("bootstrapLexicalRebuildWork");
    expect(lexicalWorker).not.toContain("bootstrapLexicalRebuildWork");
  });

  it("keeps all lexical work controls in persisted Admin settings", () => {
    const types = read("apps/api/src/runtime-settings/types.ts");
    const validation = read("apps/api/src/runtime-settings/validation.ts");
    const env = `${read(".env.example")}\n${read(".env.dev.example")}`;
    for (const field of [
      "lexicalRebuildConcurrency",
      "lexicalRebuildSourceReadConcurrency",
      "lexicalRebuildDatabaseWriteConcurrency",
      "lexicalRebuildClaimBatchSize",
      "lexicalRebuildDatabaseBatchSize",
      "lexicalRebuildMaxInFlightSourceBytes"
    ]) {
      expect(types).toContain(field);
      expect(validation).toContain(field);
    }
    expect(env).not.toMatch(/LEXICAL_REBUILD_(CONCURRENCY|CLAIM|BATCH|SOURCE_READ)/);
  });
});
