import type {
  ClaimedPublicationImpact,
  PublicationImpactRepository
} from "../application/ports/publication-impact-repository.js";
import type { PublicationWorkSettings } from "../publication/publication-settings-snapshot.js";
import { ImmutableObjectWriteInProgressError } from "../publication/immutable-object-writer.js";

export type PublicationImpactWriter = {
  write: (impact: ClaimedPublicationImpact, settings: PublicationWorkSettings) => Promise<{
    handled: boolean;
    touchedShardCount: number;
  }>;
  writeBatch?: (
    impacts: ClaimedPublicationImpact[],
    settings: PublicationWorkSettings
  ) => Promise<{
    handled: boolean;
    touchedShardCount: number;
  }>;
};

export type PublicationImpactExecutionResult =
  | { kind: "completed"; completedCount: number }
  | { kind: "failure"; error: unknown; message: string; terminal: boolean }
  | { kind: "deferred"; error: ImmutableObjectWriteInProgressError; message: string };

const GROUPED_PROJECTIONS = new Set([
  "directory", "root", "search", "links", "manifest", "tree", "graph_node", "graph_edge",
  "graph_reverse_neighbor", "related_files"
]);

export async function executePublicationImpactGroup(input: {
  impacts: Pick<PublicationImpactRepository, "completeBatch" | "release" | "fail">;
  writers: PublicationImpactWriter[];
  group: ClaimedPublicationImpact[];
  workerId: string;
  workSettings: PublicationWorkSettings;
  retryDelayMs: number;
  now: () => Date;
}): Promise<PublicationImpactExecutionResult> {
  const { group } = input;
  try {
    const result = await dispatchImpactGroup(input.writers, group, input.workSettings);
    await input.impacts.completeBatch({
      knowledgeBaseId: group[0]!.knowledgeBaseId,
      generationId: group[0]!.generationId,
      workerId: input.workerId,
      completions: group.map((impact, index) => ({
        impactId: impact.id,
        touchedShardCount: index === 0 ? result.touchedShardCount : 0
      })),
      completedAt: input.now().toISOString()
    });
    return { kind: "completed", completedCount: group.length };
  } catch (error) {
    const failedAt = input.now();
    if (error instanceof ImmutableObjectWriteInProgressError) {
      await input.impacts.release({
        impactIds: group.map((impact) => impact.id),
        workerId: input.workerId,
        releasedAt: failedAt.toISOString()
      });
      return { kind: "deferred", error, message: error.message };
    }
    const message = error instanceof Error ? error.message : "Projection write failed";
    const failures = await Promise.all(group.map((impact) => input.impacts.fail({
      knowledgeBaseId: impact.knowledgeBaseId,
      generationId: impact.generationId,
      impactId: impact.id,
      workerId: input.workerId,
      code: "PROJECTION_WRITE_FAILED",
      message,
      retryCursor: impact.retryCursor,
      retryAt: new Date(failedAt.getTime() + input.retryDelayMs).toISOString(),
      failedAt: failedAt.toISOString()
    })));
    return {
      kind: "failure",
      error,
      message,
      terminal: failures.some((failure) => failure.terminal)
    };
  }
}

export function groupPublicationImpacts(
  impacts: ClaimedPublicationImpact[]
): ClaimedPublicationImpact[][] {
  const groups: ClaimedPublicationImpact[][] = [];
  const byShard = new Map<string, ClaimedPublicationImpact[]>();
  for (const impact of impacts) {
    if (!GROUPED_PROJECTIONS.has(impact.projectionKind)) {
      groups.push([impact]);
      continue;
    }
    const key = publicationPhysicalPartition(impact);
    const group = byShard.get(key);
    if (group) {
      group.push(impact);
    } else {
      const created = [impact];
      byShard.set(key, created);
      groups.push(created);
    }
  }
  return groups;
}

export function publicationPhysicalPartition(
  impact: Pick<ClaimedPublicationImpact, "projectionKind" | "projectionKey" | "recordIdentity">
): string {
  if (impact.projectionKind === "graph_reverse_neighbor") {
    return `related_files\u001f${impact.recordIdentity}`;
  }
  if (impact.projectionKind === "related_files") {
    return `related_files\u001f${impact.projectionKey}`;
  }
  return `${impact.projectionKind}\u001f${impact.projectionKey}`;
}

async function dispatchImpact(
  writers: PublicationImpactWriter[],
  impact: ClaimedPublicationImpact,
  settings: PublicationWorkSettings
): Promise<{ touchedShardCount: number }> {
  let result: { touchedShardCount: number } | null = null;
  for (const writer of writers) {
    const candidate = await writer.write(impact, settings);
    if (!candidate.handled) continue;
    if (result) throw new Error("Publication impact has multiple writers");
    result = { touchedShardCount: candidate.touchedShardCount };
  }
  if (!result && impact.projectionKind === "cleanup" && impact.action === "validate") {
    return { touchedShardCount: 0 };
  }
  if (!result) throw new Error(`Publication impact is unsupported: ${impact.projectionKind}`);
  return result;
}

async function dispatchImpactGroup(
  writers: PublicationImpactWriter[],
  impacts: ClaimedPublicationImpact[],
  settings: PublicationWorkSettings
): Promise<{ touchedShardCount: number }> {
  if (impacts.length === 1) return dispatchImpact(writers, impacts[0]!, settings);
  let result: { touchedShardCount: number } | null = null;
  for (const writer of writers) {
    if (!writer.writeBatch) continue;
    const candidate = await writer.writeBatch(impacts, settings);
    if (!candidate.handled) continue;
    if (result) throw new Error("Publication impact batch has multiple writers");
    result = { touchedShardCount: candidate.touchedShardCount };
  }
  if (!result) throw new Error("Publication impact batch is unsupported");
  return result;
}
