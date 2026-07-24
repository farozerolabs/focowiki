import { createHash } from "node:crypto";

export const CURRENT_PROJECTION_REPAIR_VERSION = 4;
export const CURRENT_PROJECTION_REPAIR_PLANNER_VERSION = 1;

export const REQUIRED_PROJECTION_REPAIR_VERSIONS = Object.freeze({
  tree: 4,
  directory: 2,
  graph: 2
});

export type ProjectionRepairProjectionKind =
  keyof typeof REQUIRED_PROJECTION_REPAIR_VERSIONS;

export type ProjectionRepairSettingsSnapshot = {
  concurrency: number;
  databaseBatchSize: number;
  objectWriteConcurrency: number;
};

export type ProjectionRepairPlannedTask = {
  id: string;
  kind: "tree_partition" | "directory" | "graph_partition" | "graph_finalize" | "finalize";
  partitionKey: string;
  phaseOrder: number;
  baseGenerationId: string;
  sourceWatermark: number;
  settingsRevision: number;
  settings: ProjectionRepairSettingsSnapshot;
};

export function buildProjectionRepairPlan(input: {
  knowledgeBaseId: string;
  repairVersion: number;
  baseGenerationId: string;
  targetGenerationId: string;
  sourceWatermark: number;
  settingsRevision: number;
  settings: ProjectionRepairSettingsSnapshot;
  currentVersions: Partial<Record<ProjectionRepairProjectionKind, number>>;
  treePartitions: readonly string[];
  directories: readonly string[];
  graphPartitions?: ReadonlyArray<{
    projectionKind: "graph_node" | "graph_edge";
    shardKey: string;
  }>;
}): {
  staleProjectionKinds: ProjectionRepairProjectionKind[];
  tasks: ProjectionRepairPlannedTask[];
} {
  const staleProjectionKinds = (
    Object.keys(REQUIRED_PROJECTION_REPAIR_VERSIONS) as ProjectionRepairProjectionKind[]
  ).filter((kind) =>
    input.currentVersions[kind] !== REQUIRED_PROJECTION_REPAIR_VERSIONS[kind]
  );
  if (staleProjectionKinds.length === 0) {
    return { staleProjectionKinds, tasks: [] };
  }

  const tasks: ProjectionRepairPlannedTask[] = [];
  if (staleProjectionKinds.includes("tree")) {
    for (const partitionKey of uniqueSorted(input.treePartitions)) {
      tasks.push(createTask(input, "tree_partition", partitionKey, 10));
    }
  }
  if (staleProjectionKinds.includes("directory")) {
    for (const partitionKey of uniqueSorted(input.directories)) {
      tasks.push(createTask(input, "directory", partitionKey, 20));
    }
  }
  if (staleProjectionKinds.includes("graph")) {
    const graphPartitions = uniqueSorted(
      (input.graphPartitions ?? []).map((partition) =>
        `${partition.projectionKind}\u001f${partition.shardKey}`
      )
    );
    for (const partitionKey of graphPartitions) {
      tasks.push(createTask(input, "graph_partition", partitionKey, 30));
    }
    tasks.push(createTask(input, "graph_finalize", "graph", 40));
  }
  tasks.push(createTask(input, "finalize", "root", 100));
  return { staleProjectionKinds, tasks };
}

export function clampProjectionRepairConcurrency(input: {
  configuredConcurrency: number;
  databasePoolMax: number;
  reservedConnections: number;
}): {
  effectiveConcurrency: number;
  clamped: boolean;
} {
  assertPositiveInteger(input.configuredConcurrency, "configuredConcurrency");
  assertPositiveInteger(input.databasePoolMax, "databasePoolMax");
  if (
    !Number.isSafeInteger(input.reservedConnections)
    || input.reservedConnections < 0
    || input.reservedConnections >= input.databasePoolMax
  ) {
    throw new Error("reservedConnections must leave at least one database connection");
  }
  const capacity = input.databasePoolMax - input.reservedConnections;
  const effectiveConcurrency = Math.min(input.configuredConcurrency, capacity);
  return {
    effectiveConcurrency,
    clamped: effectiveConcurrency !== input.configuredConcurrency
  };
}

function createTask(
  input: {
    knowledgeBaseId: string;
    repairVersion: number;
    baseGenerationId: string;
    targetGenerationId: string;
    sourceWatermark: number;
    settingsRevision: number;
    settings: ProjectionRepairSettingsSnapshot;
  },
  kind: ProjectionRepairPlannedTask["kind"],
  partitionKey: string,
  phaseOrder: number
): ProjectionRepairPlannedTask {
  const identity = [
    input.knowledgeBaseId,
    input.repairVersion,
    input.targetGenerationId,
    kind,
    partitionKey
  ].join("\u001f");
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return {
    id: `projection-repair-task-${digest}`,
    kind,
    partitionKey,
    phaseOrder,
    baseGenerationId: input.baseGenerationId,
    sourceWatermark: input.sourceWatermark,
    settingsRevision: input.settingsRevision,
    settings: { ...input.settings }
  };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}
