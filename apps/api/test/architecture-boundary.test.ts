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

  it("packages one shared tokenizer for source facts and all search roles", () => {
    const runtimeBuild = readWorkspaceFile("apps/api/scripts/build-runtime.mjs");
    const dockerfile = readWorkspaceFile("Dockerfile");
    const workerMain = readWorkspaceFile("apps/api/src/worker-main.ts");
    const productionRuntime = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/production-runtime.ts"
    );
    const documentProcessor = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/production-document-fixed-processor.ts"
    );
    const backgroundRuntime = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/production-background-runtime.ts"
    );

    expect(runtimeBuild).toContain('external: ["nodejieba"]');
    expect(runtimeBuild).toContain('resolvePackageRoot("nodejieba")');
    expect(runtimeBuild).toContain('resolve(runtimeDir, "node_modules/nodejieba")');
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends g++ make python3");
    expect(dockerfile).toContain("ENV npm_config_build_from_source=true");
    expect(dockerfile).toContain("ca-certificates dumb-init gosu libgomp1 libstdc++6 openssl");
    expect(dockerfile).toContain("FROM python:3.12-slim-bookworm AS api");
    expect(productionRuntime.match(/createNodeJiebaTokenizer\(\)/gu)).toHaveLength(1);
    expect(documentProcessor).toContain("tokenizer:");
    expect(backgroundRuntime).toContain("searchProvider:");
    expect(`${documentProcessor}\n${backgroundRuntime}`).not.toContain(
      "createNodeJiebaTokenizer()"
    );
    expect(workerMain).toContain("assertTokenizer: assertNodeJiebaRuntimeAvailable");
    expect(workerMain).toContain("runUnifiedWorkerProduction");
    expect(`${productionRuntime}\n${documentProcessor}\n${backgroundRuntime}`).not.toContain(
      'searchConfig.provider === "opensearch"'
    );
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
    expect(countLines(
      "apps/api/src/document-indexing/infrastructure/production-document-relation-reconcile-work-handler.ts"
    )).toBeLessThanOrEqual(500);
    expect(countLines("apps/api/src/developer-openapi/routes.ts")).toBeLessThanOrEqual(350);
    expect(countLines(
      "apps/api/src/document-indexing/infrastructure/production-document-knowledge-projection-work-handler.ts"
    )).toBeLessThanOrEqual(500);
    expect(countLines("apps/admin/src/pages/KnowledgeBaseDetailPage.tsx")).toBeLessThanOrEqual(
      700
    );
  });

  it("keeps document relationship processing split into preparation, candidates, lookup, and persistence", () => {
    const graphEntry = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/production-document-relation-reconcile-work-handler.ts"
    );
    const preparation = readWorkspaceFile(
      "apps/api/src/document-indexing/application/document-source-preparation.ts"
    );
    const candidates = readWorkspaceFile(
      "apps/api/src/document-indexing/application/document-relation-candidates.ts"
    );
    const referenceFacts = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/postgres-document-reference-fact-repository.ts"
    );
    const pairs = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/postgres-relation-pair-repository.ts"
    );

    expect(graphEntry).toContain("createProductionDocumentRelationReconcileWorkHandler");
    expect(graphEntry).toContain("buildDocumentRelationCandidates");
    expect(graphEntry).toContain("buildSemanticFileReferenceCandidates");
    expect(graphEntry).toContain("settings.graph.acceptedEdgeLimit");
    expect(preparation).toContain("buildSourceContentProfile");
    expect(candidates).toContain("buildDocumentRelationCandidates");
    expect(referenceFacts).toContain("findTargetsByIdentityKeys");
    expect(referenceFacts).toContain("findReferencingIdentityKeys");
    expect(pairs).toContain("stageCanonical");
    expect(`${graphEntry}\n${preparation}\n${candidates}\n${referenceFacts}\n${pairs}`).not.toContain(
      "developer-openapi"
    );
    expect(`${graphEntry}\n${preparation}\n${candidates}\n${referenceFacts}\n${pairs}`).not.toContain(
      "apps/admin"
    );
  });

  it("keeps API and Admin UI layers separated", () => {
    const apiServer = readWorkspaceFile("apps/api/src/server.ts");
    const workerRuntime = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/production-runtime.ts"
    );
    const adminPage = readWorkspaceFile("apps/admin/src/pages/KnowledgeBaseDetailPage.tsx");

    expect(apiServer).not.toContain("apps/admin");
    expect(workerRuntime).not.toContain("apps/admin/src");
    expect(adminPage).not.toContain("apps/api/src");
  });

  it("keeps Developer OpenAPI routes in their own route module", () => {
    const server = readWorkspaceFile("apps/api/src/server.ts");
    const developerRoutes = readWorkspaceFile("apps/api/src/developer-openapi/routes.ts");
    const webhookRoutes = readWorkspaceFile(
      "apps/api/src/developer-openapi/webhook-routes.ts"
    );

    expect(server).toContain("registerDeveloperOpenApiRoutes");
    expect(server).not.toContain("serveScopedPublicFile");
    expect(developerRoutes).toContain("/openapi/v2/knowledge-bases");
    expect(developerRoutes).toContain("registerDeveloperOpenApiWebhookRoutes");
    expect(webhookRoutes).toContain("/openapi/v2/webhooks");
    expect(`${developerRoutes}\n${webhookRoutes}`).not.toContain("/openapi/v1");
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
    const uploadRoutes = readWorkspaceFile("apps/api/src/admin/upload-session-routes.ts");
    const directoryIndexes = readWorkspaceFile(
      "apps/api/src/document-indexing/application/document-directory-navigation-state.ts"
    );

    expect(pathPolicy).not.toContain("Hono");
    expect(pathPolicy).not.toContain("postgres");
    expect(uploadSessions).toContain("UPLOAD_MANIFEST_PAGE_SIZE");
    expect(uploadSessions).toContain("UPLOAD_CONTENT_TRANSFER_CONCURRENCY");
    expect(uploadSessions).not.toContain("createUploadSessionService");
    expect(directoryIndexes).not.toContain("Hono");
    expect(directoryIndexes).not.toContain("sql`");
    expect(directoryIndexes).toContain("reconcileDocumentDirectoryNavigation");
    expect(directoryIndexes).not.toContain("entries: DirectoryIndexEntry[]");
    expect(uploadRoutes).toContain("StorageVnextAdminUploadApplication");
    expect(uploadRoutes).not.toContain("StorageAdapter");
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

  it("keeps document work limited to immutable publication facts", () => {
    const projection = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/production-document-knowledge-projection-work-handler.ts"
    );

    expect(projection).not.toContain("const bundleFiles: BundleFileDraft[]");
    expect(projection).not.toContain("buildBundleTreeEntries");
    expect(projection).not.toContain("createDocumentGeneratedPageStaging");
    expect(projection).toContain("createProductionDocumentKnowledgeProjectionWorkHandler");
    expect(projection).toContain("createPostgresDocumentProjectionFacts");
    expect(projection).not.toContain("createPostgresProjectionScopeContributions");
    expect(projection).toContain("createPostgresReadyDocumentPublicationItem");
    expect(projection).not.toContain("allocatePostgresDocumentFactEpoch");
    expect(projection).toContain("waitForProjectionWithMutation");
  });

  it("keeps removed publication coordination unreachable", () => {
    const removedModules = [
      "document-publication-coordinator-runtime.ts",
      "document-publication-scope-runtime.ts",
      "document-publication-scope-generation-runtime.ts",
      "document-publication-planner.ts",
      "document-publication-dag.ts",
      "document-publication-recovery.ts",
      "document-publication-shadow-migration.ts",
      "document-publication-window.ts"
    ];
    const roots = [
      "apps/api/src/document-indexing/application",
      "apps/api/src/document-indexing/infrastructure"
    ];
    for (const root of roots) {
      for (const module of removedModules) {
        expect(existsSync(resolve(workspaceRoot, root, module)), module)
          .toBe(false);
      }
    }
    const processor = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/production-document-fixed-processor.ts"
    );
    expect(processor).toContain("createProductionDocumentPublicationJobRuntime");
    expect(processor).not.toContain("createProductionDocumentPublicationCoordinatorRuntime");
    expect(processor).not.toContain("createProductionDocumentPublicationScopeRuntime");
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
    const hardDeleteJobs = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/postgres-document-resource-deletion.ts"
    );
    const redisCoordination = readWorkspaceFile("apps/api/src/redis/coordination.ts");

    expect(hardDeleteJobs).toContain("selectSourcePage");
    expect(hardDeleteJobs).toContain("pageSize");
    expect(hardDeleteJobs).toContain("cursor");
    expect(hardDeleteJobs).not.toContain("listAll");
    expect(redisCoordination).toContain("scanIterator");
    expect(redisCoordination).not.toContain("const seenKeys = new Set<string>()");
  });

  it("keeps relationship reconciliation bounded by explicit candidate limits", () => {
    const repository = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/production-document-relation-reconcile-work-handler.ts"
    );

    expect(repository).toContain("candidateLimit");
    expect(repository).toContain("acceptedEdgeLimit");
    expect(repository).toContain("limit: settings.graph.candidateLimit");
    expect(repository).not.toContain("listAll");
  });

  it("keeps unified worker queue state restartable and bounded", () => {
    const repository = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/postgres-document-artifact-work-repository.ts"
    );
    const claimRepository = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/postgres-document-work-claim.ts"
    );
    const recoveryRepository = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/postgres-document-work-recovery.ts"
    );
    const scheduler = readWorkspaceFile(
      "apps/api/src/document-indexing/application/document-fixed-dag-scheduler.ts"
    );
    const workerRuntime = readWorkspaceFile(
      "apps/api/src/document-indexing/application/document-fixed-dag-runtime.ts"
    );
    const workerMain = readWorkspaceFile("apps/api/src/worker-main.ts");
    const productionRuntime = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/production-runtime.ts"
    );
    const repositorySource = `${repository}\n${claimRepository}\n${recoveryRepository}`
      .toLowerCase();

    expect(repositorySource).toContain("for update of work skip locked");
    expect(repository).toContain("async claim");
    expect(repository).toContain("async recoverExpired");
    expect(claimRepository).toContain("fixedPrerequisiteSql");
    expect(scheduler).toContain("tryAcquire(request.resourceLane)");
    expect(scheduler).toContain("limit: admitted.length");
    expect(workerRuntime).toContain("createDocumentFixedDagRuntime");
    expect(workerRuntime).toContain("recoverExpired");
    expect(workerRuntime).toContain("const DOCUMENT_WORK_CLAIM_ORDER");
    expect(workerRuntime).toContain("let claimOrderOffset = 0");
    expect(workerRuntime).toContain("(claimOrderOffset + index)");
    expect(workerRuntime).toContain("claimOrderOffset = (claimOrderOffset + 1)");
    expect(workerMain).toContain("runUnifiedWorkerProduction");
    expect(productionRuntime).toContain("createProductionDocumentFixedProcessor");
    expect(productionRuntime).toContain("createProductionBackgroundRuntime");
  });

  it("keeps maintenance, deletion, retention, and cleanup in the unified worker", () => {
    const backgroundRuntime = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/production-background-runtime.ts"
    );

    expect(backgroundRuntime).toContain("createStorageVnextMaintenanceCoordinator");
    expect(backgroundRuntime).toContain("createDocumentMaintenancePhaseRunner");
    expect(backgroundRuntime).toContain("createDocumentResourceDeletionWorker");
    expect(backgroundRuntime).toContain("createDocumentObsoleteArtifactCleanupWorker");
    expect(backgroundRuntime).toContain("createPostgresDocumentJobRetention");
    expect(backgroundRuntime).not.toContain("recoverStaleLeases");
    expect(backgroundRuntime).not.toMatch(/LexicalRebuild|ProjectionRepairWork/u);
  });

  it("keeps document completion free of publication orchestration", () => {
    const processor = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/postgres-document-publication-work-activation.ts"
    );
    const activation = readWorkspaceFile(
      "apps/api/src/document-indexing/infrastructure/postgres-document-publication-source-activation.ts"
    );

    expect(processor).toContain('eventType: "document.available"');
    expect(processor).not.toContain("createStorageVnextPublicationProcessor");
    expect(processor).not.toContain("activateCandidate");
    expect(activation).toContain(
      "activation_sequence = ${input.targetReadinessSequence}"
    );
    expect(activation).toContain("activateProjectionRecords");
    expect(activation).toContain("UPDATE focowiki.source_file_identity_keys");
  });

  it("keeps source-file list reads out of graph, model, and worker expansion paths", () => {
    const adminRoutes = readWorkspaceFile("apps/api/src/admin/routes.ts");
    const repository = readWorkspaceFile(
      "apps/api/src/storage-vnext/api/postgres-admin-resources.ts"
    );
    const adminCore = readWorkspaceFile(
      "apps/api/src/storage-vnext/api/postgres-admin-core.ts"
    );
    const sourceListRoute = adminRoutes.slice(
      adminRoutes.indexOf('"/admin/api/knowledge-bases/:knowledgeBaseId/source-files"'),
      adminRoutes.indexOf('"/admin/api/knowledge-bases/:knowledgeBaseId/source-files/:sourceFileId"')
    );
    const sourceListRepository = repository.slice(repository.indexOf("async function readSourceFiles"));

    expect(sourceListRoute).not.toContain("readAdminSourceFileWithGraphSummary");
    expect(sourceListRoute).not.toContain("repositories.graph");
    expect(sourceListRoute).not.toContain("enqueueSourceFileProcessingJobs");
    expect(sourceListRepository).toContain("source_file_active_revisions");
    expect(sourceListRepository).toContain("generated_page_heads");
    expect(sourceListRepository).toContain("document_processing_jobs");
    expect(sourceListRepository).not.toContain("FROM focowiki.graph_edges");
    expect(sourceListRepository).not.toContain("FROM focowiki.model_invocations");
    const sourceListApplication = adminCore.slice(
      adminCore.indexOf("async listFiles"),
      adminCore.indexOf("async getFile")
    );
    expect(sourceListApplication).not.toContain("graph_edges");
    expect(sourceListApplication).not.toContain("workerJobs");
    expect(sourceListApplication).not.toContain("model_invocations");
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
      developerServices.indexOf("async createWebhook")
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
    const detailRefresh = readWorkspaceFile(
      "apps/admin/src/hooks/use-detail-page-refresh.ts"
    );
    const pollingBoundary = `${detailPage}\n${detailRefresh}`;

    expect(pollingBoundary).toContain("document.visibilityState");
    expect(pollingBoundary).toContain("shouldScheduleSourceFileRefresh");
    expect(pollingBoundary).not.toContain("window.setInterval");
  });

  it("keeps active read models out of queue, assembly, compaction, and migration advancement", () => {
    const activeReadRepository = readWorkspaceFile(
      "apps/api/src/storage-vnext/api/postgres-openapi-read.ts"
    );
    const activeTreeReadModel = readWorkspaceFile(
      "apps/api/src/storage-vnext/api/postgres-admin-read.ts"
    );
    const activeTreeStatistics = readWorkspaceFile(
      "apps/api/src/storage-vnext/api/postgres-openapi-application.ts"
    );
    const readPlane = `${activeReadRepository}\n${activeTreeReadModel}\n${activeTreeStatistics}`;

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
    expect(activeReadRepository).toContain("focowiki.generated_page_heads");
    expect(activeReadRepository).toContain("active_source_revision_public_id");
    expect(activeTreeReadModel).toContain("focowiki.generated_page_heads");
    expect(activeTreeReadModel).toContain("focowiki.source_file_active_revisions");
    expect(activeTreeStatistics).toContain("focowiki.generated_page_heads");
  });
});
