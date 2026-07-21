import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

function countLines(path: string): number {
  return readWorkspaceFile(path).split("\n").length;
}

function listTypeScriptFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

function relativeImports(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const imports = [
    ...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu),
    ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gmu)
  ];
  return imports
    .map((match) => match[1] ?? "")
    .filter((specifier) => specifier.startsWith("."));
}

function runtimeRelativeImports(path: string): string[] {
  const sourceText = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : "";
      const clause = statement.importClause;
      const namedImports = clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements
        : [];
      const typeOnly = Boolean(
        clause?.isTypeOnly ||
        (clause && !clause.name && namedImports.length > 0 && namedImports.every((item) => item.isTypeOnly))
      );
      if (specifier.startsWith(".") && !typeOnly) imports.push(specifier);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      const specifier = ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : "";
      const namedExports = statement.exportClause && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements
        : [];
      const typeOnly = Boolean(
        statement.isTypeOnly ||
        (namedExports.length > 0 && namedExports.every((item) => item.isTypeOnly))
      );
      if (specifier.startsWith(".") && !typeOnly) imports.push(specifier);
    }
  }
  return imports;
}

function resolveTypeScriptImport(importer: string, specifier: string): string | null {
  const candidate = resolve(dirname(importer), specifier.replace(/\.js$/u, ".ts"));
  if (existsSync(candidate)) return candidate;
  const indexCandidate = resolve(dirname(importer), specifier, "index.ts");
  return existsSync(indexCandidate) ? indexCandidate : null;
}

function dependencyCycles(files: string[]): string[][] {
  const fileSet = new Set(files);
  const graph = new Map(
    files.map((file) => [
      file,
      runtimeRelativeImports(file)
        .map((specifier) => resolveTypeScriptImport(file, specifier))
        .filter((dependency): dependency is string => Boolean(dependency && fileSet.has(dependency)))
    ])
  );
  const active = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (file: string) => {
    if (visited.has(file)) return;
    if (active.has(file)) {
      const start = stack.indexOf(file);
      cycles.push([...stack.slice(start), file]);
      return;
    }
    active.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    stack.pop();
    active.delete(file);
    visited.add(file);
  };

  for (const file of files) visit(file);
  return cycles;
}

