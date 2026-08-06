import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const runtimePath = "apps/api/src/storage-vnext/source-processing/production-runtime.ts";

describe("storage vNext source worker production contract", () => {
  it("boots the source role through one storage-vNext production composition", () => {
    const main = read("apps/api/src/source-worker-main.ts");
    expect(main).toContain(
      'from "./storage-vnext/source-processing/production-runtime.js"'
    );
    expect(main).toContain("runStorageVnextSourceWorker");
    for (const legacy of [
      "createSourceFileQueueProcessor",
      "createPostgresPublicationGenerationRepository",
      "createPostgresRoleJobRepository",
      "createPostgresSearchProjectionRepository",
      "createPostgresSourceDispatchRepository",
      "createSourceRoleProcessor"
    ]) expect(main, legacy).not.toContain(legacy);
  });

  it("wires PostgreSQL facts, S3 source bodies, and the knowledge-base unified Meili index", () => {
    expect(existsSync(resolve(workspaceRoot, runtimePath)), runtimePath).toBe(true);
    if (!existsSync(resolve(workspaceRoot, runtimePath))) return;
    const runtime = read(runtimePath);
    for (const dependency of [
      "createPostgresStorageVnextWorkflowRepository",
      "createPostgresStorageVnextCatalogRepository",
      "createPostgresStorageVnextGraphRepository",
      "createPostgresStorageVnextReleaseRepository",
      "createS3StorageVnextSourceBodyStore",
      "createStorageVnextGraphCandidateSearch",
      "createStorageVnextSourceGraphExtractor",
      "createStorageVnextSourceModelAdapter",
      "createStorageVnextSourceReleaseHandoff",
      "createStorageVnextSourceProcessingWorker",
      "createStorageVnextSourceRoleRuntime"
    ]) expect(runtime, dependency).toContain(dependency);
    expect(runtime).toContain("createPostgresStorageVnextActiveSearchProjectionRepository");
    expect(runtime).toContain("createDynamicRuntimeMeilisearchSearchTransport");
    expect(runtime).not.toMatch(
      /PostgresSearchProjection|body-search-projection|graph-term-document|source_file_graph_term/u
    );
  });
});

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}
