import fs from "node:fs";
import path from "node:path";
import { aggregateCounts, latencySummary, scorePersonaResults, summarizeReportStagingPolicy } from "./agent-openapi-validation.mjs";

export const AGENT_REPORT_PATH = "ReferenceDocs/agent-openapi-exploration-agent-report.md";
export const DEVELOPER_REPORT_PATH = "ReferenceDocs/agent-openapi-exploration-developer-report.md";
export const OKF_REPORT_PATH = "ReferenceDocs/agent-openapi-exploration-okf-alignment-report.md";
export const DEMO_SKILL_CHANGE_ID = "validate-demo-skill-data-evaluation";
export const DEMO_SKILL_AGENT_REPORT_PATH = "ReferenceDocs/demo-skill-agent-exploration-report.md";
export const DEMO_SKILL_DEVELOPER_REPORT_PATH = "ReferenceDocs/demo-skill-data-evaluation-report.md";
export const DEMO_SKILL_OKF_REPORT_PATH = "ReferenceDocs/demo-skill-okf-alignment-report.md";

const REPORT_LOCALE = JSON.parse(
  fs.readFileSync(new URL("./agent-openapi-report.zh-CN.json", import.meta.url), "utf8")
);

export function redactAgentValidationText(value) {
  return String(value ?? "")
    .replace(/\/Users\/[^"'`\s)]+/g, "<redacted-path>")
    .replace(/\/home\/[^"'`\s)]+/g, "<redacted-path>")
    .replace(/\/private\/var\/[^"'`\s)]+/g, "<redacted-path>")
    .replace(/\/var\/folders\/[^"'`\s)]+/g, "<redacted-path>")
    .replace(/\/tmp\/[^"'`\s)]+/g, "<redacted-path>")
    .replace(/[A-Z]:\\Users\\[^"'`\s)]+/g, "<redacted-path>")
    .replace(/(Authorization:\s*Bearer\s+)[^"'`\s)]+/gi, "$1<redacted>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/g, "$1<redacted>")
    .replace(
      /(ADMIN_PASSWORD|ADMIN_SESSION_SECRET|PUBLIC_OPENAPI_KEY|OPENAPI_KEY|rawKey|S3_ACCESS_KEY_ID|S3_SECRET_ACCESS_KEY|MODEL_API_KEY|AUTHORIZATION|COOKIE|SESSION)\s*[:=]\s*[^,\s;}"']+/gi,
      "$1=<redacted>"
    )
    .replace(/knowledge-bases\/[^"'`\s)]+\/uploads\/[^"'`\s)]+/g, "knowledge-bases/<redacted-object-key>/uploads/<redacted-object-key>")
    .replace(/official[-_]flk[-_]sync[-_][^"'\s)]+/gi, "<redacted-fixture-root>")
    .replace(/fwok_[A-Za-z0-9._~+/-]+/g, "fwok_<redacted>");
}

export function writeAgentValidationReports(report) {
  fs.mkdirSync("ReferenceDocs", { recursive: true });
  const [agentReportPath, developerReportPath, okfReportPath] = reportPaths(report.change);
  writeRedacted(agentReportPath, renderAgentReport(report));
  writeRedacted(developerReportPath, renderDeveloperReport(report));
  writeRedacted(okfReportPath, renderOkfReport(report));
}

export function reportPaths(changeId = process.env.FOCOWIKI_AGENT_VALIDATION_CHANGE_ID || "") {
  if (changeId === DEMO_SKILL_CHANGE_ID) {
    return [DEMO_SKILL_AGENT_REPORT_PATH, DEMO_SKILL_DEVELOPER_REPORT_PATH, DEMO_SKILL_OKF_REPORT_PATH];
  }
  return [AGENT_REPORT_PATH, DEVELOPER_REPORT_PATH, OKF_REPORT_PATH];
}

function writeRedacted(filePath, text) {
  fs.writeFileSync(filePath, redactAgentValidationText(text));
}

function renderAgentReport(report) {
  const counts = aggregateCounts(report.agentResults);
  const scores = scorePersonaResults(report.agentResults);
  const latencies = latencySummary(report.latencies);
  return [
    `# ${REPORT_LOCALE.headings.agentReport}`,
    "",
    line("change", report.change),
    line("startedAt", report.startedAt),
    line("finishedAt", report.finishedAt),
    line("uploadedLegalFileCount", report.sampleCount),
    line("personaCount", Object.keys(counts.personas).length),
    line("scenarioCount", counts.scenarioCount),
    line("explorationRoundCount", counts.roundCount),
    line("evidenceCount", counts.evidenceCount),
    line("routeFailureCount", counts.routeFailureCount),
    line("endpointLatencyCount", latencies.count),
    line("endpointMedianLatencyMs", latencies.medianMs),
    line("endpointMaxLatencyMs", latencies.maxMs),
    line("agentExplorationScore", scores.combined.score),
    "",
    `## ${REPORT_LOCALE.headings.personaScores}`,
    "",
    ...Object.entries(scores).map(([persona, score]) =>
      `- ${translatePersona(persona)}:${metric("score", score.score)}, ${metric("count", score.count)}, ${metric("answerability", JSON.stringify(translateObjectKeys(score.answerability, translateAnswerability)))}`
    ),
    "",
    `## ${REPORT_LOCALE.headings.sampleCoverage}`,
    "",
    fenced(translateSampleCoverage(report.sampleCoverage)),
    "",
    `## ${REPORT_LOCALE.headings.scenarioResults}`,
    "",
    ...report.agentResults.flatMap(renderScenarioResult),
    "",
    `## ${REPORT_LOCALE.headings.unsupportedClaims}`,
    "",
    ...(report.unsupportedFindings.length
      ? report.unsupportedFindings.map((finding) => `- ${finding}`)
      : [REPORT_LOCALE.fallbacks.noneList]),
    ""
  ].join("\n");
}

function renderDeveloperReport(report) {
  return [
    `# ${REPORT_LOCALE.headings.developerReport}`,
    "",
    line("change", report.change),
    line("openapiRouteCountChecked", report.developer.routeCoverage.total),
    line("openapiRouteCountPassed", report.developer.routeCoverage.passed),
    line("schemaExampleGapCount", report.developer.schemaExampleGaps.length),
    line("identifierHandoffCount", report.developer.identifierHandoffs.length),
    line("paginationChecksPassed", report.developer.pagination.passed),
    line("paginationChecksFailed", report.developer.pagination.failed),
    line("errorClarityChecksPassed", report.developer.errors.passed),
    line("errorClarityChecksFailed", report.developer.errors.failed),
    line("demoBackendCoverageChecksPassed", report.developer.demo.passed),
    line("demoBackendCoverageChecksFailed", report.developer.demo.failed),
    line("skillCommandTotal", report.skillCommandSummary?.total ?? 0),
    line("skillCommandPassed", report.skillCommandSummary?.passed ?? 0),
    line("skillCommandFailed", report.skillCommandSummary?.failed ?? 0),
    line("skillCommandSkipped", report.skillCommandSummary?.skipped ?? 0),
    line("skillIdentifierContinuityPassed", report.skillCommandSummary?.identifierContinuityPassed ?? 0),
    line("skillIdentifierContinuityFailed", report.skillCommandSummary?.identifierContinuityFailed ?? 0),
    line("developerIntegrationScore", report.developer.score),
    "",
    `## ${REPORT_LOCALE.headings.identifierContinuity}`,
    "",
    ...report.developer.identifierHandoffs.map((item) => `- ${item.from} -> ${item.to}: ${item.field}`),
    "",
    `## ${REPORT_LOCALE.headings.schemaExampleGaps}`,
    "",
    ...(report.developer.schemaExampleGaps.length
      ? report.developer.schemaExampleGaps.map((gap) => `- ${gap}`)
      : [REPORT_LOCALE.fallbacks.noneList]),
    "",
    `## ${REPORT_LOCALE.headings.errorChecks}`,
    "",
    ...report.developer.errorChecks.map((item) => `- ${item.name}: ${metric("httpStatus", item.status)}, ${metric("errorCode", item.code || REPORT_LOCALE.fallbacks.none)}`),
    "",
    `## ${REPORT_LOCALE.headings.skillCommandCoverage}`,
    "",
    ...(report.skillCommands?.length
      ? report.skillCommands.map(renderSkillCommand)
      : [REPORT_LOCALE.fallbacks.noneList]),
    ""
  ].join("\n");
}

function renderOkfReport(report) {
  return [
    `# ${REPORT_LOCALE.headings.okfReport}`,
    "",
    line("change", report.change),
    line("generatedFileInventoryCount", report.okf.inventoryCount),
    line("reservedFileChecksPassed", report.okf.reservedFiles.passed),
    line("reservedFileChecksFailed", report.okf.reservedFiles.failed),
    line("conceptPageChecksPassed", report.okf.conceptPages.passed),
    line("conceptPageChecksFailed", report.okf.conceptPages.failed),
    line("indexChecksPassed", report.okf.indexes.passed),
    line("indexChecksFailed", report.okf.indexes.failed),
    line("graphChecksPassed", report.okf.graph.passed),
    line("graphChecksFailed", report.okf.graph.failed),
    line("privacyChecksPassed", report.okf.privacy.passed),
    line("privacyChecksFailed", report.okf.privacy.failed),
    line("securityLeakageCount", report.securityLeakageCount),
    line("okfAlignmentScore", report.okf.score),
    "",
    `## ${REPORT_LOCALE.headings.generatedInventory}`,
    "",
    ...report.okf.inventory.slice(0, 100).map((item) => `- ${item.path} (${translateFileKind(item.fileKind || item.entryType || "file")})`),
    "",
    `## ${REPORT_LOCALE.headings.graphEvidence}`,
    "",
    ...report.okf.graphEvidence.map((item) => `- ${item.path}: ${translateSummary(item.summary)}`),
    "",
    `## ${REPORT_LOCALE.headings.reportPolicy}`,
    "",
    fenced(translateReportPolicy(summarizeReportStagingPolicy())),
    ""
  ].join("\n");
}

function renderScenarioResult(result) {
  return [
    `### ${translatePersona(result.persona)} / ${translateScenarioType(result.scenarioType)}`,
    "",
    line("question", translateQuestion(result.question)),
    line("answerability", translateAnswerability(result.answerability)),
    line("stopStage", translateStopStage(result.stopStage)),
    line("stopReason", translateStopReason(result.stopReason)),
    line("score", result.score),
    line("filesRead", result.rounds.reduce((sum, round) => sum + round.metrics.filesRead, 0)),
    line("graphFilesRead", result.rounds.reduce((sum, round) => sum + round.metrics.graphFilesRead, 0)),
    line("relatedPagesFollowed", result.rounds.reduce((sum, round) => sum + round.metrics.relatedFilesFollowed, 0)),
    line("evidenceItemCount", result.evidence.length),
    "",
    `#### ${REPORT_LOCALE.headings.rounds}`,
    "",
    ...result.rounds.map((round) => `- ${round.round}. ${translateAction(round.action)} ${round.routeOrFile}: ${translateSummary(round.outputSummary)}; ${metric("nextStep", translateDecision(round.nextStepDecision))}; ${metric("roundScore", round.metrics.scoreContribution)}`),
    "",
    `#### ${REPORT_LOCALE.headings.evidence}`,
    "",
    ...(result.evidence.length
      ? result.evidence.map((item) => `- ${item.title || REPORT_LOCALE.fallbacks.untitled} (${item.path || item.fileId || REPORT_LOCALE.fallbacks.unknown})`)
      : [REPORT_LOCALE.fallbacks.noneList]),
    ""
  ];
}

function renderSkillCommand(command) {
  return [
    `- ${command.ok ? "PASS" : command.skipped ? "SKIP" : "FAIL"} ${command.name}: ${metric("httpStatus", command.httpStatus ?? REPORT_LOCALE.fallbacks.none)}, ${metric("latencyMs", command.latencyMs ?? 0)}, ${metric("identifierContinuity", command.identifierContinuity ? REPORT_LOCALE.fallbacks.yes : REPORT_LOCALE.fallbacks.no)}`,
    `  - ${REPORT_LOCALE.labels.command}: \`${command.command}\``,
    `  - ${REPORT_LOCALE.labels.responseShape}: \`${JSON.stringify(command.responseShape || {})}\``,
    command.errorCode ? `  - ${REPORT_LOCALE.labels.errorCode}: ${command.errorCode}` : ""
  ].filter(Boolean).join("\n");
}

function fenced(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function translatePersona(value) {
  return REPORT_LOCALE.personas[value] || value;
}

function translateScenarioType(value) {
  return REPORT_LOCALE.scenarioTypes[value] || value;
}

function translateAnswerability(value) {
  return REPORT_LOCALE.answerability[value] || value;
}

function translateStopStage(value) {
  return REPORT_LOCALE.stopStages[value] || value;
}

function translateStopReason(value) {
  return REPORT_LOCALE.stopReasons[value] || value;
}

function translateAction(value) {
  return REPORT_LOCALE.actions[value] || value;
}

function translateDecision(value) {
  return REPORT_LOCALE.decisions[value] || value;
}

function translateQuestion(value) {
  return String(value)
    .replace(/^Find the generated knowledge file for "(.+)" and cite the visible file evidence\.$/u, REPORT_LOCALE.questions.findGeneratedFile)
    .replace(/^Check the status or date metadata for "(.+)" using generated files only\.$/u, REPORT_LOCALE.questions.checkStatusOrDate)
    .replace(/^Compare the visible metadata and generated file evidence for "(.+)" and "(.+)"\.$/u, REPORT_LOCALE.questions.compareMetadata)
    .replace(/^Explore regional or issuer clues for "(.+)" and identify supporting generated files\.$/u, REPORT_LOCALE.questions.exploreRegionOrIssuer)
    .replace(/^Start from "(.+)" and follow visible graph or related-file evidence to another generated page\.$/u, REPORT_LOCALE.questions.followRelated)
    .replace(/^Determine whether the knowledge base contains a document titled __focowiki_validation_missing_document__\.$/u, REPORT_LOCALE.questions.missingDocument)
    .replace(/ Use legal reading order: title, status, date, issuer or region, then related laws\.$/u, REPORT_LOCALE.questions.legalReadingOrder);
}

function translateSummary(value) {
  return String(value)
    .replace(/^candidateCount=(\d+)$/u, REPORT_LOCALE.summaries.candidateCount)
    .replace(/^read page title=(.+)$/u, REPORT_LOCALE.summaries.readPageTitle)
    .replace(/^graph readable relatedPath=(.+)$/u, REPORT_LOCALE.summaries.graphReadableRelatedPath)
    .replace(/^related page read title=(.+)$/u, REPORT_LOCALE.summaries.relatedPageReadTitle)
    .replace(/^relatedCount=(\d+)$/u, REPORT_LOCALE.summaries.relatedCount)
    .replace(/^Parsed per-file graph neighborhood JSON\.$/u, REPORT_LOCALE.summaries.parsedPerFileGraph);
}

function translateSampleCoverage(value) {
  return {
    statuses: value.statuses,
    types: value.types,
    categories: value.categories,
    hasUnknownDate: value.includesUnknownDate,
    hasLongTitle: value.includesLongTitle,
    hasDuplicatedTitle: value.includesDuplicatedTitle,
    hasNonAsciiBasename: value.includesNonAsciiBasename,
    hasUnknownMetadata: value.includesUnknownMetadata,
    totalSizeBytes: value.totalSizeBytes
  };
}

function translateReportPolicy(value) {
  return {
    reportRoot: value.reportRoot,
    commitScope: value.commitScope === "local-only" ? REPORT_LOCALE.fallbacks.localOnly : value.commitScope,
    mustStageReports: value.mustStageReports
  };
}

function translateFileKind(value) {
  return REPORT_LOCALE.fileKinds[value] || value;
}

function translateObjectKeys(value, translator) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [translator(key), item]));
}

function line(labelKey, value) {
  return `- ${REPORT_LOCALE.labels[labelKey]}: ${value}`;
}

function metric(labelKey, value) {
  return `${REPORT_LOCALE.labels[labelKey]}=${value}`;
}