describe("lightweight architecture boundaries", () => {
  it("enforces domain, application, infrastructure, and interface dependency direction", () => {
    const apiSourceRoot = resolve(workspaceRoot, "apps/api/src");
    const domainFiles = listTypeScriptFiles(resolve(apiSourceRoot, "domain"));
    const applicationFiles = listTypeScriptFiles(resolve(apiSourceRoot, "application"));
    const infrastructureFiles = listTypeScriptFiles(resolve(apiSourceRoot, "infrastructure"));
    const forbiddenDomainImports = /\/(?:application|infrastructure|admin|developer-openapi|db|redis|storage|worker)\//u;
    const forbiddenApplicationImports = /\/(?:infrastructure|admin|developer-openapi|db|redis|storage|worker)\//u;
    const forbiddenInfrastructureImports = /\/(?:admin|developer-openapi)\//u;

    for (const file of domainFiles) {
      expect(
        relativeImports(file).some((item) =>
          forbiddenDomainImports.test(resolve(dirname(file), item))
        ),
        relative(workspaceRoot, file)
      ).toBe(false);
      expect(readFileSync(file, "utf8"), relative(workspaceRoot, file)).not.toContain('from "hono"');
    }
    for (const file of applicationFiles) {
      expect(
        relativeImports(file).some((item) =>
          forbiddenApplicationImports.test(resolve(dirname(file), item))
        ),
        relative(workspaceRoot, file)
      ).toBe(false);
      expect(readFileSync(file, "utf8"), relative(workspaceRoot, file)).not.toContain('from "hono"');
    }
    for (const file of infrastructureFiles) {
      expect(
        relativeImports(file).some((item) =>
          forbiddenInfrastructureImports.test(resolve(dirname(file), item))
        ),
        relative(workspaceRoot, file)
      ).toBe(false);
    }
  });

  it("keeps the API production import graph acyclic", () => {
    const files = listTypeScriptFiles(resolve(workspaceRoot, "apps/api/src"));
    const cycles = dependencyCycles(files).map((cycle) =>
      cycle.map((file) => relative(workspaceRoot, file))
    );
    expect(cycles).toEqual([]);
  });

  it("keeps destructive validation tooling out of production runtime artifacts", () => {
    const apiPackage = readWorkspaceFile("apps/api/package.json");
    const runtimeBuild = readWorkspaceFile("apps/api/scripts/build-runtime.mjs");
    const dockerfile = readWorkspaceFile("Dockerfile");

    expect(apiPackage).not.toContain("reset:destructive");
    expect(runtimeBuild).not.toContain("destructive-reset");
    expect(dockerfile).not.toContain("destructive-reset.mjs");
    expect(existsSync(resolve(workspaceRoot, "apps/api/src/destructive-reset.ts"))).toBe(false);
    expect(
      existsSync(resolve(workspaceRoot, "apps/api/src/application/destructive-reset.ts"))
    ).toBe(false);
  });

  it("cleans package build directories before compiling", () => {
    const apiPackage = JSON.parse(readWorkspaceFile("apps/api/package.json")) as {
      scripts?: Record<string, string>;
    };
    const okfPackage = JSON.parse(readWorkspaceFile("packages/okf/package.json")) as {
      scripts?: Record<string, string>;
    };

    expect(apiPackage.scripts?.prebuild).toBe("node scripts/clean-dist.mjs");
    expect(okfPackage.scripts?.prebuild).toBe("node scripts/clean-dist.mjs");
    expect(existsSync(resolve(workspaceRoot, "apps/api/scripts/clean-dist.mjs"))).toBe(true);
    expect(existsSync(resolve(workspaceRoot, "packages/okf/scripts/clean-dist.mjs"))).toBe(true);
  });

  it("keeps Focowiki validation independent from downstream Demo and Skill runtimes", () => {
    const packageJson = readWorkspaceFile("package.json");
    const forbiddenScripts = [
      "validate:demo-agent",
      "validate:demo-skill",
      "validate:agent-openapi",
      "validate:large-legal",
      "validate:legal-llm"
    ];
    const forbiddenFiles = [
      "scripts/validation/demo-agent-e2e.mjs",
      "scripts/validation/agent-openapi-exploration.mjs",
      "scripts/validation/lib/skill-curl-validation.mjs"
    ];

    for (const script of forbiddenScripts) expect(packageJson).not.toContain(script);
    for (const file of forbiddenFiles) {
      expect(existsSync(resolve(workspaceRoot, file)), file).toBe(false);
    }
  });

  it("keeps reusable production modules free of professional-domain rules", () => {
    const roots = [
      resolve(workspaceRoot, "apps/api/src"),
      resolve(workspaceRoot, "apps/admin/src"),
      resolve(workspaceRoot, "packages/okf/src")
    ];
    const domainVocabulary =
      /\b(?:lawyer|statute|court|judgment|jurisdiction)\b|法规|法律|法院|裁判|案件|司法|检察|条例|法条/iu;

    for (const root of roots) {
      for (const file of listTypeScriptFiles(root)) {
        expect(readFileSync(file, "utf8"), relative(workspaceRoot, file)).not.toMatch(
          domainVocabulary
        );
      }
    }
  });

  it("keeps production admin responsibilities out of single oversized files", () => {
    expect(countLines("apps/api/src/server.ts")).toBeLessThanOrEqual(150);
    expect(countLines("apps/api/src/admin/routes.ts")).toBeLessThanOrEqual(1_100);
    expect(countLines("apps/api/src/admin/source-file-processor.ts")).toBeLessThanOrEqual(500);
    expect(countLines("apps/api/src/graph/file-graph.ts")).toBeLessThanOrEqual(150);
    expect(countLines("apps/api/src/developer-openapi/routes.ts")).toBeLessThanOrEqual(350);
    expect(countLines("apps/api/src/publication/required-projection-writer.ts")).toBeLessThanOrEqual(600);
    expect(countLines("apps/admin/src/pages/KnowledgeBaseDetailPage.tsx")).toBeLessThanOrEqual(
      700
    );
  });

  it("keeps file graph processing split into profile, candidate, scoring, and confirmation modules", () => {
    const graphEntry = readWorkspaceFile("apps/api/src/graph/file-graph.ts");
    const nodeProfile = readWorkspaceFile("apps/api/src/graph/graph-node-profile.ts");
    const candidates = readWorkspaceFile("apps/api/src/graph/graph-candidates.ts");
    const scoring = readWorkspaceFile("apps/api/src/graph/graph-edge-scoring.ts");
    const confirmation = readWorkspaceFile("apps/api/src/graph/graph-edge-confirmation.ts");

    expect(graphEntry).toContain("createGraphNode");
    expect(graphEntry).toContain("listCandidateNodes");
    expect(graphEntry).toContain("buildGraphEdges");
    expect(graphEntry).toContain("confirmGraphEdges");
    expect(nodeProfile).toContain("buildSourceContentProfile");
    expect(candidates).toContain("listGraphCandidates");
    expect(candidates).not.toContain("listGraphNodes");
    expect(scoring).toContain("bestEdgeForCandidate");
    expect(scoring).not.toContain("requestGraphRelationshipConfirmations");
    expect(confirmation).toContain("requestGraphRelationshipConfirmations");
    expect(`${graphEntry}\n${nodeProfile}\n${candidates}\n${scoring}\n${confirmation}`).not.toContain(
      "developer-openapi"
    );
    expect(`${graphEntry}\n${nodeProfile}\n${candidates}\n${scoring}\n${confirmation}`).not.toContain(
      "apps/admin"
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
    expect(developerRoutes).toContain("/openapi/v2/knowledge-bases");
    expect(developerRoutes).toContain("/openapi/v2/webhooks");
    expect(developerRoutes).not.toContain("/openapi/v1");
  });

  it("keeps Admin API routes in their own module without obsolete pre-release endpoints", () => {
    const server = readWorkspaceFile("apps/api/src/server.ts");
    const adminRoutes = readWorkspaceFile("apps/api/src/admin/routes.ts");
    const adminClient = readWorkspaceFile("apps/admin/src/lib/admin-api.ts");

    expect(server).toContain("registerAdminApiRoutes");
    expect(server).not.toContain("/admin/api/knowledge-bases");
    expect(adminRoutes).not.toContain("/admin/api/knowledge-bases/:knowledgeBaseId/uploads");
    expect(adminRoutes).toContain("registerAdminUploadSessionRoutes");
    expect(`${adminRoutes}\n${adminClient}`).not.toContain("/admin/api/uploads");
    expect(`${adminRoutes}\n${adminClient}`).not.toContain("/admin/api/generations");
    expect(`${adminRoutes}\n${adminClient}`).not.toContain("/admin/api/result");
    expect(`${adminRoutes}\n${adminClient}`).not.toContain("/admin/api/preview");
  });

  it("keeps folder-aware mutation responsibilities in separate modules", () => {
    const pathPolicy = readWorkspaceFile("apps/api/src/domain/source-path.ts");
    const uploadSessions = readWorkspaceFile("apps/api/src/application/upload-sessions.ts");
    const directoryIndexes = readWorkspaceFile(
      "apps/api/src/publication/directory-navigation-writer.ts"
    );

    expect(pathPolicy).not.toContain("Hono");
    expect(pathPolicy).not.toContain("postgres");
    expect(uploadSessions).not.toContain("app.post");
    expect(uploadSessions).not.toContain("sql`");
    expect(directoryIndexes).not.toContain("Hono");
    expect(directoryIndexes).not.toContain("sql`");
    expect(directoryIndexes).toContain("navigation.applyEntries");
    expect(directoryIndexes).not.toContain("entries: DirectoryIndexEntry[]");
    expect(uploadSessions).toContain("UploadSessionStoragePort");
    expect(uploadSessions).toContain("ApplicationRuntime");
    expect(uploadSessions).not.toContain("StorageAdapter");
  });

  it("keeps obsolete flat upload and version-one compatibility unreachable", () => {
    const adminRoutes = readWorkspaceFile("apps/api/src/admin/routes.ts");
    const developerRoutes = readWorkspaceFile("apps/api/src/developer-openapi/routes.ts");
    const developerPaths = readWorkspaceFile("apps/api/src/developer-openapi/openapi-paths.ts");

    expect(adminRoutes).not.toContain("acceptUploadSourceFiles");
    expect(adminRoutes).not.toContain("hasDuplicateUploadFileNames");
    expect(developerRoutes).not.toContain("/openapi/v1");
    expect(developerPaths).not.toContain("/openapi/v1");
  });

  it("keeps OKF publication independent from full generation file maps", () => {
    const publication = readWorkspaceFile(
      "apps/api/src/publication/required-projection-writer.ts"
    );

    expect(publication).not.toContain("const bundleFiles: BundleFileDraft[]");
    expect(publication).not.toContain("buildBundleTreeEntries");
    expect(publication).toContain("createRequiredProjectionWriter");
    expect(publication).toContain("writeMachineProjectionBatch");
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

  it("keeps hard-delete and Redis cleanup bounded by cursor pages", () => {
    const hardDeleteJobs = readWorkspaceFile("apps/api/src/worker/hard-delete-jobs.ts");
    const redisCoordination = readWorkspaceFile("apps/api/src/redis/coordination.ts");

    expect(hardDeleteJobs).toContain("listPendingObjectKeys");
    expect(hardDeleteJobs).toContain("purgeTargetBatch");
    expect(hardDeleteJobs).toContain("discoveryCursor");
    expect(hardDeleteJobs).not.toContain("objectKeys.push");
    expect(redisCoordination).toContain("scanIterator");
    expect(redisCoordination).not.toContain("const seenKeys = new Set<string>()");
  });

  it("persists each reconciliation scan page with one bounded bulk upsert", () => {
    const repository = readWorkspaceFile(
      "apps/api/src/infrastructure/postgres/storage-reconciliation-repository.ts"
    );

    expect(repository).toContain("FROM unnest(");
    expect(repository).toContain("orphanObjects.map((object) => object.key)");
    expect(repository).not.toContain("for (const object of orphanObjects)");
  });

  it("keeps role worker queue state restartable and bounded", () => {
    const migration = readWorkspaceFile("apps/api/migrations/001_production_admin_web.sql");
    const repository = readWorkspaceFile(
      "apps/api/src/infrastructure/postgres/role-job-repository.ts"
    );
    const runtime = readWorkspaceFile("apps/api/src/worker/role-runtime.ts");
    const sourceMain = readWorkspaceFile("apps/api/src/source-worker-main.ts");
    const publicationMain = readWorkspaceFile("apps/api/src/publication-worker-main.ts");
    const maintenanceMain = readWorkspaceFile("apps/api/src/maintenance-worker-main.ts");
    const migrationSql = migration.toLowerCase();
    const repositorySource = repository.toLowerCase();

    expect(migrationSql).toContain("create table focowiki.role_jobs");
    expect(migrationSql).toContain("create table focowiki.role_heartbeats");
    expect(migration).toContain("'dead_letter'");
    expect(migration).toContain("role_jobs_claim_idx");
    expect(repositorySource).toContain("for update skip locked");
    expect(repository).toContain("async heartbeat");
    expect(repository).toContain("async fail");
    expect(repository).toContain("async release");
    expect(runtime).toContain("repository.heartbeat");
    expect(sourceMain).toContain('role: "source"');
    expect(publicationMain).toContain('role: "publication"');
    expect(maintenanceMain).toContain('role: "maintenance"');
  });

  it("keeps paged maintenance work on stable process-scoped lease tokens", () => {
    const maintenanceMain = readWorkspaceFile("apps/api/src/maintenance-worker-main.ts");

    expect(maintenanceMain).toContain("const repairLeaseToken");
    expect(maintenanceMain).toContain("leaseToken: repairLeaseToken");
    expect(maintenanceMain).toContain("const reconciliationLeaseToken");
    expect(maintenanceMain).toContain("leaseToken: reconciliationLeaseToken");
  });

  it("keeps source-file completion from running publication inline", () => {
    const processor = readWorkspaceFile("apps/api/src/admin/source-file-processor.ts");

    expect(processor).toContain("completion.complete");
    expect(processor).not.toContain("publishNow");
    expect(processor).not.toContain("processSourceFilePublicationStage");
    expect(processor).not.toContain("processSourceFileBundleStage");
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
    expect(generatedOutput).toContain("readGeneratedOutputsForSourceFiles");
    expect(generatedOutput).toContain("withActiveGeneration");
    expect(generatedOutput).not.toContain("repositories.graph");
    expect(generatedOutput).not.toContain("workerJobs");
    expect(generatedOutput).not.toContain("model_invocations");
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

  it("keeps active read models out of queue, assembly, compaction, and migration advancement", () => {
    const activeReadRepository = readWorkspaceFile(
      "apps/api/src/infrastructure/postgres/active-generation-read-repository.ts"
    );
    const activeTreeReadModel = readWorkspaceFile(
      "apps/api/src/infrastructure/postgres/active-tree-read-model.ts"
    );
    const readPlane = `${activeReadRepository}\n${activeTreeReadModel}`;

    for (const forbidden of [
      ".claimBatch(",
      ".claimNext(",
      ".assemble(",
      ".compact(",
      "advanceMigration",
      "enqueueRoleJob",
      "INSERT INTO focowiki.role_jobs",
      "UPDATE focowiki.publication_change_facts"
    ]) {
      expect(readPlane).not.toContain(forbidden);
    }
    expect(activeReadRepository).toContain(
      'if (version.optimizationState === "optimized_active")'
    );
    expect(activeTreeReadModel).toContain(
      "if (missingPaths.length > 0 && !allowCompatibilityFallback)"
    );
  });
});
