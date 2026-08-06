export function isKnowledgeBaseWorkSettled(
  summary,
  options = { includeMaintenance: false }
) {
  return (
    Number(summary?.pendingDispatch?.pendingCount ?? 0) === 0
    && Number(summary?.sourceFileJobs?.queuedCount ?? 0) === 0
    && Number(summary?.sourceFileJobs?.runningCount ?? 0) === 0
    && Number(summary?.publicationJobs?.queuedCount ?? 0) === 0
    && Number(summary?.publicationJobs?.runningCount ?? 0) === 0
    && (
      options.includeMaintenance !== true
      || isMaintenanceProgressSettled(summary?.maintenanceProgress)
    )
  );
}

export function resolveInterleavedScenarioDeadlineMs(value) {
  const resolved = value === undefined || value === ""
    ? 15 * 60_000
    : Number(value);
  if (
    !Number.isSafeInteger(resolved)
    || resolved < 5 * 60_000
    || resolved > 30 * 60_000
  ) {
    throw new Error(
      "Interleaved scenario deadline must be between 300000 and 1800000 milliseconds."
    );
  }
  return resolved;
}

function isMaintenanceProgressSettled(progress) {
  if (!progress) return true;
  return [
    progress.migration,
    progress.lexicalRebuild,
    progress.projectionRepair,
    progress.compaction?.active
  ].every(isMaintenanceItemSettled);
}

function isMaintenanceItemSettled(item) {
  if (!item) return true;
  return ![
    "running",
    "processing",
    "building",
    "finalizing",
    "retry"
  ].includes(item.state);
}
