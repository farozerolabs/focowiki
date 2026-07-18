import type {
  DispatchPressureSettings,
  DispatchPressureSnapshot
} from "../../dispatch/source-dispatch-pressure.js";
import type { SerializableJson } from "../../domain/serializable-json.js";

export type { SerializableJson } from "../../domain/serializable-json.js";

export type SourceDispatchResult = {
  paused: boolean;
  reason: keyof DispatchPressureSnapshot | null;
  dispatchedCount: number;
  pendingMarkerCount: number;
  snapshot: DispatchPressureSnapshot;
};

export type SourceDispatchSummary = {
  pendingCount: number;
  oldestPendingAt: string | null;
  paused: boolean;
  pausedReason: keyof DispatchPressureSnapshot | null;
};

export type SourceDispatchRepository = {
  getSummary: (input: {
    knowledgeBaseId: string;
  }) => Promise<SourceDispatchSummary>;
  dispatchPending: (input: {
    dispatcherId: string;
    now: string;
    batchSize: number;
    maxAttempts: number;
    settingsSnapshot: SerializableJson;
    pressure: DispatchPressureSettings;
  }) => Promise<SourceDispatchResult>;
};
