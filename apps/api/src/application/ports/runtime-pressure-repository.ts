import type { DispatchPressureSnapshot } from "../../dispatch/source-dispatch-pressure.js";

export type RuntimePressureState = {
  snapshot: DispatchPressureSnapshot;
  pendingMarkerCount: number;
};

export type RuntimePressureReconciliationResult = {
  reconciled: boolean;
  counters: {
    sourceQueueDepth: number;
    dirtyFileCount: number;
    pendingImpactCount: number;
    pendingMarkerCount: number;
  };
};

export type RuntimePressureRepository = {
  reconcileIfDue: (input: {
    now: string;
    intervalSeconds: number;
  }) => Promise<RuntimePressureReconciliationResult>;
};
