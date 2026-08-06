import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import {
  buildHandoffLedgerFromEvidence
} from "./lib/interleaved-handoff-ledger-builder.mjs";
import {
  assertHandoffLedger
} from "./lib/interleaved-handoff-ledger.mjs";
import {
  assertMutationE2ESafety,
  buildScenarioKnowledgeBaseName,
  createInterleavedLifecycleController
} from "./lib/interleaved-lifecycle-controller.mjs";
import {
  createLifecycleHttpClient,
  createUploadSessionPhaseClient
} from "./lib/interleaved-lifecycle-api.mjs";
import {
  buildMaintenancePrecondition,
  buildModificationRequest,
  classifyMaintenanceRequestResponse,
  selectLifecycleCases
} from "./lib/interleaved-lifecycle-actions.mjs";
import {
  buildDirectedPairwiseMatrix,
  buildFourLifecyclePermutations,
  buildThreeLifecyclePermutations
} from "./lib/interleaved-lifecycle-matrix.mjs";
import {
  createDeferredLifecycleAction,
  executeLifecycleSchedule
} from "./lib/interleaved-lifecycle-scheduler.mjs";
import {
  createInterleavedPostgresEvidence
} from "./lib/interleaved-postgres-evidence.mjs";
import {
  createPostgresInterleavedMaintenancePreconditions
} from "./lib/interleaved-maintenance-preconditions.mjs";
import {
  createPostgresMaintenanceObserver,
  waitForMaintenanceLifecycle,
  waitForMaintenanceStart
} from "./lib/interleaved-maintenance-observer.mjs";
import {
  buildScenarioFailure
} from "./lib/interleaved-scenario-result.mjs";
import {
  selectInterleavedScenarios
} from "./lib/interleaved-scenario-selection.mjs";
import {
  isKnowledgeBaseWorkSettled,
  resolveInterleavedScenarioDeadlineMs
} from "./lib/interleaved-runtime-settings.mjs";
import {
  createEvidenceRedactor
} from "./lib/interleaved-evidence-redaction.mjs";
import {
  selectClosedMarkdownSample
} from "./lib/storage-vnext-linked-corpus-samples.mjs";

loadLocalEnv();

const runId = requiredEnv("FOCOWIKI_INTERLEAVED_RUN_ID");
const reportRoot = path.resolve(
  "ReferenceDocs",
  "validate-interleaved-lifecycle-e2e"
);
const controller = createInterleavedLifecycleController({
  runId,
  seed: process.env.FOCOWIKI_INTERLEAVED_SEED || runId,
  reportRoot
});
await controller.initialize();
assertMutationE2ESafety({
  baselinePassed: controller.state.baseline?.repositoryChecksPassed === true,
  state: controller.state
});

const manifest = readJson(
  path.join(controller.state.evidenceDir, "corpus-manifest.json")
);
if (!Array.isArray(manifest.samples) || manifest.samples.length < 3) {
  throw new Error("Interleaved validation requires a prepared corpus manifest.");
}
const sourceRoot = path.resolve(requiredEnv("FOCOWIKI_VALIDATION_MARKDOWN_DIR"));
const linkedSamples = readClosedSamples(3);
const adminOrigin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const admin = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`
});
const developer = createLifecycleHttpClient({
  baseUrl: `http://127.0.0.1:${process.env.PUBLIC_OPENAPI_PORT || "43200"}`
});
const postgresEvidence = createInterleavedPostgresEvidence({
  databaseUrl: requiredEnv("DATABASE_URL")
});
const maintenancePreconditions =
  createPostgresInterleavedMaintenancePreconditions({
    databaseUrl: requiredEnv("DATABASE_URL")
  });
