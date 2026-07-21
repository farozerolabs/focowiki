import type { ResourceBudgetLimits } from "../runtime/resource-budget.js";
import type { RuntimeSettingsSnapshot } from "./types.js";

export function resolveResourceBudgetLimits(
  snapshot: RuntimeSettingsSnapshot
): ResourceBudgetLimits {
  return {
    model: snapshot.activeModel?.suggestionConcurrency ?? 1,
    sourceObjectRead: snapshot.worker.sourceObjectReadConcurrency,
    generatedObjectWrite: snapshot.publication.generatedObjectWriteConcurrency,
    graphQuery: snapshot.worker.graphQueryConcurrency,
    databaseMutation: snapshot.worker.databaseMutationConcurrency,
    directory: snapshot.publication.directoryMaterializationConcurrency,
    projectionPartition: snapshot.publication.projectionPartitionConcurrency,
    generationAssembly: snapshot.publication.generationAssemblyConcurrency,
    migrationBackfill: snapshot.maintenance.migrationBackfillConcurrency,
    compaction: snapshot.maintenance.compactionConcurrency
  };
}
