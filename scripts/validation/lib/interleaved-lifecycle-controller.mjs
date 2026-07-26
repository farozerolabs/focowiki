import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createInterleavedRunState,
  registerInterleavedOwnership
} from "./interleaved-lifecycle-run-state.mjs";

const RUN_ID_PATTERN = /^validation-\d{14}-[a-f0-9]{8}$/u;

export function createValidationRunId(
  now = new Date(),
  entropy = crypto.randomBytes(4)
) {
  const timestamp = now
    .toISOString()
    .replaceAll(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "")
    .replace("T", "");
  return `validation-${timestamp}-${Buffer.from(entropy).toString("hex").slice(0, 8)}`;
}

export function buildScenarioKnowledgeBaseName(runId, scenarioId) {
  if (!RUN_ID_PATTERN.test(runId) || !scenarioId) {
    throw new Error("Scenario knowledge-base naming requires a valid run and scenario.");
  }
  return `Interleaved ${runId} ${scenarioId}`;
}

export function createInterleavedLifecycleController(input) {
  const cleanupCallbacks = [];
  const initialState = createInterleavedRunState({
    runId: input.runId,
    seed: input.seed,
    reportRoot: input.reportRoot
  });
  const statePath = path.join(initialState.evidenceDir, "run-state.json");
  let state = initialState;

  const controller = {
    statePath,
    get state() {
      return state;
    },
    async initialize() {
      fs.mkdirSync(state.evidenceDir, { recursive: true });
      if (fs.existsSync(statePath)) {
        const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
        if (
          persisted.runId !== initialState.runId ||
          persisted.seed !== initialState.seed
        ) {
          throw new Error("Persisted validation state does not match this run.");
        }
        state = {
          ...persisted,
          evidenceDir: initialState.evidenceDir
        };
      } else {
        await controller.persist();
      }
      return state;
    },
    registerOwnership(kind, identity) {
      const registered = registerInterleavedOwnership(state, kind, identity);
      void controller.persist();
      return registered;
    },
    startScenario(scenarioInput) {
      if (!scenarioInput?.scenarioId) {
        throw new Error("Interleaved scenario identity is required.");
      }
      const existingIndex = state.scenarios.findIndex(
        (scenario) => scenario.scenarioId === scenarioInput.scenarioId
      );
      if (
        existingIndex !== -1
        && state.scenarios[existingIndex]?.completedAt
      ) {
        throw new Error("Interleaved scenario identity must be unique.");
      }
      const startedAt = new Date();
      const deadlineMs = positiveInteger(
        scenarioInput.deadlineMs,
        10 * 60_000
      );
      const scenario = {
        scenarioId: scenarioInput.scenarioId,
        family: scenarioInput.family ?? null,
        lifecycles: scenarioInput.lifecycles ?? [],
        barriers: [],
        startedAt: startedAt.toISOString(),
        deadlineAt: new Date(startedAt.getTime() + deadlineMs).toISOString(),
        completedAt: null,
        outcome: "running",
        errorCode: null
      };
      if (existingIndex === -1) state.scenarios.push(scenario);
      else state.scenarios[existingIndex] = scenario;
      void controller.persist();
      return scenario;
    },
    recordBarrier(scenarioId, barrier) {
      const scenario = requireScenario(state, scenarioId);
      scenario.barriers.push({
        name: barrier.name,
        lifecycle: barrier.lifecycle,
        state: barrier.state,
        details: barrier.details ?? null,
        observedAt: new Date().toISOString()
      });
      void controller.persist();
    },
    completeScenario(scenarioId, result) {
      const scenario = requireScenario(state, scenarioId);
      scenario.outcome = result.outcome;
      scenario.errorCode = result.errorCode ?? null;
      scenario.errorMessage = result.errorMessage ?? null;
      scenario.completedAt = new Date().toISOString();
      void controller.persist();
      return scenario;
    },
    addFinding(finding) {
      state.findings.push({
        scenarioId: finding.scenarioId ?? null,
        severity: finding.severity,
        code: finding.code,
        summary: finding.summary
      });
      void controller.persist();
    },
    registerCleanup(name, callback) {
      if (!name || typeof callback !== "function") {
        throw new Error("Cleanup registration requires name and callback.");
      }
      cleanupCallbacks.push({ name, callback });
    },
    async cleanup() {
      state.cleanup.attempted = true;
      state.cleanup.unresolved = [];

      for (const cleanup of [...cleanupCallbacks].reverse()) {
        try {
          await cleanup.callback();
        } catch (error) {
          state.cleanup.unresolved.push({
            name: cleanup.name,
            errorCode: error?.code ?? "CLEANUP_FAILED"
          });
        }
      }

      state.cleanup.completed = state.cleanup.unresolved.length === 0;
      state.finishedAt = new Date().toISOString();
      await controller.persist();
      if (!state.cleanup.completed) {
        throw new Error("Interleaved validation cleanup did not converge.");
      }
    },
    async persist() {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const temporaryPath = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const persistedState = {
        ...state,
        evidenceDir: path.join(
          "ReferenceDocs",
          "validate-interleaved-lifecycle-e2e",
          "runs",
          state.runId
        )
      };
      fs.writeFileSync(
        temporaryPath,
        `${JSON.stringify(persistedState, null, 2)}\n`,
        { mode: 0o600 }
      );
      fs.renameSync(temporaryPath, statePath);
    }
  };

  return controller;
}

export function assertMutationE2ESafety(input) {
  if (input?.baselinePassed !== true) {
    throw new Error("Mutation E2E requires a passing repository baseline.");
  }
  if (
    !RUN_ID_PATTERN.test(input?.state?.runId ?? "") ||
    !String(input?.state?.evidenceDir ?? "").includes(
      `${path.sep}validate-interleaved-lifecycle-e2e${path.sep}runs${path.sep}`
    )
  ) {
    throw new Error("Mutation E2E requires isolated validation ownership.");
  }
  return true;
}

function requireScenario(state, scenarioId) {
  const scenario = state.scenarios.find(
    (candidate) => candidate.scenarioId === scenarioId
  );
  if (!scenario) throw new Error(`Unknown interleaved scenario: ${scenarioId}.`);
  return scenario;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
