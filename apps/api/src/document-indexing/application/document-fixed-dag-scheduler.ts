import type { DocumentWorkKind } from "../domain/document-work-graph.js";
import type { AdaptiveResourceObservation } from
  "./adaptive-resource-controller.js";
import { readProcessResourcePressure } from "./process-resource-pressure.js";

export const DOCUMENT_RESOURCE_LANES = [
  "postgres_s3",
  "coordination",
  "generation_model",
  "graphrag_adapter",
  "embedding",
  "search_transport",
  "projection",
  "activation",
  "cleanup"
] as const;

export type DocumentResourceLane = (typeof DOCUMENT_RESOURCE_LANES)[number];

export type ClaimedDocumentWork = {
  publicId: string;
  kind: DocumentWorkKind;
  resourceLane: DocumentResourceLane;
};

type DocumentWorkClaimRequest = {
  kind: DocumentWorkKind;
  resourceLane: DocumentResourceLane;
  workerId: string;
  now: string;
  leaseDurationMs: number;
  signal?: AbortSignal;
};

export function createDocumentFixedDagScheduler<TWork extends ClaimedDocumentWork>(input: {
  claimLimit?: number;
  work: {
    claim(request: {
      kind: DocumentWorkKind;
      limit: number;
      workerId: string;
      now: string;
      leaseDurationMs: number;
      resourceLane: DocumentResourceLane;
    }): Promise<readonly TWork[]>;
  };
  lanes: {
    acquire(lane: DocumentResourceLane, signal?: AbortSignal): Promise<() => void>;
    tryAcquire?(lane: DocumentResourceLane): (() => void) | null;
    observe?(
      lane: DocumentResourceLane,
      observation: AdaptiveResourceObservation
    ): number;
  };
  clockMs?: () => number;
  pressure?: () => { cpuPressure: number; memoryPressure: number };
}) {
  const clockMs = input.clockMs ?? Date.now;
  const pressure = input.pressure ?? readProcessResourcePressure;
  let claimLimit = input.claimLimit ?? 1;
  if (!Number.isSafeInteger(claimLimit) || claimLimit < 1 || claimLimit > 1_000) {
    throw new Error("DOCUMENT_WORK_CLAIM_LIMIT_INVALID");
  }
  const releases = new Map<string, {
    release(): void;
    lane: DocumentResourceLane;
    startedAt: number;
  }>();
  async function claimWithLimit(
    request: DocumentWorkClaimRequest,
    maximumClaims: number
  ): Promise<readonly TWork[]> {
    const admitted: Array<() => void> = [];
    if (input.lanes.tryAcquire) {
      while (admitted.length < maximumClaims) {
        const release = input.lanes.tryAcquire(request.resourceLane);
        if (!release) break;
        admitted.push(release);
      }
    } else {
      admitted.push(await input.lanes.acquire(
        request.resourceLane,
        request.signal
      ));
    }
    if (admitted.length === 0) return [];
    try {
      const rows = await input.work.claim({
        kind: request.kind,
        limit: admitted.length,
        workerId: request.workerId,
        now: request.now,
        leaseDurationMs: request.leaseDurationMs,
        resourceLane: request.resourceLane
      });
      if (rows.length > admitted.length || rows.some((work) =>
        work.kind !== request.kind
        || work.resourceLane !== request.resourceLane
        || releases.has(work.publicId))) {
        throw new Error("DOCUMENT_WORK_CLAIM_CONTRACT_INVALID");
      }
      rows.forEach((work, index) => releases.set(work.publicId, {
        release: admitted[index]!,
        lane: request.resourceLane,
        startedAt: clockMs()
      }));
      admitted.slice(rows.length).forEach((release) => release());
      return rows;
    } catch (error) {
      admitted.forEach((release) => release());
      throw error;
    }
  }
  async function claimAvailable(
    request: DocumentWorkClaimRequest
  ): Promise<readonly TWork[]> {
    return claimWithLimit(request, claimLimit);
  }
  return {
    claimAvailable,
    updateClaimLimit(value: number): void {
      if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
        throw new Error("DOCUMENT_WORK_CLAIM_LIMIT_INVALID");
      }
      claimLimit = value;
    },
    async claimOne(request: DocumentWorkClaimRequest): Promise<TWork | null> {
      const rows = await claimWithLimit(request, 1);
      return rows[0] ?? null;
    },
    release(
      publicId: string,
      outcome: AdaptiveResourceObservation["outcome"] = "success"
    ): void {
      const retained = releases.get(publicId);
      if (!retained) return;
      releases.delete(publicId);
      retained.release();
      input.lanes.observe?.(retained.lane, {
        outcome,
        latencyMs: Math.max(0, clockMs() - retained.startedAt),
        ...pressure()
      });
    }
  };
}