const maintenanceObserver = createPostgresMaintenanceObserver({
  databaseUrl: requiredEnv("DATABASE_URL")
});
const redactor = createEvidenceRedactor(controller.state.seed);
const resultsPath = path.join(
  controller.state.evidenceDir,
  "interleaved-results.json"
);
const scenarioResults = mergePersistedScenarioResults(
  readExistingResults(resultsPath),
  controller.state.scenarios
);
const scenarioDeadlineMs = resolveInterleavedScenarioDeadlineMs(
  process.env.FOCOWIKI_INTERLEAVED_SCENARIO_DEADLINE_MS
);
let keyId = null;

try {
  await login();
  const credential = await createOpenApiKey();
  keyId = credential.id;
  developer.authorization = `Bearer ${credential.rawKey}`;

  const scenarios = selectScenarios(
    readScenarioLimit(),
    readScenarioIds()
  );
  for (const scenario of scenarios) {
    const result = await executeScenario(scenario);
    const existingIndex = scenarioResults.findIndex(
      (candidate) => candidate.scenarioId === result.scenarioId
    );
    if (existingIndex === -1) scenarioResults.push(result);
    else scenarioResults[existingIndex] = result;
    writeJson(
      resultsPath,
      {
        kind: "focowiki-interleaved-lifecycle-results",
        runId,
        completedScenarioCount: scenarioResults.length,
        scenarioCount: scenarios.length,
        scenarios: scenarioResults
      }
    );
  }
  writeJson(resultsPath, {
    kind: "focowiki-interleaved-lifecycle-results",
    runId,
    completedScenarioCount: scenarioResults.length,
    scenarioCount: scenarioResults.length,
    scenarios: scenarioResults
  });
} finally {
  if (keyId) {
    await admin.request(`/admin/api/openapi-keys/${encodeURIComponent(keyId)}`, {
      method: "DELETE",
      headers: { origin: adminOrigin }
    }).catch(() => undefined);
  }
  await admin.request("/admin/api/logout", {
    method: "POST",
    headers: { origin: adminOrigin }
  }).catch(() => undefined);
  await Promise.allSettled([
    postgresEvidence.close(),
    maintenancePreconditions.close(),
    maintenanceObserver.close()
  ]);
}

process.stdout.write(`${JSON.stringify({
  runId,
  scenarioCount: scenarioResults.length,
  succeeded: scenarioResults.filter((result) => result.outcome === "succeeded").length,
  conflicted: scenarioResults.filter((result) => result.outcome === "conflicted").length,
  failed: scenarioResults.filter((result) => result.outcome === "failed").length
}, null, 2)}\n`);

