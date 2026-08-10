import { createHash, randomUUID } from "node:crypto";
import {
  GRAPHRAG_REQUEST_SCHEMA,
  type GraphRagAdapterRequest
} from "../graphrag/contracts.js";
import type { GraphRagPythonPool } from "../graphrag/python-pool.js";
import type { CommunityRelationshipInput } from "./community-planner.js";

export type CommunityPartitionWork = {
  knowledgeBaseId: string;
  semanticGenerationPublicId: string;
  partitionPublicId: string;
  partitionKey: string;
  inputVersion: string;
  boundaryVersion: string;
  entityPublicIds: readonly string[];
  localRelationships: readonly CommunityRelationshipInput[];
  boundaryRelationships: readonly CommunityRelationshipInput[];
  timeoutMs: number;
};

export type CommunityPartitionOutput = {
  communityPublicId: string;
  level: number;
  entityPublicIds: readonly string[];
  summary: string;
  checksumSha256: string;
};

export function createCommunityPartitionWorker(input: {
  pool: Pick<GraphRagPythonPool, "run">;
  isCurrent(work: CommunityPartitionWork): Promise<boolean>;
  summarize(request: {
    knowledgeBaseId: string;
    partitionKey: string;
    entityPublicIds: readonly string[];
    boundaryRelationships: readonly CommunityRelationshipInput[];
    signal?: AbortSignal;
  }): Promise<string>;
  replacePartition(request: {
    work: CommunityPartitionWork;
    outputs: readonly CommunityPartitionOutput[];
  }): Promise<"created" | "updated" | "reused">;
  publishLocal?(request: {
    work: CommunityPartitionWork;
    outputs: readonly CommunityPartitionOutput[];
  }): Promise<void>;
  checkpoint(request: {
    work: CommunityPartitionWork;
    outcome: "completed" | "retry" | "cancelled" | "superseded";
    safeCode: string | null;
  }): Promise<void>;
}) {
  return {
    async process(work: CommunityPartitionWork, signal?: AbortSignal) {
      assertWork(work);
      try {
        assertNotAborted(signal);
        if (!await input.isCurrent(work)) {
          await input.checkpoint({ work, outcome: "superseded", safeCode: null });
          return { outcome: "superseded" as const, outputCount: 0 };
        }
        const response = await input.pool.run(clusterRequest(work), {
          timeoutMs: work.timeoutMs,
          ...(signal ? { signal } : {})
        });
        if (!response.ok || !response.result) throw new Error("Community adapter failed");
        const communities = parseCommunities(response.result.communities, work.entityPublicIds);
        const outputs: CommunityPartitionOutput[] = [];
        for (const community of communities) {
          assertNotAborted(signal);
          const summary = await input.summarize({
            knowledgeBaseId: work.knowledgeBaseId,
            partitionKey: work.partitionKey,
            entityPublicIds: community.entityPublicIds,
            boundaryRelationships: work.boundaryRelationships,
            ...(signal ? { signal } : {})
          });
          const checksumSha256 = hash(
            work.inputVersion,
            work.boundaryVersion,
            community.communityPublicId,
            summary
          );
          outputs.push({ ...community, summary: requireSummary(summary), checksumSha256 });
        }
        if (!await input.isCurrent(work)) {
          await input.checkpoint({ work, outcome: "superseded", safeCode: null });
          return { outcome: "superseded" as const, outputCount: 0 };
        }
        const outcome = await input.replacePartition({ work, outputs });
        if (input.publishLocal && outputs.length > 0) {
          await input.publishLocal({ work, outputs });
        }
        await input.checkpoint({ work, outcome: "completed", safeCode: null });
        return { outcome, outputCount: outputs.length };
      } catch (error) {
        const cancelled = signal?.aborted === true;
        await input.checkpoint({
          work,
          outcome: cancelled ? "cancelled" : "retry",
          safeCode: cancelled ? "community_cancelled" : "community_dependency_failed"
        });
        throw error;
      }
    }
  };
}

function clusterRequest(work: CommunityPartitionWork): GraphRagAdapterRequest {
  return {
    schemaVersion: GRAPHRAG_REQUEST_SCHEMA,
    requestId: `community-${randomUUID()}`,
    operation: "cluster",
    knowledgeBaseId: work.knowledgeBaseId,
    partitionId: work.partitionPublicId,
    edges: [...work.localRelationships, ...work.boundaryRelationships].map((edge) => ({
      sourceEntityId: edge.fromEntityPublicId,
      targetEntityId: edge.toEntityPublicId,
      weight: edge.weight
    }))
  };
}

function parseCommunities(value: unknown, localEntityPublicIds: readonly string[]) {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error("Community adapter output is invalid");
  }
  const local = new Set(localEntityPublicIds);
  return value.map((item) => {
    if (!isRecord(item) || typeof item.communityId !== "string"
      || !Number.isSafeInteger(item.level) || !Array.isArray(item.members)) {
      throw new Error("Community adapter record is invalid");
    }
    const entityPublicIds = [...new Set(item.members.filter(
      (member): member is string => typeof member === "string" && local.has(member)
    ))].sort();
    if (entityPublicIds.length === 0) {
      throw new Error("Community adapter record has no local member");
    }
    return {
      communityPublicId: item.communityId,
      level: item.level as number,
      entityPublicIds
    };
  }).sort((left, right) => left.level - right.level
    || left.communityPublicId.localeCompare(right.communityPublicId, "en"));
}

function assertWork(work: CommunityPartitionWork): void {
  if (!work.knowledgeBaseId || !work.semanticGenerationPublicId
    || !work.partitionPublicId || !work.partitionKey || !work.inputVersion
    || !work.boundaryVersion || !Number.isSafeInteger(work.timeoutMs)
    || work.timeoutMs < 1 || work.entityPublicIds.length > 10_000
    || work.localRelationships.length > 20_000
    || work.boundaryRelationships.length > 10_000) {
    throw new Error("Community partition work is invalid");
  }
}

function requireSummary(value: string): string {
  if (!value.trim() || Buffer.byteLength(value) > 65_536) {
    throw new Error("Community summary is invalid");
  }
  return value.trim();
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Community work aborted", "AbortError");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hash(...values: string[]): string {
  return createHash("sha256").update(values.join("\u001f")).digest("hex");
}
