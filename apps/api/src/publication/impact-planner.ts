import {
  createProjectionImpactIdentity,
  resolveProjectionShard,
  type ChangeFactKind,
  type ProjectionKind
} from "../domain/generation.js";

export type PublicationImpact = {
  id: string;
  projectionKind: ProjectionKind;
  projectionKey: string;
  recordIdentity: string;
  action: "upsert" | "delete" | "validate";
};

export type ImpactPlannerConfig = {
  searchShardCount: number;
  linkShardCount: number;
  manifestShardCount: number;
  treeShardCount: number;
  graphNodeShardCount: number;
  graphEdgeShardCount: number;
};

export function planPublicationImpacts(input: {
  changeFactId: string;
  kind: ChangeFactKind;
  sourceFileId: string | null;
  previousPath: string | null;
  path: string | null;
  graphNeighborSourceFileIds?: string[];
  graphEdgeIds?: string[];
  removedGraphEdgeIds?: string[];
  config: ImpactPlannerConfig;
}): PublicationImpact[] {
  const sourceRecordAction = input.kind.endsWith("deleted") ? "delete" : "upsert";
  const impacts = new Map<string, PublicationImpact>();
  const add = (
    projectionKind: ProjectionKind,
    projectionKey: string,
    recordIdentity: string,
    impactAction: PublicationImpact["action"] = sourceRecordAction
  ) => {
    const id = createProjectionImpactIdentity({
      changeFactId: input.changeFactId,
      projectionKind,
      projectionKey,
      recordIdentity,
      action: impactAction
    });
    impacts.set(id, {
      id,
      projectionKind,
      projectionKey,
      recordIdentity,
      action: impactAction
    });
  };

  if (input.kind === "knowledge_base_deleted") {
    add("cleanup", "knowledge-base", "knowledge-base", "delete");
    return [...impacts.values()];
  }

  if (input.sourceFileId) {
    add("page", input.sourceFileId, input.sourceFileId);
    add("search", shard("search", input.sourceFileId, input.config.searchShardCount), input.sourceFileId);
    add("manifest", shard("manifest", input.sourceFileId, input.config.manifestShardCount), input.sourceFileId);
    add("tree", shard("tree", input.sourceFileId, input.config.treeShardCount), input.sourceFileId);
    add("graph_node", shard("graph_node", input.sourceFileId, input.config.graphNodeShardCount), input.sourceFileId);
    add("related_files", input.sourceFileId, input.sourceFileId);
  }

  for (const path of uniqueStrings([input.previousPath, input.path])) {
    for (const directory of pathAncestors(path)) {
      add(
        "directory",
        directory,
        `${input.sourceFileId ?? "directory"}:${path}:${directory || "pages"}`,
        "validate"
      );
      const recordIdentity = `directory:${directory}`;
      add(
        "tree",
        shard("tree", recordIdentity, input.config.treeShardCount),
        recordIdentity,
        "upsert"
      );
    }
  }

  for (const sourceFileId of uniqueStrings(input.graphNeighborSourceFileIds ?? [])) {
    add("graph_reverse_neighbor", sourceFileId, sourceFileId, "upsert");
    add("related_files", sourceFileId, sourceFileId, "upsert");
  }
  for (const edgeId of uniqueStrings(input.graphEdgeIds ?? [])) {
    add(
      "links",
      shard("links", edgeId, input.config.linkShardCount),
      edgeId
    );
    add(
      "graph_edge",
      shard("graph_edge", edgeId, input.config.graphEdgeShardCount),
      edgeId
    );
  }
  for (const edgeId of uniqueStrings(input.removedGraphEdgeIds ?? [])) {
    add(
      "links",
      shard("links", edgeId, input.config.linkShardCount),
      edgeId,
      "delete"
    );
    add(
      "graph_edge",
      shard("graph_edge", edgeId, input.config.graphEdgeShardCount),
      edgeId,
      "delete"
    );
  }

  for (const root of [
    "index.md",
    "schema.md",
    "log.md",
    "_index/index.md",
    "_graph/index.md"
  ]) {
    add("root", root, root, "upsert");
  }
  const cleanupIdentity = input.sourceFileId ?? input.path ?? input.previousPath ?? "mutation";
  add("cleanup", cleanupIdentity, cleanupIdentity, "validate");

  return [...impacts.values()].sort(
    (left, right) =>
      left.projectionKind.localeCompare(right.projectionKind, "en") ||
      left.projectionKey.localeCompare(right.projectionKey, "en") ||
      left.recordIdentity.localeCompare(right.recordIdentity, "en")
  );
}

function shard(
  kind: "search" | "links" | "manifest" | "tree" | "graph_node" | "graph_edge",
  identity: string,
  count: number
): string {
  return resolveProjectionShard({
    projectionKind: kind,
    stableIdentity: identity,
    shardCount: count
  });
}

function pathAncestors(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  const result = [""];
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    result.push(current);
  }
  return result;
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
