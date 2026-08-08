import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createOkfV02HttpE2E } from "./okf-v02-http-e2e.mjs";
import { createOkfV02RuntimeInfrastructure } from
  "./okf-v02-runtime-infrastructure.mjs";
import { recordOkfV02OwnedResource } from "./okf-v02-workspace.mjs";
import {
  createOkfV02ResourceSampler,
  createOkfV02StoreObserver
} from "./okf-v02-runtime-observations.mjs";

const execFileAsync = promisify(execFile);

export async function runOkfV02RuntimeE2E(input) {
  const infrastructure = createOkfV02RuntimeInfrastructure({
    env: input.env,
    workspace: input.workspace
  });
  const evidenceDir = path.join(input.workspace.root, "evidence");
  const lifecycleReportPath = path.join(evidenceDir, "resource-lifecycle.json");
  let checks = null;
  let resourceSampler = null;
  let storeObserver = null;
  try {
    await fs.mkdir(evidenceDir, { recursive: true });
    const ownership = input.journal.state.ownership;
    recordOkfV02OwnedResource(
      ownership,
      "evidenceArtifacts",
      lifecycleReportPath
    );
    await input.journal.update({
      phase: "runtime-starting",
      ownership,
      runtimeProject: "<RUN_COMPOSE_PROJECT>"
    });

    await infrastructure.start("meilisearch");
    storeObserver = createOkfV02StoreObserver({ env: infrastructure.env });
    resourceSampler = createOkfV02ResourceSampler({
      intervalMs: 5_000,
      capture: () => infrastructure.captureResourceSnapshot()
    });
    await resourceSampler.start();
    recordOkfV02OwnedResource(
      ownership,
      "searchIndexes",
      `${infrastructure.env.SEARCH_INDEX_PREFIX}:meilisearch`
    );
    await input.journal.update({ phase: "initial-provider-ready", ownership });

    await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      "scripts/validation/folder-aware-resource-lifecycle.mjs"
    ], {
      cwd: process.cwd(),
      env: {
        ...infrastructure.env,
        FOCOWIKI_RESOURCE_LIFECYCLE_EXACT_OKF_CORPUS: "1",
        FOCOWIKI_RESOURCE_LIFECYCLE_MUTATION_PREFIX: "legacy/",
        FOCOWIKI_VALIDATION_MARKDOWN_DIR: input.workspace.stagingRoot,
        FOCOWIKI_RESOURCE_LIFECYCLE_REPORT: lifecycleReportPath,
        FOCOWIKI_VALIDATION_KEEP_KNOWLEDGE_BASE: "1"
      },
      maxBuffer: 64 * 1024 * 1024
    });
    const lifecycle = JSON.parse(await fs.readFile(lifecycleReportPath, "utf8"));
    assertLifecycleReport(lifecycle);
    recordOkfV02OwnedResource(
      ownership,
      "knowledgeBaseIds",
      lifecycle.knowledgeBaseId
    );
    await input.journal.update({
      phase: "all-openapi-operations-verified",
      ownership,
      operationCoverage: {
        count: lifecycle.operationCoverage.operationCount,
        complete: lifecycle.operationCoverage.complete
      }
    });

    const openApiDocument = JSON.parse(
      await fs.readFile("docs/public/openapi/focowiki-openapi.json", "utf8")
    );
    checks = await createOkfV02HttpE2E({
      env: infrastructure.env,
      runId: input.workspace.runId,
      journal: input.journal,
      knowledgeBaseId: lifecycle.knowledgeBaseId,
      official: input.official,
      lifecycle,
      openApiDocument,
      provider: "meilisearch",
      secondProvider: "opensearch",
      ownership,
      storeObserver,
      captureResourceSnapshot: () => infrastructure.captureResourceSnapshot(),
      assertRuntimeHealthy: () => infrastructure.assertApplicationsRunning()
    });
    const initial = await checks.runInitialProviderChecks();
    const resources = await resourceSampler.stop();
    resourceSampler = null;
    const stores = await storeObserver.capture(lifecycle.knowledgeBaseId);
    await input.journal.update({
      phase: "bounded-runtime-observations-recorded",
      ownership,
      resourceObservations: {
        elapsedMs: resources.elapsedMs,
        sampleCount: resources.sampleCount,
        maximumCpuPercent: resources.maximumCpuPercent,
        maximumRssBytes: resources.maximumRssBytes,
        maximumProcessCount: resources.maximumProcessCount,
        postgresTransactions: stores.postgresTransactions,
        postgresConnections: stores.postgresConnections,
        redisCommandsProcessed: stores.redisCommandsProcessed,
        redisUsedMemoryBytes: stores.redisUsedMemoryBytes,
        s3ObjectCount: stores.s3ObjectCount,
        s3VersionCount: stores.s3VersionCount,
        s3TotalBytes: stores.s3TotalBytes,
        searchDocumentCount: stores.searchDocumentCount,
        searchBatchChecksumObserved: Boolean(stores.searchLastBatchChecksum),
        maximumSearchResponseBytes: initial.search.responseBytes
      }
    });

    await infrastructure.switchProvider("opensearch");
    recordOkfV02OwnedResource(
      ownership,
      "searchIndexes",
      `${infrastructure.env.SEARCH_INDEX_PREFIX}:opensearch`
    );
    await input.journal.update({ phase: "provider-switched", ownership });
    await checks.runSwitchedProviderChecks(initial);
  } catch (error) {
    const failureSummary = await infrastructure.readFailureSummary();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}`
      + `; runtime failures: ${JSON.stringify(failureSummary)}`,
      { cause: error }
    );
  } finally {
    if (resourceSampler) {
      await resourceSampler.stop().catch(async (error) => {
        await input.journal.update({ resourceObservationFailure: safeError(error) });
      });
      resourceSampler = null;
    }
    await checks?.cleanup().catch(async (error) => {
      await input.journal.update({
        cleanupFailure: safeError(error)
      });
    });
    await storeObserver?.close().catch(async (error) => {
      await input.journal.update({ storeObservationCleanupFailure: safeError(error) });
    });
    await infrastructure.cleanup();
  }
}

function assertLifecycleReport(report) {
  if (
    report?.ok !== true
    || typeof report.knowledgeBaseId !== "string"
    || report.operationCoverage?.complete !== true
    || report.operationCoverage?.operationCount !== 43
    || report.operationCoverage?.missingAuthentication?.length !== 0
    || report.operationCoverage?.missingBusinessPath?.length !== 0
    || report.okfV02Baseline?.totalCompared !== 200
    || report.okfV02Baseline?.officialCompared !== 53
    || report.okfV02Baseline?.legacyCompared !== 147
  ) {
    throw new Error("The real Developer OpenAPI lifecycle coverage is incomplete.");
  }
}

function safeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error)
  };
}
