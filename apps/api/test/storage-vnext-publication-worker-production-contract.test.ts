import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const runtimePath = "apps/api/src/storage-vnext/publication/production-runtime.ts";

describe("storage vNext publication worker production contract", () => {
  it("boots the publication role through one storage-vNext production composition", () => {
    const main = read("apps/api/src/publication-worker-main.ts");
    expect(main).toContain(
      'from "./storage-vnext/publication/production-runtime.js"'
    );
    expect(main).toContain("runStorageVnextPublicationWorker");
    for (const legacy of [
      "createPostgresPublicationGenerationRepository",
      "createPostgresPublicationImpactRepository",
      "createPostgresProjectionRecordRepository",
      "createProjectionSegmentWriter",
      "createPublicationSubtaskRuntime",
      "createGenerationAssemblyProcessor",
      "createRoleWorkerRuntime"
    ]) expect(main, legacy).not.toContain(legacy);
  });

  it("wires one knowledge-base candidate across PostgreSQL, S3, graph, and the selected search provider", () => {
    expect(existsSync(resolve(workspaceRoot, runtimePath)), runtimePath).toBe(true);
    if (!existsSync(resolve(workspaceRoot, runtimePath))) return;
    const runtime = read(runtimePath);
    const pipeline = read(
      "apps/api/src/storage-vnext/publication/production-pipeline.ts"
    );
    const composition = `${runtime}\n${pipeline}`;
    for (const dependency of [
      "createPostgresStorageVnextWorkflowRepository",
      "createPostgresStorageVnextCatalogRepository",
      "createPostgresStorageVnextGraphRepository",
      "createPostgresStorageVnextReleaseRepository",
      "createPostgresStorageVnextOwnershipRepository",
      "createPostgresStorageVnextSearchProjectionRepository",
      "createS3StorageVnextSourceBodyStore",
      "createS3StorageVnextImmutableBodyStore",
      "createStorageVnextSearchCandidateLifecycle",
      "buildStorageVnextSearchCandidate",
      "createStorageVnextPublicationGraphReconciler",
      "createStorageVnextPublicationProjectionLoader",
      "createStorageVnextPublicationArtifactAssembler",
      "createStorageVnextPublicationCandidateValidator",
      "createStorageVnextPublicationProcessor",
      "createStorageVnextPublicationWorker",
      "createStorageVnextPublicationRoleRuntime"
    ]) expect(composition, dependency).toContain(dependency);
    expect(runtime).toContain('logger.error("publication_worker.item_failed"');
    expect(runtime).toContain("workflow.recoverStale({");
    expect(runtime).toContain('kinds: ["publication", "mutation"]');
    expect(runtime).toContain('reasonCode: "STALE_LEASE"');
    expect(composition).toContain("createStorageVnextGraphCandidateSearchForProjection");
    expect(composition).toContain("reconcileStorageVnextGraphFacts");
    expect(composition).toContain("buildPersistedGraphCandidateTerms");
    expect(runtime).toContain("nodejieba-tokenizer");
    expect(runtime).toContain("createNodeJiebaTokenizer");
    expect(runtime).not.toContain('searchConfig.provider === "opensearch"');
    expect(runtime).toContain("previousSearchProvider");
    expect(runtime).toContain("await closeSearchProvider(previousSearchProvider)");
    expect(runtime).toContain("await closeSearchProvider(searchProvider)");
    expect(pipeline).not.toContain("nodejieba-tokenizer");
    expect(composition).not.toMatch(
      /PublicationGeneration|ProjectionRecord|GenerationObjectReference|PublicationSubtask/u
    );
  });
});

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}
