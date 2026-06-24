import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

function countLines(path: string): number {
  return readWorkspaceFile(path).split("\n").length;
}

describe("lightweight architecture boundaries", () => {
  it("keeps production admin responsibilities out of single oversized files", () => {
    expect(countLines("apps/api/src/server.ts")).toBeLessThanOrEqual(150);
    expect(countLines("apps/api/src/admin/routes.ts")).toBeLessThanOrEqual(1_100);
    expect(countLines("apps/api/src/admin/source-file-upload.ts")).toBeLessThanOrEqual(300);
    expect(countLines("apps/api/src/admin/source-file-processor.ts")).toBeLessThanOrEqual(500);
    expect(countLines("apps/api/src/developer-openapi/routes.ts")).toBeLessThanOrEqual(350);
    expect(countLines("apps/api/src/okf/publication.ts")).toBeLessThanOrEqual(800);
    expect(countLines("apps/admin/src/pages/KnowledgeBaseDetailPage.tsx")).toBeLessThanOrEqual(
      700
    );
  });

  it("keeps API and Admin UI layers separated", () => {
    const apiServer = readWorkspaceFile("apps/api/src/server.ts");
    const sourceFileProcessor = readWorkspaceFile("apps/api/src/admin/source-file-processor.ts");
    const adminPage = readWorkspaceFile("apps/admin/src/pages/KnowledgeBaseDetailPage.tsx");

    expect(apiServer).not.toContain("apps/admin");
    expect(sourceFileProcessor).not.toContain("apps/admin");
    expect(adminPage).not.toContain("apps/api/src");
  });

  it("keeps Developer OpenAPI routes in their own route module", () => {
    const server = readWorkspaceFile("apps/api/src/server.ts");
    const developerRoutes = readWorkspaceFile("apps/api/src/developer-openapi/routes.ts");

    expect(server).toContain("registerDeveloperOpenApiRoutes");
    expect(server).not.toContain("serveScopedPublicFile");
    expect(developerRoutes).toContain("/openapi/v1/knowledge-bases");
    expect(developerRoutes).toContain("/openapi/v1/webhooks");
  });

  it("keeps Admin API routes in their own module without obsolete pre-release endpoints", () => {
    const server = readWorkspaceFile("apps/api/src/server.ts");
    const adminRoutes = readWorkspaceFile("apps/api/src/admin/routes.ts");
    const adminClient = readWorkspaceFile("apps/admin/src/lib/admin-api.ts");

    expect(server).toContain("registerAdminApiRoutes");
    expect(server).not.toContain("/admin/api/knowledge-bases");
    expect(adminRoutes).toContain("/admin/api/knowledge-bases/:knowledgeBaseId/uploads");
    expect(`${adminRoutes}\n${adminClient}`).not.toContain("/admin/api/uploads");
    expect(`${adminRoutes}\n${adminClient}`).not.toContain("/admin/api/generations");
    expect(`${adminRoutes}\n${adminClient}`).not.toContain("/admin/api/result");
    expect(`${adminRoutes}\n${adminClient}`).not.toContain("/admin/api/preview");
  });

  it("keeps OKF publication independent from full release file maps", () => {
    const publication = readWorkspaceFile("apps/api/src/okf/publication.ts");

    expect(publication).not.toContain("const bundleFiles: BundleFileDraft[]");
    expect(publication).not.toContain("buildBundleTreeEntries");
    expect(publication).toContain("flushTreeEntries");
  });

  it("keeps upload acceptance out of process-local source-file workers", () => {
    const adminRoutes = readWorkspaceFile("apps/api/src/admin/routes.ts");
    const developerRoutes = readWorkspaceFile("apps/api/src/developer-openapi/routes.ts");
    const developerServices = readWorkspaceFile("apps/api/src/developer-openapi/services.ts");

    expect(adminRoutes).not.toContain("createBoundedTaskRunner(config.upload.taskConcurrency)");
    expect(adminRoutes).not.toContain("adminTaskRunner.run");
    expect(adminRoutes).not.toContain("createSourceFileQueueProcessor");
    expect(developerRoutes).not.toContain("createBoundedTaskRunner");
    expect(developerRoutes).not.toContain("taskRunner.run");
    expect(developerServices).not.toContain("createSourceFileQueueProcessor");
    expect(developerServices).not.toContain("runTask:");
  });

  it("keeps durable worker queue state restartable and bounded", () => {
    const migration = readWorkspaceFile("apps/api/migrations/001_production_admin_web.sql");
    const repository = readWorkspaceFile("apps/api/src/db/worker-job-repository.ts");
    const runtime = readWorkspaceFile("apps/api/src/worker/runtime.ts");
    const workerMain = readWorkspaceFile("apps/api/src/worker-main.ts");
    const migrationSql = migration.toLowerCase();
    const repositorySource = repository.toLowerCase();

    expect(migrationSql).toContain("create table if not exists focowiki.worker_jobs");
    expect(migrationSql).toContain("create table if not exists focowiki.worker_heartbeats");
    expect(migration).toContain("'dead_letter'");
    expect(migration).toContain("worker_jobs_running_heartbeat_idx");
    expect(repositorySource).toContain("for update skip locked");
    expect(repository).toContain("heartbeatWorkerJob");
    expect(repository).toContain("deadLetterWorkerJob");
    expect(repository).toContain("cleanupWorkerJobs");
    expect(repository).toContain("getWorkerQueueSummary");
    expect(runtime).toContain("cleanupWorkerJobHistory");
    expect(runtime).toContain("recordWorkerHeartbeat");
    expect(workerMain).toContain("from focowiki.worker_jobs");
    expect(workerMain).toContain("from focowiki.worker_heartbeats");
  });

  it("keeps source-file completion from running publication inline", () => {
    const processor = readWorkspaceFile("apps/api/src/admin/source-file-processor.ts");
    const scheduler = readWorkspaceFile("apps/api/src/admin/publication-scheduler.ts");

    expect(processor).toContain("!repositories.workerJobs");
    expect(scheduler).toContain("workerJobs.enqueuePublicationJob");
    expect(scheduler).not.toContain("const result = await service.publishNow");
  });

  it("keeps source-file list reads out of graph, model, and worker expansion paths", () => {
    const adminRoutes = readWorkspaceFile("apps/api/src/admin/routes.ts");
    const repository = readWorkspaceFile("apps/api/src/db/admin-repositories.ts");
    const generatedOutput = readWorkspaceFile("apps/api/src/admin/source-file-generated-output.ts");
    const sourceListRoute = adminRoutes.slice(
      adminRoutes.indexOf('"/admin/api/knowledge-bases/:knowledgeBaseId/source-files"'),
      adminRoutes.indexOf('"/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId"')
    );
    const sourceListRepository = repository.slice(
      repository.indexOf("async listSourceFiles"),
      repository.indexOf("async listReleases")
    );

    expect(sourceListRoute).not.toContain("readAdminSourceFileWithGraphSummary");
    expect(sourceListRoute).not.toContain("repositories.graph");
    expect(sourceListRoute).not.toContain("enqueueSourceFileProcessingJobs");
    expect(sourceListRepository).not.toContain("LEFT JOIN LATERAL");
    expect(sourceListRepository).not.toContain("FROM focowiki.model_invocations");
    expect(generatedOutput).not.toContain("listGeneratedOutputsForSourceFiles");
  });

  it("keeps Developer OpenAPI file content reads out of source-file list scans", () => {
    const developerServices = readWorkspaceFile("apps/api/src/developer-openapi/services.ts");
    const contentReadBlock = developerServices.slice(
      developerServices.indexOf("async function readSourceForBundle"),
      developerServices.indexOf("async function readGeneratedObjectText")
    );

    expect(developerServices).not.toContain("async function findSourceFileById");
    expect(contentReadBlock).not.toContain("listSourceFiles");
  });

  it("keeps Admin file tree and preview reads out of worker and publication paths", () => {
    const fileTreeRoutes = readWorkspaceFile("apps/api/src/admin/file-tree-routes.ts");
    const adminRoutes = readWorkspaceFile("apps/api/src/admin/routes.ts");
    const previewRoute = adminRoutes.slice(
      adminRoutes.indexOf('"/admin/api/knowledge-bases/:knowledgeBaseId/files/detail"'),
      adminRoutes.indexOf('app.delete(\n    "/admin/api/knowledge-bases/:knowledgeBaseId/files/detail"')
    );

    expect(fileTreeRoutes).not.toContain("workerJobs");
    expect(fileTreeRoutes).not.toContain("enqueue");
    expect(fileTreeRoutes).not.toContain("publish");
    expect(fileTreeRoutes).not.toContain("listSourceFiles");
    expect(previewRoute).not.toContain("workerJobs");
    expect(previewRoute).not.toContain("listSourceFiles");
    expect(previewRoute).not.toContain("publish");
  });

  it("keeps Developer OpenAPI tree and content reads out of worker and publication paths", () => {
    const developerServices = readWorkspaceFile("apps/api/src/developer-openapi/services.ts");
    const treeBlock = developerServices.slice(
      developerServices.indexOf("async listTree"),
      developerServices.indexOf("async getFileById")
    );
    const contentByPathBlock = developerServices.slice(
      developerServices.indexOf("async getFileContentByPath"),
      developerServices.indexOf("async deleteFileById")
    );

    expect(treeBlock).not.toContain("workerJobs");
    expect(treeBlock).not.toContain("enqueue");
    expect(treeBlock).not.toContain("publish");
    expect(treeBlock).not.toContain("listSourceFiles");
    expect(contentByPathBlock).not.toContain("workerJobs");
    expect(contentByPathBlock).not.toContain("enqueue");
    expect(contentByPathBlock).not.toContain("publish");
    expect(contentByPathBlock).not.toContain("listSourceFiles");
  });

  it("keeps Admin polling page-scoped and visibility-aware", () => {
    const detailPage = readWorkspaceFile("apps/admin/src/pages/KnowledgeBaseDetailPage.tsx");

    expect(detailPage).toContain("document.visibilityState");
    expect(detailPage).toContain("shouldScheduleSourceFileRefresh");
    expect(detailPage).not.toContain("window.setInterval");
  });
});
