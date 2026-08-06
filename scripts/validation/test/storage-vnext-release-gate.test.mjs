import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE_VNEXT_RELEASE_LEDGER_PATH,
  STORAGE_VNEXT_LEDGER_IDS,
  discoverStorageVnextFocusedTests,
  readLedgerArgument,
  readAndValidateStorageVnextLedger,
  validateStorageVnextFocusedTestMappings,
  validateStorageVnextLedger
} from "../storage-vnext-release-gate.mjs";

const rootDir = new URL("../../..", import.meta.url);

function pendingRow(id) {
  return {
    id,
    disposition: "pending",
    codeTrace: [],
    executableEvidence: [],
    measuredResult: null,
    rejectionEvidence: []
  };
}

function completedRow(id) {
  return {
    id,
    disposition: "implemented",
    codeTrace: [
      {
        path: "apps/api/src/example.ts",
        symbols: ["exampleSymbol"],
        action: "changed"
      }
    ],
    executableEvidence: [
      {
        command: "pnpm test",
        result: "passed",
        evidence: "evidence/tests.json"
      }
    ],
    measuredResult: {
      status: "passed",
      before: { value: 2, unit: "bytes" },
      after: { value: 1, unit: "bytes" },
      target: "at most 1 byte",
      evidence: "evidence/measurement.json"
    },
    rejectionEvidence: []
  };
}

function ledger(rows) {
  return {
    schemaVersion: 1,
    changeName: "implement-breaking-storage-vnext",
    rows
  };
}

test("requires the complete storage-vNext optimization ID set", () => {
  assert.equal(STORAGE_VNEXT_LEDGER_IDS.length, 26);
  assert.deepEqual(
    validateStorageVnextLedger(ledger([])).errors,
    STORAGE_VNEXT_LEDGER_IDS.map((id) => `${id}: missing ledger row`)
  );

  const duplicated = STORAGE_VNEXT_LEDGER_IDS.map(completedRow);
  duplicated.push(completedRow("PG-01"), completedRow("PG-99"));
  const result = validateStorageVnextLedger(ledger(duplicated));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PG-01: duplicate ledger row"));
  assert.ok(result.errors.includes("PG-99: unexpected ledger row"));
});

test("fails every incomplete disposition and evidence field", () => {
  const result = validateStorageVnextLedger(
    ledger(STORAGE_VNEXT_LEDGER_IDS.map(pendingRow))
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PG-01: disposition is pending"));
  assert.ok(result.errors.includes("PG-01: code trace is missing"));
  assert.ok(result.errors.includes("PG-01: executable evidence is missing"));
  assert.ok(result.errors.includes("PG-01: measured result is missing"));
});

test("requires passed executable and measured evidence", () => {
  const rows = STORAGE_VNEXT_LEDGER_IDS.map(completedRow);
  rows[0] = {
    ...rows[0],
    codeTrace: [{ path: "", symbols: [], action: "" }],
    executableEvidence: [{ command: "pnpm test", result: "failed", evidence: "" }],
    measuredResult: {
      status: "failed",
      before: null,
      after: null,
      target: "",
      evidence: ""
    }
  };

  const result = validateStorageVnextLedger(ledger(rows));

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PG-01: code trace entry 1 is incomplete"));
  assert.ok(result.errors.includes("PG-01: executable evidence entry 1 did not pass"));
  assert.ok(result.errors.includes("PG-01: measured result did not pass"));
});

test("requires official and benchmark evidence for a rejected row", () => {
  const rows = STORAGE_VNEXT_LEDGER_IDS.map(completedRow);
  rows[0] = {
    ...rows[0],
    disposition: "rejected",
    rejectionEvidence: []
  };

  const missing = validateStorageVnextLedger(ledger(rows));
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.includes("PG-01: evidence-backed rejection is missing"));

  rows[0] = {
    ...rows[0],
    rejectionEvidence: [
      {
        reason: "The measured implementation would regress correctness.",
        officialSources: ["https://example.test/official"],
        benchmarkEvidence: ["evidence/rejection-benchmark.json"]
      }
    ]
  };
  assert.deepEqual(validateStorageVnextLedger(ledger(rows)), {
    ok: true,
    errors: []
  });
});

test("passes only when all 26 rows are closed with complete evidence", () => {
  assert.deepEqual(
    validateStorageVnextLedger(
      ledger(STORAGE_VNEXT_LEDGER_IDS.map(completedRow))
    ),
    { ok: true, errors: [] }
  );
});

test("discovers every source-controlled storage-vNext focused test", () => {
  const focusedTests = discoverStorageVnextFocusedTests(rootDir);

  assert.ok(focusedTests.includes(
    "apps/api/test/storage-vnext-zero-owner-cleanup.test.ts"
  ));
  assert.ok(focusedTests.includes(
    "scripts/validation/test/storage-vnext-release-gate.test.mjs"
  ));
  assert.deepEqual(focusedTests, [...new Set(focusedTests)].sort());
  assert.equal(focusedTests.some((path) => path.includes("ReferenceDocs")), false);
});

test("uses a source-controlled release ledger for the default gate", () => {
  assert.equal(
    STORAGE_VNEXT_RELEASE_LEDGER_PATH,
    "scripts/validation/storage-vnext-release-gate.json"
  );
  assert.equal(readLedgerArgument([]), STORAGE_VNEXT_RELEASE_LEDGER_PATH);
  assert.deepEqual(
    readAndValidateStorageVnextLedger(STORAGE_VNEXT_RELEASE_LEDGER_PATH, {
      focusedTests: discoverStorageVnextFocusedTests(rootDir)
    }),
    { ok: true, errors: [] }
  );
});

test("requires every focused test to map to an owning ledger row", () => {
  const focusedTests = [
    "apps/api/test/storage-vnext-object-ownership-contract.test.ts",
    "apps/api/test/storage-vnext-zero-owner-cleanup.test.ts"
  ];
  const rows = STORAGE_VNEXT_LEDGER_IDS.map(completedRow);
  rows[0].focusedTests = [focusedTests[0]];

  const missing = validateStorageVnextLedger(ledger(rows), { focusedTests });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.includes(
    `${focusedTests[1]}: focused test is not mapped to an implementation ledger row`
  ));

  rows[1].focusedTests = [focusedTests[1]];
  assert.deepEqual(
    validateStorageVnextLedger(ledger(rows), { focusedTests }),
    { ok: true, errors: [] }
  );
});

test("rejects focused-test mappings that do not exist in the source inventory", () => {
  const rows = STORAGE_VNEXT_LEDGER_IDS.map(completedRow);
  rows[0].focusedTests = [
    "apps/api/test/storage-vnext-removed.test.ts"
  ];

  const result = validateStorageVnextLedger(ledger(rows), {
    focusedTests: ["apps/api/test/storage-vnext-zero-owner-cleanup.test.ts"]
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes(
    "PG-01: maps an unknown focused test: "
      + "apps/api/test/storage-vnext-removed.test.ts"
  ));
});

test("validates focused-test ownership while final release evidence is pending", () => {
  const focusedTests = [
    "apps/api/test/storage-vnext-object-ownership-contract.test.ts"
  ];
  const rows = STORAGE_VNEXT_LEDGER_IDS.map(pendingRow);
  rows[12].focusedTests = focusedTests;

  assert.deepEqual(
    validateStorageVnextFocusedTestMappings(ledger(rows), { focusedTests }),
    { ok: true, errors: [] }
  );

  const fullGate = validateStorageVnextLedger(ledger(rows), { focusedTests });
  assert.equal(fullGate.ok, false);
  assert.ok(fullGate.errors.includes("PG-01: disposition is pending"));
});
