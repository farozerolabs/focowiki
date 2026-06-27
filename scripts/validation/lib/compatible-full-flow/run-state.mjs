import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redactReportText } from "../redaction.mjs";

export const VALIDATION_MARKER_KEY = "validation.compatibleFullE2E.runId";

export function createValidationRunId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
  return `validation-${timestamp}-${randomUUID().slice(0, 8)}`;
}

export function createValidationMarker(runId) {
  return {
    [VALIDATION_MARKER_KEY]: runId,
    validationKind: "compatible-full-flow"
  };
}

export function createRunState({ runId = createValidationRunId(), reportDir }) {
  return {
    kind: "compatible-full-flow-run-state",
    runId,
    marker: createValidationMarker(runId),
    createdAt: new Date().toISOString(),
    updatedAt: null,
    reportDir: "<FOCOWIKI_VALIDATION_REPORT_DIR>",
    resources: {
      knowledgeBases: [],
      sourceFiles: [],
      webhooks: [],
      generatedFiles: [],
      screenshots: [],
      reports: []
    },
    cleanup: {
      attemptedAt: null,
      currentRunOnly: true,
      deleted: [],
      skipped: [],
      unresolved: []
    },
    localReportDir: reportDir ? path.basename(reportDir) : null
  };
}

export function recordValidationResource(state, type, resource) {
  const bucket = state.resources[type];

  if (!Array.isArray(bucket)) {
    throw new Error(`Unknown validation resource type: ${type}`);
  }

  const markerRunId = resource?.marker?.[VALIDATION_MARKER_KEY] ?? resource?.runId ?? state.runId;

  if (markerRunId !== state.runId) {
    throw new Error("Refusing to record a validation resource for another run.");
  }

  bucket.push({
    ...resource,
    runId: state.runId,
    marker: createValidationMarker(state.runId)
  });
  state.updatedAt = new Date().toISOString();
}

export function currentRunResources(state, type) {
  const bucket = type ? state.resources[type] ?? [] : Object.values(state.resources).flat();
  return bucket.filter((resource) => resource.runId === state.runId);
}

export function createCleanupPlan(state) {
  return {
    runId: state.runId,
    currentRunOnly: true,
    resources: Object.fromEntries(
      Object.entries(state.resources).map(([type, resources]) => [
        type,
        resources.filter((resource) => resource.runId === state.runId)
      ])
    )
  };
}

export function recordValidationCleanupResult(state) {
  state.cleanup.attemptedAt = new Date().toISOString();
  state.cleanup.currentRunOnly = true;
  state.cleanup.deleted = [];
  state.cleanup.skipped = [];
  state.cleanup.unresolved = [];

  for (const [type, resources] of Object.entries(state.resources)) {
    for (const resource of resources) {
      if (resource.runId !== state.runId) {
        state.cleanup.unresolved.push({
          type,
          id: resource.id ?? null,
          reason: "non-current-run-resource"
        });
        continue;
      }

      if (type === "reports" || type === "screenshots") {
        state.cleanup.skipped.push({
          type,
          id: resource.id ?? null,
          reason: "local-validation-evidence"
        });
        continue;
      }

      state.cleanup.deleted.push({
        type,
        id: resource.id ?? null,
        reason: "deleted-by-validation-flow"
      });
    }
  }

  state.updatedAt = new Date().toISOString();
}

export function diagnoseOlderValidationMarkers(resources, currentRunId) {
  return resources
    .filter((resource) => resource?.runId && resource.runId !== currentRunId)
    .map((resource) => ({
      type: resource.type ?? "unknown",
      id: resource.id ?? null,
      runId: resource.runId,
      action: "dry-run-only"
    }));
}

export function writeRunState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const safeState = JSON.parse(redactReportText(JSON.stringify(state, null, 2)));
  fs.writeFileSync(filePath, `${JSON.stringify(safeState, null, 2)}\n`);
}

export function readRunState(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