async function executeScenario(scenario) {
  const scenarioRun = controller.startScenario({
    scenarioId: scenario.id,
    family: scenario.family,
    lifecycles: scenario.order,
    deadlineMs: scenarioDeadlineMs
  });
  const samples = samplesForScenario(scenario.caseIndex);
  const cases = selectLifecycleCases(scenario.caseIndex);
  let knowledgeBaseId = null;
  let knowledgeBaseRevision = null;
  let knowledgeBaseDeletionAccepted = false;
  let uploadSequence = 0;
  let lastSnapshot = null;
  let baseline = null;

  try {
    const created = await developer.json("/openapi/v2/knowledge-bases", {
      method: "POST",
      headers: {
        "idempotency-key": `${runId}-${scenario.id}-knowledge-base`
      },
      json: {
        name: buildScenarioKnowledgeBaseName(runId, scenario.id),
        description: `Validation scenario ${scenario.id}`
      },
      expectedStatus: 201
    });
    const knowledgeBase = created.knowledgeBase ?? created;
    knowledgeBaseId = knowledgeBase.knowledgeBaseId;
    knowledgeBaseRevision = knowledgeBase.resourceRevision;
    controller.registerOwnership("knowledgeBases", knowledgeBaseId);
    baseline = await seedScenarioBaseline({
      scenario,
      knowledgeBaseId,
      samples
    });

    const actions = {
      upload: async () => {
        uploadSequence += 1;
        const upload = createUploadSessionPhaseClient({
          client: developer,
          knowledgeBaseId,
          idempotencyPrefix: `${runId}-${scenario.id}-${uploadSequence}`
        });
        const relativePath = `incoming/${scenario.id}/source.md`;
        const createdSession = await upload.create([{
          relativePath,
          bytes: Buffer.from(
            `# Interleaved upload\n\nA link-free source for interleaved upload ${scenario.id}.\n`
          )
        }]);
        const sessionId = createdSession.session.id;
        controller.registerOwnership("uploadSessions", sessionId);
        controller.recordBarrier(scenario.id, {
          name: "manifest-draft",
          lifecycle: "upload",
          state: createdSession.session.state
        });
        await upload.appendManifest(sessionId);
        await upload.seal(sessionId);
        const reconciled = await reconcileUploadReservations(upload, sessionId);
        controller.recordBarrier(scenario.id, {
          name: "manifest-sealed",
          lifecycle: "upload",
          state: reconciled.session?.state ?? "manifest_sealed"
        });
        return {
          async settle() {
            try {
              await upload.uploadMissingContent(sessionId, reconciled.entries);
              await upload.finalize(sessionId);
              const terminal = await waitForUploadSession(upload, sessionId);
              return { state: terminal.state };
            } catch (error) {
              throw lifecycleError(error);
            }
          }
        };
      },
      modification: async () => {
        const current = await readKnowledgeBase(knowledgeBaseId);
        if (!current) throw codedError("NOT_FOUND", "Knowledge base is unavailable.");
        const sourceFile = await readSourceFile(
          knowledgeBaseId,
          baseline.primarySourceFileId
        );
        const directory = await readSourceDirectory(
          knowledgeBaseId,
          baseline.nestedDirectoryId
        );
        const request = buildModificationRequest({
          kind: cases.modificationKind,
          runId,
          scenarioId: scenario.id,
          sequence: 1,
          knowledgeBaseId,
          knowledgeBaseRevision: current.resourceRevision,
          sourceFile,
          directory,
          replacementBody: Buffer.from(
            `# Primary control\n\nLifecycle replacement for ${scenario.id}.\n`
          )
        });
        const response = await developer.request(request.pathname, {
          method: request.method,
          headers: request.headers,
          ...(request.json ? { json: request.json } : {}),
          ...(request.rawBody ? { rawBody: request.rawBody } : {})
        });
        const body = await readResponseBody(response);
        if (!response.ok) throw responseError(response, body);
        if (cases.modificationKind === "knowledge-base-metadata-update") {
          knowledgeBaseRevision = body.knowledgeBase.resourceRevision;
          controller.recordBarrier(scenario.id, {
            name: "resource-revision-advanced",
            lifecycle: "modification",
            state: "completed",
            details: { kind: cases.modificationKind }
          });
          return { state: "completed" };
        }
        const operationId = body.operation?.operationId;
        if (!operationId) {
          throw codedError(
            "OPERATION_ID_MISSING",
            "Accepted modification returned no operation ID."
          );
        }
        controller.recordBarrier(scenario.id, {
          name: "modification-accepted",
          lifecycle: "modification",
          state: body.operation.state ?? "accepted",
          details: { kind: cases.modificationKind }
        });
        return {
          async settle() {
            const operation = await waitForOperation(
              knowledgeBaseId,
              operationId
            );
            return { state: operation.state };
          }
        };
      },
      maintenance: () => createDeferredLifecycleAction(async () => {
          const precondition = buildMaintenancePrecondition({
            kind: cases.maintenanceKind,
            knowledgeBaseId,
            runId,
            ownedKnowledgeBaseIds: new Set([knowledgeBaseId]),
            s3Prefix: requiredEnv("S3_PREFIX")
          });
          const prepared = await maintenancePreconditions.prepare(precondition);
          const requested = await requestKnowledgeBaseIndexMaintenance({
            knowledgeBaseId,
            idempotencyKey: `${runId}-${scenario.id}-index-maintenance`
          });
          const requestClassification = classifyMaintenanceRequestResponse(
            requested
          );
          controller.recordBarrier(scenario.id, {
            name: "maintenance-requested",
            lifecycle: "maintenance",
            state: requested.maintenance?.state ?? requested.result,
            details: { kind: cases.maintenanceKind }
          });
          if (!requestClassification.shouldObserve) {
            return { state: requestClassification.lifecycleState };
          }
          const observe = () => maintenanceObserver.observe({
            kind: cases.maintenanceKind,
            knowledgeBaseId,
            knowledgeBaseId
          });
          const started = await waitForMaintenanceStart({
            kind: cases.maintenanceKind,
            preparedAt: prepared.preparedAt,
            observe,
            timeoutMs: 5 * 60_000
          });
          controller.recordBarrier(scenario.id, {
            name: "maintenance-started",
            lifecycle: "maintenance",
            state: started.state,
            details: {
              kind: cases.maintenanceKind,
              phase: started.phase,
              strategy: prepared.strategy
            }
          });
          if (started.terminal) {
            return { state: started.succeeded ? "completed" : "failed" };
          }
          const terminal = await waitForMaintenanceLifecycle({
            kind: cases.maintenanceKind,
            preparedAt: prepared.preparedAt,
            observe,
            timeoutMs: 10 * 60_000
          });
          return { state: terminal.succeeded ? "completed" : "failed" };
        }),
      deletion: () => startDeletion({
        scenario,
        deletionKind: cases.deletionKind,
        knowledgeBaseId,
        baseline,
        onKnowledgeBaseAccepted() {
          knowledgeBaseDeletionAccepted = true;
        },
        recordBarrier(details) {
          controller.recordBarrier(scenario.id, {
            name: "deletion-accepted",
            lifecycle: "deletion",
            state: "accepted",
            details
          });
        }
      })
    };

    const scheduled = await executeLifecycleSchedule({
      order: scenario.order,
      actions,
      deadlineAt: scenarioRun.deadlineAt
    });
    if (!knowledgeBaseDeletionAccepted) {
      const current = await readKnowledgeBase(knowledgeBaseId);
      if (current) {
        await waitForKnowledgeBaseWorkToSettle(
          knowledgeBaseId,
          remainingScenarioTime(scenarioRun.deadlineAt),
          { includeMaintenance: true }
        );
        lastSnapshot = await postgresEvidence.snapshotKnowledgeBase(knowledgeBaseId);
        const ledger = buildHandoffLedgerFromEvidence({
          postgres: lastSnapshot,
          redactor,
          scenarioId: scenario.id,
          publicOutcome: scheduled.outcomes.some((item) => item.state === "failed")
            ? "conflicted"
            : "succeeded"
        });
        writeJson(
          path.join(
            controller.state.evidenceDir,
            "ledgers",
            `${scenario.id}.json`
          ),
          ledger
        );
        assertHandoffLedger(ledger);
      }
    }

    const failedCount = scheduled.outcomes.filter(
      (outcome) => outcome.state === "failed"
    ).length;
    const outcome = failedCount === 0 ? "succeeded" : "conflicted";
    controller.completeScenario(scenario.id, { outcome });
    return {
      scenarioId: scenario.id,
      family: scenario.family,
      order: scenario.order,
      cases,
      outcome,
      lifecycleOutcomes: scheduled.outcomes
    };
  } catch (error) {
    const failure = buildScenarioFailure(error, {
      workspacePath: process.cwd()
    });
    controller.completeScenario(scenario.id, {
      outcome: "failed",
      ...failure
    });
    return {
      scenarioId: scenario.id,
      family: scenario.family,
      order: scenario.order,
      outcome: "failed",
      ...failure
    };
  } finally {
    if (knowledgeBaseId && !knowledgeBaseDeletionAccepted) {
      await deleteKnowledgeBaseAsAdmin(knowledgeBaseId).catch(() => undefined);
    }
    if (lastSnapshot) {
      lastSnapshot = null;
    }
    await controller.persist();
  }
}

