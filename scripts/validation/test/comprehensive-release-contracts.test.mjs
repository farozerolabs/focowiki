import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPREHENSIVE_CONTRACT_TASKS,
  buildRequirementTaskMatrix,
  parseRequirementHeadings
} from "../lib/comprehensive-release-contracts.mjs";

test("maps every requirement in an included capability to current task IDs", () => {
  const matrix = buildRequirementTaskMatrix({
    specFiles: [
      {
        capability: "developer-openapi",
        content: [
          "### Requirement: Contract is exported",
          "",
          "### Requirement: Requests stay authenticated"
        ].join("\n")
      },
      {
        capability: "security-baseline",
        content: "### Requirement: Secrets remain protected\n"
      }
    ],
    taskIds: [
      ...new Set([
        ...COMPREHENSIVE_CONTRACT_TASKS["developer-openapi"],
        ...COMPREHENSIVE_CONTRACT_TASKS["security-baseline"]
      ])
    ]
  });

  assert.equal(matrix.length, 3);
  assert.deepEqual(
    matrix.map((row) => row.requirement),
    ["Contract is exported", "Requests stay authenticated", "Secrets remain protected"]
  );
  assert.ok(matrix.every((row) => row.taskIds.length > 0));
  assert.ok(matrix.every((row) => /^[a-f0-9]{64}$/u.test(row.requirementSha256)));
  assert.deepEqual(matrix[0].scenarios, []);
  assert.equal(new Set(matrix.map((row) => row.id)).size, matrix.length);
});

test("fails closed for an unmapped capability or stale task ID", () => {
  assert.throws(
    () =>
      buildRequirementTaskMatrix({
        specFiles: [{ capability: "unmapped", content: "### Requirement: Missing\n" }],
        taskIds: ["1.1"]
      }),
    /Unmapped contract capability/u
  );

  assert.throws(
    () =>
      buildRequirementTaskMatrix({
        specFiles: [
          {
            capability: "developer-openapi",
            content: "### Requirement: Contract is exported\n"
          }
        ],
        taskIds: ["2.1"]
      }),
    /unknown task/u
  );
});

test("contract scope explicitly covers every release-audit domain", () => {
  const capabilities = new Set(Object.keys(COMPREHENSIVE_CONTRACT_TASKS));

  for (const capability of [
    "admin-console-generation",
    "developer-openapi",
    "bounded-storage-ownership",
    "file-first-graph-relations",
    "okf-v0-2-trust-signals",
    "meilisearch-search-runtime",
    "ranked-search-retrieval",
    "admin-runtime-settings",
    "docker-compose-deployment",
    "security-baseline",
    "markdown-docs-deployment",
    "large-scale-runtime-performance"
  ]) {
    assert.ok(capabilities.has(capability), capability);
  }
});

test("requirement parser rejects duplicate headings within one capability", () => {
  assert.throws(
    () =>
      parseRequirementHeadings(
        "### Requirement: Duplicate\n\n### Requirement: Duplicate\n",
        "duplicate-capability"
      ),
    /Duplicate requirement heading/u
  );
});
