export const REQUIRED_CLI_OPENAPI_CASE_IDS = Object.freeze([
  "CLI-OPENAPI-001",
  "CLI-OPENAPI-002",
  "CLI-OPENAPI-003",
  "CLI-OPENAPI-004",
  "CLI-OPENAPI-005",
  "CLI-OPENAPI-006",
  "CLI-OPENAPI-007",
  "CLI-OPENAPI-008"
]);

const CATEGORIES = new Set([
  "openapi_runtime_or_contract",
  "knowledge_base_implementation",
  "demo_cli_skill",
  "production_environment_only",
  "corpus_content",
  "non_defect",
  "unresolved"
]);

const REQUIRED_LAYERS = ["openapi", "demo", "cli", "skill"];

export function validateCliOpenApiDiagnosisReport(report) {
  const errors = [];
  const cases = Array.isArray(report?.cases) ? report.cases : [];

  for (const caseId of REQUIRED_CLI_OPENAPI_CASE_IDS) {
    const finding = cases.find((item) => item?.caseId === caseId);
    if (!finding) {
      errors.push(`${caseId} is missing`);
      continue;
    }
    if (!CATEGORIES.has(finding.category)) {
      errors.push(`${caseId} has an invalid category`);
    }
    for (const layer of REQUIRED_LAYERS) {
      if (!finding.layers?.[layer]) errors.push(`${caseId} is missing ${layer} evidence`);
    }
    if (finding.category === "unresolved" && finding.status === "fixed") {
      errors.push(`${caseId} cannot be fixed while unresolved`);
    }
    if (!finding.manualReview) errors.push(`${caseId} is missing manual review`);
    if (!finding.compatibility) errors.push(`${caseId} is missing compatibility evidence`);
    if (!finding.conclusion) errors.push(`${caseId} is missing a conclusion`);
  }

  if (Number(report?.corpusMutationCount ?? 0) !== 0) {
    errors.push("Corpus mutation is prohibited");
  }
  if (Array.isArray(report?.unrelatedChangedAreas) && report.unrelatedChangedAreas.length > 0) {
    errors.push(`Unrelated changed areas are prohibited: ${report.unrelatedChangedAreas.join(", ")}`);
  }
  if (/Authorization\s*:\s*Bearer\s+[^\s"']+/iu.test(JSON.stringify(report))) {
    errors.push("Report contains sensitive authorization data");
  }
  if (!report?.summary) errors.push("Report is missing an overall conclusion");
  return errors;
}
