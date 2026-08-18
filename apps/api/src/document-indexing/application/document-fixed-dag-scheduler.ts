import type { DocumentWorkKind } from "../domain/document-work-graph.js";
import type { AdaptiveResourceObservation } from
  "./adaptive-resource-controller.js";
import { readProcessResourcePressure } from "./process-resource-pressure.js";

export const DOCUMENT_RESOURCE_LANES = [
  "postgres_s3",
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

export function createDocumentFixedDagScheduler<TWork extends ClaimedDocumentWork>(input: {
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
  const releases = new Map<string, {
    release(): void;
    lane: DocumentResourceLane;
    startedAt: number;
  }>();
  return {
    async claimOne(request: {
      kind: DocumentWorkKind;
      resourceLane: DocumentResourceLane;
      workerId: string;
      now: string;
      leaseDurationMs: number;
      signal?: AbortSignal;
    }): Promise<TWork | null> {
      const release = input.lanes.tryAcquire
        ? input.lanes.tryAcquire(request.resourceLane)
        : await input.lanes.acquire(request.resourceLane, request.signal);
      if (!release) return null;
      let retained = false;
      try {
        const rows = await input.work.claim({
          kind: request.kind,
          limit: 1,
          workerId: request.workerId,
          now: request.now,
          leaseDurationMs: request.leaseDurationMs,
          resourceLane: request.resourceLane
        });
        const work = rows[0] ?? null;
        if (!work) {
          release();
          retained = true;
          return null;
        }
        if (rows.length !== 1 || work.kind !== request.kind
          || work.resourceLane !== request.resourceLane
          || releases.has(work.publicId)) {
          release();
          retained = true;
          throw new Error("DOCUMENT_WORK_CLAIM_CONTRACT_INVALID");
        }
        releases.set(work.publicId, {
          release,
          lane: request.resourceLane,
          startedAt: clockMs()
        });
        retained = true;
        return work;
      } catch (error) {
        if (!retained) release();
        throw error;
      }
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
