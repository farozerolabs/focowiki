import test from "node:test";
import assert from "node:assert/strict";

import {
  MIN_AGENT_VALIDATION_SAMPLE_COUNT,
  assertAgentEvidenceBoundary,
  buildAgentScenarioPlan,
  defaultAgentProcessingTimeoutMs,
  requireQuantifiedFindings,
  requireValidationSampleCount,
  scorePersonaResults,
  summarizeReportStagingPolicy
} from "../lib/agent-openapi-validation.mjs";
import { redactAgentValidationText } from "../lib/agent-openapi-report.mjs";

test("agent validation requires at least 50 Markdown samples", () => {
  assert.equal(MIN_AGENT_VALIDATION_SAMPLE_COUNT, 50);
  assert.throws(
    () => requireValidationSampleCount(new Array(49).fill({ basename: "sample.md" })),
    /at least 50/
  );
});

test("agent validation processing timeout scales for 50-file model runs", () => {
  assert.equal(defaultAgentProcessingTimeoutMs(50), 4_500_000);
  assert.equal(defaultAgentProcessingTimeoutMs(10), 1_800_000);
});

test("agent scenario plan includes generic and domain personas with varied task coverage", () => {
  const samples = buildSamples(52);
  const plan = buildAgentScenarioPlan(samples);

  assert.equal(new Set(plan.map((scenario) => scenario.persona)).has("generic"), true);
  assert.equal(new Set(plan.map((scenario) => scenario.persona)).has("domain"), true);
  assert.equal(new Set(plan.map((scenario) => scenario.scenarioType)).size >= 5, true);
  assert.equal(plan.every((scenario) => scenario.question && scenario.expectedVisibleClues.length > 0), true);
});

test("persona scores stay separate before combined scoring", () => {
  const scores = scorePersonaResults([
    { persona: "generic", answerability: "partially_answered", score: 62 },
    { persona: "domain", answerability: "answered", score: 86 }
  ]);

  assert.equal(scores.generic.score, 62);
  assert.equal(scores.domain.score, 86);
  assert.equal(scores.combined.score, 74);
});

test("agent evidence boundary rejects internal rescue data", () => {
  assert.throws(
    () =>
      assertAgentEvidenceBoundary({
        route: "/openapi/v1/knowledge-bases/kb/files/content",
        internalDatabaseRowsUsed: 1,
        s3ObjectKeyUsed: false,
        localFixtureBodyUsed: false,
        manualTargetFileUsed: false
      }),
    /internal evidence/
  );
});

test("unquantified findings cannot be counted as pass results", () => {
  assert.throws(
    () =>
      requireQuantifiedFindings([
        { claim: "Agent can explore related files", metrics: {}, evidence: [] }
      ]),
    /quantified/
  );
});

test("report redaction removes local paths and raw auth values", () => {
  const redacted = redactAgentValidationText(
    "Read /private/var/folders/fixture-root/markdown Authorization: Bearer fwok_secret S3_SECRET_ACCESS_KEY=secret"
  );

  assert.equal(redacted.includes("fixture-root"), false);
  assert.equal(redacted.includes("fwok_secret"), false);
  assert.equal(redacted.includes("secret"), false);
});

test("report staging policy documents local-only ReferenceDocs output", () => {
  const policy = summarizeReportStagingPolicy();

  assert.equal(policy.reportRoot, "ReferenceDocs");
  assert.equal(policy.commitScope, "local-only");
  assert.equal(policy.mustStageReports, false);
});

function buildSamples(count) {
  return Array.from({ length: count }, (_, index) => ({
    basename: `${String(index + 1).padStart(2, "0")}.md`,
    title: index === 2 ? "Duplicated title" : `Knowledge sample ${index + 1}`,
    type: ["policy", "guide", "manual", "workflow", "reference"][index % 5],
    status: ["active", "revised", "draft"][index % 3],
    category: index % 4 === 0 ? "Operations > Support" : "Knowledge",
    publicationDate: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
    sizeBytes: 1024 + index
  }));
}