function remainingScenarioTime(deadlineAt) {
  const remainingMs = Date.parse(deadlineAt) - Date.now();
  if (remainingMs <= 0) {
    throw codedError(
      "LIFECYCLE_DEADLINE_EXCEEDED",
      "Interleaved lifecycle exceeded its scenario deadline."
    );
  }
  return remainingMs;
}

function selectScenarios(limit, requestedIds) {
  const pairwise = buildDirectedPairwiseMatrix().map((scenario) => ({
    id: scenario.id,
    family: "pairwise",
    order: [scenario.activeLifecycle, scenario.startedLifecycle]
  }));
  const threeWay = buildThreeLifecyclePermutations().map((scenario) => ({
    id: scenario.id,
    family: "three-way",
    order: scenario.order
  }));
  const fourWay = buildFourLifecyclePermutations().map((scenario) => ({
    id: scenario.id,
    family: "four-way",
    order: scenario.order
  }));
  const completed = new Set(
    controller.state.scenarios
      .filter((scenario) => scenario.completedAt)
      .map((scenario) => scenario.scenarioId)
  );
  return selectInterleavedScenarios({
    scenarios: [...pairwise, ...threeWay, ...fourWay]
      .map((scenario, caseIndex) => ({ ...scenario, caseIndex })),
    completedIds: completed,
    requestedIds,
    limit
  });
}

