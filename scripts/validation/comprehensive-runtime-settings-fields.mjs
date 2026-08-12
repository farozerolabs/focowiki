import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { createLifecycleHttpClient } from "./lib/interleaved-lifecycle-api.mjs";

loadLocalEnv();

const baseUrl = `http://127.0.0.1:${process.env.ADMIN_API_PORT || "43000"}`;
const origin = process.env.ADMIN_PUBLIC_ORIGIN || "http://127.0.0.1:43100";
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_RUNTIME_FIELDS_REPORT
    || "ReferenceDocs/validation/comprehensive-large-scale-release/runtime-settings-fields.json"
);
const client = createLifecycleHttpClient({ baseUrl });
const routes = Object.freeze({
  rateLimits: "rate-limits",
  worker: "worker",
  publication: "publication",
  graph: "graph",
  maintenance: "maintenance",
  semantic: "semantic",
  search: "search"
});
const rangeBounds = Object.freeze({
  "worker.sourceFileConcurrency": [1, 32],
  "worker.sourceObjectReadConcurrency": [1, 32],
  "worker.hardDeleteObjectBatchSize": [1, 1_000],
  "publication.generatedObjectWriteConcurrency": [1, 32],
  "graph.searchDefaultDepth": [0, 2],
  "graph.searchMaxDepth": [0, 2],
  "maintenance.knowledgeBaseMaintenanceScanIntervalSeconds": [60, 2_592_000],
  "maintenance.knowledgeBaseMaintenanceConcurrency": [1, 16],
  "maintenance.scanBatchSize": [1, 1_000],
  "maintenance.deletionBatchSize": [1, 1_000],
  "maintenance.projectionRepairConcurrency": [1, 16],
  "maintenance.projectionRepairDatabaseBatchSize": [100, 10_000],
  "maintenance.projectionRepairObjectWriteConcurrency": [1, 32],
  "maintenance.lexicalRebuildConcurrency": [1, 16],
  "maintenance.lexicalRebuildSourceReadConcurrency": [1, 32],
  "maintenance.lexicalRebuildMaxInFlightSourceBytes": [1_048_576, 536_870_912],
  "semantic.maximumChunkCharacters": [1, 64_000],
  "semantic.maximumChunks": [1, 32],
  "semantic.maximumEvidenceTargets": [1, 256],
  "semantic.maximumCommunityPartitions": [1, 256],
  "semantic.maximumCommunityEntities": [1, 10_000],
  "semantic.maximumCommunityRelationships": [0, 20_000],
  "semantic.maximumCommunityBoundaryRelationships": [0, 10_000],
  "semantic.maximumCommunitySummaryCharacters": [256, 65_536],
  "semantic.communityAdapterTimeoutMs": [100, 300_000],
  "semantic.searchLaneCutoffMs": [50, 3_000],
  "semantic.queryEmbeddingConcurrency": [1, 32],
  "semantic.queryEmbeddingCacheEntries": [1, 10_000],
  "search.requestTimeoutMs": [100, 30_000],
  "search.engineSearchCutoffMs": [50, 10_000],
  "search.overfetchFactor": [1, 10],
  "search.indexBatchDocumentCount": [1, 10_000],
  "search.indexBatchCompressedBytes": [65_536, 33_554_432],
  "search.maxInFlightTasks": [1, 32],
  "search.taskPollIntervalMs": [100, 30_000],
  "search.taskTimeoutMs": [10_000, 3_600_000],
  "search.maxAttempts": [1, 20],
  "search.retryDelayMs": [100, 300_000],
  "search.cleanupBatchSize": [1, 5_000],
  "search.stagingRetentionHours": [1, 720],
  "search.cropLength": [50, 5_000]
});
const positiveOnlyFields = new Set([
  "rateLimits.adminLogin.max",
  "rateLimits.adminLogin.windowSeconds",
  "rateLimits.adminApi.max",
  "rateLimits.adminApi.windowSeconds",
  "rateLimits.publicOpenApi.max",
  "rateLimits.publicOpenApi.windowSeconds",
  "worker.claimBatchSize",
  "worker.pollIntervalMs",
  "worker.lockTtlSeconds",
  "worker.heartbeatIntervalMs",
  "worker.jobMaxAttempts",
  "worker.jobRetryDelayMs",
  "worker.completedJobRetentionDays",
  "worker.hardDeleteConcurrency",
  "worker.hardDeleteDatabaseBatchSize",
  "worker.hardDeleteMaxAttempts",
  "worker.hardDeleteRetryDelayMs",
  "publication.intervalSeconds",
  "publication.roleConcurrency",
  "publication.claimBatchSize",
  "publication.directoryIndexMaxEntries",
  "publication.directoryIndexMaxBytes",
  "graph.candidateLimit",
  "graph.acceptedEdgeLimit",
  "graph.searchDefaultFanout",
  "graph.searchMaxFanout",
  "graph.genericPhraseThreshold",
  "maintenance.quarantineGracePeriodSeconds",
  "maintenance.maxAttempts",
  "maintenance.retryDelayMs"
]);
const report = {
  kind: "focowiki-comprehensive-runtime-settings-fields",
  version: 1,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  fields: [],
  cleanup: { originalSectionsRestored: false }
};
let originalSettings = null;

