import { createHash } from "node:crypto";

const REQUIRED_CHECKS = Object.freeze([
  "manifest",
  "upload",
  "processing",
  "tree",
  "content",
  "generated",
  "graph",
  "search",
  "vector",
  "originalRead",
  "crud",
  "crossFileImpact",
  "directoryImpact",
  "manualUi"
]);
const AGGREGATE_EVIDENCE_IDS = new Set([
  "aggregate-pass",
  "bulk-pass",
  "category-pass",
  "percentage-only"
]);

export function buildComprehensiveCorpusManualReconciliation(input) {
  const runId = String(input?.runId ?? "");
  if (!/^validation-\d{14}-[a-f0-9]{8}$/u.test(runId)) {
    throw new Error("Comprehensive corpus manual run ID is invalid");
  }
  if (!Array.isArray(input?.files) || input.files.length !== 200) {
    throw new Error("Comprehensive corpus manual reconciliation requires exactly 200 files");
  }
  const aliases = input.files.map((item) => requiredString(item?.alias, "corpus alias"));
  if (new Set(aliases).size !== aliases.length) {
    throw new Error("Comprehensive corpus manual reconciliation contains a duplicate corpus alias");
  }
  const cleanupCompleted = input.cleanupCompleted === true;
  const rows = input.files.map((item) => {
    const alias = requiredString(item.alias, "corpus alias");
    const family = requiredString(item.family, "corpus family");
    if (!Array.isArray(item.evidenceIds) || item.evidenceIds.length === 0) {
      throw new Error(`Comprehensive corpus manual evidence is missing: ${alias}`);
    }
    const evidenceIds = item.evidenceIds.map((value) => requiredString(value, "evidence ID"));
    if (evidenceIds.some((value) => AGGREGATE_EVIDENCE_IDS.has(value))) {
      throw new Error(`Comprehensive corpus manual contains aggregate evidence: ${alias}`);
    }
    if (new Set(evidenceIds).size !== evidenceIds.length) {
      throw new Error(`Comprehensive corpus manual contains duplicate evidence: ${alias}`);
    }
    for (const check of REQUIRED_CHECKS) {
      if (item.checks?.[check] !== true) {
        throw new Error(`Comprehensive corpus manual check failed: ${alias}:${check}`);
      }
    }
    const checks = Object.fromEntries(REQUIRED_CHECKS.map((check) => [check, true]));
    return {
      id: `corpus-manual:${alias}`,
      alias,
      family,
      checks,
      evidenceIds,
      evidenceHash: sha256(stableStringify({ alias, family, checks, evidenceIds })),
      manualStatus: "pass",
      cleanupStatus: cleanupCompleted ? "pass" : "pending"
    };
  }).sort((left, right) => left.alias.localeCompare(right.alias));
  return {
    schemaVersion: 1,
    kind: "focowiki-comprehensive-corpus-manual-reconciliation",
    runId,
    coverageMode: "exhaustive",
    generatedAt: new Date().toISOString(),
    requiredChecks: [...REQUIRED_CHECKS],
    reviewOk: true,
    cleanupOk: cleanupCompleted,
    summary: {
      expected: 200,
      reviewed: 200,
      reviewPassed: 200,
      cleanupPassed: cleanupCompleted ? 200 : 0,
      cleanupPending: cleanupCompleted ? 0 : 200
    },
    rows
  };
}

function requiredString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`Comprehensive corpus manual ${label} is missing`);
  return normalized;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
