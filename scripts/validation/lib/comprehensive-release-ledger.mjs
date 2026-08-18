import { redactReportText } from "./redaction.mjs";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export function assertCompleteAuditResult(report) {
  if (report?.schemaVersion !== 1) {
    throw new Error("Unsupported comprehensive audit schema version");
  }
  if (!/^validation-\d{14}-[a-f0-9]{8}$/u.test(String(report.runId ?? ""))) {
    throw new Error("Comprehensive audit run ID is invalid");
  }
  if (report.coverageMode !== "exhaustive") {
    throw new Error("Comprehensive audit coverage must be exhaustive");
  }
  if (
    !report.applicationFingerprint
    || report.evidenceFingerprint !== report.applicationFingerprint
  ) {
    throw new Error("Comprehensive audit evidence is stale");
  }

  const expectedItems = requireUniqueIds(report.expectedItems, "expected item");
  if (expectedItems.length === 0) {
    throw new Error("Comprehensive audit cannot pass with zero expected items");
  }

  assertExactResults("automated", expectedItems, report.automatedResults);
  assertExactResults("manual", expectedItems, report.manualResults);
  assertExactResults("cleanup", expectedItems, report.cleanupResults);

  const corpusFiles = requireUniqueIds(report.corpusFiles, "corpus file");
  if (corpusFiles.length !== 200) {
    throw new Error(`Comprehensive audit requires exactly 200 corpus files, found ${corpusFiles.length}`);
  }
  assertExactResults("corpus automated", corpusFiles, report.corpusAutomatedResults);
  assertExactResults("corpus manual", corpusFiles, report.corpusManualResults);
  assertExactResults("corpus cleanup", corpusFiles, report.corpusCleanupResults);

  for (const skipped of report.skipped ?? []) {
    if (!String(skipped?.id ?? "") || !String(skipped?.reason ?? "").trim()) {
      throw new Error("Skipped audit item is missing an explicit reason");
    }
    if (skipped.required !== false) {
      throw new Error(`Required audit item cannot be skipped: ${skipped.id}`);
    }
  }

  for (const resource of report.resources ?? []) {
    if (!resource?.owned || !String(resource.id ?? "").includes(report.runId)) {
      throw new Error(`Audit resource is unowned: ${String(resource?.id ?? "unknown")}`);
    }
  }

  for (const evidence of report.sanitizedEvidence ?? []) {
    const serialized = typeof evidence === "string" ? evidence : JSON.stringify(evidence);
    if (redactReportText(serialized) !== serialized) {
      throw new Error("Comprehensive audit evidence contains private or secret data");
    }
  }
}

function requireUniqueIds(items, label) {
  if (!Array.isArray(items)) {
    throw new Error(`Comprehensive audit ${label} list is missing`);
  }
  const normalized = items.map((item) =>
    typeof item === "string" ? item : String(item?.id ?? "")
  );
  if (normalized.some((id) => !id) || new Set(normalized).size !== normalized.length) {
    throw new Error(`Comprehensive audit ${label} identities are invalid`);
  }
  return normalized;
}

function assertExactResults(kind, expectedItems, results) {
  const resultIds = requireUniqueIds(results, `${kind} result`);
  const missing = expectedItems.filter((id) => !resultIds.includes(id));
  const extra = resultIds.filter((id) => !expectedItems.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${kind} result cardinality mismatch`);
  }

  for (const result of results) {
    if (result.status !== "pass" || !HASH_PATTERN.test(String(result.evidenceHash ?? ""))) {
      throw new Error(`${kind} result is incomplete: ${String(result.id ?? "unknown")}`);
    }
  }
}