function samplesForScenario(_caseIndex) {
  return linkedSamples;
}

function sampleBytes(sample) {
  return sample.bytes;
}

async function seedScenarioBaseline(input) {
  const upload = createUploadSessionPhaseClient({
    client: developer,
    knowledgeBaseId: input.knowledgeBaseId,
    idempotencyPrefix: `${runId}-${input.scenario.id}-baseline`
  });
  const files = [
    ...input.samples.map((sample) => ({
      relativePath: `baseline/${sample.basename}`,
      bytes: sampleBytes(sample)
    })),
    {
      relativePath: "baseline/nested/primary.md",
      bytes: Buffer.from(
        "# Primary control\n\nA link-free source for interleaved modification.\n"
      )
    },
    {
      relativePath: "baseline/secondary.md",
      bytes: Buffer.from(
        "# Secondary control\n\nA link-free source for interleaved deletion.\n"
      )
    }
  ];
  const created = await upload.create(files);
  const sessionId = created.session.id;
  controller.registerOwnership("uploadSessions", sessionId);
  await upload.appendManifest(sessionId);
  await upload.seal(sessionId);
  const reconciled = await reconcileUploadReservations(upload, sessionId);
  await upload.uploadMissingContent(sessionId, reconciled.entries);
  await upload.finalize(sessionId);
  await waitForUploadSession(upload, sessionId);
  const visible = await waitForVisibleSourceFiles(
    input.knowledgeBaseId,
    files.length
  );
  const primary = visible.find(
    (item) => item.relativePath === "baseline/nested/primary.md"
  );
  const secondary = visible.find(
    (item) => item.relativePath === "baseline/secondary.md"
  );
  const directories = await listSourceDirectories(input.knowledgeBaseId);
  const nested = directories.find(
    (item) => item.relativePath === "baseline/nested"
  );
  if (!primary || !secondary || !nested) {
    throw codedError(
      "BASELINE_RESOURCE_MISSING",
      "Scenario baseline did not expose its file and directory resources."
    );
  }
  await waitForKnowledgeBaseWorkToSettle(
    input.knowledgeBaseId,
    180_000,
    { includeMaintenance: true }
  );
  return {
    primarySourceFileId: primary.sourceFileId,
    secondarySourceFileId: secondary.sourceFileId,
    nestedDirectoryId: nested.directoryId
  };
}

function readClosedSamples(count) {
  const files = [];
  collectMarkdownFiles(sourceRoot, files);
  const selected = selectClosedMarkdownSample({
    filePaths: files,
    limit: count,
    readText: (filePath) => fs.readFileSync(filePath, "utf8")
  });
  return selected.map((filePath) => ({
    basename: path.basename(filePath),
    bytes: fs.readFileSync(filePath)
  }));
}

