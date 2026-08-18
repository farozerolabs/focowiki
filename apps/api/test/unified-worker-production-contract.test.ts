import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("unified worker production contract", () => {
  it("builds one backend worker runtime", () => {
    const build = read("apps/api/scripts/build-runtime.mjs");
    expect(build).toContain('worker: "src/worker-main.ts"');
    expect(build).not.toMatch(/(?:source|publication|maintenance)-worker/u);
  });

  it.each([
    "docker-compose.yml.example",
    "docker-compose.local.yml.example",
    "docker-compose.dev.yml.example"
  ])("uses one worker service in %s", (path) => {
    const compose = read(path);
    expect(compose).toMatch(/^  worker:\s*$/mu);
    expect(compose).not.toMatch(/^  (?:source|publication|maintenance)-worker:\s*$/mu);
    expect(compose).not.toContain("FOCOWIKI_SOURCE_WORKER_IMAGE");
  });

  it("uses one worker database pool setting", () => {
    const config = read("apps/api/src/config.ts");
    expect(config).toContain("WORKER_DATABASE_POOL_MAX");
    expect(config).not.toMatch(/(?:SOURCE|PUBLICATION|MAINTENANCE)_WORKER_DATABASE_POOL_MAX/u);
    const client = read("apps/api/src/db/client.ts");
    expect(client).toContain('| "worker"');
    expect(client).not.toMatch(/(?:source|publication|maintenance)-worker/u);
    expect(config).toContain("DEFAULT_WORKER_DATABASE_POOL_MAX = 8");
    expect(read(".env.example")).toContain("WORKER_DATABASE_POOL_MAX=8");
    expect(read(".env.dev.example")).toContain("WORKER_DATABASE_POOL_MAX=8");
    for (const path of [
      "docker-compose.yml.example",
      "docker-compose.local.yml.example",
      "docker-compose.dev.yml.example"
    ]) expect(read(path)).toMatch(/\n    env_file:\n      - \.env\n/u);
  });

  it.each([
    "docker-compose.yml.example",
    "docker-compose.local.yml.example",
    "docker-compose.dev.yml.example"
  ])("keeps the unified worker inside an explicit memory limit in %s", (path) => {
    const compose = read(path);
    const worker = compose.slice(compose.indexOf("  worker:\n"));
    expect(worker).toMatch(/\n    mem_limit: \$\{WORKER_MEMORY_LIMIT/u);
  });

  it("wires real deletion, maintenance, cleanup, and retention work", () => {
    const runtime = read(
      "apps/api/src/document-indexing/infrastructure/production-runtime.ts"
    );
    const background = read(
      "apps/api/src/document-indexing/infrastructure/production-background-runtime.ts"
    );
    expect(runtime).toContain("createProductionBackgroundRuntime");
    expect(runtime).toContain("backgroundRuntime!.run");
    expect(background).toContain("createDocumentResourceDeletionWorker");
    expect(background).toContain("createStorageVnextMaintenanceCoordinator");
    expect(background).toContain("createDocumentMaintenancePhaseRunner");
    expect(background).toContain("createDocumentObsoleteArtifactCleanupWorker");
    expect(background).toContain("recoverStorageVnextStaleReservations");
    expect(background).toContain("createPostgresDocumentJobRetention");
    expect(background).not.toContain("recoverStaleLeases");
    expect(background).toContain("createStorageVnextUploadSessionMaintenance");
    expect(background).toContain("createDocumentRetention");
    expect(background).toContain("documentRetention.run");
    expect(background).not.toContain("convergeCompletedDocumentHistory");
    expect(background.indexOf("documentRetention.run")).toBeGreaterThan(
      background.indexOf("const obsoleteResult = await cleanup.run")
    );
  });

  it("emits safe lifecycle, queue, provider, activation, and cleanup metrics", () => {
    const runtime = read(
      "apps/api/src/document-indexing/infrastructure/production-runtime.ts"
    );
    const processor = read(
      "apps/api/src/document-indexing/infrastructure/production-document-fixed-processor.ts"
    );
    const background = read(
      "apps/api/src/document-indexing/infrastructure/production-background-runtime.ts"
    );
    expect(runtime).toContain("observability");
    expect(processor).toContain("input.observability?.work");
    expect(processor).toContain("onWorkEvent");
    expect(background).toContain("observability?.cleanup");
  });
});
