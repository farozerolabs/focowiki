import type {
  SearchProjectionEpochProgress
} from "../application/ports/search-projection-state-repository.js";

type PendingSearchContract = {
  routeState: "postgres_compatibility" | "meilisearch";
  pendingActivationState: "indexing" | "swapping";
  pendingEpoch: number | null;
  pendingGenerationId: string | null;
  pendingContentSchemaVersion: string | null;
  pendingGraphSchemaVersion: string | null;
  pendingContentSettingsChecksum: string | null;
  pendingGraphSettingsChecksum: string | null;
};

export type SearchEpochActivationDecision =
  | { outcome: "compatibility" }
  | {
      outcome: "pending" | "failed" | "superseded";
      code:
        | "SEARCH_PROJECTION_PENDING"
        | "SEARCH_PROJECTION_FAILED"
        | "SEARCH_PROJECTION_SUPERSEDED";
    }
  | {
      outcome: "activate";
      epoch: number;
      contentSchemaVersion: string;
      graphSchemaVersion: string;
      contentSettingsChecksum: string;
      graphSettingsChecksum: string;
    };

export function resolveSearchEpochActivation(input: {
  generationId: string;
  state: PendingSearchContract;
  progress: SearchProjectionEpochProgress | null;
}): SearchEpochActivationDecision {
  if (input.state.pendingEpoch === null) {
    return input.state.routeState === "postgres_compatibility"
      ? { outcome: "compatibility" }
      : {
          outcome: "pending",
          code: "SEARCH_PROJECTION_PENDING"
        };
  }
  if (input.state.pendingGenerationId !== input.generationId) {
    return {
      outcome: "superseded",
      code: "SEARCH_PROJECTION_SUPERSEDED"
    };
  }
  if (
    !input.progress
    || input.progress.total === 0
    || input.progress.queued > 0
    || input.progress.submitted > 0
    || input.progress.retry > 0
    || !input.progress.activationReady
  ) {
    if (
      input.progress
      && (
        input.progress.failed > 0
        || input.progress.canceled > 0
        || input.progress.superseded > 0
      )
    ) {
      return {
        outcome: "failed",
        code: "SEARCH_PROJECTION_FAILED"
      };
    }
    return {
      outcome: "pending",
      code: "SEARCH_PROJECTION_PENDING"
    };
  }
  if (input.state.pendingActivationState !== "swapping") {
    return {
      outcome: "pending",
      code: "SEARCH_PROJECTION_PENDING"
    };
  }
  const contract = requirePendingContract(input.state);
  return {
    outcome: "activate",
    epoch: input.state.pendingEpoch,
    ...contract
  };
}

function requirePendingContract(
  state: PendingSearchContract
): Omit<Extract<SearchEpochActivationDecision, { outcome: "activate" }>, "outcome" | "epoch"> {
  if (
    !state.pendingContentSchemaVersion
    || !state.pendingGraphSchemaVersion
    || !isChecksum(state.pendingContentSettingsChecksum)
    || !isChecksum(state.pendingGraphSettingsChecksum)
  ) {
    throw new Error("Pending search projection contract is incomplete");
  }
  return {
    contentSchemaVersion: state.pendingContentSchemaVersion,
    graphSchemaVersion: state.pendingGraphSchemaVersion,
    contentSettingsChecksum: state.pendingContentSettingsChecksum,
    graphSettingsChecksum: state.pendingGraphSettingsChecksum
  };
}

function isChecksum(value: string | null): value is string {
  return Boolean(value && /^[a-f0-9]{64}$/u.test(value));
}