function collectMarkdownFiles(directory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) collectMarkdownFiles(target, files);
    else if (entry.isFile() && target.toLowerCase().endsWith(".md")) {
      files.push(target);
    }
  }
}

async function reconcileUploadReservations(upload, sessionId) {
  let current = await upload.reconcile(sessionId);
  for (
    let attempt = 0;
    current.session?.counts?.waitingReservation > 0 && attempt < 40;
    attempt += 1
  ) {
    await sleep(100);
    current = await upload.reconcile(sessionId);
  }
  if (current.session?.counts?.waitingReservation > 0) {
    throw codedError(
      "UPLOAD_RESERVATION_TIMEOUT",
      "Upload path reservations did not converge."
    );
  }
  return current;
}

async function waitForUploadSession(upload, sessionId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await upload.get(sessionId, { limit: 1 });
    const state = current.session?.state;
    if (state === "completed") return current.session;
    if (["cancelled", "expired", "failed"].includes(state)) {
      throw codedError(
        current.session?.error?.code ?? "UPLOAD_SESSION_FAILED",
        `Upload session ended in ${state}.`
      );
    }
    await sleep(200);
  }
  throw codedError("UPLOAD_SESSION_TIMEOUT", "Upload session did not converge.");
}

async function waitForVisibleSourceFiles(
  knowledgeBaseId,
  expectedMinimum,
  timeoutMs = 180_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = await listSourceFiles(knowledgeBaseId);
    if (
      files.length >= expectedMinimum
      && files.every((item) => item.state === "visible")
    ) {
      return files;
    }
    const failed = files.find((item) => item.state === "failed");
    if (failed) {
      throw codedError(
        failed.failure?.code ?? "SOURCE_FILE_FAILED",
        `Source file ${failed.relativePath} failed.`
      );
    }
    await sleep(250);
  }
  throw codedError(
    "SOURCE_VISIBILITY_TIMEOUT",
    "Source files did not reach visible state."
  );
}

async function listSourceFiles(knowledgeBaseId) {
  return listAll(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(
      knowledgeBaseId
    )}/source-files`
  );
}

async function listSourceDirectories(knowledgeBaseId) {
  const directories = [];
  const parents = ["root"];
  while (parents.length > 0) {
    const parentDirectoryId = parents.shift();
    const children = await listAll(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(
        knowledgeBaseId
      )}/source-directories?parentDirectoryId=${encodeURIComponent(
        parentDirectoryId
      )}`
    );
    directories.push(...children);
    parents.push(...children.map((item) => item.directoryId));
  }
  return directories;
}

