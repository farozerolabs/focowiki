export function indexMaintenanceStageLabel(
  stage: string,
  translate: (key: string) => string
): string {
  if (stage.startsWith("projection:")) return translate("indexMaintenance.stages.projection");
  if (stage.startsWith("search:")) return translate("indexMaintenance.stages.search");
  if (stage === "compaction") return translate("indexMaintenance.stages.compaction");
  if (stage === "validating") return translate("indexMaintenance.stages.validating");
  if (stage === "retrying") return translate("indexMaintenance.stages.retrying");
  if (stage === "search_rebuild") return translate("indexMaintenance.stages.search");
  if (stage === "projection_repair" || stage === "object_reconciliation") {
    return translate("indexMaintenance.stages.projection");
  }
  if (stage === "catch_up") return translate("indexMaintenance.stages.catchUp");
  if (stage === "validation") return translate("indexMaintenance.stages.validating");
  if (stage === "activation") return translate("indexMaintenance.stages.activating");
  if (stage === "cleanup") return translate("indexMaintenance.stages.cleanup");
  return translate("indexMaintenance.stages.preparing");
}

export function indexMaintenanceFailureLabel(
  code: string | null,
  fallback: string,
  translate: (key: string) => string
): string {
  if (code === "INDEX_MAINTENANCE_STATISTICS_FAILED") {
    return translate("indexMaintenance.failures.statistics");
  }
  if (code === "INDEX_MAINTENANCE_COMPACTION_FAILED") {
    return translate("indexMaintenance.failures.compaction");
  }
  if (code === "INDEX_MAINTENANCE_FAILED") {
    return translate("indexMaintenance.failures.general");
  }
  return fallback;
}
