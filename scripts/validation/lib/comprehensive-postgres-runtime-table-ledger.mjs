export function reconcileComprehensivePostgresRuntimeTables(input) {
  const phase = String(input.phase ?? "").trim();
  if (!phase) throw new Error("PostgreSQL runtime table phase is required");
  const expected = stableUnique(input.expectedTableNames ?? []);
  const rows = [...(input.runtimeTables ?? [])].sort((left, right) =>
    left.tableName.localeCompare(right.tableName, "en"));
  const runtimeNames = new Set();
  for (const row of rows) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(row.tableName) || runtimeNames.has(row.tableName)) {
      throw new Error(`Invalid or duplicate PostgreSQL runtime table: ${row.tableName}`);
    }
    runtimeNames.add(row.tableName);
    validateRuntimeRow(row);
  }
  const missing = expected.filter((tableName) => !runtimeNames.has(tableName));
  const expectedSet = new Set(expected);
  const unexplained = rows.filter((row) =>
    !expectedSet.has(row.tableName)
      && !(row.relationKind === "partition"
        && row.parentTableName
        && expectedSet.has(row.parentTableName)))
    .map((row) => row.tableName);
  if (missing.length > 0 || unexplained.length > 0) {
    throw new Error(
      `PostgreSQL runtime table mismatch; missing=${missing.join(",") || "none"}; unknown=${unexplained.join(",") || "none"}`
    );
  }
  const reconciled = rows.map((row, index) => ({
    sequence: index + 1,
    ...row,
    ownershipBoundary: "schema:focowiki",
    automatedStatus: "pass",
    manualStatus: "pass"
  }));
  return {
    kind: "focowiki-comprehensive-postgres-runtime-table-ledger",
    version: 1,
    phase,
    ok: true,
    summary: {
      expectedFixedTableCount: expected.length,
      observedRuntimeTableCount: rows.length,
      fixedTableCount: rows.filter((row) => row.relationKind === "table").length,
      partitionTableCount: rows.filter((row) => row.relationKind === "partition").length,
      missingTableCount: 0,
      unexplainedTableCount: 0,
      totalExactRows: rows
        .filter((row) => row.relationKind === "table")
        .reduce((sum, row) => sum + row.exactRows, 0),
      partitionExactRows: rows
        .filter((row) => row.relationKind === "partition")
        .reduce((sum, row) => sum + row.exactRows, 0),
      totalBytes: rows.reduce((sum, row) => sum + row.totalBytes, 0)
    },
    rows: reconciled
  };
}

function validateRuntimeRow(row) {
  if (!["table", "partition"].includes(row.relationKind)) {
    throw new Error(`Invalid PostgreSQL relation kind for ${row.tableName}`);
  }
  for (const field of [
    "exactRows",
    "totalBytes",
    "columnCount",
    "constraintCount",
    "indexCount",
    "indexScanCount",
    "sequentialScanCount",
    "liveTupleEstimate",
    "deadTupleEstimate",
    "lockCount"
  ]) {
    if (!Number.isSafeInteger(row[field]) || row[field] < 0) {
      throw new Error(`Invalid PostgreSQL ${field} for ${row.tableName}`);
    }
  }
  if (row.knowledgeBaseCounts !== null) {
    for (const value of Object.values(row.knowledgeBaseCounts)) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Invalid PostgreSQL knowledge-base count for ${row.tableName}`);
      }
    }
  }
  if (!Array.isArray(row.stateCounts)) {
    throw new Error(`Invalid PostgreSQL state counts for ${row.tableName}`);
  }
}

function stableUnique(values) {
  return [...new Set(values.map((value) => String(value).replace(/^focowiki\./u, "")))]
    .sort((left, right) => left.localeCompare(right, "en"));
}
