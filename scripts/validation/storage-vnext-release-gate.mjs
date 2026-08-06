import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STORAGE_VNEXT_RELEASE_LEDGER_PATH =
  "scripts/validation/storage-vnext-release-gate.json";
const FOCUSED_TEST_DIRECTORIES = Object.freeze([
  {
    path: path.join("apps", "api", "test"),
    fileName: /^storage-vnext-.*\.test\.ts$/u
  },
  {
    path: path.join("scripts", "validation", "test"),
    fileName: /^storage-vnext-.*\.test\.mjs$/u
  }
]);

const CLOSED_DISPOSITIONS = new Set([
  "implemented",
  "removed",
  "retained",
  "rejected"
]);

export const STORAGE_VNEXT_LEDGER_IDS = Object.freeze([
  ...Array.from({ length: 12 }, (_value, index) =>
    `PG-${String(index + 1).padStart(2, "0")}`
  ),
  ...Array.from({ length: 6 }, (_value, index) =>
    `S3-${String(index + 1).padStart(2, "0")}`
  ),
  ...Array.from({ length: 5 }, (_value, index) =>
    `MEILI-${String(index + 1).padStart(2, "0")}`
  ),
  "REDIS-01",
  "LOG-01",
  "CROSS-01"
]);

export function discoverStorageVnextFocusedTests(rootDirectory = process.cwd()) {
  const root = rootDirectory instanceof URL
    ? fileURLToPath(rootDirectory)
    : path.resolve(rootDirectory);
  const focusedTests = [];

  for (const directory of FOCUSED_TEST_DIRECTORIES) {
    const absoluteDirectory = path.join(root, directory.path);
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !directory.fileName.test(entry.name)) continue;
      focusedTests.push(toPortablePath(path.join(directory.path, entry.name)));
    }
  }

  return [...new Set(focusedTests)].sort();
}

export function validateStorageVnextLedger(ledger, options = {}) {
  const errors = [];

  if (!isRecord(ledger)) {
    return { ok: false, errors: ["ledger: expected an object"] };
  }
  if (ledger.schemaVersion !== 1) {
    errors.push("ledger: schemaVersion must be 1");
  }
  if (ledger.changeName !== "implement-breaking-storage-vnext") {
    errors.push("ledger: changeName is invalid");
  }

  const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
  if (!Array.isArray(ledger.rows)) {
    errors.push("ledger: rows must be an array");
  }
  const rowsById = new Map();
  const expectedFocusedTests = validateFocusedTestInventory(options.focusedTests, errors);
  const mappedFocusedTests = new Set();

  for (const row of rows) {
    const id = isRecord(row) && typeof row.id === "string" ? row.id : "<invalid>";
    const existing = rowsById.get(id) ?? [];
    existing.push(row);
    rowsById.set(id, existing);
  }

  for (const id of STORAGE_VNEXT_LEDGER_IDS) {
    const matches = rowsById.get(id) ?? [];
    if (matches.length === 0) {
      errors.push(`${id}: missing ledger row`);
      continue;
    }
    if (matches.length > 1) {
      errors.push(`${id}: duplicate ledger row`);
    }
    validateRow(
      id,
      matches[0],
      errors,
      expectedFocusedTests,
      mappedFocusedTests
    );
  }

  for (const id of rowsById.keys()) {
    if (!STORAGE_VNEXT_LEDGER_IDS.includes(id)) {
      errors.push(`${id}: unexpected ledger row`);
    }
  }

  for (const focusedTest of expectedFocusedTests) {
    if (!mappedFocusedTests.has(focusedTest)) {
      errors.push(
        `${focusedTest}: focused test is not mapped to an implementation ledger row`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateStorageVnextFocusedTestMappings(ledger, options = {}) {
  const errors = [];

  if (!isRecord(ledger)) {
    return { ok: false, errors: ["ledger: expected an object"] };
  }
  if (ledger.schemaVersion !== 1) {
    errors.push("ledger: schemaVersion must be 1");
  }
  if (ledger.changeName !== "implement-breaking-storage-vnext") {
    errors.push("ledger: changeName is invalid");
  }

  const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
  if (!Array.isArray(ledger.rows)) {
    errors.push("ledger: rows must be an array");
  }
  const rowsById = collectRowsById(rows);
  const expectedFocusedTests = validateFocusedTestInventory(
    options.focusedTests,
    errors
  );
  const mappedFocusedTests = new Set();

  for (const id of STORAGE_VNEXT_LEDGER_IDS) {
    const matches = rowsById.get(id) ?? [];
    if (matches.length === 0) {
      errors.push(`${id}: missing ledger row`);
      continue;
    }
    if (matches.length > 1) {
      errors.push(`${id}: duplicate ledger row`);
    }
    validateFocusedTestMapping(
      id,
      matches[0],
      errors,
      expectedFocusedTests,
      mappedFocusedTests
    );
  }

  for (const id of rowsById.keys()) {
    if (!STORAGE_VNEXT_LEDGER_IDS.includes(id)) {
      errors.push(`${id}: unexpected ledger row`);
    }
  }
  validateFocusedTestCoverage(expectedFocusedTests, mappedFocusedTests, errors);

  return { ok: errors.length === 0, errors };
}

export function readAndValidateStorageVnextLedger(
  filePath = STORAGE_VNEXT_RELEASE_LEDGER_PATH,
  options = {}
) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    return {
      ok: false,
      errors: [`ledger: file not found: ${resolvedPath}`]
    };
  }

  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      errors: [
        `ledger: invalid JSON: ${error instanceof Error ? error.message : String(error)}`
      ]
    };
  }
  return options.focusedTestsOnly
    ? validateStorageVnextFocusedTestMappings(ledger, options)
    : validateStorageVnextLedger(ledger, options);
}

