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
});