try {
  await client.json("/admin/api/login", {
    method: "POST",
    headers: { origin },
    json: {
      username: requiredEnv("ADMIN_USERNAME"),
      password: requiredEnv("ADMIN_PASSWORD")
    }
  });
  const initial = await client.json("/admin/api/settings/runtime");
  originalSettings = structuredClone(initial.settings);
  const raised = structuredClone(originalSettings.rateLimits);
  raised.adminApi.max = Math.max(10_000, raised.adminApi.max);
  await updateSection("rateLimits", raised, 200);
  const working = await client.json("/admin/api/settings/runtime");
  const fields = Object.keys(routes).flatMap((section) =>
    flattenLeaves(working.settings[section]).map((leaf) => ({ section, ...leaf }))
  );
  assert(fields.length > 0, "Runtime settings produced no fields.");

  for (const field of fields) {
    const route = routes[field.section];
    const id = `${field.section}.${field.path.join(".")}`;
    const sectionSnapshot = structuredClone(working.settings[field.section]);
    const cases = [];

    await updateSection(field.section, sectionSnapshot, 200);
    cases.push("current-save");
    assert(
      same(readPath((await client.json("/admin/api/settings/runtime")).settings[field.section], field.path),
        field.value),
      `${id} did not persist its current value.`
    );
    cases.push("current-reload");

    const missing = structuredClone(sectionSnapshot);
    deletePath(missing, field.path);
    await updateSection(field.section, missing, 400);
    cases.push("missing-rejected");

    const nullable = structuredClone(sectionSnapshot);
    writePath(nullable, field.path, null);
    await updateSection(field.section, nullable, 400);
    cases.push("null-rejected");

    const wrongType = structuredClone(sectionSnapshot);
    writePath(wrongType, field.path, wrongTypeValue(field.value));
    await updateSection(field.section, wrongType, 400);
    cases.push("wrong-type-rejected");

    const bounds = boundsFor(id, field.value);
    if (!bounds) {
      cases.push(
        "minimum-not-applicable",
        "below-minimum-not-applicable",
        "maximum-not-applicable",
        "above-maximum-not-applicable"
      );
    } else if (id === "rateLimits.adminApi.max") {
      cases.push(
        "minimum-covered-by-isolated-rate-limit-suite",
        "below-minimum-rejected"
      );
      const below = structuredClone(sectionSnapshot);
      writePath(below, field.path, bounds.minimum - 1);
      await updateSection(field.section, below, 400);
      cases.push("maximum-not-defined", "above-maximum-not-applicable");
    } else {
      const minimum = structuredClone(sectionSnapshot);
      prepareBoundary(id, minimum, bounds.minimum);
      writePath(minimum, field.path, bounds.minimum);
      await exerciseAcceptedBoundary({
        id,
        section: field.section,
        path: field.path,
        value: bounds.minimum,
        candidate: minimum,
        restore: sectionSnapshot,
        cases,
        label: "minimum"
      });

      const below = structuredClone(sectionSnapshot);
      prepareBoundary(id, below, bounds.minimum - 1);
      writePath(below, field.path, bounds.minimum - 1);
      await updateSection(field.section, below, 400);
      cases.push("below-minimum-rejected");

      if (bounds.maximum === null) {
        cases.push("maximum-not-defined", "above-maximum-not-applicable");
      } else {
        const maximum = structuredClone(sectionSnapshot);
        prepareBoundary(id, maximum, bounds.maximum);
        writePath(maximum, field.path, bounds.maximum);
        await exerciseAcceptedBoundary({
          id,
          section: field.section,
          path: field.path,
          value: bounds.maximum,
          candidate: maximum,
          restore: sectionSnapshot,
          cases,
          label: "maximum",
          allowCapacityRejection: true
        });

        const above = structuredClone(sectionSnapshot);
        prepareBoundary(id, above, bounds.maximum + 1);
        writePath(above, field.path, bounds.maximum + 1);
        await updateSection(field.section, above, 400);
        cases.push("above-maximum-rejected");
      }
    }

    const alternate = structuredClone(sectionSnapshot);
    prepareAlternate(id, alternate);
    const alternateValue = alternateValueFor(id, field.value, sectionSnapshot);
    if (alternateValue === null) {
      cases.push("alternate-not-applicable-at-deployment-capacity");
    } else {
      writePath(alternate, field.path, alternateValue);
      await updateSection(field.section, alternate, 200);
      cases.push("alternate-save");
      const reloaded = await client.json("/admin/api/settings/runtime");
      assert(
        same(readPath(reloaded.settings[field.section], field.path), alternateValue),
        `${id} did not reload its alternate value.`
      );
      cases.push("alternate-reload");
    }

    await updateSection(field.section, sectionSnapshot, 200);
    cases.push("restored");
    report.fields.push({ id, cases });
  }

  report.ok = true;
} finally {
  if (originalSettings) {
    try {
      for (const section of [
        "worker", "publication", "graph", "maintenance", "search", "semantic"
      ]) {
        await updateSection(section, originalSettings[section], 200);
      }
      await updateSection("rateLimits", originalSettings.rateLimits, 200);
      report.cleanup.originalSectionsRestored = true;
    } catch {
      report.cleanup.originalSectionsRestored = false;
    }
  }
  await client.request("/admin/api/logout", { method: "POST", headers: { origin } })
    .catch(() => undefined);
  report.finishedAt = new Date().toISOString();
  report.ok = report.ok && report.cleanup.originalSectionsRestored;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    fieldCount: report.fields.length,
    caseCount: report.fields.reduce((total, field) => total + field.cases.length, 0),
    cleanup: report.cleanup,
    reportPath
  })}\n`);
}

async function updateSection(section, value, expectedStatus) {
  const body = await client.json(`/admin/api/settings/${routes[section]}`, {
    method: "PUT",
    headers: { origin },
    json: value,
    expectedStatus
  });
  if (expectedStatus === 400) {
    assert(
      body?.error?.code === "RUNTIME_SETTINGS_VALIDATION_FAILED"
        && Array.isArray(body.error.issues)
        && body.error.issues.length > 0,
      `${section} did not return the stable validation error envelope.`
    );
  }
  return body;
}

async function exerciseAcceptedBoundary(input) {
  let semanticRestore = null;
  if (input.id === "search.requestTimeoutMs") {
    const current = await client.json("/admin/api/settings/runtime");
    if (current.settings.semantic.searchLaneCutoffMs > input.value) {
      semanticRestore = structuredClone(current.settings.semantic);
      const semanticCandidate = structuredClone(semanticRestore);
      semanticCandidate.searchLaneCutoffMs = Math.min(input.value, 50);
      await updateSection("semantic", semanticCandidate, 200);
      input.cases.push(`${input.label}-semantic-dependency-prepared`);
    }
  }
  const outcome = await attemptUpdateSection(input.section, input.candidate);
  if (outcome.status === 400 && input.allowCapacityRejection) {
    assertValidationEnvelope(outcome.body, input.section);
    assert(
      outcome.body.error.issues.some((issue) => /Capacity$/.test(String(issue.field))),
      `${input.id} ${input.label} was rejected for a non-capacity reason.`
    );
    input.cases.push(`${input.label}-rejected-by-deployment-capacity`);
    if (semanticRestore) await updateSection("semantic", semanticRestore, 200);
    return;
  }
  if (outcome.status !== 200 && semanticRestore) {
    await updateSection("semantic", semanticRestore, 200);
  }
  assert(outcome.status === 200, `${input.id} ${input.label} returned HTTP ${outcome.status}.`);
  input.cases.push(`${input.label}-save`);
  const reloaded = await client.json("/admin/api/settings/runtime");
  assert(
    same(readPath(reloaded.settings[input.section], input.path), input.value),
    `${input.id} did not reload its ${input.label} value.`
  );
  input.cases.push(`${input.label}-reload`);
  await updateSection(input.section, input.restore, 200);
  input.cases.push(`${input.label}-restored`);
  if (semanticRestore) {
    await updateSection("semantic", semanticRestore, 200);
    input.cases.push(`${input.label}-semantic-dependency-restored`);
  }
}

async function attemptUpdateSection(section, value) {
  const response = await client.request(`/admin/api/settings/${routes[section]}`, {
    method: "PUT",
    headers: { origin, "content-type": "application/json" },
    rawBody: JSON.stringify(value)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function assertValidationEnvelope(body, section) {
  assert(
    body?.error?.code === "RUNTIME_SETTINGS_VALIDATION_FAILED"
      && Array.isArray(body.error.issues)
      && body.error.issues.length > 0,
    `${section} did not return the stable validation error envelope.`
  );
}

function flattenLeaves(value, prefix = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [{ path: prefix, value }];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flattenLeaves(child, [...prefix, key])
  );
}

function alternateValueFor(id, value, section) {
  if (typeof value === "boolean") return !value;
  if (typeof value === "string") {
    if (id === "publication.mode") {
      return value === "manual" ? "batch" : "manual";
    }
    if (id === "maintenance.knowledgeBaseMaintenanceMode") {
      return value === "manual" ? "automatic" : "manual";
    }
    throw new Error(`No alternate enum is defined for ${id}.`);
  }
  if (id === "worker.sourceFileConcurrency") return 1;
  if (id === "worker.sourceObjectReadConcurrency") return 1;
  if (id === "worker.hardDeleteConcurrency" && value === 1) return null;
  if (id === "publication.roleConcurrency") return 1;
  if (id === "maintenance.knowledgeBaseMaintenanceConcurrency" && value === 1) {
    return null;
  }
  if (id === "graph.searchDefaultDepth") return value === 0 ? 1 : 0;
  if (id === "graph.searchMaxDepth") {
    return Math.max(Number(section.searchDefaultDepth), value === 2 ? 1 : 2);
  }
  if (id === "graph.searchDefaultFanout") return 1;
  if (id === "graph.searchMaxFanout") {
    return Math.max(Number(section.searchDefaultFanout), value - 1);
  }
  return value > 1 ? value - 1 : value + 1;
}

function prepareAlternate(id, section) {
  if (id === "worker.sourceFileConcurrency") {
    section.sourceObjectReadConcurrency = 1;
  }
}

function boundsFor(id, value) {
  if (typeof value !== "number") return null;
  const range = rangeBounds[id];
  if (range) return { minimum: range[0], maximum: range[1] };
  if (positiveOnlyFields.has(id)) return { minimum: 1, maximum: null };
  throw new Error(`No numeric boundary contract is defined for ${id}.`);
}

function prepareBoundary(id, section, value) {
  if (id === "worker.sourceFileConcurrency") {
    section.sourceObjectReadConcurrency = Math.min(section.sourceObjectReadConcurrency, value);
    section.claimBatchSize = Math.max(section.claimBatchSize, value);
  }
  if (id === "worker.sourceObjectReadConcurrency") {
    section.sourceFileConcurrency = Math.max(section.sourceFileConcurrency, value);
    section.claimBatchSize = Math.max(section.claimBatchSize, section.sourceFileConcurrency);
  }
  if (id === "worker.claimBatchSize") {
    section.sourceFileConcurrency = Math.min(section.sourceFileConcurrency, value);
    section.sourceObjectReadConcurrency = Math.min(
      section.sourceObjectReadConcurrency,
      section.sourceFileConcurrency
    );
  }
  if (id === "publication.roleConcurrency") {
    section.claimBatchSize = Math.max(section.claimBatchSize, value);
  }
  if (id === "publication.claimBatchSize") {
    section.roleConcurrency = Math.min(section.roleConcurrency, value);
  }
  if (id === "graph.searchDefaultDepth") {
    section.searchMaxDepth = Math.max(section.searchMaxDepth, value);
  }
  if (id === "graph.searchMaxDepth") {
    section.searchDefaultDepth = Math.min(section.searchDefaultDepth, value);
  }
  if (id === "graph.searchDefaultFanout") {
    section.searchMaxFanout = Math.max(section.searchMaxFanout, value);
  }
  if (id === "graph.searchMaxFanout") {
    section.searchDefaultFanout = Math.min(section.searchDefaultFanout, value);
  }
  if (id === "search.requestTimeoutMs") {
    section.engineSearchCutoffMs = Math.min(section.engineSearchCutoffMs, value);
  }
  if (id === "search.engineSearchCutoffMs") {
    section.requestTimeoutMs = Math.max(section.requestTimeoutMs, value);
  }
}

function wrongTypeValue(value) {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  return 1;
}

function readPath(target, segments) {
  return segments.reduce((value, segment) => value?.[segment], target);
}

function writePath(target, segments, value) {
  let current = target;
  for (const segment of segments.slice(0, -1)) current = current[segment];
  current[segments.at(-1)] = value;
}

function deletePath(target, segments) {
  let current = target;
  for (const segment of segments.slice(0, -1)) current = current[segment];
  delete current[segments.at(-1)];
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function loadLocalEnv() {
  const envPath = path.resolve(process.env.ENV_FILE || ".env");
  if (fs.existsSync(envPath)) loadEnvFile(envPath);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