function validateRow(id, row, errors, expectedFocusedTests, mappedFocusedTests) {
  if (!isRecord(row)) {
    errors.push(`${id}: row must be an object`);
    return;
  }

  if (!CLOSED_DISPOSITIONS.has(row.disposition)) {
    errors.push(
      row.disposition === "pending"
        ? `${id}: disposition is pending`
        : `${id}: disposition is invalid`
    );
  }

  validateCodeTrace(id, row.codeTrace, errors);
  validateExecutableEvidence(
    id,
    row.executableEvidence,
    errors
  );
  validateFocusedTestMapping(
    id,
    row,
    errors,
    expectedFocusedTests,
    mappedFocusedTests
  );
  validateMeasuredResult(id, row.measuredResult, errors);

  if (row.disposition === "rejected") {
    validateRejectionEvidence(id, row.rejectionEvidence, errors);
  }
}

function validateCodeTrace(id, entries, errors) {
  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push(`${id}: code trace is missing`);
    return;
  }
  entries.forEach((entry, index) => {
    if (
      !isRecord(entry)
      || !nonEmptyString(entry.path)
      || !Array.isArray(entry.symbols)
      || entry.symbols.length === 0
      || entry.symbols.some((symbol) => !nonEmptyString(symbol))
      || !nonEmptyString(entry.action)
    ) {
      errors.push(`${id}: code trace entry ${index + 1} is incomplete`);
    }
  });
}

function validateExecutableEvidence(id, entries, errors) {
  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push(`${id}: executable evidence is missing`);
    return;
  }
  entries.forEach((entry, index) => {
    if (
      !isRecord(entry)
      || !nonEmptyString(entry.command)
      || entry.result !== "passed"
      || !nonEmptyString(entry.evidence)
    ) {
      errors.push(`${id}: executable evidence entry ${index + 1} did not pass`);
    }

  });
}