async function listAll(pathname) {
  const items = [];
  let cursor = null;
  do {
    const separator = pathname.includes("?") ? "&" : "?";
    const page = await developer.json(
      `${pathname}${cursor ? `${separator}cursor=${encodeURIComponent(cursor)}` : ""}`
    );
    items.push(...(page.items ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return items;
}

async function readSourceFile(knowledgeBaseId, sourceFileId) {
  const response = await developer.request(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(
      knowledgeBaseId
    )}/source-files/${encodeURIComponent(sourceFileId)}`
  );
  if (response.status === 404) {
    throw codedError("NOT_FOUND", "Source file is unavailable.");
  }
  const body = await readResponseBody(response);
  if (!response.ok) throw responseError(response, body);
  return body.sourceFile;
}

async function readSourceDirectory(knowledgeBaseId, directoryId) {
  const response = await developer.request(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(
      knowledgeBaseId
    )}/source-directories/${encodeURIComponent(directoryId)}`
  );
  if (response.status === 404) {
    throw codedError("NOT_FOUND", "Source directory is unavailable.");
  }
  const body = await readResponseBody(response);
  if (!response.ok) throw responseError(response, body);
  return body.directory;
}

async function waitForOperation(
  knowledgeBaseId,
  operationId,
  timeoutMs = 180_000
) {
  const deadline = Date.now() + timeoutMs;
  const pathname = `/openapi/v2/knowledge-bases/${encodeURIComponent(
    knowledgeBaseId
  )}/operations/${encodeURIComponent(operationId)}`;
  while (Date.now() < deadline) {
    const response = await developer.request(pathname);
    if (response.status === 404) {
      throw codedError("NOT_FOUND", "Resource operation is unavailable.");
    }
    const body = await readResponseBody(response);
    if (!response.ok) throw responseError(response, body);
    const operation = body.operation;
    if (operation.state === "completed") return operation;
    if (["failed", "cancelled", "superseded"].includes(operation.state)) {
      throw codedError(
        operation.errorCode ?? "RESOURCE_OPERATION_FAILED",
        `Resource operation ended in ${operation.state}.`
      );
    }
    await sleep(200);
  }
  throw codedError(
    "RESOURCE_OPERATION_TIMEOUT",
    "Resource operation did not converge."
  );
}

async function startDeletion(input) {
  if (input.deletionKind === "task") {
    const response = await admin.json(
      `/admin/api/knowledge-bases/${encodeURIComponent(
        input.knowledgeBaseId
      )}/source-files/task-deletions`,
      {
        method: "POST",
        headers: { origin: adminOrigin },
        json: { sourceFileIds: [input.baseline.primarySourceFileId] }
      }
    );
    input.recordBarrier({
      kind: input.deletionKind,
      result: response.results?.[0]?.status ?? null
    });
    return { state: "completed" };
  }

  if (input.deletionKind === "knowledge-base") {
    const current = await readKnowledgeBase(input.knowledgeBaseId);
    if (!current) return { state: "completed" };
    const pathname = `/openapi/v2/knowledge-bases/${encodeURIComponent(
      input.knowledgeBaseId
    )}`;
    const response = await developer.request(pathname, {
      method: "DELETE",
      headers: {
        "idempotency-key": `${runId}-${input.scenario.id}-delete-kb`,
        "if-match": `"${current.resourceRevision}"`
      }
    });
    const body = await readResponseBody(response);
    if (!response.ok) throw responseError(response, body);
    input.onKnowledgeBaseAccepted();
    input.recordBarrier({ kind: input.deletionKind });
    return {
      async settle() {
        await waitUntilMissing(input.knowledgeBaseId);
        return { state: "completed" };
      }
    };
  }

  const isDirectory = input.deletionKind === "source-directory";
  const resource = isDirectory
    ? await readSourceDirectory(
        input.knowledgeBaseId,
        input.baseline.nestedDirectoryId
      )
    : await readSourceFile(
        input.knowledgeBaseId,
        input.baseline.primarySourceFileId
      );
  const resourceId = isDirectory ? resource.directoryId : resource.sourceFileId;
  const resourceType = isDirectory ? "source-directories" : "source-files";
  const pathname = `/openapi/v2/knowledge-bases/${encodeURIComponent(
    input.knowledgeBaseId
  )}/${resourceType}/${encodeURIComponent(resourceId)}`;
  const response = await developer.request(pathname, {
    method: "DELETE",
    headers: {
      "idempotency-key": `${runId}-${input.scenario.id}-delete-${resourceType}`,
      "if-match": `"${resource.resourceRevision}"`
    }
  });
  const body = await readResponseBody(response);
  if (!response.ok) throw responseError(response, body);
  input.recordBarrier({ kind: input.deletionKind });
  return {
    async settle() {
      await waitForOperation(
        input.knowledgeBaseId,
        body.operation.operationId
      );
      await waitForResourceMissing(pathname);
      return { state: "completed" };
    }
  };
}

async function waitForResourceMissing(pathname, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await developer.request(pathname);
    if (response.status === 404) return;
    if (!response.ok) {
      throw responseError(response, await readResponseBody(response));
    }
    await sleep(250);
  }
  throw codedError(
    "RESOURCE_DELETION_TIMEOUT",
    "Deleted resource remained visible."
  );
}

async function login() {
  await admin.json("/admin/api/login", {
    method: "POST",
    headers: { origin: adminOrigin },
    json: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
}

async function createOpenApiKey() {
  const response = await admin.json("/admin/api/openapi-keys", {
    method: "POST",
    headers: { origin: adminOrigin },
    json: { name: `interleaved-${runId}` },
    expectedStatus: 201
  });
  return {
    id: response.key.id,
    rawKey: response.oneTimeKey.rawKey
  };
}

async function requestKnowledgeBaseIndexMaintenance(input) {
  const response = await admin.request(
    `/admin/api/knowledge-bases/${encodeURIComponent(
      input.knowledgeBaseId
    )}/index-maintenance`,
    {
      method: "POST",
      headers: {
        origin: adminOrigin,
        "content-type": "application/json",
        "idempotency-key": input.idempotencyKey
      },
      json: { idempotencyKey: input.idempotencyKey }
    }
  );
  const body = await readResponseBody(response);
  if (!response.ok) throw responseError(response, body);
  return body;
}

async function readKnowledgeBase(knowledgeBaseId) {
  const response = await developer.request(
    `/openapi/v2/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`
  );
  if (response.status === 404) return null;
  const body = await readResponseBody(response);
  if (!response.ok) throw responseError(response, body);
  return body.knowledgeBase ?? body;
}

async function waitUntilMissing(knowledgeBaseId, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await readKnowledgeBase(knowledgeBaseId))) return;
    await sleep(250);
  }
  throw new Error("Knowledge-base deletion did not converge.");
}

