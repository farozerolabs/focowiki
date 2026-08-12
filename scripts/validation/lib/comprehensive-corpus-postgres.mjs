const REQUIRED_COMPLETED_STAGES = Object.freeze([
  "extraction",
  "reconciliation",
  "embedding",
  "community",
  "vector",
  "publication"
]);

const TERMINAL_STAGE_STATES = new Set([
  "failed",
  "cancelled",
  "superseded"
]);

export function assertCorpusPostgresRows(rows, options) {
  const expectedAliases = new Set(options.expectedAliases);
  if (expectedAliases.size !== options.expectedAliases.length) {
    throw new Error("Expected corpus aliases contain a duplicate");
  }
  const observedAliases = new Set();
  const sanitized = [];
  for (const row of rows) {
    if (observedAliases.has(row.alias)) {
      throw new Error(`PostgreSQL evidence has a duplicate row for ${row.alias}`);
    }
    if (!expectedAliases.has(row.alias)) {
      throw new Error(`PostgreSQL evidence has an unknown row for ${row.alias}`);
    }
    observedAliases.add(row.alias);
    sanitized.push(assertRow(row, options.expectedProvider));
  }
  const missing = [...expectedAliases].filter((alias) => !observedAliases.has(alias));
  if (missing.length > 0) {
    throw new Error(`PostgreSQL evidence is missing rows: ${missing.join(",")}`);
  }
  return sanitized.sort((left, right) => left.alias.localeCompare(right.alias));
}

function assertRow(row, expectedProvider) {
  required(row.sourceStatus === "ready", row, "source is not ready");
  required(row.sourceDeleted === false, row, "source is deleted");
  required(row.safeErrorCode === null, row, "source has a safe error");
  required(row.currentRevisionCount === 1, row, "current revision is not unique");
  required(row.sourceChecksumSha256 === row.expectedChecksumSha256, row,
    "source checksum does not match the corpus");
  required(row.sourceByteCount === row.expectedSizeBytes, row,
    "source byte count does not match the corpus");
  required(row.objectState === "verified", row, "source object is not verified");
  required(row.objectChecksumSha256 === row.expectedChecksumSha256, row,
    "source object checksum does not match the corpus");
  required(row.objectByteCount === row.expectedSizeBytes, row,
    "source object byte count does not match the corpus");
  required(row.sourceObjectOwnerCount === 1, row,
    "source object owner is not unique");
  required(row.modelInvocationStatus === row.expectedModelInvocationStatus, row,
    "model invocation status does not match the API evidence");
  required(["completed", "skipped"].includes(row.modelInvocationStatus), row,
    "model invocation is not terminal");
  required(
    row.modelInvocationStatus === "completed"
      ? row.modelNameRecorded === true
      : row.modelNameRecorded === false,
    row,
    "model invocation identity is inconsistent"
  );
  required(row.activeSemanticGenerationCount === 1, row,
    "active semantic generation is not unique");
  required(row.activeSemanticGenerationState === "active", row,
    "active semantic generation is not active");
  required(row.projectionContractCount === 1, row,
    "semantic projection contract is not unique");
  required(row.reconciliationCount === 1, row,
    "current reconciliation is not unique");
  required(
    row.skeletonSelected === (row.modelInvocationStatus === "completed"),
    row,
    "skeleton selection does not match model use-or-skip"
  );
  required(Number.isInteger(row.sourceChunkCount) && row.sourceChunkCount > 0, row,
    "reconciliation source chunks are missing");
  required(Number.isInteger(row.selectedChunkCount) && row.selectedChunkCount >= 0, row,
    "reconciliation selected chunk count is invalid");
  required(
    row.skeletonSelected
      ? row.selectedChunkCount > 0 && row.selectedChunkCount <= row.sourceChunkCount
      : row.selectedChunkCount === 0,
    row,
    "reconciliation selected chunks are inconsistent"
  );
  const completedStages = new Set(row.completedStages);
  for (const stage of REQUIRED_COMPLETED_STAGES) {
    required(completedStages.has(stage), row,
      `required ${stage} stage is not completed`);
  }
  required(row.liveSemanticStageCount === 0, row,
    "live semantic stage work remains");
  required(row.liveOperationWorkCount === 0, row,
    "live operation work remains");
  required(row.activationEventCount >= 1 && row.latestActivationAt, row,
    "generation activation evidence is missing");
  const historicalTerminalFailuresExplained = assertHistoricalTerminals(row);
  required(
    completedStages.has("validation") || historicalTerminalFailuresExplained,
    row,
    "validation is neither completed nor explained by recovered history"
  );
  required(row.catalogSourceEntryCount === 1, row,
    "active release catalog source entry is not unique");
  required(row.catalogObjectState === "verified", row,
    "active release catalog object is not verified");
  required(row.activeSnapshotCount === 1, row,
    "active snapshot is not unique");
  required(row.activeSearchProjectionCount === 1, row,
    "active search projection is not unique");
  required(row.activeSearchProjectionState === "ready", row,
    "active search projection is not ready");
  required(row.activeSearchProviderKind === expectedProvider, row,
    "active search projection uses an unexpected provider");
  required(Number.isInteger(row.activeVectorDocumentCount)
    && row.activeVectorDocumentCount >= 0, row,
  "active vector document count is invalid");
  required(row.activeVectorDimensionMismatchCount === 0, row,
    "active vector document dimension mismatch remains");

  return {
    alias: row.alias,
    family: row.family,
    source: "ready",
    currentRevision: "verified",
    modelInvocation: row.modelInvocationStatus,
    skeletonSelected: row.skeletonSelected,
    completedStages: [...completedStages].sort(),
    historicalTerminalCount: row.historicalTerminalStages.length,
    historicalTerminalFailuresExplained,
    activationRecorded: true,
    generatedCatalogEntry: "verified",
    searchProvider: row.activeSearchProviderKind,
    searchProjection: "ready",
    activeVectorDocumentCount: row.activeVectorDocumentCount,
    vectorDimensionsVerified: true
  };
}

function assertHistoricalTerminals(row) {
  if (!Array.isArray(row.historicalTerminalStages)) {
    throw new Error(`${row.alias}: historical terminal stages are missing`);
  }
  if (row.historicalTerminalStages.length === 0) return true;
  const activationTime = Date.parse(row.latestActivationAt);
  required(Number.isFinite(activationTime), row,
    "generation activation timestamp is invalid");
  for (const terminal of row.historicalTerminalStages) {
    required(TERMINAL_STAGE_STATES.has(terminal.state), row,
      "historical stage is not terminal");
    if (terminal.state === "failed") {
      required(typeof terminal.safeErrorCode === "string"
        && terminal.safeErrorCode.length > 0, row,
      "historical failure has no safe error code");
    }
    const terminalTime = Date.parse(terminal.completedAt);
    required(Number.isFinite(terminalTime), row,
      "historical terminal timestamp is invalid");
    required(activationTime > terminalTime, row,
      "historical terminal stage was not followed by activation");
  }
  return true;
}

function required(condition, row, message) {
  if (!condition) throw new Error(`${row.alias}: ${message}`);
}