function validateFocusedTestMapping(
  id,
  row,
  errors,
  expectedFocusedTests,
  mappedFocusedTests
) {
  if (!isRecord(row) || row.focusedTests === undefined) return;
  if (!nonEmptyStringArray(row.focusedTests)) {
    errors.push(`${id}: focused test mapping is invalid`);
    return;
  }
  for (const focusedTest of row.focusedTests) {
    const normalized = normalizeFocusedTestPath(focusedTest);
    if (!normalized || !expectedFocusedTests.has(normalized)) {
      errors.push(`${id}: maps an unknown focused test: ${focusedTest}`);
      continue;
    }
    mappedFocusedTests.add(normalized);
  }
}

function validateFocusedTestCoverage(expectedFocusedTests, mappedFocusedTests, errors) {
  for (const focusedTest of expectedFocusedTests) {
    if (!mappedFocusedTests.has(focusedTest)) {
      errors.push(
        `${focusedTest}: focused test is not mapped to an implementation ledger row`
      );
    }
  }
}

function collectRowsById(rows) {
  const rowsById = new Map();
  for (const row of rows) {
    const id = isRecord(row) && typeof row.id === "string" ? row.id : "<invalid>";
    const existing = rowsById.get(id) ?? [];
    existing.push(row);
    rowsById.set(id, existing);
  }
  return rowsById;
}

function validateFocusedTestInventory(value, errors) {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) {
    errors.push("focused tests: inventory must be an array");
    return new Set();
  }

  const focusedTests = new Set();
  for (const entry of value) {
    const normalized = normalizeFocusedTestPath(entry);
    if (!normalized) {
      errors.push(`focused tests: invalid inventory path: ${String(entry)}`);
      continue;
    }
    focusedTests.add(normalized);
  }
  return focusedTests;
}

function normalizeFocusedTestPath(value) {
  if (!nonEmptyString(value) || path.isAbsolute(value)) return null;
  const normalized = toPortablePath(path.normalize(value));
  if (
    normalized === ".."
    || normalized.startsWith("../")
    || !FOCUSED_TEST_DIRECTORIES.some((directory) =>
      normalized.startsWith(`${toPortablePath(directory.path)}/`)
    )
  ) {
    return null;
  }
  return normalized;
}

function toPortablePath(value) {
  return value.split(path.sep).join("/");
}

function validateMeasuredResult(id, result, errors) {
  if (!isRecord(result)) {
    errors.push(`${id}: measured result is missing`);
    return;
  }
  if (
    result.status !== "passed"
    || result.before === null
    || result.before === undefined
    || result.after === null
    || result.after === undefined
    || !nonEmptyString(result.target)
    || !nonEmptyString(result.evidence)
  ) {
    errors.push(`${id}: measured result did not pass`);
  }
}

function validateRejectionEvidence(id, entries, errors) {
  if (
    !Array.isArray(entries)
    || entries.length === 0
    || entries.some((entry) =>
      !isRecord(entry)
      || !nonEmptyString(entry.reason)
      || !nonEmptyStringArray(entry.officialSources)
      || !nonEmptyStringArray(entry.benchmarkEvidence)
    )
  ) {
    errors.push(`${id}: evidence-backed rejection is missing`);
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyStringArray(value) {
  return (
    Array.isArray(value)
    && value.length > 0
    && value.every((item) => nonEmptyString(item))
  );
}

export function readLedgerArgument(argv) {
  const index = argv.indexOf("--ledger");
  if (index === -1) return STORAGE_VNEXT_RELEASE_LEDGER_PATH;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--ledger requires a file path");
  }
  return value;
}

function runCli() {
  let ledgerPath;
  try {
    ledgerPath = readLedgerArgument(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  const focusedTests = discoverStorageVnextFocusedTests();
  const focusedTestsOnly = process.argv.includes("--focused-tests-only");
  const result = readAndValidateStorageVnextLedger(ledgerPath, {
    focusedTests,
    focusedTestsOnly
  });
  if (!result.ok) {
    console.error("Storage vNext release gate failed:");
    result.errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
    return;
  }
  console.log(focusedTestsOnly
    ? `Storage vNext focused-test ownership passed for ${focusedTests.length} tests.`
    : `Storage vNext release gate passed for all 26 ledger rows and `
      + `${focusedTests.length} focused tests.`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  runCli();
}