async function waitForKnowledgeBaseWorkToSettle(
  knowledgeBaseId,
  timeoutMs = 180_000,
  options = { includeMaintenance: false }
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const summary = await admin.json(
      `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/processing-summary`
    );
    if (
      isKnowledgeBaseWorkSettled(summary, options)
      && !(await postgresEvidence.hasLiveWorkItems(knowledgeBaseId))
    ) return;
    await sleep(500);
  }
  throw new Error("Knowledge-base work did not converge.");
}

async function deleteKnowledgeBaseAsAdmin(knowledgeBaseId) {
  const response = await admin.request(
    `/admin/api/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}`,
    {
      method: "DELETE",
      headers: { origin: adminOrigin }
    }
  );
  if (response.status !== 200 && response.status !== 404) {
    throw responseError(response, await readResponseBody(response));
  }
  if (response.status === 200) {
    await waitUntilMissing(knowledgeBaseId);
  }
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function responseError(response, body) {
  const error = new Error(`Lifecycle request returned HTTP ${response.status}.`);
  error.code = body?.error?.code ?? `HTTP_${response.status}`;
  return error;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function lifecycleError(error) {
  if (error?.code) return error;
  const match = String(error?.message ?? "").match(/"code":"([^"]+)"/u);
  if (match) error.code = match[1];
  return error;
}

function readScenarioLimit() {
  const value = process.env.FOCOWIKI_INTERLEAVED_SCENARIO_LIMIT;
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 60) {
    throw new Error("FOCOWIKI_INTERLEAVED_SCENARIO_LIMIT must be between 1 and 60.");
  }
  return parsed;
}

function readScenarioIds() {
  const value = process.env.FOCOWIKI_INTERLEAVED_SCENARIO_IDS?.trim();
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readExistingResults(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const value = readJson(filePath);
  return Array.isArray(value?.scenarios) ? value.scenarios : [];
}

function mergePersistedScenarioResults(existing, persisted) {
  const byId = new Map(existing.map((result) => [result.scenarioId, result]));
  for (const scenario of persisted) {
    if (byId.has(scenario.scenarioId)) continue;
    byId.set(scenario.scenarioId, {
      scenarioId: scenario.scenarioId,
      family: scenario.family,
      order: scenario.lifecycles,
      outcome: scenario.outcome,
      errorCode: scenario.errorCode
    });
  }
  return [...byId.values()];
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function loadLocalEnv() {
  const envPath = process.env.ENV_FILE || ".env";
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
